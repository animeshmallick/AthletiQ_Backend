/**
 * Skill tracking. Each sport has skill areas (Footwork, Serve…) holding skills, and a level
 * ladder (Foundation → … → Elite). The batch's main coach assesses every student once a month,
 * rating each skill 1–5; the student's level follows the latest assessment's average.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { batches, sports } from './academy.js';
import { students } from './students.js';
import { users } from './users.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const skillAreas = pgTable(
  'skill_areas',
  {
    id: id(),
    sportId: uuid()
      .notNull()
      .references(() => sports.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    position: smallint().notNull(),
    /** Retired areas keep their history but are no longer assessed. */
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [index('skill_areas_sport_idx').on(t.sportId, t.position)],
);

export const skills = pgTable(
  'skills',
  {
    id: id(),
    areaId: uuid()
      .notNull()
      .references(() => skillAreas.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** What "good" looks like, shown to coaches while rating. */
    description: text(),
    position: smallint().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [index('skills_area_idx').on(t.areaId, t.position)],
);

/** A rung of a sport's ladder, reached when the assessment average is at least `minScore`. */
export const sportLevels = pgTable(
  'sport_levels',
  {
    id: id(),
    sportId: uuid()
      .notNull()
      .references(() => sports.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Minimum average rating × 100 (e.g. 250 = 2.5). */
    minScore: smallint().notNull(),
    position: smallint().notNull(),
    ...timestamps,
  },
  (t) => [
    index('sport_levels_sport_idx').on(t.sportId, t.position),
    check('sport_levels_min_chk', sql`${t.minScore} between 100 and 500`),
  ],
);

/** One student's monthly assessment in one batch (by that batch's coach). */
export const skillAssessments = pgTable(
  'skill_assessments',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    sportId: uuid()
      .notNull()
      .references(() => sports.id, { onDelete: 'restrict' }),
    batchId: uuid()
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** First day of the month assessed. */
    month: date({ mode: 'string' }).notNull(),
    /** Average of the ratings × 100. */
    average: smallint().notNull(),
    /** The level this average reached (a snapshot, so later ladder edits don't rewrite history). */
    levelName: text(),
    levelPosition: smallint(),
    comment: text(),
    goals: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('skill_assessments_student_batch_month_uq').on(t.studentId, t.batchId, t.month),
    index('skill_assessments_batch_month_idx').on(t.batchId, t.month),
    check('skill_assessments_month_chk', sql`extract(day from ${t.month}) = 1`),
  ],
);

export const skillRatings = pgTable(
  'skill_ratings',
  {
    assessmentId: uuid()
      .notNull()
      .references(() => skillAssessments.id, { onDelete: 'cascade' }),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: 'restrict' }),
    rating: smallint().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assessmentId, t.skillId] }),
    index('skill_ratings_skill_idx').on(t.skillId),
    check('skill_ratings_rating_chk', sql`${t.rating} between 1 and 5`),
  ],
);

/** Optional student photo (a small JPEG/PNG, resized on the device before upload). */
export const studentPhotos = pgTable('student_photos', {
  studentId: uuid()
    .primaryKey()
    .references(() => students.id, { onDelete: 'cascade' }),
  mime: text().notNull(),
  data: bytea().notNull(),
  updatedAt: tz().notNull().defaultNow(),
});

/** A private link that opens a student's latest report without signing in. */
export const reportLinks = pgTable(
  'report_links',
  {
    id: id(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token; the token itself is only shown once. */
    tokenHash: text().notNull(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tz().notNull(),
    revokedAt: tz(),
    views: integer().notNull().default(0),
    lastViewedAt: tz(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('report_links_token_uq').on(t.tokenHash),
    index('report_links_student_idx').on(t.studentId),
  ],
);
