import { timesOn } from '../../lib/batch-times.js';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  lessonEvents,
  lessonPlanCells,
  lessonPlans,
  lessonStages,
  locations,
  users,
} from '../../db/schema/index.js';
import {
  addDays,
  diffDays,
  eachDay,
  isoWeekday,
  startOfIsoWeek,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIsoDate } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { cancellationsIn } from '../attendance/cancellations.js';

/** How far ahead "needs a plan" looks, and how far back the planning streak is counted. */
const AHEAD_DAYS = 14;
const STREAK_LOOKBACK = 90;

const Query = z.object({
  from: zIsoDate,
  to: zIsoDate,
  batchId: zId.optional(),
  coachId: zId.optional(),
});

type PlanRow = {
  id: string;
  batchId: string;
  date: string;
  coachId: string;
  eventIds: string[];
  stageIds: string[];
  createdAt: Date;
  grid: number;
  filled: number;
};

type Status = 'complete' | 'partial' | 'empty' | 'unplanned';

const statusOf = (p: PlanRow | undefined): Status =>
  !p ? 'unplanned' : p.filled === 0 ? 'empty' : p.filled >= p.grid ? 'complete' : 'partial';

const ratio = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

/**
 * Planning insights for a coach's batches (or, for admins, any batch/coach): how many sessions
 * are planned and how fully, what still needs a plan in the next two weeks, weekly coverage,
 * and which drills and stages the plans lean on.
 */
