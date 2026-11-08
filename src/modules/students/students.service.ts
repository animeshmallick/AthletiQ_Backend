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

/** Validates the target batch and that training days fall on days the batch runs. */
export async function assertEnrollable(
  batchId: string,
  trainingDays: number[],
  tx: DbOrTx = db,
  /** Student already counted in this batch (e.g. changing training days) — excluded from capacity. */
  excludeStudentId?: string,
) {
  const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) throw AppError.unprocessable('Selected batch does not exist');
  if (!batch.isActive) throw AppError.unprocessable('Selected batch is inactive');
  const runs = new Set(batch.weekdays);
  if (trainingDays.some((d) => !runs.has(d))) {
    throw new AppError('VALIDATION_ERROR', 'Training days must be days the batch runs', {
      fields: [{ path: 'trainingDays', message: 'Pick only days the batch runs' }],
    });
  }
  if (batch.capacity !== null) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.batchId, batchId),
          isNull(enrollments.effectiveTo),
          excludeStudentId ? ne(enrollments.studentId, excludeStudentId) : undefined,
        ),
      );
    if (n >= batch.capacity)
      throw AppError.unprocessable(`${batch.name} is full (capacity ${batch.capacity})`);
  }
  return batch;
}

export async function assertActivePlan(feePlanId: string, tx: DbOrTx = db) {
  const plan = await tx.query.feePlans.findFirst({ where: eq(feePlans.id, feePlanId) });
  if (!plan) throw AppError.unprocessable('Selected fee plan does not exist');
  if (!plan.isActive) throw AppError.unprocessable('Selected fee plan is inactive');
  return plan;
}

/**
 * Moves a student to a batch (or changes training days) from `effectiveFrom`. The current
 * enrollment is closed the day before; if it started the same day it is replaced instead.
 */
export async function transferStudent(
  tx: DbOrTx,
  input: {
    studentId: string;
    batchId: string;
    trainingDays: number[];
    effectiveFrom: IsoDate;
    reason: string | null;
    actorId: string;
  },
) {
  const [current] = await tx
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.studentId, input.studentId), isNull(enrollments.effectiveTo)))
    .for('update');

  if (!current) throw AppError.unprocessable('Student has no active enrollment');
  if (input.effectiveFrom < current.effectiveFrom) {
    throw AppError.unprocessable(
      `Transfer date cannot be before the current enrollment started (${current.effectiveFrom})`,
    );
  }

  await assertEnrollable(input.batchId, input.trainingDays, tx, input.studentId);

  if (input.effectiveFrom === current.effectiveFrom) {
    await tx.delete(enrollments).where(eq(enrollments.id, current.id));
  } else {
    await tx
      .update(enrollments)
      .set({ effectiveTo: addDays(input.effectiveFrom, -1) })
      .where(eq(enrollments.id, current.id));
  }

  const [next] = await tx
    .insert(enrollments)
    .values({
      studentId: input.studentId,
      batchId: input.batchId,
      trainingDays: input.trainingDays,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      createdById: input.actorId,
    })
    .returning();
  return { previous: current, current: next! };
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
  feePlanId: string;
  customMonthlyFee?: number | null;
  monthlyDiscount?: number;
  joiningDate: IsoDate;
  batchId: string;
  trainingDays: number[];
  billingStartsOn?: IsoDate;
}

/** Registers a student with their initial batch enrollment. Billing starts from the joining date. */
export async function createStudent(tx: DbOrTx, input: CreateStudentInput, actorId: string) {
  await assertActivePlan(input.feePlanId, tx);
  await assertEnrollable(input.batchId, input.trainingDays, tx);
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
      feePlanId: input.feePlanId,
      customMonthlyFee: input.customMonthlyFee ?? null,
      monthlyDiscount: input.monthlyDiscount ?? 0,
      billingStartsOn: input.billingStartsOn ?? minDate(todayInAppTz(), input.joiningDate),
      createdById: actorId,
    })
    .returning();

  await tx.insert(enrollments).values({
    studentId: s!.id,
    batchId: input.batchId,
    trainingDays: input.trainingDays,
    effectiveFrom: input.joiningDate,
    reason: 'Initial enrollment',
    createdById: actorId,
  });
  return s!;
}

export async function getStudentDetail(studentId: string) {
  const [row] = await db
    .select({ student: students, plan: feePlans })
    .from(students)
    .innerJoin(feePlans, eq(feePlans.id, students.feePlanId))
    .where(eq(students.id, studentId));
  if (!row) throw AppError.notFound('Student');

  const today = todayInAppTz();
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
        trainingDays: enrollments.trainingDays,
        effectiveFrom: enrollments.effectiveFrom,
        effectiveTo: enrollments.effectiveTo,
        reason: enrollments.reason,
      })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .innerJoin(users, eq(users.id, batches.coachId))
      .innerJoin(locations, eq(locations.id, batches.locationId))
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

  const fee = effectiveMonthlyFee(
    row.plan.monthlyFee,
    row.student.customMonthlyFee,
    row.student.monthlyDiscount,
  );
  return {
    ...row.student,
    feePlan: {
      id: row.plan.id,
      name: row.plan.name,
      monthlyFee: row.plan.monthlyFee,
      daysPerWeek: row.plan.daysPerWeek,
    },
    effectiveFee: fee,
    currentEnrollment: history.find((h) => h.effectiveTo === null) ?? null,
    enrollmentHistory: history,
    upcomingMakeups,
    billing: invoiceSummary[0] ?? { outstanding: 0, overdue: 0, paid: 0, invoiceCount: 0 },
  };
}
