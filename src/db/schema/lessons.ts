import { sql } from 'drizzle-orm';
import {
  boolean,
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

/**
 * The blocks of a session, in order, e.g. Warm-up 10 min, Ball drills 20 min, Cool down 5 min.
 * Each coach keeps one library of stages and events, used across all their batches.
 */
export const lessonStages = pgTable(
  'lesson_stages',
  {
    id: id(),
    /** Batch the item was first made for (history only; the library belongs to the coach). */
    batchId: uuid().references(() => batches.id, { onDelete: 'set null' }),
    /** Whose library it is. */
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    color: text(),
    /** Default length of this block in minutes. */
    durationMin: integer(),
    sortOrder: integer().notNull().default(0),
    isArchived: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lesson_stages_coach_name_uq').on(t.coachId, sql`lower(${t.name})`),
    index('lesson_stages_coach_idx').on(t.coachId, t.sortOrder),
  ],
);

/** Drills / skills / games the coach runs, picked into a session's blocks. Coach-wide library. */
export const lessonEvents = pgTable(
  'lesson_events',
  {
    id: id(),
    /** Batch the item was first made for (history only; the library belongs to the coach). */
    batchId: uuid().references(() => batches.id, { onDelete: 'set null' }),
    /** Whose library it is. */
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    sortOrder: integer().notNull().default(0),
    isArchived: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lesson_events_coach_name_uq').on(t.coachId, sql`lower(${t.name})`),
    index('lesson_events_coach_idx').on(t.coachId, t.sortOrder),
  ],
);

/**
 * A day's plan for one batch. `stageIds` / `eventIds` fix the grid's column and row order at the
 * time of planning, so archiving a stage later never breaks historical plans.
 */
export const lessonPlans = pgTable(
  'lesson_plans',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    date: date({ mode: 'string' }).notNull(),
    stageIds: uuid().array().notNull(),
    eventIds: uuid().array().notNull(),
    /** Minutes per stage for this session (stage id → minutes); falls back to the stage default. */
    durations: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** One line on what this session is about. */
    focus: text(),
    notes: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lesson_plans_batch_date_uq').on(t.batchId, t.date),
    index('lesson_plans_coach_date_idx').on(t.coachId, t.date),
  ],
);

/** One cell of the grid: what the coach will do/teach for (event × stage). */
export const lessonPlanCells = pgTable(
  'lesson_plan_cells',
  {
    id: id(),
    planId: uuid()
      .notNull()
      .references(() => lessonPlans.id, { onDelete: 'cascade' }),
    eventId: uuid()
      .notNull()
      .references(() => lessonEvents.id, { onDelete: 'restrict' }),
    stageId: uuid()
      .notNull()
      .references(() => lessonStages.id, { onDelete: 'restrict' }),
    content: text().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('lesson_plan_cells_uq').on(t.planId, t.eventId, t.stageId)],
);

/** A whole session plan saved under a name ("Footwork day") to apply to any session in a tap. */
export const lessonPlanTemplates = pgTable(
  'lesson_plan_templates',
  {
    id: id(),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    focus: text(),
    notes: text(),
    stageIds: uuid().array().notNull(),
    eventIds: uuid().array().notNull(),
    durations: jsonb().$type<Record<string, number>>().notNull().default({}),
    cells: jsonb()
      .$type<{ eventId: string; stageId: string; content: string }[]>()
      .notNull()
      .default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('lesson_plan_templates_coach_name_uq').on(t.coachId, sql`lower(${t.name})`)],
);
