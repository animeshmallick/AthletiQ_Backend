import type { AuthUser } from '../auth/auth.types.js';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  gte,
} from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  feePlans,
  invoices,
  makeupSessions,
  studentAttendance,
  students,
  users,
  weeklyFeedback,
  skillAssessments,
} from '../../db/schema/index.js';
import { isoWeekday, minDate, onDay, todayInAppTz, addDays } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, noContent, ok, pageMeta } from '../../lib/http.js';
import {
  parse,
  zEmail,
  zId,
  zIdParam,
  zIsoDate,
  zName,
  zOptionalText,
  zPagination,
  zPaise,
  zPhone,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertStudentAccess, isAdmin, studentScope } from '../access/access.js';
import { billOnAcceptance } from '../billing/invoice-generator.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { createStudent, getStudentDetail, joinBatch, moveEnrollment } from './students.service.js';
import {
  noticeMakeupBooked,
  noticeStudentJoined,
  noticeStudentLeft,
  noticeStudentMovedOut,
} from '../push/coach-notices.js';
import { notifyAdmins, notifyInBackground } from '../push/push.service.js';
import { assertNotCancelled } from '../attendance/cancellations.js';

export const studentsRouter = Router();

// ─── List ────────────────────────────────────────────────────────────────────

const ListQuery = zPagination.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'left']).optional(),
  batchId: zId.optional(),
  coachId: zId.optional(),
  feePlanId: zId.optional(),
  /** Only students with unpaid ("outstanding") or past-due ("overdue") invoices. */
  /** outstanding/overdue: has unpaid invoices. paying: leaves out students whose every current
   *  batch is free (₹0 after their own fee and discount). */
  dues: z.enum(['outstanding', 'overdue', 'paying']).optional(),
  sort: z.enum(['name', 'joiningDate', 'recent', 'dues']).default('name'),
});

studentsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];

  const scope = studentScope(user, students.id);
  if (scope) filters.push(scope);
  if (q.status) filters.push(eq(students.status, q.status));
  // Students currently in a batch matching a condition.
  const inBatch = (cond: SQL) =>
    inArray(
      students.id,
      db
        .select({ id: enrollments.studentId })
        .from(enrollments)
        .innerJoin(batches, eq(batches.id, enrollments.batchId))
        .where(and(isNull(enrollments.effectiveTo), cond)),
    );
  if (q.feePlanId) filters.push(inBatch(eq(batches.feePlanId, q.feePlanId)));
  if (q.batchId) filters.push(inBatch(eq(batches.id, q.batchId)));
  if (q.coachId && isAdmin(user)) filters.push(inBatch(eq(batches.coachId, q.coachId)));
  if (q.search) {
    const term = `%${q.search}%`;
    filters.push(
      or(
        ilike(students.fullName, term),
        ilike(students.code, term),
        ilike(students.phone, term),
        ilike(students.guardianName, term),
      )!,
    );
  }
  const today = todayInAppTz();
  if (q.dues === 'paying') {
    // Only free memberships = has a current batch, and none of them costs anything.
    const open = sql`select 1 from ${enrollments} e join ${batches} b on b.id = e.batch_id
      join ${feePlans} f on f.id = b.fee_plan_id
      where e.student_id = ${students.id} and e.effective_to is null`;
    filters.push(
      sql`not (exists (${open}) and not exists (${open}
        and greatest(coalesce(e.custom_monthly_fee, f.monthly_fee) - e.monthly_discount, 0) > 0))`,
    );
  } else if (q.dues) {
    filters.push(
      inArray(
        students.id,
        db
          .select({ id: invoices.studentId })
          .from(invoices)
          .where(
            and(
              eq(invoices.status, 'due'),
              q.dues === 'overdue' ? lt(invoices.dueDate, today) : undefined,
            ),
          ),
      ),
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  const outstanding = db
    .select({
      studentId: invoices.studentId,
      due: sql<number>`sum(${invoices.totalAmount})`.as('due'),
      overdue:
        sql<number>`sum(${invoices.totalAmount}) filter (where ${invoices.dueDate} < ${today})`.as(
          'overdue',
        ),
    })
    .from(invoices)
    .where(eq(invoices.status, 'due'))
    .groupBy(invoices.studentId)
    .as('outstanding');

  const order =
    q.sort === 'dues'
      ? [
          desc(sql`coalesce(${outstanding.overdue}, 0)`),
          desc(sql`coalesce(${outstanding.due}, 0)`),
          asc(students.fullName),
        ]
      : q.sort === 'joiningDate'
        ? [desc(students.joiningDate)]
        : q.sort === 'recent'
          ? [desc(students.createdAt)]
          : [asc(students.fullName)];

  // Each student's current batches (coaches see only their own), with each one's monthly fee.
  const fee = sql<number>`greatest(coalesce(${enrollments.customMonthlyFee}, ${feePlans.monthlyFee}) - ${enrollments.monthlyDiscount}, 0)`;
  const memberships = db
    .select({
      studentId: enrollments.studentId,
      batches: sql<
        {
          id: string;
          name: string;
          coachId: string;
          coachName: string;
          planName: string;
          fee: number;
        }[]
      >`json_agg(json_build_object('id', ${batches.id}, 'name', ${batches.name}, 'coachId', ${batches.coachId}, 'coachName', ${users.name}, 'planName', ${feePlans.name}, 'fee', ${fee}) order by ${enrollments.effectiveFrom})`.as(
        'batches',
      ),
      monthlyFee: sql<number>`sum(${fee})::int`.as('monthly_fee'),
    })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
    .where(
      and(
        isNull(enrollments.effectiveTo),
        isAdmin(user) ? undefined : eq(batches.coachId, user.id),
      ),
    )
    .groupBy(enrollments.studentId)
    .as('memberships');

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        id: students.id,
        code: students.code,
        fullName: students.fullName,
        phone: students.phone,
        guardianName: students.guardianName,
        status: students.status,
        joiningDate: students.joiningDate,
        leftOn: students.leftOn,
        batches: sql<
          {
            id: string;
            name: string;
            coachId: string;
            coachName: string;
            planName: string;
            fee: number;
          }[]
        >`coalesce(${memberships.batches}, '[]'::json)`,
        effectiveFee: sql<number>`coalesce(${memberships.monthlyFee}, 0)::int`,
        outstanding: sql<number>`coalesce(${outstanding.due}, 0)::int`,
        overdue: sql<number>`coalesce(${outstanding.overdue}, 0)::int`,
      })
      .from(students)
      .leftJoin(memberships, eq(memberships.studentId, students.id))
      .leftJoin(outstanding, eq(outstanding.studentId, students.id))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(students).where(where),
  ]);

  ok(res, await withCardStats(user, rows), pageMeta(q.page, q.pageSize, total));
});

/**
 * For the student cards: attendance over the last 30 days (in the batches the user can see) and
 * the latest assessed level. One query each for the page of students.
 */
async function withCardStats<T extends { id: string }>(user: AuthUser, rows: T[]) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const from = addDays(todayInAppTz(), -29);
  const own = isAdmin(user)
    ? undefined
    : inArray(
        studentAttendance.batchId,
        db.select({ id: batches.id }).from(batches).where(eq(batches.coachId, user.id)),
      );
  const [att, lvl] = await Promise.all([
    db
      .select({
        studentId: studentAttendance.studentId,
        marked: sql<number>`count(*)::int`,
        present: sql<number>`count(*) filter (where ${studentAttendance.status} in ('present', 'late'))::int`,
      })
      .from(studentAttendance)
      .where(and(inArray(studentAttendance.studentId, ids), gte(studentAttendance.date, from), own))
      .groupBy(studentAttendance.studentId),
    db
      .selectDistinctOn([skillAssessments.studentId], {
        studentId: skillAssessments.studentId,
        code: skillAssessments.levelCode,
        name: skillAssessments.levelName,
      })
      .from(skillAssessments)
      .where(inArray(skillAssessments.studentId, ids))
      .orderBy(skillAssessments.studentId, desc(skillAssessments.month)),
  ]);
  return rows.map((r) => {
    const a = att.find((x) => x.studentId === r.id);
    const l = lvl.find((x) => x.studentId === r.id);
    return {
      ...r,
      attendanceRate: a?.marked ? Math.round((a.present * 100) / a.marked) : null,
      level: l ? { code: l.code, name: l.name } : null,
    };
  });
}

studentsRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(currentUser(req), id);
  ok(res, await getStudentDetail(id));
});

// ─── Admin: register / update ────────────────────────────────────────────────

const ProfileFields = {
  fullName: zName,
  dateOfBirth: zIsoDate.nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  guardianName: zOptionalText(120),
  phone: zPhone,
  alternatePhone: zPhone.nullable().optional(),
  email: zEmail.nullable().optional(),
  address: zOptionalText(500),
  medicalNotes: zOptionalText(1000),
  notes: zOptionalText(2000),
};

/** A batch to join, with this student's own price adjustments (the plan comes from the batch). */
const BatchJoin = z.object({
  batchId: zId,
  customMonthlyFee: zPaise.nullable().optional(),
  monthlyDiscount: zPaise.default(0),
});
const BatchList = z
  .array(BatchJoin)
  .min(1, 'Pick at least one batch')
  .max(10)
  .refine(
    (l) => new Set(l.map((b) => b.batchId)).size === l.length,
    'Each batch can be picked once',
  );

const CreateBody = z.object({
  ...ProfileFields,
  joiningDate: zIsoDate,
  batches: BatchList,
  /**
   * Acceptance date for prepaid billing: the first invoice is issued on this date and months that
   * started earlier are not billed. Defaults to the earlier of today and the joining date; set it
   * later when importing existing students whose current month was settled outside the system.
   */
  billingStartsOn: zIsoDate.optional(),
});

studentsRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(CreateBody, req.body);
  const actor = currentUser(req);

  const student = await db.transaction(async (tx) => {
    const s = await createStudent(tx, body, actor.id);
    await audit(
      {
        ...auditCtx(req),
        action: 'student.created',
        entityType: 'student',
        entityId: s.id,
        metadata: { code: s.code, batchIds: body.batches.map((b) => b.batchId) },
      },
      tx,
    );
    return s;
  });

  await billOnAcceptance(student.id);
  notifyInBackground(() => noticeStudentJoined(student.id));
  created(res, await getStudentDetail(student.id));
});

const UpdateBody = z.object({ ...ProfileFields, joiningDate: zIsoDate }).partial();

/** Profile details. Fees are per batch (see the batch membership routes below). */
studentsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(UpdateBody, req.body);

  let rebill = false;
  await db.transaction(async (tx) => {
    const existing = await tx.query.students.findFirst({ where: eq(students.id, id) });
    if (!existing) throw AppError.notFound('Student');

    if (body.joiningDate && body.joiningDate !== existing.joiningDate) {
      // The joining date anchors the billing of the batches joined that day. It can be corrected
      // until money has changed hands: their unpaid invoices are cancelled and billing restarts.
      const firsts = await tx
        .select()
        .from(enrollments)
        .where(
          and(eq(enrollments.studentId, id), eq(enrollments.effectiveFrom, existing.joiningDate)),
        );
      if (firsts.some((e) => e.effectiveTo !== null && e.effectiveTo < body.joiningDate!))
        throw AppError.unprocessable('Joining date conflicts with the batch history.');
      for (const e of firsts) {
        const rows = await tx
          .select({ status: invoices.status, cycle: invoices.cycleNumber })
          .from(invoices)
          .where(eq(invoices.enrollmentId, e.id));
        if (rows.some((r) => r.status === 'paid' || r.status === 'refunded')) {
          throw AppError.unprocessable(
            'Joining date cannot change after a payment has been recorded (it anchors the billing cycle).',
          );
        }
        let billing: Partial<typeof enrollments.$inferInsert> = {
          billingStartsOn: minDate(todayInAppTz(), body.joiningDate),
        };
        if (rows.length || e.lastFreeCycle) {
          await tx
            .update(invoices)
            .set({ status: 'cancelled', cancelledReason: 'Joining date corrected' })
            .where(and(eq(invoices.enrollmentId, e.id), eq(invoices.status, 'due')));
          billing = {
            ...billing,
            billingAnchorDate: body.joiningDate,
            cycleOffset: Math.max(e.lastFreeCycle, ...rows.map((r) => r.cycle)),
          };
          rebill = true;
        }
        await tx
          .update(enrollments)
          .set({ ...billing, effectiveFrom: body.joiningDate })
          .where(eq(enrollments.id, e.id));
      }
    }

    // Nothing to change (e.g. only fields that now live on batch memberships) is a no-op.
    if (Object.keys(body).length) await tx.update(students).set(body).where(eq(students.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'student.updated',
        entityType: 'student',
        entityId: id,
        metadata: { changes: Object.keys(body) },
      },
      tx,
    );
  });

  if (rebill) await billOnAcceptance(id);
  ok(res, await getStudentDetail(id));
});

