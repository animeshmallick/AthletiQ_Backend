import { and, asc, count, desc, eq, gt, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  feePlans,
  invoices,
  makeupSessions,
  students,
  users,
} from '../../db/schema/index.js';
import { isoWeekday, todayInAppTz } from '../../lib/dates.js';
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
  zTrainingDays,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertStudentAccess, isAdmin, studentScope } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import {
  assertActivePlan,
  createStudent,
  effectiveMonthlyFee,
  getStudentDetail,
  transferStudent,
} from './students.service.js';

export const studentsRouter = Router();

// ─── List ────────────────────────────────────────────────────────────────────

const ListQuery = zPagination.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'left']).optional(),
  batchId: zId.optional(),
  coachId: zId.optional(),
  feePlanId: zId.optional(),
  sort: z.enum(['name', 'joiningDate', 'recent']).default('name'),
});

studentsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];

  const scope = studentScope(user, students.id);
  if (scope) filters.push(scope);
  if (q.status) filters.push(eq(students.status, q.status));
  if (q.feePlanId) filters.push(eq(students.feePlanId, q.feePlanId));
  if (q.batchId) filters.push(eq(batches.id, q.batchId));
  if (q.coachId && isAdmin(user)) filters.push(eq(batches.coachId, q.coachId));
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
  const where = filters.length ? and(...filters) : undefined;
  const today = todayInAppTz();

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
    q.sort === 'joiningDate'
      ? [desc(students.joiningDate)]
      : q.sort === 'recent'
        ? [desc(students.createdAt)]
        : [asc(students.fullName)];

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
        feePlan: { id: feePlans.id, name: feePlans.name, monthlyFee: feePlans.monthlyFee },
        customMonthlyFee: students.customMonthlyFee,
        monthlyDiscount: students.monthlyDiscount,
        batch: { id: batches.id, name: batches.name },
        coach: { id: users.id, name: users.name },
        trainingDays: enrollments.trainingDays,
        outstanding: sql<number>`coalesce(${outstanding.due}, 0)::int`,
        overdue: sql<number>`coalesce(${outstanding.overdue}, 0)::int`,
      })
      .from(students)
      .innerJoin(feePlans, eq(feePlans.id, students.feePlanId))
      .leftJoin(
        enrollments,
        and(eq(enrollments.studentId, students.id), isNull(enrollments.effectiveTo)),
      )
      .leftJoin(batches, eq(batches.id, enrollments.batchId))
      .leftJoin(users, eq(users.id, batches.coachId))
      .leftJoin(outstanding, eq(outstanding.studentId, students.id))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db
      .select({ total: count() })
      .from(students)
      .leftJoin(
        enrollments,
        and(eq(enrollments.studentId, students.id), isNull(enrollments.effectiveTo)),
      )
      .leftJoin(batches, eq(batches.id, enrollments.batchId))
      .where(where),
  ]);

  ok(
    res,
    rows.map((r) => ({
      ...r,
      effectiveFee: effectiveMonthlyFee(r.feePlan.monthlyFee, r.customMonthlyFee, r.monthlyDiscount)
        .total,
    })),
    pageMeta(q.page, q.pageSize, total),
  );
});

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

const FeeFields = {
  feePlanId: zId,
  customMonthlyFee: zPaise.nullable().optional(),
  monthlyDiscount: zPaise.default(0),
};

