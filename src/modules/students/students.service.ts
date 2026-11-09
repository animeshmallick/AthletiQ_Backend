import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  counters,
  enrollments,
  feePlans,
  invoices,
  locations,
  makeupSessions,
  students,
  users,
} from '../../db/schema/index.js';
import { addDays, minDate, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { cycleFor, nextUpcomingCycle } from '../billing/cycle.js';
import { AppError } from '../../lib/errors.js';
import type { Paise } from '../../lib/money.js';

/** Monthly amount a student is billed: custom fee (or plan fee) minus discount, never negative. */
export function effectiveMonthlyFee(
  planFee: Paise,
  customFee: Paise | null,
  discount: Paise,
): { base: Paise; discount: Paise; total: Paise } {
  const base = customFee ?? planFee;
  const applied = Math.min(discount, base);
  return { base, discount: applied, total: base - applied };
}

export async function nextStudentCode(tx: DbOrTx): Promise<string> {
  const [row] = await tx
    .insert(counters)
    .values({ key: 'student_code', value: 1 })
    .onConflictDoUpdate({ target: counters.key, set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  return `ATQ-${String(row!.value).padStart(4, '0')}`;
}

/**
 * A batch a student can join: it exists, is active, has room, and the student isn't already in
 * it. `excludeStudentId` leaves that student out of the capacity count (e.g. while moving).
 */
export async function assertJoinable(
  batchId: string,
  tx: DbOrTx = db,
  opts: { studentId?: string; excludeStudentId?: string } = {},
) {
  const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) throw AppError.unprocessable('Selected batch does not exist');
  if (!batch.isActive) throw AppError.unprocessable(`${batch.name} is inactive`);
  if (opts.studentId) {
    const [already] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.batchId, batchId),
          eq(enrollments.studentId, opts.studentId),
          isNull(enrollments.effectiveTo),
        ),
      )
      .limit(1);
    if (already) throw AppError.conflict(`Already in ${batch.name}`);
  }
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.batchId, batchId),
        isNull(enrollments.effectiveTo),
        opts.excludeStudentId ? ne(enrollments.studentId, opts.excludeStudentId) : undefined,
      ),
    );
  if (n >= batch.capacity)
    throw AppError.unprocessable(`${batch.name} is full (capacity ${batch.capacity})`);
  return batch;
}

export async function assertActivePlan(feePlanId: string, tx: DbOrTx = db) {
  const plan = await tx.query.feePlans.findFirst({ where: eq(feePlans.id, feePlanId) });
  if (!plan) throw AppError.unprocessable('Selected fee plan does not exist');
  if (!plan.isActive) throw AppError.unprocessable('Selected fee plan is inactive');
  return plan;
}

/** A batch to join, with this student's own price adjustments. */
export interface JoinInput {
  batchId: string;
  customMonthlyFee?: number | null;
  monthlyDiscount?: number;
}

/**
 * Adds a student to a batch from `effectiveFrom` (a new membership with its own billing run:
 * cycles anchored on that day, the first invoice issued at acceptance).
 */
export async function joinBatch(
  tx: DbOrTx,
  input: JoinInput & {
    studentId: string;
    effectiveFrom: IsoDate;
    reason: string | null;
    actorId: string;
    billingStartsOn?: IsoDate;
  },
) {
  const batch = await assertJoinable(input.batchId, tx, { studentId: input.studentId });
  const [row] = await tx
    .insert(enrollments)
    .values({
      studentId: input.studentId,
      batchId: batch.id,
      trainingDays: [...batch.weekdays].sort((x, y) => x - y),
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      customMonthlyFee: input.customMonthlyFee ?? null,
      monthlyDiscount: input.monthlyDiscount ?? 0,
      billingStartsOn: input.billingStartsOn ?? minDate(todayInAppTz(), input.effectiveFrom),
      createdById: input.actorId,
    })
    .returning();
  return { enrollment: row!, batch };
}

/** First day of the cycle (on `anchor`'s day of month) that starts on or after `date`. */
export function nextCycleStart(anchor: IsoDate, date: IsoDate): IsoDate {
  for (let k = 1; k < 1300; k++) {
    const start = cycleFor(anchor, k).periodStart;
    if (start >= date) return start;
  }
  return date;
}

/**
 * Moves a membership to another batch from `effectiveFrom`. The old membership ends the day
 * before; the new one keeps the same billing day and continues with the next cycle, priced by the
 * new batch's plan (the month in progress was already billed by the old batch). Custom fee and
 * discount carry over unless given.
 */