// ─── Admin: batch memberships ────────────────────────────────────────────────

async function activeStudent(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string) {
  const [s] = await tx.select().from(students).where(eq(students.id, id)).for('update');
  if (!s) throw AppError.notFound('Student');
  if (s.status === 'left') throw AppError.unprocessable('Student has left the academy');
  return s;
}

async function openMembership(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  studentId: string,
  enrollmentId: string,
) {
  const [e] = await tx
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.studentId, studentId)))
    .for('update');
  if (!e) throw AppError.notFound('Batch membership');
  if (e.effectiveTo !== null) throw AppError.unprocessable('That membership has already ended');
  return e;
}

const JoinBody = BatchJoin.extend({ effectiveFrom: zIsoDate, reason: zOptionalText(500) });

/** Adds a student to another batch (billed separately, from the day they join it). */
studentsRouter.post('/:id/batches', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(JoinBody, req.body);
  const actor = currentUser(req);
  await db.transaction(async (tx) => {
    const s = await activeStudent(tx, id);
    if (body.effectiveFrom < s.joiningDate)
      throw AppError.badRequest('A batch cannot start before the joining date');
    const { batch } = await joinBatch(tx, {
      ...body,
      studentId: id,
      reason: body.reason ?? 'Added to batch',
      actorId: actor.id,
    });
    await audit(
      {
        ...auditCtx(req),
        action: 'student.batch_added',
        entityType: 'student',
        entityId: id,
        metadata: { batchId: batch.id, effectiveFrom: body.effectiveFrom },
      },
      tx,
    );
  });
  await billOnAcceptance(id);
  notifyInBackground(() => noticeStudentJoined(id, body.batchId));
  created(res, await getStudentDetail(id));
});

const FeeBody = z.object({
  customMonthlyFee: zPaise.nullable().optional(),
  monthlyDiscount: zPaise.optional(),
});

/** Changes one membership's custom fee / discount (applies from its next invoice). */
studentsRouter.patch('/:id/batches/:enrollmentId', requireAdmin, async (req, res) => {
  const { id, enrollmentId } = parse(z.object({ id: zId, enrollmentId: zId }), req.params);
  const body = parse(FeeBody, req.body);
  await db.transaction(async (tx) => {
    const e = await openMembership(tx, id, enrollmentId);
    await tx.update(enrollments).set(body).where(eq(enrollments.id, e.id));
    await audit(
      {
        ...auditCtx(req),
        action: 'student.fee_changed',
        entityType: 'student',
        entityId: id,
        metadata: {
          batchId: e.batchId,
          before: { customMonthlyFee: e.customMonthlyFee, monthlyDiscount: e.monthlyDiscount },
          changes: body,
        },
      },
      tx,
    );
  });
  ok(res, await getStudentDetail(id));
});

