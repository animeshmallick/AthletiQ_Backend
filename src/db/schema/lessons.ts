import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './_shared.js';
import { batches } from './academy.js';
import { users } from './users.js';

// ─── One lesson plan per batch ────────────────────────────────────────────────

/**
 * A batch's lesson plan: every session of the batch follows it. Blocks (timed parts, in order)
 * hold drills (in order). The blocks add up to the session length.
 */
export const batchPlans = pgTable(
  'batch_plans',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    /** One line on what the plan works on. */
    focus: text(),
    notes: text(),
    updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('batch_plans_batch_uq').on(t.batchId)],
);

export const batchPlanBlocks = pgTable(
  'batch_plan_blocks',
  {
    id: id(),
    planId: uuid()
      .notNull()
      .references(() => batchPlans.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    color: text(),
    minutes: integer().notNull(),
    sortOrder: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    index('batch_plan_blocks_plan_idx').on(t.planId, t.sortOrder),
    check('batch_plan_blocks_minutes_chk', sql`${t.minutes} between 1 and 600`),
  ],
);

export const batchPlanDrills = pgTable(
  'batch_plan_drills',
  {
    id: id(),
    blockId: uuid()
      .notNull()
      .references(() => batchPlanBlocks.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Optional time for the drill within its block. */
    minutes: integer(),
    /** Reps / sets, free text (e.g. "3 × 10"). */
    reps: text(),
    note: text(),
    sortOrder: integer().notNull(),
    ...timestamps,
  },
  (t) => [index('batch_plan_drills_block_idx').on(t.blockId, t.sortOrder)],
);

/** A block as stored in a session's own copy of the plan. */
export interface SessionBlock {
  name: string;
  color: string | null;
  minutes: number;
  drills: { name: string; minutes: number | null; reps: string | null; note: string | null }[];
}

/**
 * One session's own version of the plan, when the coach adjusts that day (skip a drill, change
 * minutes, add a note). Without one, the session follows the batch plan.
 */
export const sessionPlans = pgTable(
  'session_plans',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    date: date({ mode: 'string' }).notNull(),
    coachId: uuid().references(() => users.id, { onDelete: 'set null' }),
    blocks: jsonb().$type<SessionBlock[]>().notNull(),
    note: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex('session_plans_batch_date_uq').on(t.batchId, t.date)],
);
