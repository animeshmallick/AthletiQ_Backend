import { and, asc, count, eq, isNull, ne, sql, type SQL, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, feePlans, locations, sports, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizeDayTimes, timesOn, type DayTimes, type Timed } from '../../lib/batch-times.js';
import { todayInAppTz } from '../../lib/dates.js';
import { created, ok } from '../../lib/http.js';
import {
  parse,
  patchOf,
  zBoolQuery,
  zId,
  zIdParam,
  zIsoDate,
  zName,
  zTime,
  zWeekdays,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { coveringNowOrLater, myCoverage } from '../substitutions/coverage.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { openForBatch } from '../cycles/cycles.js';
import { batchInsights } from './insights.js';
import { currentMembers, expectedRoster } from './roster.js';
import { noticeBatchAssigned, noticeBatchChanged } from '../push/coach-notices.js';
import { notifyInBackground } from '../push/push.service.js';

export const batchesRouter = Router();

const coach = alias(users, 'coach');

const memberCounts = () =>
  db
    .select({ batchId: enrollments.batchId, n: count().as('n') })
    .from(enrollments)
    .where(isNull(enrollments.effectiveTo))
    .groupBy(enrollments.batchId)
    .as('members');

function batchSelect(members: ReturnType<typeof memberCounts>) {
  return {
    id: batches.id,
    name: batches.name,
    weekdays: batches.weekdays,
    startTime: batches.startTime,
    endTime: batches.endTime,
    dayTimes: batches.dayTimes,
    capacity: batches.capacity,
    coachFeedback: batches.coachFeedback,
    isActive: batches.isActive,
    /** Course length in months (null: not set up yet). Target = days a week × 4 × months. */
    courseMonths: batches.courseMonths,
    createdAt: batches.createdAt,
    sport: { id: sports.id, name: sports.name },
    feePlan: {
      id: feePlans.id,
      name: feePlans.name,
      monthlyFee: feePlans.monthlyFee,
      daysPerWeek: feePlans.daysPerWeek,
    },
    coach: { id: coach.id, name: coach.name, phone: coach.phone },
    location: {
      id: locations.id,
      name: locations.name,
      latitude: locations.latitude,
      longitude: locations.longitude,
      radiusMeters: locations.radiusMeters,
    },
    memberCount: sql<number>`coalesce(${members.n}, 0)::int`,
  };
}

const ListQuery = z.object({
  active: zBoolQuery,
  coachId: zId.optional(),
  locationId: zId.optional(),
});

batchesRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  // Coaches: own batches plus any they cover (now or upcoming) as a substitute.
  if (!isAdmin(user)) filters.push(or(eq(batches.coachId, user.id), coveringNowOrLater(user.id))!);
  else if (q.coachId) filters.push(eq(batches.coachId, q.coachId));
  if (q.locationId) filters.push(eq(batches.locationId, q.locationId));
  if (q.active !== undefined) filters.push(eq(batches.isActive, q.active));

  const members = memberCounts();
  const rows = await db
    .select(batchSelect(members))
    .from(batches)
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
    .leftJoin(members, eq(members.batchId, batches.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(batches.startTime), asc(batches.name));
  if (isAdmin(user)) return ok(res, rows);
  // Mark batches the coach only covers as a substitute, with the days they cover.
  const coverage = await myCoverage(user.id);
  ok(
    res,
    rows.map((r) => ({
      ...r,
      substitution: r.coach.id === user.id ? null : (coverage.get(r.id) ?? null),
    })),
  );
});

batchesRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertBatchAccess(currentUser(req), id);
  const members = memberCounts();
  const [row] = await db
    .select(batchSelect(members))
    .from(batches)
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
    .leftJoin(members, eq(members.batchId, batches.id))
    .where(eq(batches.id, id));
  ok(res, { ...row, members: await currentMembers(id) });
});