const MoveBody = z.object({
  batchId: zId,
  effectiveFrom: zIsoDate,
  reason: zOptionalText(500),
  customMonthlyFee: zPaise.nullable().optional(),
  monthlyDiscount: zPaise.optional(),
});

/**
 * Moves a membership to another batch from a date. Billing continues on the same monthly day:
 * the new batch's plan applies from the next cycle.
 */
studentsRouter.post('/:id/batches/:enrollmentId/move', requireAdmin, async (req, res) => {
  const { id, enrollmentId } = parse(z.object({ id: zId, enrollmentId: zId }), req.params);
  const body = parse(MoveBody, req.body);
  const moved = await db.transaction(async (tx) => {
    await activeStudent(tx, id);
    const { previous, current } = await moveEnrollment(tx, {
      studentId: id,
      enrollmentId,
      toBatchId: body.batchId,
      effectiveFrom: body.effectiveFrom,
      reason: body.reason ?? null,
      actorId: currentUser(req).id,
      customMonthlyFee: body.customMonthlyFee,
      monthlyDiscount: body.monthlyDiscount,
    });
    await audit(
      {
        ...auditCtx(req),
        action: 'student.transferred',
        entityType: 'student',
        entityId: id,
        metadata: {
          fromBatchId: previous.batchId,
          toBatchId: current.batchId,
          effectiveFrom: body.effectiveFrom,
        },
      },
      tx,
    );
    return { from: previous.batchId, to: current.batchId };
  });
  notifyInBackground(() => noticeStudentJoined(id, moved.to));
  notifyInBackground(() => noticeStudentMovedOut(id, moved.from, moved.to, body.effectiveFrom));
  ok(res, await getStudentDetail(id));
});

const LeaveBatchBody = z.object({ leftOn: zIsoDate, reason: zOptionalText(500) });

/**
 * Ends one batch membership (its invoices stop; the month in progress was already billed).
 * Leaving the only batch means leaving the academy — use /leave for that.
 */
studentsRouter.post('/:id/batches/:enrollmentId/leave', requireAdmin, async (req, res) => {
  const { id, enrollmentId } = parse(z.object({ id: zId, enrollmentId: zId }), req.params);
  const body = parse(LeaveBatchBody, req.body);
  const batchId = await db.transaction(async (tx) => {
    await activeStudent(tx, id);
    const e = await openMembership(tx, id, enrollmentId);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(enrollments)
      .where(and(eq(enrollments.studentId, id), isNull(enrollments.effectiveTo)));
    if (n <= 1)
      throw AppError.unprocessable(
        'This is the student’s only batch. Mark them as left the academy instead.',
      );
    if (body.leftOn < e.effectiveFrom)
      throw AppError.badRequest(`The last day cannot be before they joined (${e.effectiveFrom})`);
    await tx.update(enrollments).set({ effectiveTo: body.leftOn }).where(eq(enrollments.id, e.id));
    await tx
      .delete(makeupSessions)
      .where(
        and(
          eq(makeupSessions.studentId, id),
          eq(makeupSessions.batchId, e.batchId),
          gt(makeupSessions.date, body.leftOn),
        ),
      );
    await audit(
      {
        ...auditCtx(req),
        action: 'student.batch_left',
        entityType: 'student',
        entityId: id,
        metadata: { batchId: e.batchId, ...body },
      },
      tx,
    );
    return e.batchId;
  });
  notifyInBackground(() => noticeStudentLeft(id, batchId, body.leftOn, false));
  ok(res, await getStudentDetail(id));
});

const LeaveBody = z.object({ leftOn: zIsoDate, reason: zOptionalText(500) });

/**
 * Marks a student as left the academy: every batch membership ends on `leftOn`, so cycles
 * starting after it are not billed; already-issued invoices are untouched. Future makeups are
 * cancelled.
 */