const CreateBody = z.object({
  ...ProfileFields,
  ...FeeFields,
  joiningDate: zIsoDate,
  batchId: zId,
  trainingDays: zTrainingDays,
  /**
   * First date whose completed cycle may be invoiced. Defaults to today, so registering a student
   * with a past joining date does not back-bill months that were settled outside the system.
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
        metadata: { code: s.code, batchId: body.batchId },
      },
      tx,
    );
    return s;
  });

  created(res, await getStudentDetail(student.id));
});

const UpdateBody = z.object({ ...ProfileFields, ...FeeFields, joiningDate: zIsoDate }).partial();

studentsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(UpdateBody, req.body);

  await db.transaction(async (tx) => {
    const existing = await tx.query.students.findFirst({ where: eq(students.id, id) });
    if (!existing) throw AppError.notFound('Student');
    if (body.feePlanId && body.feePlanId !== existing.feePlanId)
      await assertActivePlan(body.feePlanId, tx);

    if (body.joiningDate && body.joiningDate !== existing.joiningDate) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(invoices)
        .where(eq(invoices.studentId, id));
      if (n > 0) {
        throw AppError.unprocessable(
          'Joining date cannot change after invoices have been generated (it anchors the billing cycle).',
        );
      }
      // Keep the initial enrollment aligned with the new joining date.
      const first = await tx.query.enrollments.findFirst({
        where: eq(enrollments.studentId, id),
        orderBy: asc(enrollments.effectiveFrom),
      });
      if (first && (first.effectiveTo === null || first.effectiveTo >= body.joiningDate)) {
        await tx
          .update(enrollments)
          .set({ effectiveFrom: body.joiningDate })
          .where(eq(enrollments.id, first.id));
      } else if (first) {
        throw AppError.unprocessable('Joining date conflicts with the enrollment history.');
      }
    }

    await tx.update(students).set(body).where(eq(students.id, id));
    const feeChanged = ['feePlanId', 'customMonthlyFee', 'monthlyDiscount'].some((k) => k in body);
    await audit(
      {
        ...auditCtx(req),
        action: feeChanged ? 'student.fee_changed' : 'student.updated',
        entityType: 'student',
        entityId: id,
        metadata: feeChanged
          ? {
              before: {
                feePlanId: existing.feePlanId,
                customMonthlyFee: existing.customMonthlyFee,
                monthlyDiscount: existing.monthlyDiscount,
              },
              changes: body,
            }
          : { changes: Object.keys(body) },
      },
      tx,
    );
  });

  ok(res, await getStudentDetail(id));
});

// ─── Admin: transfer / leave ─────────────────────────────────────────────────

const TransferBody = z.object({
  batchId: zId,
  trainingDays: zTrainingDays,
  effectiveFrom: zIsoDate,
  reason: zOptionalText(500),
});

/** Permanent move to another batch, or a change of training days, from a given date. */
studentsRouter.post('/:id/transfer', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(TransferBody, req.body);

  await db.transaction(async (tx) => {
    const s = await tx.query.students.findFirst({ where: eq(students.id, id) });
    if (!s) throw AppError.notFound('Student');
    if (s.status === 'left') throw AppError.unprocessable('Student has left the academy');
    const { previous, current } = await transferStudent(tx, {
      studentId: id,
      ...body,
      actorId: currentUser(req).id,
    });
    await audit(
      {
        ...auditCtx(req),
        action:
          previous.batchId === current.batchId
            ? 'student.training_days_changed'
            : 'student.transferred',
        entityType: 'student',
        entityId: id,
        metadata: {
          fromBatchId: previous.batchId,
          toBatchId: current.batchId,
          effectiveFrom: body.effectiveFrom,
          trainingDays: body.trainingDays,
        },
      },
      tx,
    );
  });

  ok(res, await getStudentDetail(id));
});

const LeaveBody = z.object({ leftOn: zIsoDate, reason: zOptionalText(500) });

/**
 * Marks a student as left. Cycles that complete after `leftOn` are not billed; already-issued
 * invoices are untouched. Future makeups are cancelled.
 */
studentsRouter.post('/:id/leave', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(LeaveBody, req.body);

  await db.transaction(async (tx) => {
    const s = await tx.query.students.findFirst({ where: eq(students.id, id) });
    if (!s) throw AppError.notFound('Student');
    if (s.status === 'left') throw AppError.unprocessable('Student has already left');
    if (body.leftOn < s.joiningDate)
      throw AppError.badRequest('Leaving date cannot be before the joining date');

    const [current] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.studentId, id), isNull(enrollments.effectiveTo)));
    if (current) {
      if (body.leftOn < current.effectiveFrom) {
        throw AppError.badRequest(
          `Leaving date cannot be before the current enrollment started (${current.effectiveFrom})`,
        );
      }
      await tx
        .update(enrollments)
        .set({ effectiveTo: body.leftOn })
        .where(eq(enrollments.id, current.id));
    }
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
  });

  ok(res, await getStudentDetail(id));
});

// ─── Makeups (one-off reschedules) ───────────────────────────────────────────

const MakeupBody = z.object({
  batchId: zId,
  date: zIsoDate,
  missedDate: zIsoDate.nullable().optional(),
  reason: zOptionalText(500),
});

/** Admins, or the student's current coach, can book a one-off session in any active batch. */
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

  const [makeup] = await db
    .insert(makeupSessions)
    .values({ studentId: id, ...body, missedDate: body.missedDate ?? null, createdById: user.id })
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'student.makeup_booked',
    entityType: 'student',
    entityId: id,
    metadata: body,
  });
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
