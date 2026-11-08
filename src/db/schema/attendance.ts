import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { attendanceStatus, id, timestamps, tz } from './_shared.js';
import { batches, locations } from './academy.js';
import { students } from './students.js';
import { users } from './users.js';

/** Student attendance for one batch session (batch + date). */
export const studentAttendance = pgTable(
  'student_attendance',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    date: date({ mode: 'string' }).notNull(),
    status: attendanceStatus().notNull(),
    isMakeup: boolean().notNull().default(false),
    note: text(),
    markedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('student_attendance_session_uq').on(t.batchId, t.studentId, t.date),
    index('student_attendance_student_date_idx').on(t.studentId, t.date),
    index('student_attendance_batch_date_idx').on(t.batchId, t.date),
  ],
);

/**
 * Coach self-attendance per batch session with GPS evidence. Readings outside the geofence are
 * accepted but flagged for admin review (GPS can be unreliable).
 */
export const coachSessions = pgTable(
  'coach_sessions',
  {
    id: id(),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    /** Snapshot of the batch location at check-in time. */
    locationId: uuid()
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    date: date({ mode: 'string' }).notNull(),

    checkInAt: tz().notNull(),
    checkInLat: doublePrecision().notNull(),
    checkInLng: doublePrecision().notNull(),
    checkInAccuracyM: doublePrecision(),
    checkInDistanceM: integer().notNull(),
    checkInWithinFence: boolean().notNull(),

    checkOutAt: tz(),
    checkOutLat: doublePrecision(),
    checkOutLng: doublePrecision(),
    checkOutAccuracyM: doublePrecision(),
    checkOutDistanceM: integer(),
    checkOutWithinFence: boolean(),

    note: text(),
    /** Admin review of flagged sessions. */
    reviewedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tz(),
    reviewNote: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('coach_sessions_coach_batch_date_uq').on(t.coachId, t.batchId, t.date),
    index('coach_sessions_date_idx').on(t.date),
    index('coach_sessions_flagged_idx')
      .on(t.date)
      .where(sql`${t.checkInWithinFence} = false or ${t.checkOutWithinFence} = false`),
  ],
);