studentsRouter.post('/:id/leave', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(LeaveBody, req.body);

  const leftBatchIds = await db.transaction(async (tx) => {
    const s = await tx.query.students.findFirst({ where: eq(students.id, id) });
    if (!s) throw AppError.notFound('Student');
    if (s.status === 'left') throw AppError.unprocessable('Student has already left');
    if (body.leftOn < s.joiningDate)
      throw AppError.badRequest('Leaving date cannot be before the joining date');

    const open = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.studentId, id), isNull(enrollments.effectiveTo)));
    const latestStart = open.reduce((m, e) => (e.effectiveFrom > m ? e.effectiveFrom : m), '');
    if (open.length && body.leftOn < latestStart) {
      throw AppError.badRequest(
        `Leaving date cannot be before their latest batch started (${latestStart})`,
      );
    }
    if (open.length)
      await tx
        .update(enrollments)
        .set({ effectiveTo: body.leftOn })
        .where(and(eq(enrollments.studentId, id), isNull(enrollments.effectiveTo)));
    await tx
      .delete(makeupSessions)
      .where(and(eq(makeupSessions.studentId, id), gt(makeupSessions.date, body.leftOn)));
    await tx
      .update(students)
      .set({ status: 'left', leftOn: body.leftOn, leftReason: body.reason })
      .where(eq(students.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'student.left',
        entityType: 'student',
        entityId: id,
        metadata: body,
      },
      tx,
    );
    return open.map((e) => e.batchId);
  });
  for (const batchId of leftBatchIds)
    notifyInBackground(() => noticeStudentLeft(id, batchId, body.leftOn));

  ok(res, await getStudentDetail(id));
});

// ─── Makeups (one-off reschedules) ───────────────────────────────────────────

const MakeupBody = z.object({
  batchId: zId,
  date: zIsoDate,
  missedDate: zIsoDate.nullable().optional(),
  reason: zOptionalText(500),
});

/**
 * One-off session in another batch/day.
 *  - Admins: any batch, approved immediately.
 *  - Coaches (their own students): only in batches they coach, and it waits for an admin.
 */
studentsRouter.post('/:id/makeups', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(MakeupBody, req.body);
  const user = currentUser(req);
  await assertStudentAccess(user, id);

  const s = await db.query.students.findFirst({ where: eq(students.id, id) });
  if (!s) throw AppError.notFound('Student');
  if (s.status === 'left') throw AppError.unprocessable('Student has left the academy');

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, body.batchId) });
  if (!batch?.isActive) throw AppError.unprocessable('Selected batch is not active');
  if (!batch.weekdays.includes(isoWeekday(body.date))) {
    throw AppError.unprocessable(`${batch.name} does not run on that day`);
  }
  if (body.date < s.joiningDate)
    throw AppError.unprocessable('Makeup date is before the student joined');
  const admin = user.role === 'admin';
  if (!admin && batch.coachId !== user.id) {
    throw AppError.forbidden(
      'You can book makeups only in your own batches. Ask an admin to book another coach’s batch.',
    );
  }
  await assertNotCancelled(batch.id, body.date);

  // A previously rejected request for the same session can be asked for again.
  await db
    .delete(makeupSessions)
    .where(
      and(
        eq(makeupSessions.studentId, id),
        eq(makeupSessions.batchId, body.batchId),
        eq(makeupSessions.date, body.date),
        eq(makeupSessions.status, 'rejected'),
      ),
    );
  const [makeup] = await db
    .insert(makeupSessions)
    .values({
      studentId: id,
      ...body,
      missedDate: body.missedDate ?? null,
      createdById: user.id,
      status: admin ? 'approved' : 'pending',
      reviewedById: admin ? user.id : null,
      reviewedAt: admin ? new Date() : null,
    })
    .returning();
  await audit({
    ...auditCtx(req),
    action: admin ? 'student.makeup_booked' : 'student.makeup_requested',
    entityType: 'student',
    entityId: id,
    metadata: body,
  });
  if (admin) {
    notifyInBackground(() => noticeMakeupBooked(id, body.batchId, body.date, user.id));
  } else {
    notifyInBackground(() =>
      notifyAdmins({
        title: 'Makeup request',
        body: `${s.fullName} → ${batch.name} ${onDay(body.date)} · requested by ${user.name}`,
        link: '/makeups',
        tag: 'makeups',
      }),
    );
  }
  created(res, makeup);
});

