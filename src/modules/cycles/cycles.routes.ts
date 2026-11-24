/**
 * Cycles (progress, student history, certificates) and renewals (stop, restore, exit).
 * Coaches: their own batches, no amounts; they can stop or restore a renewal at cycle end.
 * Exits, moves and write-offs are admin only.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batchCycles,
  batches,
  enrollments,
  invoices,
  students,
  users,
} from '../../db/schema/index.js';
import { addDays, formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { whatsappLink } from '../billing/share-links.js';
import { noticeStudentJoined, noticeStudentLeft } from '../push/coach-notices.js';
import { notifyAdmins, notifyInBackground } from '../push/push.service.js';
import { NO_PLAN } from '../students/students.service.js';
import { buildCertificate, certificateData, signCertificateLink } from './certificate.js';
import { exitInvoices, exitNow, planEnd } from './exits.js';
import { cycleProgress, type CycleProgress } from './progress.js';

const counts = ({ sessions: _s, ...p }: CycleProgress) => p;

/** Mounted at /cycles. */
export const cyclesRouter = Router();

/** Every running cycle of a batch, with progress. */
cyclesRouter.get('/batches/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const b = await assertBatchAccess(currentUser(req), id, { mainOnly: true });
  const rows = await db
    .select({
      c: batchCycles,
      student: { id: students.id, code: students.code, fullName: students.fullName },
      plannedEndOn: enrollments.plannedEndOn,
    })
    .from(batchCycles)
    .innerJoin(enrollments, eq(enrollments.id, batchCycles.enrollmentId))
    .innerJoin(students, eq(students.id, batchCycles.studentId))
    .where(and(eq(batchCycles.batchId, id), eq(batchCycles.status, 'active')))
    .orderBy(asc(students.fullName));
  const progress = await cycleProgress(rows.map((r) => r.c));
  ok(res, {
    courseMonths: b.courseMonths,
    perMonth: b.weekdays.length * 4,
    cycles: rows.map((r) => ({
      ...r.c,
      student: r.student,
      plannedEndOn: r.plannedEndOn,
      ...counts(progress.get(r.c.id)!),
    })),
  });
});

/**
 * Every batch a student has been in, with each cycle's sessions, attendance and (admins and the
 * batch's coach) invoices. Coaches see only their own batches.
 */
cyclesRouter.get('/students/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const memberships = await db
    .select({
      e: enrollments,
      batch: { id: batches.id, name: batches.name },
      coach: { id: users.id, name: users.name },
    })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      and(eq(enrollments.studentId, id), isAdmin(user) ? undefined : eq(batches.coachId, user.id)),
    )
    .orderBy(desc(enrollments.effectiveFrom));
  if (!memberships.length) throw AppError.notFound('Student');
  const ids = memberships.map((m) => m.e.id);
  const [cycles, bills] = await Promise.all([
    db
      .select()
      .from(batchCycles)
      .where(inArray(batchCycles.enrollmentId, ids))
      .orderBy(desc(batchCycles.roundNo)),
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        enrollmentId: invoices.enrollmentId,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        totalAmount: invoices.totalAmount,
        status: invoices.status,
      })
      .from(invoices)
      .where(inArray(invoices.enrollmentId, ids))
      .orderBy(desc(invoices.periodStart)),
  ]);
  const progress = await cycleProgress(cycles);
  ok(
    res,
    memberships.map(({ e, batch, coach }) => {
      const mine = cycles.filter((c) => c.enrollmentId === e.id);
      const billed = bills.filter((b) => b.enrollmentId === e.id);
      const inCycle = (c: (typeof mine)[number], b: (typeof billed)[number]) =>
        b.periodStart >= c.startsOn && b.periodStart <= c.endsOn;
      return {
        enrollmentId: e.id,
        batch,
        coach,
        from: e.effectiveFrom,
        to: e.effectiveTo,
        plannedEndOn: e.plannedEndOn,
        reason: e.reason,
        cycles: mine.map((c) => ({
          ...c,
          ...progress.get(c.id)!,
          invoices: billed.filter((b) => inCycle(c, b)),
        })),
        /** Billed before the course was set up. */
        earlier: billed.filter((b) => !mine.some((c) => inCycle(c, b))),
      };
    }),
  );
});