export async function moveEnrollment(
  tx: DbOrTx,
  input: {
    studentId: string;
    enrollmentId: string;
    toBatchId: string;
    effectiveFrom: IsoDate;
    reason: string | null;
    actorId: string;
    customMonthlyFee?: number | null;
    monthlyDiscount?: number;
  },
) {
  const [current] = await tx
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.id, input.enrollmentId), eq(enrollments.studentId, input.studentId)))
    .for('update');
  if (!current) throw AppError.notFound('Batch membership');
  if (current.effectiveTo !== null) throw AppError.unprocessable('That membership has ended');
  if (current.batchId === input.toBatchId)
    throw AppError.unprocessable('Pick a different batch to move to');
  if (input.effectiveFrom <= current.effectiveFrom) {
    throw AppError.unprocessable(
      `The move date must be after ${current.effectiveFrom}, when this membership started`,
    );
  }
  const batch = await assertJoinable(input.toBatchId, tx, { studentId: input.studentId });

  await tx
    .update(enrollments)
    .set({ effectiveTo: addDays(input.effectiveFrom, -1) })
    .where(eq(enrollments.id, current.id));
  const anchor = current.billingAnchorDate ?? current.effectiveFrom;
  const [next] = await tx
    .insert(enrollments)
    .values({
      studentId: input.studentId,
      batchId: batch.id,
      trainingDays: [...batch.weekdays].sort((x, y) => x - y),
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      customMonthlyFee:
        input.customMonthlyFee !== undefined ? input.customMonthlyFee : current.customMonthlyFee,
      monthlyDiscount: input.monthlyDiscount ?? current.monthlyDiscount,
      billingAnchorDate: anchor,
      cycleOffset: current.cycleOffset,
      // The old batch billed every cycle that started before the move.
      billingStartsOn: nextCycleStart(anchor, input.effectiveFrom),
      createdById: input.actorId,
    })
    .returning();
  return { previous: current, current: next!, batch };
}

export interface CreateStudentInput {
  fullName: string;
  dateOfBirth?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  guardianName?: string | null;
  phone: string;
  alternatePhone?: string | null;
  email?: string | null;
  address?: string | null;
  medicalNotes?: string | null;
  notes?: string | null;
  joiningDate: IsoDate;
  /** One or more batches; each is billed on its own plan. */
  batches: JoinInput[];
  /** Acceptance date (first invoices); defaults to the earlier of today and the joining date. */
  billingStartsOn?: IsoDate;
}

/** Registers a student in one or more batches. Billing for each starts from the joining date. */
export async function createStudent(tx: DbOrTx, input: CreateStudentInput, actorId: string) {
  if (!input.batches.length) throw AppError.badRequest('Pick at least one batch');
  if (new Set(input.batches.map((b) => b.batchId)).size !== input.batches.length)
    throw AppError.badRequest('Each batch can be picked once');
  const code = await nextStudentCode(tx);

  const [s] = await tx
    .insert(students)
    .values({
      code,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      guardianName: input.guardianName ?? null,
      phone: input.phone,
      alternatePhone: input.alternatePhone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      medicalNotes: input.medicalNotes ?? null,
      notes: input.notes ?? null,
      joiningDate: input.joiningDate,
      createdById: actorId,
    })
    .returning();

  for (const b of input.batches) {
    await joinBatch(tx, {
      ...b,
      studentId: s!.id,
      effectiveFrom: input.joiningDate,
      reason: 'Initial enrollment',
      actorId,
      billingStartsOn: input.billingStartsOn,
    });
  }
  return s!;
}

