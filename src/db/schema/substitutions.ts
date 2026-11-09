import { sql } from 'drizzle-orm';
import { check, date, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { batches } from './academy.js';
import { users } from './users.js';

export const substitutionStatus = pgEnum('substitution_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

/**
 * A substitute coach covering a batch for a date range. While approved, the substitute can run
 * the batch's sessions on those days (check-in, attendance, lesson plans) — nothing to do with
 * fees or income, which stay with the batch's own coach. Only one approved substitute per batch
 * per day; requests from coaches wait for an admin.
 */
export const batchSubstitutions = pgTable(
  'batch_substitutions',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    substituteCoachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The batch's own coach when the substitution was set up. */
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fromDate: date({ mode: 'string' }).notNull(),
    toDate: date({ mode: 'string' }).notNull(),
    reason: text(),
    status: substitutionStatus().notNull().default('pending'),
    requestedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tz(),
    reviewNote: text(),
    ...timestamps,
  },
  (t) => [
    index('batch_subs_batch_idx').on(t.batchId, t.fromDate),
    index('batch_subs_substitute_idx').on(t.substituteCoachId, t.fromDate),
    index('batch_subs_status_idx').on(t.status),
    check('batch_subs_range_chk', sql`${t.toDate} >= ${t.fromDate}`),
    check('batch_subs_not_self_chk', sql`${t.substituteCoachId} <> ${t.coachId}`),
  ],
);