async function cycleFor(id: string, user: AuthUser) {
  const [row] = await db
    .select({ c: batchCycles, coachId: batches.coachId, phone: students.phone })
    .from(batchCycles)
    .innerJoin(batches, eq(batches.id, batchCycles.batchId))
    .innerJoin(students, eq(students.id, batchCycles.studentId))
    .where(eq(batchCycles.id, id));
  if (!row || (!isAdmin(user) && row.coachId !== user.id)) throw AppError.notFound('Cycle');
  return row;
}

cyclesRouter.get('/:id/certificate', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await cycleFor(id, currentUser(req));
  const { pdf, filename } = await buildCertificate(id);
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
});

cyclesRouter.post('/:id/certificate/share', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { c, phone } = await cycleFor(id, currentUser(req));
  const data = await certificateData(id);
  const link = signCertificateLink(id);
  await audit({
    ...auditCtx(req),
    action: 'certificate.shared',
    entityType: 'student',
    entityId: c.studentId,
    metadata: { cycleId: id },
  });
  ok(res, {
    ...link,
    whatsappUrl: whatsappLink(
      phone,
      `Congratulations! ${data.studentName} has completed round ${data.roundNo} of ${data.sportName} (${data.batchName}).\n\nCertificate: ${link.url}\n\nOpen it with the registration number.`,
    ),
  });
});

// ─── Renewals ────────────────────────────────────────────────────────────────

/** Mounted at /renewals. */
export const renewalsRouter = Router();

/** Running cycles and whether each renews. Dues are shown to admins only. */
renewalsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { batchId } = parse(z.object({ batchId: zId.optional() }), req.query);
  const rows = await db
    .select({
      c: batchCycles,
      e: enrollments,
      student: { id: students.id, code: students.code, fullName: students.fullName },
      batch: { id: batches.id, name: batches.name },
      coach: { id: users.id, name: users.name },
      plannedBy: sql<
        string | null
      >`(select u.name from ${users} u where u.id = ${enrollments.plannedById})`,
      moveTo: sql<
        string | null
      >`(select b.name from ${batches} b where b.id = ${enrollments.plannedMoveToId})`,
    })
    .from(batchCycles)
    .innerJoin(enrollments, eq(enrollments.id, batchCycles.enrollmentId))
    .innerJoin(students, eq(students.id, batchCycles.studentId))
    .innerJoin(batches, eq(batches.id, batchCycles.batchId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      and(
        eq(batchCycles.status, 'active'),
        isNull(enrollments.effectiveTo),
        isAdmin(user) ? undefined : eq(batches.coachId, user.id),
        batchId ? eq(batches.id, batchId) : undefined,
      ),
    )
    .orderBy(asc(batchCycles.endsOn), asc(students.fullName));
  const [progress, dues] = await Promise.all([
    cycleProgress(rows.map((r) => r.c)),
    isAdmin(user) && rows.length
      ? db
          .select({
            enrollmentId: invoices.enrollmentId,
            amount: sql<number>`sum(${invoices.totalAmount})::int`,
            count: sql<number>`count(*)::int`,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.status, 'due'),
              inArray(
                invoices.enrollmentId,
                rows.map((r) => r.e.id),
              ),
            ),
          )
          .groupBy(invoices.enrollmentId)
      : [],
  ]);
  const owed = new Map(dues.map((d) => [d.enrollmentId, d]));
  ok(
    res,
    rows.map((r) => ({
      cycleId: r.c.id,
      enrollmentId: r.e.id,
      student: r.student,
      batch: r.batch,
      coach: r.coach,
      roundNo: r.c.roundNo,
      months: r.c.months,
      startsOn: r.c.startsOn,
      endsOn: r.c.endsOn,
      renewsOn: addDays(r.c.endsOn, 1),
      progress: counts(progress.get(r.c.id)!),
      stopped: r.e.plannedEndOn
        ? {
            on: r.e.plannedEndOn,
            reason: r.e.plannedReason,
            by: r.plannedBy,
            moveTo: r.e.plannedMoveToId ? { id: r.e.plannedMoveToId, name: r.moveTo } : null,
          }
        : null,
      dues: isAdmin(user)
        ? {
            amount: owed.get(r.e.id)?.amount ?? 0,
            count: owed.get(r.e.id)?.count ?? 0,
          }
        : null,
    })),
  );
});

const Reason = z.string().trim().min(3, 'Please give a reason').max(300);
const StopBody = z.object({ reason: Reason, moveToBatchId: zId.nullable().optional() });