export async function getStudentDetail(studentId: string) {
  const [student] = await db.select().from(students).where(eq(students.id, studentId));
  if (!student) throw AppError.notFound('Student');

  const today = todayInAppTz();
  const lastCycle = db
    .select({
      enrollmentId: invoices.enrollmentId,
      last: sql<number>`max(${invoices.cycleNumber})`.as('last'),
    })
    .from(invoices)
    .where(eq(invoices.studentId, studentId))
    .groupBy(invoices.enrollmentId)
    .as('last_cycle');
  const [history, upcomingMakeups, invoiceSummary] = await Promise.all([
    db
      .select({
        id: enrollments.id,
        batchId: batches.id,
        batchName: batches.name,
        coachId: users.id,
        coachName: users.name,
        locationName: locations.name,
        startTime: batches.startTime,
        endTime: batches.endTime,
        weekdays: batches.weekdays,
        trainingDays: enrollments.trainingDays,
        effectiveFrom: enrollments.effectiveFrom,
        effectiveTo: enrollments.effectiveTo,
        reason: enrollments.reason,
        customMonthlyFee: enrollments.customMonthlyFee,
        monthlyDiscount: enrollments.monthlyDiscount,
        billingAnchorDate: enrollments.billingAnchorDate,
        billingStartsOn: enrollments.billingStartsOn,
        cycleOffset: enrollments.cycleOffset,
        lastInvoicedCycle: sql<number>`coalesce(${lastCycle.last}, 0)::int`,
        plan: {
          id: feePlans.id,
          name: feePlans.name,
          monthlyFee: feePlans.monthlyFee,
          daysPerWeek: feePlans.daysPerWeek,
        },
      })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .innerJoin(users, eq(users.id, batches.coachId))
      .innerJoin(locations, eq(locations.id, batches.locationId))
      .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
      .leftJoin(lastCycle, eq(lastCycle.enrollmentId, enrollments.id))
      .where(eq(enrollments.studentId, studentId))
      .orderBy(desc(enrollments.effectiveFrom)),
    db
      .select({
        id: makeupSessions.id,
        date: makeupSessions.date,
        missedDate: makeupSessions.missedDate,
        reason: makeupSessions.reason,
        batchId: batches.id,
        batchName: batches.name,
        startTime: batches.startTime,
        status: makeupSessions.status,
      })
      .from(makeupSessions)
      .innerJoin(batches, eq(batches.id, makeupSessions.batchId))
      .where(
        and(
          eq(makeupSessions.studentId, studentId),
          gt(makeupSessions.date, addDays(today, -1)),
          ne(makeupSessions.status, 'rejected'),
        ),
      )
      .orderBy(asc(makeupSessions.date)),
    db
      .select({
        outstanding: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due'), 0)::int`,
        overdue: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due' and ${invoices.dueDate} < ${today}), 0)::int`,
        paid: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'paid'), 0)::int`,
        invoiceCount: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(eq(invoices.studentId, studentId)),
  ]);

  // Current batch memberships, each with its own price and next invoice.
  const memberships = history
    .filter((h) => h.effectiveTo === null)
    .sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom))
    .map((h) => {
      const next = nextUpcomingCycle(
        {
          joiningDate: h.effectiveFrom,
          billingAnchorDate: h.billingAnchorDate,
          cycleOffset: h.cycleOffset,
          billingStartsOn: h.billingStartsOn,
          leftOn: h.effectiveTo,
          lastInvoicedCycle: h.lastInvoicedCycle,
        },
        today,
      );
      return {
        enrollmentId: h.id,
        batchId: h.batchId,
        batchName: h.batchName,
        coachId: h.coachId,
        coachName: h.coachName,
        locationName: h.locationName,
        weekdays: h.weekdays,
        startTime: h.startTime,
        endTime: h.endTime,
        since: h.effectiveFrom,
        plan: h.plan,
        customMonthlyFee: h.customMonthlyFee,
        monthlyDiscount: h.monthlyDiscount,
        fee: effectiveMonthlyFee(h.plan.monthlyFee, h.customMonthlyFee, h.monthlyDiscount),
        /** Day of the month invoices are issued for this batch. */
        billingDay: Number((h.billingAnchorDate ?? h.effectiveFrom).slice(8, 10)),
        nextInvoice: next
          ? { issueDate: next.issueDate, periodStart: next.periodStart, periodEnd: next.periodEnd }
          : null,
      };
    });
  const sum = (k: 'base' | 'discount' | 'total') => memberships.reduce((n, m) => n + m.fee[k], 0);

  return {
    ...student,
    memberships,
    /** Monthly total across all current batches. */
    effectiveFee: { base: sum('base'), discount: sum('discount'), total: sum('total') },
    enrollmentHistory: history.map(
      ({
        billingAnchorDate: _a,
        billingStartsOn: _b,
        cycleOffset: _c,
        lastInvoicedCycle: _l,
        ...h
      }) => h,
    ),
    upcomingMakeups,
    billing: invoiceSummary[0] ?? { outstanding: 0, overdue: 0, paid: 0, invoiceCount: 0 },
  };
}
