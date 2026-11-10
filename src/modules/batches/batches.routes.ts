import { and, asc, count, eq, isNull, sql, type SQL, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, feePlans, locations, sports, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizeDayTimes, type DayTimes } from '../../lib/batch-times.js';
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
      { includeMoney: isAdmin(user) },
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

batchesRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(BatchBody, req.body);
  body.dayTimes = timings(body.weekdays, body.startTime, body.endTime, body.dayTimes);
  const [, , , plan] = await Promise.all([
    assertCoach(body.coachId),
    assertLocation(body.locationId),
    assertSport(body.sportId),
    assertPlanFits(body.feePlanId, body.weekdays),
  ]);
  // Paying students always get feedback; only a free batch can be attendance-only.
  if (plan.monthlyFee > 0) body.coachFeedback = true;
  const [batch] = await db.insert(batches).values(body).returning();
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
  const body = parse(patchOf(BatchBody), req.body);
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

  const members = await currentMembers(id);
  if (body.capacity !== undefined && body.capacity < members.length) {
    throw AppError.unprocessable(
      `This batch has ${members.length} students. Capacity can't be less than that.`,
      { fields: [{ path: 'capacity', message: `At least ${members.length}` }] },
    );
  }
  if (body.isActive === false && members.length) {
    throw AppError.unprocessable('Move all students out of this batch before deactivating it.');
  }

  const batch = await db.transaction(async (tx) => {
    const [updated] = await tx.update(batches).set(body).where(eq(batches.id, id)).returning();
    // Students train on every day the batch runs.
    if (daysChanged)
      await tx
        .update(enrollments)
        .set({ trainingDays: [...weekdays].sort((a, b) => a - b) })
        .where(and(eq(enrollments.batchId, id), isNull(enrollments.effectiveTo)));
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