/** The open membership and its running cycle, locked, if this user may manage its renewal. */
async function lockRenewal(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  enrollmentId: string,
  user: AuthUser,
) {
  const [e] = await tx
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .for('update');
  const [b] = e ? await tx.select().from(batches).where(eq(batches.id, e.batchId)) : [];
  if (!e || !b || (!isAdmin(user) && b.coachId !== user.id)) throw AppError.notFound('Renewal');
  if (e.effectiveTo) throw AppError.conflict('That membership has already ended');
  const [c] = await tx
    .select()
    .from(batchCycles)
    .where(and(eq(batchCycles.enrollmentId, e.id), eq(batchCycles.status, 'active')));
  if (!c) throw AppError.notFound('Renewal');
  return { e, b, c };
}

/** Stops the renewal at the end of the running cycle (admins can set where they move to). */
renewalsRouter.post('/:id/stop', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(StopBody, req.body);
  const user = currentUser(req);
  if (body.moveToBatchId && !isAdmin(user))
    throw AppError.forbidden('Only an admin can choose the next batch');
  const out = await db.transaction(async (tx) => {
    const { e, b, c } = await lockRenewal(tx, id, user);
    // A coach can't replace what an admin planned.
    if (e.plannedEndOn && !isAdmin(user)) throw AppError.conflict('This is already stopped');
    if (c.endsOn < todayInAppTz()) throw AppError.conflict('This cycle has just ended. Try again.');
    await planEnd(tx, e, {
      on: c.endsOn,
      reason: body.reason,
      actorId: user.id,
      moveToId: body.moveToBatchId,
    });
    await audit(
      {
        ...auditCtx(req),
        action: 'renewal.stopped',
        entityType: 'student',
        entityId: e.studentId,
        metadata: { enrollmentId: e.id, batchId: b.id, on: c.endsOn, ...body },
      },
      tx,
    );
    const s = await tx.query.students.findFirst({ where: eq(students.id, e.studentId) });
    return { on: c.endsOn, name: s!.fullName, batch: b.name };
  });
  notifyInBackground(() =>
    notifyAdmins({
      category: 'approvals',
      icon: '⏹️',
      title: `Renewal stopped · ${out.name}`,
      body: `${out.batch}, after ${formatDisplayDate(out.on)} · ${user.name}: ${body.reason}`,
      link: '/renewals?state=stopped',
      tag: `renewal-${id}`,
    }),
  );
  ok(res, { on: out.on });
});

/** Undoes a stopped renewal or planned leaving, until it takes effect. */
renewalsRouter.post('/:id/restore', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  await db.transaction(async (tx) => {
    const { e } = await lockRenewal(tx, id, user);
    if (!e.plannedEndOn) throw AppError.conflict('This renewal isn’t stopped');
    if (e.plannedEndOn < todayInAppTz()) throw AppError.conflict('It has already taken effect');
    // A coach restores only what a coach may stop: the cycle end, with no move planned.
    const ownStop = e.plannedById === user.id && !e.plannedMoveToId;
    if (!isAdmin(user) && !ownStop)
      throw AppError.forbidden('An admin planned this. Ask an admin to change it.');
    await tx.update(enrollments).set(NO_PLAN).where(eq(enrollments.id, e.id));
    await audit(
      {
        ...auditCtx(req),
        action: 'renewal.restored',
        entityType: 'student',
        entityId: e.studentId,
        metadata: { enrollmentId: e.id, was: e.plannedEndOn, reason: e.plannedReason },
      },
      tx,
    );
  });
  ok(res, { restored: true });
});

/** Admin: what exiting today does to each unpaid invoice. */
renewalsRouter.get('/:id/exit', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const [e] = await db.select().from(enrollments).where(eq(enrollments.id, id));
  if (!e || e.effectiveTo) throw AppError.notFound('Membership');
  const today = todayInAppTz();
  ok(res, {
    lastDay: e.effectiveFrom > today ? e.effectiveFrom : today,
    invoices: await exitInvoices(db, e, today),
  });
});

const ExitBody = z.object({
  reason: Reason,
  moveToBatchId: zId.nullable().optional(),
  lostInvoiceIds: z.array(zId).max(100).default([]),
});

renewalsRouter.post('/:id/exit', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ExitBody, req.body);
  const out = await exitNow(
    { enrollmentId: id, ...body },
    { actorId: currentUser(req).id, ipAddress: req.ip ?? null },
  );
  if (body.moveToBatchId)
    notifyInBackground(() => noticeStudentJoined(out.studentId, body.moveToBatchId!));
  notifyInBackground(() =>
    noticeStudentLeft(out.studentId, out.batchId, out.lastDay, out.leftAcademy),
  );
  ok(res, out);
});