/**
 * The batch details page: students with attendance, fees, level and tenure; attendance trend,
 * sessions, coach punctuality and skills; fee totals for admins only.
 */
batchesRouter.get('/:id/insights', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const b = await assertBatchAccess(user, id);
  const plan = await db.query.feePlans.findFirst({ where: eq(feePlans.id, b.feePlanId) });
  ok(
    res,
    await batchInsights(
      { ...b, feePlanMonthlyFee: plan?.monthlyFee ?? 0 },
      { includeMoney: isAdmin(user), hideFees: !isAdmin(user) && b.coachId !== user.id },
    ),
  );
});

/** Students expected at the session on `date` (defaults to today). */
batchesRouter.get('/:id/roster', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { date } = parse(z.object({ date: zIsoDate.optional() }), req.query);
  const day = date ?? todayInAppTz();
  await assertBatchAccess(currentUser(req), id, { on: day });
  ok(res, { date: day, students: await expectedRoster(id, day) });
});

// ─── Admin mutations ─────────────────────────────────────────────────────────

const DayTimesBody = z.partialRecord(
  z.enum(['1', '2', '3', '4', '5', '6', '7']),
  z.object({ start: zTime, end: zTime }),
);

const BatchBody = z.object({
  name: zName,
  coachId: zId,
  locationId: zId,
  weekdays: zWeekdays,
  startTime: zTime,
  endTime: zTime,
  /** Days that run at a different time: ISO weekday ("1"…"7") → start/end. */
  dayTimes: DayTimesBody.default({}),
  capacity: z.number().int().min(1).max(1000),
  sportId: zId,
  feePlanId: zId,
  /** Coach feedback (weekly reports, assessments, plan reminders). Only free batches can opt out. */
  coachFeedback: z.boolean().default(true),
  isActive: z.boolean().default(true),
  /**
   * Course length in whole months. Fixed, like the training days, while the batch has students
   * (their cycles run on it); it can't be removed once set.
   */
  courseMonths: z.number().int().min(1).max(60).optional(),
});

const DAY_NAMES = [
  '',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Checks every day's time and returns only the overrides that matter. */
function timings(weekdays: number[], startTime: string, endTime: string, dayTimes: DayTimes) {
  if (endTime <= startTime) throw AppError.badRequest('End time must be after start time');
  const out = normalizeDayTimes(dayTimes, weekdays, startTime, endTime);
  for (const [d, t] of Object.entries(out)) {
    if (t!.end <= t!.start)
      throw new AppError(
        'VALIDATION_ERROR',
        `${DAY_NAMES[Number(d)]}: end time must be after start time`,
        {
          fields: [{ path: `dayTimes.${d}`, message: 'End must be after start' }],
        },
      );
  }
  return out;
}

async function assertCoach(coachId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, coachId) });
  if (!u?.roles.includes('coach')) throw AppError.unprocessable('Selected coach does not exist');
  if (u.status === 'disabled') throw AppError.unprocessable('Selected coach is disabled');
}

async function assertSport(sportId: string) {
  const s = await db.query.sports.findFirst({ where: eq(sports.id, sportId) });
  if (!s) throw AppError.unprocessable('Selected sport does not exist');
  if (!s.isActive) throw AppError.unprocessable('Selected sport is inactive');
}

/** The batch's fee plan: active, and priced for as many days a week as the batch runs. */
async function assertPlanFits(feePlanId: string, weekdays: number[]) {
  const p = await db.query.feePlans.findFirst({ where: eq(feePlans.id, feePlanId) });
  if (!p) throw AppError.unprocessable('Selected fee plan does not exist');
  if (!p.isActive) throw AppError.unprocessable('Selected fee plan is inactive');
  // The free plan fits a batch on any number of days.
  if (!p.isSystem && p.daysPerWeek !== weekdays.length)
    throw new AppError(
      'VALIDATION_ERROR',
      `${p.name} is for ${p.daysPerWeek} day${p.daysPerWeek === 1 ? '' : 's'} a week, but the batch runs ${weekdays.length}.`,
      { fields: [{ path: 'feePlanId', message: `Pick a ${weekdays.length}-day plan` }] },
    );
  return p;
}

