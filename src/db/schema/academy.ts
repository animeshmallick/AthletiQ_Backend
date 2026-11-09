import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DayTimes } from '../../lib/batch-times.js';
import { id, timestamps } from './_shared.js';
import { users } from './users.js';

/** Training grounds. Coaches' GPS check-ins are validated against a batch's location. */
export const locations = pgTable(
  'locations',
  {
    id: id(),
    name: text().notNull(),
    address: text(),
    latitude: doublePrecision().notNull(),
    longitude: doublePrecision().notNull(),
    radiusMeters: integer().notNull().default(200),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('locations_name_lower_uq').on(sql`lower(${t.name})`),
    check('locations_lat_chk', sql`${t.latitude} between -90 and 90`),
    check('locations_lng_chk', sql`${t.longitude} between -180 and 180`),
    check('locations_radius_chk', sql`${t.radiusMeters} between 10 and 5000`),
  ],
);

/** A sport the academy teaches. Each has its own skills and level ladder (see skills.ts). */
export const sports = pgTable(
  'sports',
  {
    id: id(),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('sports_name_lower_uq').on(sql`lower(${t.name})`)],
);

/** A recurring training group, e.g. "Morning U-12", owned by exactly one coach at one location. */
export const batches = pgTable(
  'batches',
  {
    id: id(),
    name: text().notNull(),
    coachId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    locationId: uuid()
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    /** ISO weekdays the batch runs (1 = Monday … 7 = Sunday). */
    weekdays: smallint().array().notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
    /** Days that run at a different time than the default above (ISO weekday → start/end). */
    dayTimes: jsonb().$type<DayTimes>().notNull().default({}),
    capacity: integer().notNull(),
    /**
     * The batch's price: every student in the batch is billed this plan (their enrollment can
     * add a custom fee or discount). Its days per week must match the batch's days.
     */
    feePlanId: uuid()
      .notNull()
      .references((): AnyPgColumn => feePlans.id, { onDelete: 'restrict' }),
    /** What the batch trains; decides which skills its students are assessed on. */
    sportId: uuid()
      .notNull()
      .references(() => sports.id, { onDelete: 'restrict' }),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('batches_name_lower_uq').on(sql`lower(${t.name})`),
    index('batches_coach_idx').on(t.coachId),
    index('batches_location_idx').on(t.locationId),
    index('batches_fee_plan_idx').on(t.feePlanId),
    check('batches_time_chk', sql`${t.endTime} > ${t.startTime}`),
    check('batches_weekdays_chk', sql`cardinality(${t.weekdays}) between 1 and 7`),
  ],
);

/** Monthly fee plans, typically priced by training days per week. Amounts are in paise. */
export const feePlans = pgTable(
  'fee_plans',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    daysPerWeek: smallint().notNull(),
    monthlyFee: integer().notNull(),
    isActive: boolean().notNull().default(true),
    /**
     * The built-in free plan: ₹0, fits a batch on any number of days, offered when setting up a
     * batch but not listed (or editable) on the Fee plans page. There is exactly one.
     */
    isSystem: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fee_plans_name_lower_uq').on(sql`lower(${t.name})`),
    uniqueIndex('fee_plans_one_system_uq')
      .on(t.isSystem)
      .where(sql`${t.isSystem}`),
    check('fee_plans_days_chk', sql`${t.daysPerWeek} between 1 and 7`),
    check('fee_plans_fee_chk', sql`${t.monthlyFee} >= 0`),
  ],
);
