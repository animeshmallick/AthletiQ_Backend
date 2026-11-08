import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { feedbackStatus, id, timestamps, tz } from './_shared.js';
import { batches } from './academy.js';
import { students } from './students.js';
import { users } from './users.js';

export interface AttendanceSummarySnapshot {
  scheduled: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  unmarked: number;
}

/**
 * Weekly (Mon–Sun) feedback for one student. Answers are stored as JSON keyed by the template's
 * field ids, together with the template key + version they were written against, so editing the
 * template in code never corrupts historical reports.
 */
export const weeklyFeedback = pgTable(
  'weekly_feedback',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    weekStart: date({ mode: 'string' }).notNull(),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    answers: jsonb().$type<Record<string, unknown>>().notNull(),
    attendanceSummary: jsonb().$type<AttendanceSummarySnapshot>(),
    status: feedbackStatus().notNull().default('draft'),
    submittedAt: tz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('weekly_feedback_student_week_uq').on(t.studentId, t.weekStart),
    index('weekly_feedback_coach_week_idx').on(t.coachId, t.weekStart),
  ],
);