studentsRouter.delete('/:id/makeups/:makeupId', async (req, res) => {
  const { id, makeupId } = parse(z.object({ id: zId, makeupId: zId }), req.params);
  await assertStudentAccess(currentUser(req), id);
  const [deleted] = await db
    .delete(makeupSessions)
    .where(and(eq(makeupSessions.id, makeupId), eq(makeupSessions.studentId, id)))
    .returning();
  if (!deleted) throw AppError.notFound('Makeup session');
  await audit({
    ...auditCtx(req),
    action: 'student.makeup_cancelled',
    entityType: 'student',
    entityId: id,
    metadata: { date: deleted.date, batchId: deleted.batchId },
  });
  noContent(res);
});

// ─── Admin: rejoin after leaving ─────────────────────────────────────────────

const RejoinBody = z.object({
  rejoinDate: zIsoDate,
  batches: BatchList,
  reason: zOptionalText(500),
});

/**
 * Re-activates a student who left, in one or more batches. Each batch's billing starts afresh
 * from the rejoin date (its own monthly day); earlier invoices are untouched.
 */
studentsRouter.post('/:id/rejoin', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(RejoinBody, req.body);
  const actor = currentUser(req);

  await db.transaction(async (tx) => {
    const [s] = await tx.select().from(students).where(eq(students.id, id)).for('update');
    if (!s) throw AppError.notFound('Student');
    if (s.status !== 'left') throw AppError.unprocessable('Only students who have left can rejoin');
    if (s.leftOn && body.rejoinDate <= s.leftOn) {
      throw AppError.badRequest(`Rejoin date must be after the leaving date (${s.leftOn})`);
    }
    await tx
      .update(students)
      .set({ status: 'active', leftOn: null, leftReason: null })
      .where(eq(students.id, id));
    for (const b of body.batches) {
      await joinBatch(tx, {
        ...b,
        studentId: id,
        effectiveFrom: body.rejoinDate,
        reason: body.reason ?? 'Rejoined',
        actorId: actor.id,
      });
    }
    await audit(
      {
        ...auditCtx(req),
        action: 'student.rejoined',
        entityType: 'student',
        entityId: id,
        metadata: {
          rejoinDate: body.rejoinDate,
          batchIds: body.batches.map((b) => b.batchId),
          previousLeftOn: s.leftOn,
        },
      },
      tx,
    );
  });

  await billOnAcceptance(id);
  notifyInBackground(() => noticeStudentJoined(id));
  ok(res, await getStudentDetail(id));
});

// ─── Admin: delete a record created by mistake ───────────────────────────────

/**
 * Hard-deletes a student only when nothing depends on them yet (no invoices, attendance or
 * feedback) — e.g. a duplicate entry. Otherwise the student must be marked as left.
 */
studentsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await db.transaction(async (tx) => {
    const [s] = await tx.select().from(students).where(eq(students.id, id)).for('update');
    if (!s) throw AppError.notFound('Student');
    const [inv, att, fb] = await Promise.all([
      tx.$count(invoices, eq(invoices.studentId, id)),
      tx.$count(studentAttendance, eq(studentAttendance.studentId, id)),
      tx.$count(weeklyFeedback, eq(weeklyFeedback.studentId, id)),
    ]);
    if (inv + att + fb > 0) {
      throw AppError.unprocessable(
        'This student already has invoices, attendance or feedback, so the record must be kept. Mark them as left instead.',
        { invoices: inv, attendance: att, feedback: fb },
      );
    }
    await tx.delete(students).where(eq(students.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'student.deleted',
        entityType: 'student',
        entityId: id,
        metadata: { code: s.code, fullName: s.fullName },
      },
      tx,
    );
  });
  noContent(res);
});
