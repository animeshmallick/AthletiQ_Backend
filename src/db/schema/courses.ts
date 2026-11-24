import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { batches } from './academy.js';
import { invoices } from './billing.js';
import { enrollments, students } from './students.js';
import { users } from './users.js';

/**
 * active     counting sessions towards the course target.
 * awaiting   target reached: membership ended on `completedOn`, seat held, waiting for an admin.
 * readmitted continued in the same batch (a new membership and round).
 * moved      continued in another batch.
 * left       left the batch (after completion, or mid-course).
 */
export const courseRoundStatus = pgEnum('course_round_status', [
  'active',
  'awaiting',
  'readmitted',
  'moved',
  'left',
]);

/** One money change made when a round completed, kept so it can be undone exactly. */
export interface RoundAdjustment {
  invoiceId: string;
  /**
   * cancelled: issued for a month after completion, unpaid → cancelled.
   * reduced:   the extension month, unpaid → cut to the sessions used.
   * credited:  paid → its unused part became a credit.
   */
  action: 'cancelled' | 'reduced' | 'credited';
  /** Money returned to the student by this step (paise). */
  amount: number;
  before: { status: string; discountAmount: number; totalAmount: number; paidAt: string | null };
  after: { status: string; discountAmount: number; totalAmount: number };
  /** Credits this step created (status held). */
  createdCreditIds: string[];
  /** Credits that had been applied to the invoice and were taken back (status held). */
  releasedCreditIds: string[];
}

/**
 * A pass through a batch's course: `target` sessions (sessions per month × course months)
 * attended from `startedOn`. Rounds are per membership; re-admission starts a new membership and
 * round. `historical` rounds were replayed from attendance when the course was first set up.
 */
export const courseRounds = pgTable(
  'course_rounds',
  {
    id: id(),
    enrollmentId: uuid()
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    roundNo: smallint().notNull(),
    /** First day counted. */
    startedOn: date({ mode: 'string' }).notNull(),
    status: courseRoundStatus().notNull().default('active'),
    /** Day of the session that reached the target (or the day they left mid-course). */
    completedOn: date({ mode: 'string' }),
    /** Snapshots at completion. */
    attended: smallint(),
    target: smallint(),
    historical: boolean().notNull().default(false),
    adjustments: jsonb().$type<RoundAdjustment[]>().notNull().default([]),
    decidedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: tz(),
    note: text(),
    /** The membership a re-admission / move continued with. */
    nextEnrollmentId: uuid().references(() => enrollments.id, { onDelete: 'set null' }),
    /** Left automatically after 30 days without a decision. */
    autoLeft: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('course_rounds_one_open_uq')
      .on(t.enrollmentId)
      .where(sql`${t.status} in ('active', 'awaiting')`),
    index('course_rounds_student_idx').on(t.studentId),
    index('course_rounds_batch_status_idx').on(t.batchId, t.status),
  ],
);

export const creditKind = pgEnum('credit_kind', ['course_unused', 'shortfall']);

/**
 * held        waiting for a course decision (where it goes).
 * assigned    will be taken off the next invoice(s) of `enrollmentId`.
 * applied     taken off `appliedInvoiceId`.
 * refund_due  owed back to the family (settled outside, then recorded).
 * refunded    paid back.
 * forfeited   not returned (admin's choice when the student left).
 * void        undone (the completion it came from was undone).
 */
export const creditStatus = pgEnum('credit_status', [
  'held',
  'assigned',
  'applied',
  'refund_due',
  'refunded',
  'forfeited',
  'void',
]);

/** Money owed to a student that comes off a later invoice (or is refunded). Integer paise. */
export const studentCredits = pgTable(
  'student_credits',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    kind: creditKind().notNull(),
    amount: integer().notNull(),
    status: creditStatus().notNull(),
    /** Membership whose next invoice takes it (assigned), or where it came from. */
    enrollmentId: uuid().references(() => enrollments.id, { onDelete: 'set null' }),
    roundId: uuid().references(() => courseRounds.id, { onDelete: 'set null' }),
    /** The invoice it came from (course_unused). */
    sourceInvoiceId: uuid().references(() => invoices.id, { onDelete: 'set null' }),
    appliedInvoiceId: uuid().references(() => invoices.id, { onDelete: 'set null' }),
    reason: text().notNull(),
    settledById: uuid().references(() => users.id, { onDelete: 'set null' }),
    settledAt: tz(),
    note: text(),
    ...timestamps,
  },
  (t) => [
    index('student_credits_student_idx').on(t.studentId),
    index('student_credits_status_idx').on(t.status),
    index('student_credits_enrollment_idx').on(t.enrollmentId, t.status),
    check('student_credits_amount_chk', sql`${t.amount} > 0`),
  ],
);

/**
 * at_risk      month in progress: sessions held + still scheduled < sessions per month.
 * short        month over with fewer sessions held than sessions per month (waits for an admin).
 * recovered    was at risk, then enough sessions were scheduled (e.g. an extra session).
 * discounted   resolved: pro-rata amount credited (off the next unpaid invoice).
 * extra_added  resolved: an extra session was scheduled to make up for it.
 * dismissed    resolved without action (with a reason).
 */
export const shortfallStatus = pgEnum('shortfall_status', [
  'at_risk',
  'short',
  'recovered',
  'discounted',
  'extra_added',
  'dismissed',
]);

/** A billing month in which a student is (or was) offered fewer sessions than they pay for. */
export const sessionShortfalls = pgTable(
  'session_shortfalls',
  {
    id: id(),
    enrollmentId: uuid()
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    /** Global cycle number of the membership's billing month. */
    cycleNumber: integer().notNull(),
    periodStart: date({ mode: 'string' }).notNull(),
    periodEnd: date({ mode: 'string' }).notNull(),
    /** Sessions per month. */
    target: smallint().notNull(),
    /** Sessions held so far (not cancelled, up to today). */
    held: smallint().notNull(),
    /** Sessions still scheduled in the month (0 once it is over). */
    remaining: smallint().notNull(),
    status: shortfallStatus().notNull(),
    /** Discount: amount credited, and the invoice it came off (if one was unpaid). */
    amount: integer(),
    creditId: uuid().references(() => studentCredits.id, { onDelete: 'set null' }),
    invoiceId: uuid().references(() => invoices.id, { onDelete: 'set null' }),
    /** Extra session that makes up for it. */
    sessionChangeId: uuid(),
    resolvedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: tz(),
    note: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('session_shortfalls_cycle_uq').on(t.enrollmentId, t.cycleNumber),
    index('session_shortfalls_status_idx').on(t.status),
    index('session_shortfalls_batch_idx').on(t.batchId, t.status),
  ],
);
