import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { batches } from './academy.js';
import { users } from './users.js';

/**
 * reschedule  one regular session moved to another day and/or time (`originalDate` → `date`).
 *             A same-day time change has `originalDate = date`.
 * extra       an additional one-off session on a day the batch doesn't run (e.g. to make up a
 *             cancelled one).
 */
export const sessionChangeKind = pgEnum('session_change_kind', ['reschedule', 'extra']);

/**
 * pending    waits for an admin (coach asked with less than 24 hours' notice).
 * approved   in effect: the session runs on `date` at `startTime`–`endTime`.
 * rejected   turned down by an admin.
 * cancelled  withdrawn / reverted before the session started.
 * expired    still pending when the session was due to start.
 */
export const sessionChangeStatus = pgEnum('session_change_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
]);

/**
 * Changes to a batch's regular timetable. A moved or extra session is identified by its actual
 * date (batch + date), like every regular session, so attendance, check-ins, lesson plans and
 * cancellations all work on it unchanged. The new day must be one the batch doesn't normally run,
 * so (batch, date) always names exactly one session.
 */
export const sessionChanges = pgTable(
  'session_changes',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    kind: sessionChangeKind().notNull(),
    /** The regular session being moved (reschedule only). */
    originalDate: date({ mode: 'string' }),
    /** The day the session actually runs. */
    date: date({ mode: 'string' }).notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
    status: sessionChangeStatus().notNull().default('pending'),
    reason: text(),
    requestedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tz(),
    reviewNote: text(),
    ...timestamps,
  },
  (t) => [
    // One live (pending or in-effect) session per batch per day…
    uniqueIndex('session_changes_batch_date_uq')
      .on(t.batchId, t.date)
      .where(sql`${t.status} in ('pending', 'approved')`),
    // …and a regular session can only be moved once at a time.
    uniqueIndex('session_changes_batch_original_uq')
      .on(t.batchId, t.originalDate)
      .where(sql`${t.status} in ('pending', 'approved') and ${t.originalDate} is not null`),
    index('session_changes_date_idx').on(t.date),
    index('session_changes_status_idx').on(t.status),
    check(
      'session_changes_kind_chk',
      sql`(${t.kind} = 'extra' and ${t.originalDate} is null) or (${t.kind} = 'reschedule' and ${t.originalDate} is not null)`,
    ),
    check('session_changes_time_chk', sql`${t.endTime} > ${t.startTime}`),
  ],
);