async function assertLocation(locationId: string) {
  const l = await db.query.locations.findFirst({ where: eq(locations.id, locationId) });
  if (!l) throw AppError.unprocessable('Selected location does not exist');
  if (!l.isActive) throw AppError.unprocessable('Selected location is inactive');
}

/**
 * A coach with two batches at the same time: refused at different places, and at the same place
 * only after the admin confirms (they can run both together there).
 */
async function assertCoachFree(
  b: Timed & { coachId: string; locationId: string; weekdays: number[] },
  confirm: boolean,
  exceptId?: string,
) {
  const others = await db
    .select()
    .from(batches)
    .where(
      and(
        eq(batches.coachId, b.coachId),
        eq(batches.isActive, true),
        exceptId ? ne(batches.id, exceptId) : undefined,
      ),
    );
  const hm = (t: string) => t.slice(0, 5);
  const clashing = others.flatMap((o) => {
    const day = b.weekdays.find((d) => {
      if (!o.weekdays.includes(d)) return false;
      const [x, y] = [timesOn(b, d), timesOn(o, d)];
      return hm(x.startTime) < hm(y.endTime) && hm(y.startTime) < hm(x.endTime);
    });
    return day ? [{ name: o.name, day: DAY_NAMES[day]!, here: o.locationId === b.locationId }] : [];
  });
  const list = (l: typeof clashing) => l.map((c) => `${c.name} (${c.day})`).join(', ');
  const away = clashing.filter((c) => !c.here);
  if (away.length)
    throw AppError.unprocessable(
      `The coach already has ${list(away)} at that time at another location.`,
    );
  if (clashing.length && !confirm)
    throw AppError.conflict(
      `The coach already has ${list(clashing)} at that time at this location.`,
      { warnings: [{ code: 'coach-busy' }] },
    );
}

/** The admin saw the warning and goes ahead. */
const Confirm = { confirm: z.boolean().optional() };

/** New batches must say how long their course is. */
const CreateBody = BatchBody.extend({
  ...Confirm,
  courseMonths: z.number({ error: 'Choose the course length in months' }).int().min(1).max(60),
});

batchesRouter.post('/', requireAdmin, async (req, res) => {
  const { confirm, ...body } = parse(CreateBody, req.body);
  body.dayTimes = timings(body.weekdays, body.startTime, body.endTime, body.dayTimes);
  const [, , , plan] = await Promise.all([
    assertCoach(body.coachId),
    assertLocation(body.locationId),
    assertSport(body.sportId),
    assertPlanFits(body.feePlanId, body.weekdays),
  ]);
  if (body.isActive) await assertCoachFree(body, !!confirm);
  // Paying students always get feedback; only a free batch can be attendance-only.
  if (plan.monthlyFee > 0) body.coachFeedback = true;
  const [batch] = await db
    .insert(batches)
    .values({ ...body, courseSetOn: body.courseMonths ? todayInAppTz() : null })
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'batch.created',
    entityType: 'batch',
    entityId: batch!.id,
    metadata: body,
  });
  notifyInBackground(() => noticeBatchAssigned(batch!.id));
  created(res, batch);
});

batchesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { confirm, ...body } = parse(patchOf(BatchBody).extend(Confirm), req.body);
  const existing = await assertBatchAccess(currentUser(req), id);

  // Timing changes apply from today on: past check-ins keep the time they were scheduled for.
  if (body.startTime || body.endTime || body.weekdays || body.dayTimes)
    body.dayTimes = timings(
      body.weekdays ?? existing.weekdays,
      body.startTime ?? existing.startTime,
      body.endTime ?? existing.endTime,
      body.dayTimes ?? existing.dayTimes,
    );
  if (body.coachId && body.coachId !== existing.coachId) await assertCoach(body.coachId);
  if (body.locationId && body.locationId !== existing.locationId)
    await assertLocation(body.locationId);
  if (body.sportId && body.sportId !== existing.sportId) await assertSport(body.sportId);
  const weekdays = body.weekdays ?? existing.weekdays;
  const daysChanged =
    !!body.weekdays && [...body.weekdays].sort().join() !== [...existing.weekdays].sort().join();
  if (body.feePlanId || daysChanged || body.coachFeedback === false) {
    const plan = await assertPlanFits(body.feePlanId ?? existing.feePlanId, weekdays);
    // Paying students always get feedback; only a free batch can be attendance-only.
    if (plan.monthlyFee > 0) body.coachFeedback = true;
  }

  // Only when this edit changes who, where or when: an old overlap doesn't block other edits.
  const next = { ...existing, ...body };
  const slot = (b: typeof existing) =>
    JSON.stringify([
      b.isActive,
      b.coachId,
      b.locationId,
      [...b.weekdays].sort().map((d) => {
        const t = timesOn(b, d);
        return [d, t.startTime.slice(0, 5), t.endTime.slice(0, 5)];
      }),
    ]);
  if (next.isActive && slot(next) !== slot(existing)) await assertCoachFree(next, !!confirm, id);

  const members = await currentMembers(id);
  const [heldRow] = await db
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.plannedMoveToId, id), isNull(enrollments.effectiveTo)));
  const held = heldRow?.n ?? 0;
  const seats = members.length + held;
  if (body.capacity !== undefined && body.capacity < seats) {
    throw AppError.unprocessable(
      `This batch has ${seats} students${held ? ` (${held} moving in)` : ''}. Capacity can't be less than that.`,
      { fields: [{ path: 'capacity', message: `At least ${seats}` }] },
    );
  }
  const courseChanged =
    body.courseMonths !== undefined && body.courseMonths !== existing.courseMonths;
  if (existing.courseMonths !== null && members.length && (courseChanged || daysChanged)) {
    throw AppError.unprocessable(
      'Training days and course length can’t change while students are in a cycle. Open a new batch instead.',
    );
  }
  if (body.isActive === false && held) {
    throw AppError.unprocessable('Students are due to move into this batch. Change that first.');
  }
  if (body.isActive === false && members.length) {
    throw AppError.unprocessable('Move all students out of this batch before deactivating it.');
  }

  const today = todayInAppTz();
  const batch = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(batches)
      .set({ ...body, ...(courseChanged ? { courseSetOn: today } : {}) })
      .where(eq(batches.id, id))
      .returning();
    // Students train on every day the batch runs.
    if (daysChanged)
      await tx
        .update(enrollments)
        .set({ trainingDays: [...weekdays].sort((a, b) => a - b) })
        .where(and(eq(enrollments.batchId, id), isNull(enrollments.effectiveTo)));
    // First set-up: everyone starts round 1 with their current billing month.
    if (courseChanged && existing.courseMonths === null) await openForBatch(tx, id, today);
    return updated!;
  });
  await audit({
    ...auditCtx(req),
    action:
      body.coachId && body.coachId !== existing.coachId
        ? 'batch.coach_reassigned'
        : 'batch.updated',
    entityType: 'batch',
    entityId: id,
    metadata: {
      changes: body,
      previousCoachId: existing.coachId,
      previousFeePlanId: body.feePlanId ? existing.feePlanId : undefined,
      studentsAffected: daysChanged || body.feePlanId ? members.length : 0,
    },
  });
  notifyInBackground(() =>
    body.coachId && body.coachId !== existing.coachId
      ? noticeBatchAssigned(id, existing.coachId)
      : noticeBatchChanged(existing, id, { studentsUpdated: daysChanged && members.length > 0 }),
  );
  ok(res, batch);
});
