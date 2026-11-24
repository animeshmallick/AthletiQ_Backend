/**
 * Courses: progress, completions waiting for a decision, decisions, and credits.
 * Mounted at /courses.
 */
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  courseRounds,
  enrollments,
  invoices,
  studentCredits,
  students,
} from '../../db/schema/index.js';
import { addDays, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText, zPaise } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertBatchAccess, assertStudentAccess } from '../access/access.js';
import type { AuthUser } from '../auth/auth.types.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { whatsappLink } from '../billing/share-links.js';
import { buildCertificate, certificateData, signCertificateLink } from './certificate.js';
import { courseTarget, roundMonth, sessionsPerMonth } from './course-math.js';
import { DECISION_DAYS, countedDates, decide, evaluateCourses, outstandingDues } from './rounds.js';

export const coursesRouter = Router();

type RoundRow = typeof courseRounds.$inferSelect;
type EnrollmentRow = typeof enrollments.$inferSelect;
type BatchRow = typeof batches.$inferSelect;

/** Where a round stands today. */
async function progress(round: RoundRow, e: EnrollmentRow, b: BatchRow, today: IsoDate) {
  const perMonth = sessionsPerMonth(b.weekdays);
  const months = b.courseMonths;
  if (round.status !== 'active' || !months) {
    return {
      attended: round.attended,
      target: round.target,
      remaining: null,
      month: null,
      extension: false,
      perMonth,
    };
  }
  const attended = (await countedDates(db, e, round.startedOn, today)).length;
  const target = courseTarget(b.weekdays, months);
  const month =
    today >= round.startedOn
      ? roundMonth(e.billingAnchorDate ?? e.effectiveFrom, round.startedOn, today)
      : 0;
  return {
    attended,
    target,
    remaining: Math.max(0, target - attended),
    /** Billing month of the course the student is in (1-based); past `months`: an extension. */
    month,
    extension: month > months,
    perMonth,
  };
}

const roundView = (r: RoundRow) => ({
  id: r.id,
  roundNo: r.roundNo,
  status: r.status,
  startedOn: r.startedOn,
  completedOn: r.completedOn,
  historical: r.historical,
  autoLeft: r.autoLeft,
  decidedAt: r.decidedAt,
  note: r.note,
  adjustments: r.adjustments,
});

// ─── Batch progress ──────────────────────────────────────────────────────────

/** Every current member's course progress, and completions waiting for a decision. */
coursesRouter.get('/batches/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const b = await assertBatchAccess(user, id, { mainOnly: true });
  const today = todayInAppTz();
  const rows = await db
    .select({
      round: courseRounds,
      e: enrollments,
      s: { id: students.id, code: students.code, fullName: students.fullName },
    })
    .from(courseRounds)
    .innerJoin(enrollments, eq(enrollments.id, courseRounds.enrollmentId))
    .innerJoin(students, eq(students.id, courseRounds.studentId))
    .where(and(eq(courseRounds.batchId, id), inArray(courseRounds.status, ['active', 'awaiting'])))
    .orderBy(asc(students.fullName));
  const list = await Promise.all(
    rows.map(async ({ round, e, s }) => ({
      student: s,
      round: roundView(round),
      ...(await progress(round, e, b, today)),
    })),
  );
  ok(res, {
    batch: { id: b.id, name: b.name, courseMonths: b.courseMonths, courseSetOn: b.courseSetOn },
    sessionsPerMonth: sessionsPerMonth(b.weekdays),
    target: b.courseMonths ? courseTarget(b.weekdays, b.courseMonths) : null,
    students: list.filter((x) => x.round.status === 'active'),
    awaiting: list.filter((x) => x.round.status === 'awaiting'),
  });
});

// ─── Student course history ──────────────────────────────────────────────────

