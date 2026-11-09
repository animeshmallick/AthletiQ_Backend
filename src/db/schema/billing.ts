import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, invoiceStatus, paymentMode, paymentStatus, timestamps, tz } from './_shared.js';
import { batches, feePlans } from './academy.js';
import { enrollments, students } from './students.js';
import { users } from './users.js';

/**
 * One invoice per batch membership (enrollment) per billing cycle. Pricing and ownership (plan, batch,
 * coach) are snapshotted at generation so later changes never rewrite history.
 * Amounts are integer paise.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    number: text().notNull(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    /** The batch membership this invoice bills. */
    enrollmentId: uuid()
      .notNull()
      .references(() => enrollments.id, { onDelete: 'restrict' }),
    /** 1-based cycle index of the enrollment's billing run. */
    cycleNumber: integer().notNull(),
    periodStart: date({ mode: 'string' }).notNull(),
    periodEnd: date({ mode: 'string' }).notNull(),
    issueDate: date({ mode: 'string' }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),

    feePlanId: uuid().references(() => feePlans.id, { onDelete: 'set null' }),
    feePlanName: text().notNull(),
    batchId: uuid().references(() => batches.id, { onDelete: 'set null' }),
    batchName: text(),
    coachId: uuid().references(() => users.id, { onDelete: 'set null' }),

    baseAmount: integer().notNull(),
    discountAmount: integer().notNull().default(0),
    totalAmount: integer().notNull(),

    status: invoiceStatus().notNull().default('due'),
    paidAt: tz(),
    notes: text(),
    cancelledReason: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invoices_number_uq').on(t.number),
    uniqueIndex('invoices_enrollment_cycle_uq').on(t.enrollmentId, t.cycleNumber),
    index('invoices_student_idx').on(t.studentId),
    index('invoices_status_due_idx').on(t.status, t.dueDate),
    index('invoices_issue_date_idx').on(t.issueDate),
    index('invoices_coach_idx').on(t.coachId),
    check('invoices_amounts_chk', sql`${t.totalAmount} >= 0 and ${t.discountAmount} >= 0`),
  ],
);

/**
 * Payment records. Reverting (marked by mistake) or refunding keeps the row with its new status,
 * so the full money trail is preserved. At most one `completed` payment may exist per invoice.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amount: integer().notNull(),
    mode: paymentMode().notNull(),
    reference: text(),
    paidOn: date({ mode: 'string' }).notNull(),
    note: text(),
    status: paymentStatus().notNull().default('completed'),
    recordedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reversedById: uuid().references(() => users.id, { onDelete: 'restrict' }),
    reversedAt: tz(),
    reversalReason: text(),
    ...timestamps,
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_paid_on_idx').on(t.paidOn),
    uniqueIndex('payments_one_completed_per_invoice_uq')
      .on(t.invoiceId)
      .where(sql`${t.status} = 'completed'`),
    check('payments_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** Gap-free invoice numbering per Indian financial year (row-locked on increment). */
export const invoiceSequences = pgTable('invoice_sequences', {
  financialYear: text().primaryKey(),
  lastValue: integer().notNull().default(0),
});
