import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { gender, id, studentStatus, timestamps } from './_shared.js';
import { batches, feePlans } from './academy.js';
import { users } from './users.js';

export const students = pgTable(
  'students',
  {
    id: id(),
    /** Human-friendly code, e.g. ATQ-0042. */
    code: text().notNull(),
    fullName: text().notNull(),
    dateOfBirth: date({ mode: 'string' }),
    gender: gender(),
    guardianName: text(),
    phone: text().notNull(),
    alternatePhone: text(),
    email: text(),
    address: text(),
    medicalNotes: text(),
    notes: text(),
    /** First day of the first billing cycle. Every cycle is anchored on this date's day-of-month. */
    joiningDate: date({ mode: 'string' }).notNull(),
    status: studentStatus().notNull().default('active'),
    /** Last day the student trained; cycles that complete after this date are not billed. */
    leftOn: date({ mode: 'string' }),
    leftReason: text(),
    feePlanId: uuid()
      .notNull()
      .references(() => feePlans.id, { onDelete: 'restrict' }),
    /** Replaces the plan's monthly fee when set (paise). */
    customMonthlyFee: integer(),
    /** Flat monthly discount applied after plan/custom fee (paise). */
    monthlyDiscount: integer().notNull().default(0),
    /**
     * Cycles that ended before this date are never auto-billed. Set to the record creation day so
     * that importing a student with a historic joining date does not back-bill old months.
     */
    billingStartsOn: date({ mode: 'string' }).notNull(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('students_code_uq').on(t.code),
    index('students_status_idx').on(t.status),
    index('students_name_idx').on(sql`lower(${t.fullName})`),
    check(
      'students_custom_fee_chk',
      sql`${t.customMonthlyFee} is null or ${t.customMonthlyFee} >= 0`,
    ),
    check('students_discount_chk', sql`${t.monthlyDiscount} >= 0`),
  ],
);

/**
 * A student's home-batch membership over time. Exactly one open row (effectiveTo is null) exists
 * for an active student; a permanent transfer closes the current row and opens a new one.
 */
export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    /** ISO weekdays this student attends within the batch (subset of the batch's weekdays). */
    trainingDays: smallint().array().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    /** Inclusive last day; null while current. */
    effectiveTo: date({ mode: 'string' }),
    reason: text(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('enrollments_student_idx').on(t.studentId, t.effectiveFrom),
    index('enrollments_batch_idx').on(t.batchId),
    uniqueIndex('enrollments_one_open_per_student_uq')
      .on(t.studentId)
      .where(sql`${t.effectiveTo} is null`),
    check(
      'enrollments_range_chk',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** One-off reschedule: the student attends another batch's session on a specific date. */
export const makeupSessions = pgTable(
  'makeup_sessions',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    date: date({ mode: 'string' }).notNull(),
    /** Optional: the regular session being made up for. */
    missedDate: date({ mode: 'string' }),
    reason: text(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('makeup_student_batch_date_uq').on(t.studentId, t.batchId, t.date),
    index('makeup_batch_date_idx').on(t.batchId, t.date),
  ],
);

/** Monotonic counter for student codes. */
export const counters = pgTable('counters', {
  key: text().primaryKey(),
  value: integer().notNull().default(0),
});
