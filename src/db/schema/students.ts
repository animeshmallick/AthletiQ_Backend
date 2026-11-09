import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { gender, id, studentStatus, timestamps, tz } from './_shared.js';
import { batches } from './academy.js';
import { users } from './users.js';

/** Registration numbers: 1001, 1002, … in the order students are added. */
export const studentRegistrationSeq = pgSequence('student_registration_seq', { startWith: 1001 });

export const students = pgTable(
  'students',
  {
    id: id(),
    /** Human-friendly code, e.g. ATQ-0042. */
    code: text().notNull(),
    /**
     * Registration number (1001…). Shown only on the student's profile; parents type it to open
     * a shared report or invoice, so it works like a simple PIN.
     */
    registrationNo: integer()
      .notNull()
      .default(sql`nextval('student_registration_seq')`),
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
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('students_code_uq').on(t.code),
    uniqueIndex('students_registration_no_uq').on(t.registrationNo),
    index('students_status_idx').on(t.status),
    index('students_name_idx').on(sql`lower(${t.fullName})`),
  ],
);

/**
 * A student's membership of one batch, over time. A student can be in several batches at once
 * (one open row per batch). Each membership is billed on its own: the batch's fee plan, with this
 * row's custom fee / discount, in monthly cycles anchored on `billingAnchorDate` (default: the
 * day they joined the batch). Moving to another batch closes this row and opens a new one that
 * keeps the same billing day.
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
    /** ISO weekdays the student attends: always every day the batch runs (kept in step with it). */
    trainingDays: smallint().array().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    /** Inclusive last day; null while current. */
    effectiveTo: date({ mode: 'string' }),
    reason: text(),
    /** Replaces the batch plan's monthly fee for this student when set (paise). */
    customMonthlyFee: integer(),
    /** Flat monthly discount after the plan / custom fee (paise). */
    monthlyDiscount: integer().notNull().default(0),
    /**
     * Prepaid: the first invoice is issued on this date (acceptance); cycles that started before
     * it are never billed (e.g. settled before the move, or outside the system).
     */
    billingStartsOn: date({ mode: 'string' }).notNull(),
    /** Day the monthly cycles are anchored on. Null means `effectiveFrom`. */
    billingAnchorDate: date({ mode: 'string' }),
    /** Added to local cycle numbers so a continued billing run keeps counting. */
    cycleOffset: integer().notNull().default(0),
    /**
     * Highest cycle that cost nothing (free plan, or fully discounted): no invoice is created for
     * those, but they count as billed so a later fee never back-bills them.
     */
    lastFreeCycle: integer().notNull().default(0),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('enrollments_student_idx').on(t.studentId, t.effectiveFrom),
    index('enrollments_batch_idx').on(t.batchId),
    uniqueIndex('enrollments_one_open_per_batch_uq')
      .on(t.studentId, t.batchId)
      .where(sql`${t.effectiveTo} is null`),
    check(
      'enrollments_custom_fee_chk',
      sql`${t.customMonthlyFee} is null or ${t.customMonthlyFee} >= 0`,
    ),
    check('enrollments_discount_chk', sql`${t.monthlyDiscount} >= 0`),
    check(
      'enrollments_range_chk',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** One-off reschedule: the student attends another batch's session on a specific date. */
export const makeupStatus = pgEnum('makeup_status', ['pending', 'approved', 'rejected']);

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
    /** Coach requests wait for an admin; admin bookings are approved immediately. */
    status: makeupStatus().notNull().default('approved'),
    reviewedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tz(),
    reviewNote: text(),
    ...timestamps,
  },
  (t) => [
    index('makeup_status_idx').on(t.status),
    uniqueIndex('makeup_student_batch_date_uq').on(t.studentId, t.batchId, t.date),
    index('makeup_batch_date_idx').on(t.batchId, t.date),
  ],
);

/** Monotonic counter for student codes. */
export const counters = pgTable('counters', {
  key: text().primaryKey(),
  value: integer().notNull().default(0),
});