coursesRouter.get('/students/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  await assertStudentAccess(user, id);
  const today = todayInAppTz();
  const rows = await db
    .select({ round: courseRounds, e: enrollments, b: batches })
    .from(courseRounds)
    .innerJoin(enrollments, eq(enrollments.id, courseRounds.enrollmentId))
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .where(eq(courseRounds.studentId, id))
    .orderBy(desc(courseRounds.startedOn), desc(courseRounds.roundNo));
  const rounds = await Promise.all(
    rows.map(async ({ round, e, b }) => ({
      ...roundView(round),
      batch: { id: b.id, name: b.name, courseMonths: b.courseMonths },
      ...(await progress(round, e, b, today)),
    })),
  );
  // Credits are money: admins only.
  const credits =
    user.role === 'admin'
      ? await db
          .select()
          .from(studentCredits)
          .where(eq(studentCredits.studentId, id))
          .orderBy(desc(studentCredits.createdAt))
      : null;
  ok(res, { rounds, credits });
});

// ─── Decisions (admin) ───────────────────────────────────────────────────────

/** Completed courses waiting for a decision, oldest first, with dues and credit. */
coursesRouter.get('/decisions', requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      round: courseRounds,
      student: {
        id: students.id,
        code: students.code,
        fullName: students.fullName,
        phone: students.phone,
      },
      batch: { id: batches.id, name: batches.name, capacity: batches.capacity },
      e: {
        customMonthlyFee: enrollments.customMonthlyFee,
        monthlyDiscount: enrollments.monthlyDiscount,
      },
    })
    .from(courseRounds)
    .innerJoin(students, eq(students.id, courseRounds.studentId))
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .innerJoin(enrollments, eq(enrollments.id, courseRounds.enrollmentId))
    .where(eq(courseRounds.status, 'awaiting'))
    .orderBy(asc(courseRounds.completedOn));
  const out = await Promise.all(
    rows.map(async (r) => {
      const credit = await db
        .select({ amount: studentCredits.amount })
        .from(studentCredits)
        .where(
          and(
            inArray(studentCredits.status, ['held', 'assigned']),
            eq(studentCredits.studentId, r.student.id),
          ),
        );
      return {
        ...roundView(r.round),
        attended: r.round.attended,
        target: r.round.target,
        student: r.student,
        batch: r.batch,
        fee: r.e,
        dues: await outstandingDues(db, r.student.id),
        credit: credit.reduce((n, c) => n + c.amount, 0),
        /** Undecided by then, the student leaves automatically (credit owed back). */
        autoLeaveOn: addDays(r.round.completedOn!, DECISION_DAYS),
      };
    }),
  );
  ok(res, out);
});

const DecideBody = z
  .object({
    action: z.enum(['readmit', 'move', 'leave']),
    startsOn: zIsoDate.optional(),
    batchId: zId.optional(),
    customMonthlyFee: zPaise.nullable().optional(),
    monthlyDiscount: zPaise.optional(),
    credit: z.enum(['refund', 'forfeit']).optional(),
    confirmDues: z.boolean().optional(),
    note: zOptionalText(500),
  })
  .refine((b) => b.action !== 'move' || !!b.batchId, {
    message: 'Choose the batch to move to',
    path: ['batchId'],
  });

coursesRouter.post('/rounds/:id/decide', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(DecideBody, req.body);
  const result = await decide(id, body, currentUser(req).id);
  const [round] = await db.select().from(courseRounds).where(eq(courseRounds.id, id));
  ok(res, { ...result, round: roundView(round!) });
});

const EvaluateBody = z.object({ studentId: zId.optional(), batchId: zId.optional() });

/** Checks courses against attendance now (normally done after marking and every night). */
coursesRouter.post('/evaluate', requireAdmin, async (req, res) => {
  const body = parse(EvaluateBody, req.body ?? {});
  ok(
    res,
    await evaluateCourses(todayInAppTz(), {
      studentIds: body.studentId ? [body.studentId] : undefined,
      batchId: body.batchId,
      actorId: currentUser(req).id,
    }),
  );
});

// ─── Credits (admin) ─────────────────────────────────────────────────────────

const CreditsQuery = z.object({
  status: z
    .enum(['held', 'assigned', 'applied', 'refund_due', 'refunded', 'forfeited', 'void'])
    .optional(),
  studentId: zId.optional(),
});