export async function lessonInsights(req: Request, res: Response) {
  const user = currentUser(req);
  const q = parse(Query, req.query);
  if (q.to < q.from || diffDays(q.from, q.to) > 92)
    throw AppError.badRequest('Choose a range of up to 3 months');
  if (q.batchId) await assertBatchAccess(user, q.batchId);
  const admin = isAdmin(user);
  const today = todayInAppTz();

  const scope = await db
    .select({
      id: batches.id,
      name: batches.name,
      weekdays: batches.weekdays,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
      coachId: batches.coachId,
      coachName: users.name,
      locationId: locations.id,
      locationName: locations.name,
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(
      and(
        eq(batches.isActive, true),
        admin ? undefined : eq(batches.coachId, user.id),
        q.batchId ? eq(batches.id, q.batchId) : undefined,
        admin && q.coachId ? eq(batches.coachId, q.coachId) : undefined,
      ),
    )
    .orderBy(asc(batches.startTime), asc(batches.name));
  const ids = scope.map((b) => b.id);

  // One window covers the chosen range, the look-ahead and the streak look-back.
  const winFrom = [q.from, addDays(today, -STREAK_LOOKBACK)].sort()[0]!;
  const winTo = [q.to, addDays(today, AHEAD_DAYS - 1)].sort().at(-1)!;

  const [plans, cancelled] = await Promise.all([
    ids.length
      ? db
          .select({
            id: lessonPlans.id,
            batchId: lessonPlans.batchId,
            date: lessonPlans.date,
            coachId: lessonPlans.coachId,
            eventIds: lessonPlans.eventIds,
            stageIds: lessonPlans.stageIds,
            createdAt: lessonPlans.createdAt,
            grid: sql<number>`(cardinality(${lessonPlans.stageIds}) * cardinality(${lessonPlans.eventIds}))::int`,
            filled: sql<number>`count(${lessonPlanCells.id})::int`,
          })
          .from(lessonPlans)
          .leftJoin(lessonPlanCells, eq(lessonPlanCells.planId, lessonPlans.id))
          .where(
            and(
              inArray(lessonPlans.batchId, ids),
              gte(lessonPlans.date, winFrom),
              lte(lessonPlans.date, winTo),
            ),
          )
          .groupBy(lessonPlans.id)
      : ([] as PlanRow[]),
    cancellationsIn(ids, winFrom, winTo),
  ]);
  const planAt = new Map(plans.map((p) => [`${p.batchId}:${p.date}`, p]));

  /** Every scheduled (not cancelled) session of a batch between two dates. */
  const sessionsOf = (b: (typeof scope)[number], from: IsoDate, to: IsoDate) =>
    from > to
      ? []
      : eachDay(from, to).filter(
          (d) => b.weekdays.includes(isoWeekday(d)) && !cancelled.has(`${b.id}:${d}`),
        );

  const totals = {
    sessions: 0,
    cancelled: 0,
    planned: 0,
    complete: 0,
    missed: 0,
    upcomingUnplanned: 0,
    plannedAhead: 0,
    filledCells: 0,
    gridCells: 0,
  };
  const weeks = new Map<
    string,
    { start: string; sessions: number; planned: number; complete: number }
  >();
  const needsPlan: {
    batchId: string;
    batchName: string;
    startTime: string;
    date: string;
    status: Exclude<Status, 'complete'>;
  }[] = [];

  const batchRows = scope.map((b) => {
    const days = sessionsOf(b, q.from, q.to);
    const row = { sessions: days.length, planned: 0, complete: 0, missed: 0, filled: 0, grid: 0 };
    totals.cancelled += eachDay(q.from, q.to).filter(
      (d) => b.weekdays.includes(isoWeekday(d)) && cancelled.has(`${b.id}:${d}`),
    ).length;
    for (const d of days) {
      const p = planAt.get(`${b.id}:${d}`);
      const s = statusOf(p);
      const wk = startOfIsoWeek(d);
      const w = weeks.get(wk) ?? { start: wk, sessions: 0, planned: 0, complete: 0 };
      w.sessions++;
      weeks.set(wk, w);
      if (p) {
        row.planned++;
        w.planned++;
        row.filled += Math.min(p.filled, p.grid);
        row.grid += p.grid;
        if (todayInAppTz(p.createdAt) < d) totals.plannedAhead++;
      } else if (d < today) row.missed++;
      if (s === 'complete') {
        row.complete++;
        w.complete++;
      }
    }

    // Look-ahead: next two weeks from today, regardless of the chosen range.
    const ahead = sessionsOf(b, today, addDays(today, AHEAD_DAYS - 1));
    for (const d of ahead) {
      const s = statusOf(planAt.get(`${b.id}:${d}`));
      if (s !== 'complete')
        needsPlan.push({
          batchId: b.id,
          batchName: b.name,
          startTime: timesOn(b, d).startTime,
          date: d,
          status: s,
        });
    }
    const nextDate = ahead[0];
    const next = nextDate ? planAt.get(`${b.id}:${nextDate}`) : undefined;

    // Streak: consecutive most recent sessions (up to today) that had a plan.
    const past = sessionsOf(b, addDays(today, -STREAK_LOOKBACK), today).reverse();
    let streak = 0;
    for (const d of past) {
      if (planAt.has(`${b.id}:${d}`)) streak++;
      else if (d === today)
        continue; // Today can still be planned.
      else break;
    }

    totals.sessions += row.sessions;
    totals.planned += row.planned;
    totals.complete += row.complete;
    totals.missed += row.missed;
    totals.filledCells += row.filled;
    totals.gridCells += row.grid;

    return {
      id: b.id,
      name: b.name,
      startTime: b.startTime,
      endTime: b.endTime,
      dayTimes: b.dayTimes,
      weekdays: b.weekdays,
      coach: { id: b.coachId, name: b.coachName },
      location: { id: b.locationId, name: b.locationName },
      sessions: row.sessions,
      planned: row.planned,
      complete: row.complete,
      missed: row.missed,
      fillRate: ratio(row.filled, row.grid),
      streak,
      next: nextDate
        ? {
            date: nextDate,
            status: statusOf(next),
            filled: next?.filled ?? 0,
            total: next?.grid ?? 0,
          }
        : null,
    };
  });
  needsPlan.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  totals.upcomingUnplanned = needsPlan.filter((n) => n.status === 'unplanned').length;

  // ── What the plans in the range are made of ────────────────────────────────
  const inRange = plans.filter((p) => p.date >= q.from && p.date <= q.to);
  const rangeIds = inRange.map((p) => p.id);
  const cellCounts = rangeIds.length
    ? await db
        .select({
          eventId: lessonPlanCells.eventId,
          stageId: lessonPlanCells.stageId,
          n: sql<number>`count(*)::int`,
        })
        .from(lessonPlanCells)
        .where(inArray(lessonPlanCells.planId, rangeIds))
        .groupBy(lessonPlanCells.eventId, lessonPlanCells.stageId)
    : [];

  const eventUse = new Map<string, { plans: number; cells: number; lastUsed: string }>();
  const stageUse = new Map<string, { plans: number; cells: number }>();
  for (const p of inRange) {
    for (const e of p.eventIds) {
      const u = eventUse.get(e) ?? { plans: 0, cells: 0, lastUsed: p.date };
      u.plans++;
      if (p.date > u.lastUsed) u.lastUsed = p.date;
      eventUse.set(e, u);
    }
    for (const s of p.stageIds) {
      const u = stageUse.get(s) ?? { plans: 0, cells: 0 };
      u.plans++;
      stageUse.set(s, u);
    }
  }
  for (const c of cellCounts) {
    const e = eventUse.get(c.eventId);
    if (e) e.cells += c.n;
    const s = stageUse.get(c.stageId);
    if (s) s.cells += c.n;
  }

  // A single library is in view when the scope has exactly one coach.
  // A single template is in view when the scope is exactly one batch.
  const libraryBatch = scope.length === 1 ? scope[0]!.id : null;

  const [eventRows, stageRows, lastUsedEver] = await Promise.all([
    db
      .select({
        id: lessonEvents.id,
        name: lessonEvents.name,
        isArchived: lessonEvents.isArchived,
      })
      .from(lessonEvents)
      .where(
        libraryBatch
          ? eq(lessonEvents.batchId, libraryBatch)
          : eventUse.size
            ? inArray(lessonEvents.id, [...eventUse.keys()])
            : sql`false`,
      ),
    stageUse.size
      ? db
          .select({ id: lessonStages.id, name: lessonStages.name, color: lessonStages.color })
          .from(lessonStages)
          .where(inArray(lessonStages.id, [...stageUse.keys()]))
      : [],
    // Recent history (newest first) to say when an unused drill was last run.
    libraryBatch
      ? db
          .select({ date: lessonPlans.date, eventIds: lessonPlans.eventIds })
          .from(lessonPlans)
          .where(and(eq(lessonPlans.batchId, libraryBatch), lte(lessonPlans.date, today)))
          .orderBy(desc(lessonPlans.date))
          .limit(500)
      : [],
  ]);
  const lastEver = new Map<string, string>();
  for (const p of lastUsedEver)
    for (const e of p.eventIds) if (!lastEver.has(e)) lastEver.set(e, p.date);

  const events = eventRows
    .filter((e) => eventUse.has(e.id))
    .map((e) => ({ id: e.id, name: e.name, ...eventUse.get(e.id)! }))
    .sort((a, b) => b.plans - a.plans || b.cells - a.cells || a.name.localeCompare(b.name));
  const unusedEvents = libraryBatch
    ? eventRows
        .filter((e) => !e.isArchived && !eventUse.has(e.id))
        .map((e) => ({ id: e.id, name: e.name, lastUsed: lastEver.get(e.id) ?? null }))
        .sort(
          (a, b) =>
            (a.lastUsed ?? '').localeCompare(b.lastUsed ?? '') || a.name.localeCompare(b.name),
        )
    : null;
  const stages = stageRows
    .map((s) => ({ ...s, ...stageUse.get(s.id)! }))
    .sort((a, b) => b.cells - a.cells || a.name.localeCompare(b.name));

  const { filledCells, gridCells, ...counts } = totals;
  ok(res, {
    from: q.from,
    to: q.to,
    today,
    totals: {
      ...counts,
      fillRate: ratio(filledCells, gridCells),
      avgEvents: inRange.length
        ? Math.round((inRange.reduce((n, p) => n + p.eventIds.length, 0) / inRange.length) * 10) /
          10
        : null,
      streak: batchRows.length ? Math.max(...batchRows.map((b) => b.streak)) : 0,
    },
    batches: batchRows,
    needsPlan,
    weeks: [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start)),
    events,
    stages,
    unusedEvents,
  });
}
