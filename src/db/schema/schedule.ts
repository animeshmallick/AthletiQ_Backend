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
import { id, timestamps } from './_shared.js';
import { batches } from './academy.js';
import { users } from './users.js';

/**
 * reschedule  one regular session moved to another day and/or time (`originalDate` → `date`).
 *             A same-day time change has `originalDate = date`.
 * extra       an additional one-off session on a day the batch doesn't run (e.g. to make up a
 *             cancelled one).
 */
export const sessionChangeKind = pgEnum('session_change_kind', ['reschedule', 'extra']);

/** approved: in effect. cancelled: undone, or replaced by a later change. */
export const sessionChangeStatus = pgEnum('session_change_status', ['approved', 'cancelled']);

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
    status: sessionChangeStatus().notNull().default('approved'),
    reason: text(),
    requestedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    // One session in effect per batch per day…
    uniqueIndex('session_changes_batch_date_uq')
      .on(t.batchId, t.date)
      .where(sql`${t.status} = 'approved'`),
    // …and a regular session can only be moved once at a time.
    uniqueIndex('session_changes_batch_original_uq')
      .on(t.batchId, t.originalDate)
      .where(sql`${t.status} = 'approved' and ${t.originalDate} is not null`),
    index('session_changes_date_idx').on(t.date),
    index('session_changes_status_idx').on(t.status),
    check(
      'session_changes_kind_chk',
      sql`(${t.kind} = 'extra' and ${t.originalDate} is null) or (${t.kind} = 'reschedule' and ${t.originalDate} is not null)`,
    ),
    check('session_changes_time_chk', sql`${t.endTime} > ${t.startTime}`),
  ],
);