coursesRouter.get('/credits', requireAdmin, async (req, res) => {
  const q = parse(CreditsQuery, req.query);
  const where: SQL[] = [];
  if (q.status) where.push(eq(studentCredits.status, q.status));
  if (q.studentId) where.push(eq(studentCredits.studentId, q.studentId));
  const rows = await db
    .select({
      credit: studentCredits,
      student: { id: students.id, code: students.code, fullName: students.fullName },
      sourceInvoice: { id: invoices.id, number: invoices.number },
    })
    .from(studentCredits)
    .innerJoin(students, eq(students.id, studentCredits.studentId))
    .leftJoin(invoices, eq(invoices.id, studentCredits.sourceInvoiceId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(studentCredits.createdAt))
    .limit(500);
  ok(
    res,
    rows.map((r) => ({
      ...r.credit,
      student: r.student,
      sourceInvoice: r.sourceInvoice?.id ? r.sourceInvoice : null,
    })),
  );
});

const SettleBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refunded'), note: zOptionalText(500) }),
  z.object({ action: z.literal('forfeited'), note: zOptionalText(500) }),
  /** Owed back, but the student is (still / again) training: take it off a membership's invoice. */
  z.object({ action: z.literal('assign'), enrollmentId: zId, note: zOptionalText(500) }),
]);

/** Settles a credit owed back: paid out, kept, or put towards a current membership. */
coursesRouter.post('/credits/:id/settle', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(SettleBody, req.body);
  const user = currentUser(req);
  const credit = await db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(studentCredits)
      .where(eq(studentCredits.id, id))
      .for('update');
    if (!c) throw AppError.notFound('Credit');
    if (c.status !== 'refund_due')
      throw AppError.conflict(
        `Only credit owed back can be settled (this one is ${c.status.replace('_', ' ')})`,
      );
    let set: Partial<typeof studentCredits.$inferInsert>;
    if (body.action === 'assign') {
      const [e] = await tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.id, body.enrollmentId),
            eq(enrollments.studentId, c.studentId),
            isNull(enrollments.effectiveTo),
          ),
        );
      if (!e) throw AppError.badRequest('Choose one of the student’s current batches');
      set = { status: 'assigned', enrollmentId: e.id, note: body.note ?? null };
    } else {
      set = {
        status: body.action,
        settledById: user.id,
        settledAt: new Date(),
        note: body.note ?? null,
      };
    }
    const [updated] = await tx
      .update(studentCredits)
      .set(set)
      .where(eq(studentCredits.id, id))
      .returning();
    await audit(
      {
        ...auditCtx(req),
        action: `credit.${body.action}`,
        entityType: 'student',
        entityId: c.studentId,
        metadata: { creditId: id, amount: c.amount, note: body.note ?? null },
      },
      tx,
    );
    return updated!;
  });
  ok(res, credit);
});

// ─── Certificates ────────────────────────────────────────────────────────────

/**
 * The round's student, if the user may see it: admins, the coach of the round's batch (even after
 * the membership ended, e.g. on completion), or a coach who currently coaches the student.
 */
async function roundStudent(id: string, user: AuthUser) {
  const [r] = await db
    .select({ studentId: courseRounds.studentId, coachId: batches.coachId })
    .from(courseRounds)
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .where(eq(courseRounds.id, id));
  if (!r) throw AppError.notFound('Course round');
  if (r.coachId !== user.id) await assertStudentAccess(user, r.studentId);
  return r.studentId;
}

/** The completion certificate (PDF) for a completed round. */
coursesRouter.get('/rounds/:id/certificate', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await roundStudent(id, currentUser(req));
  const { pdf, filename } = await buildCertificate(id);
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
});

/** A link for parents: opens the certificate after the registration number is entered. */
coursesRouter.post('/rounds/:id/certificate/share', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const studentId = await roundStudent(id, currentUser(req));
  const data = await certificateData(id); // completed rounds only
  const link = signCertificateLink(id);
  const [s] = await db
    .select({ phone: students.phone })
    .from(students)
    .where(eq(students.id, studentId));
  await audit({
    ...auditCtx(req),
    action: 'certificate.shared',
    entityType: 'student',
    entityId: studentId,
    metadata: { roundId: id },
  });
  ok(res, {
    ...link,
    whatsapp: whatsappLink(
      s?.phone ?? null,
      `Congratulations! ${data.studentName} has completed the ${data.sportName} course at ${data.batchName}. Certificate: ${link.url} (open it with the registration number).`,
    ),
  });
});
