import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './_shared.js';
import { batches } from './academy.js';
import { enrollments, students } from './students.js';

/** active: running. completed: reached its last day. exited: the student left before that. */
export const cycleStatus = pgEnum('cycle_status', ['active', 'completed', 'exited']);

/**
 * One round of a batch's course for one membership: `months` of the student's own billing months.
 * The membership stays open across rounds; a renewal only opens the next row (never an invoice).
 */
export const batchCycles = pgTable(
  'batch_cycles',
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
    /** First billing month (1-based, of the membership's billing anchor). */
    firstMonth: integer().notNull(),
    months: smallint().notNull(),
    /** Sessions owed per month (days a week × 4), as of the start. */
    perMonth: smallint().notNull(),
    startsOn: date({ mode: 'string' }).notNull(),
    endsOn: date({ mode: 'string' }).notNull(),
    status: cycleStatus().notNull().default('active'),
    /** Last day: `endsOn`, or the day they left. */
    endedOn: date({ mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('batch_cycles_round_uq').on(t.enrollmentId, t.roundNo),
    uniqueIndex('batch_cycles_one_active_uq')
      .on(t.enrollmentId)
      .where(sql`${t.status} = 'active'`),
    index('batch_cycles_student_idx').on(t.studentId),
    index('batch_cycles_batch_idx').on(t.batchId, t.status, t.endsOn),
    check('batch_cycles_range_chk', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);
