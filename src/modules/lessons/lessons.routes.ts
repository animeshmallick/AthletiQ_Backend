import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
  lessonEvents,
  lessonPlanCells,
  lessonPlans,
  lessonPlanTemplates,
  lessonStages,
} from '../../db/schema/index.js';
import { diffDays, eachDay, isoWeekday, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zName, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireCoach } from '../../middleware/auth.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertBatchAccess, isSubstituteFor } from '../access/access.js';
import { cancellationsIn, getCancellation } from '../attendance/cancellations.js';
import { lessonInsights } from './insights.js';

export const lessonsRouter = Router();

/**
 * Each coach keeps one library: stages (the timed blocks of a session, e.g. Warm-up 10 min) and
 * events (drills / skills picked into those blocks). It is used across all their batches. A day's
 * plan picks blocks and drills from the library, with minutes per block, a focus line and notes;
 * whole plans can be saved under a name and applied to any session in one tap.
 */

// ─── Library: stages (blocks) and events (drills) ────────────────────────────

const zMinutes = z.number().int().min(1).max(240);
const LibraryItem = z.object({
  /** Batch the coach was planning when they added it (kept for history only). */
  batchId: zId.optional(),
  name: zName,
  description: zOptionalText(500),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #22c55e')
    .nullable()
    .optional(),
  durationMin: zMinutes.nullable().optional(),
});
const LibraryPatch = LibraryItem.omit({ batchId: true })
  .partial()
  .extend({ isArchived: z.boolean().optional() });
const ReorderBody = z.object({ ids: z.array(zId).min(1).max(200) });

/** Whose library a request reads: the coach's own; for admins, the given batch's coach. */
async function libraryOwner(user: AuthUser, batchId: string | undefined) {
  if (user.role !== 'admin') return user.id;
  if (!batchId) throw AppError.badRequest('Pick a batch');
  return (await assertBatchAccess(user, batchId)).coachId;
}

function libraryRoutes(kind: 'stages' | 'events') {
  const table = kind === 'stages' ? lessonStages : lessonEvents;
  const label = kind === 'stages' ? 'Stage' : 'Drill';

  lessonsRouter.get(`/${kind}`, async (req, res) => {
    const { batchId, includeArchived } = parse(
      z.object({ batchId: zId.optional(), includeArchived: z.enum(['true', 'false']).optional() }),
      req.query,
    );
    const owner = await libraryOwner(currentUser(req), batchId);
    const rows = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.coachId, owner),
          includeArchived === 'true' ? undefined : eq(table.isArchived, false),
        ),
      )
      .orderBy(asc(table.sortOrder), asc(table.name));
    ok(res, rows);
  });

  lessonsRouter.post(`/${kind}`, requireCoach, async (req, res) => {
    const user = currentUser(req);
    const body = parse(LibraryItem, req.body);
    if (body.batchId) await assertBatchAccess(user, body.batchId);
    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${table.sortOrder}), -1)::int + 1` })
      .from(table)
      .where(eq(table.coachId, user.id));
    const base = {
      batchId: body.batchId ?? null,
      coachId: user.id,
      name: body.name,
      sortOrder: next,
    };
    const values =
      kind === 'stages'
        ? { ...base, color: body.color ?? null, durationMin: body.durationMin ?? null }
        : { ...base, description: body.description };
    const [row] = await db
      .insert(table)
      .values(values as typeof table.$inferInsert)
      .returning();
    created(res, row);
  });

  lessonsRouter.put(`/${kind}/order`, requireCoach, async (req, res) => {
    const { ids } = parse(ReorderBody, req.body);
    const user = currentUser(req);
    await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.coachId, user.id), inArray(table.id, ids)));
      if (owned.length !== new Set(ids).size)
        throw AppError.badRequest(`Unknown ${kind} in order list`);
      await Promise.all(
        ids.map((id, i) => tx.update(table).set({ sortOrder: i }).where(eq(table.id, id))),
      );
    });
    noContent(res);
  });

  lessonsRouter.patch(`/${kind}/:id`, requireCoach, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(LibraryPatch, req.body);
    const [item] = await db.select({ coachId: table.coachId }).from(table).where(eq(table.id, id));
    if (!item || item.coachId !== currentUser(req).id) throw AppError.notFound(label);
    const changes =
      kind === 'stages'
        ? {
            name: body.name,
            color: body.color,
            durationMin: body.durationMin,
            isArchived: body.isArchived,
          }
        : { name: body.name, description: body.description, isArchived: body.isArchived };
    const [row] = await db.update(table).set(changes).where(eq(table.id, id)).returning();
    ok(res, row);
  });
}

libraryRoutes('stages');
libraryRoutes('events');

// ─── Daily plans ─────────────────────────────────────────────────────────────

type Cell = { eventId: string; stageId: string; content: string };
type Grid = {
  stageIds: string[];
  eventIds: string[];
  durations: Record<string, number>;
  focus: string | null;
  notes: string | null;
  cells: Cell[];
};

async function loadPlan(batchId: string, date: string, tx: DbOrTx = db) {
  const plan = await tx.query.lessonPlans.findFirst({
    where: and(eq(lessonPlans.batchId, batchId), eq(lessonPlans.date, date)),
  });
  if (!plan) return null;
  const cells = await tx.select().from(lessonPlanCells).where(eq(lessonPlanCells.planId, plan.id));
  return {
    id: plan.id,
    batchId: plan.batchId,
    coachId: plan.coachId,
    date: plan.date,
    updatedAt: plan.updatedAt,
    ...(await expandGrid(
      {
        stageIds: plan.stageIds,
        eventIds: plan.eventIds,
        durations: plan.durations,
        focus: plan.focus,
        notes: plan.notes,
        cells: cells.map((c) => ({ eventId: c.eventId, stageId: c.stageId, content: c.content })),
      },
      tx,
    )),
  };
}

/** Resolves a grid's ids into names, colours and minutes (in the grid's order). */
async function expandGrid(grid: Grid, tx: DbOrTx = db) {
  const [stages, events] = await Promise.all([
    grid.stageIds.length
      ? tx.select().from(lessonStages).where(inArray(lessonStages.id, grid.stageIds))
      : [],
    grid.eventIds.length
      ? tx.select().from(lessonEvents).where(inArray(lessonEvents.id, grid.eventIds))
      : [],
  ]);
  const byId = <T extends { id: string }>(rows: T[], ids: string[]) =>
    ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is T => Boolean(r));
  const orderedStages = byId(stages, grid.stageIds).map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    durationMin: s.durationMin,
    /** This session's minutes for the block (falls back to the library default). */
    minutes: grid.durations[s.id] ?? s.durationMin ?? null,
  }));
  return {
    focus: grid.focus,
    notes: grid.notes,
    durations: grid.durations,
    totalMinutes: orderedStages.reduce((n, s) => n + (s.minutes ?? 0), 0),
    stages: orderedStages,
    events: byId(events, grid.eventIds).map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
    })),
    cells: grid.cells,
  };
}

/** Calendar view: which days in a range have a plan, and how filled each grid is. */
lessonsRouter.get('/plans', async (req, res) => {
  const q = parse(z.object({ batchId: zId, from: zIsoDate, to: zIsoDate }), req.query);
  if (q.to < q.from || diffDays(q.from, q.to) > 92)
    throw AppError.badRequest('Choose a range of up to 3 months');
  const batch = await assertBatchAccess(currentUser(req), q.batchId);

  const plans = await db
    .select({
      id: lessonPlans.id,
      date: lessonPlans.date,
      focus: lessonPlans.focus,
      gridSize: sql<number>`cardinality(${lessonPlans.stageIds})::int`,
      filled: sql<number>`count(distinct ${lessonPlanCells.stageId})::int`,
      content: sql<boolean>`(count(${lessonPlanCells.id}) > 0 or coalesce(btrim(${lessonPlans.focus}), '') <> '' or coalesce(btrim(${lessonPlans.notes}), '') <> '')`,
    })
    .from(lessonPlans)
    .leftJoin(lessonPlanCells, eq(lessonPlanCells.planId, lessonPlans.id))
    .where(
      and(
        eq(lessonPlans.batchId, q.batchId),
        gte(lessonPlans.date, q.from),
        lte(lessonPlans.date, q.to),
      ),
    )
    .groupBy(lessonPlans.id);

  const byDate = new Map(plans.map((p) => [p.date, p]));
  const cancelled = await cancellationsIn([q.batchId], q.from, q.to);
  ok(res, {
    batch: { id: batch.id, name: batch.name, weekdays: batch.weekdays },
    days: eachDay(q.from, q.to).map((date) => {
      const p = byDate.get(date);
      return {
        date,
        isSessionDay: batch.weekdays.includes(isoWeekday(date)),
        cancelled: cancelled.get(`${q.batchId}:${date}`) ?? null,
        planId: p?.id ?? null,
        /** Anything filled in (a drill, the focus or notes): the session counts as planned. */
        hasContent: p?.content ?? false,
        focus: p?.focus ?? null,
        filledCells: p?.filled ?? 0,
        totalCells: p?.gridSize ?? 0,
      };
    }),
  });
});

/** Planning coverage, look-ahead and library usage across the caller's batches. */
lessonsRouter.get('/insights', lessonInsights);

lessonsRouter.get('/plans/day', async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  const batch = await assertBatchAccess(currentUser(req), q.batchId, { on: q.date });
  const [plan, cancelled, blocked, [previous]] = await Promise.all([
    loadPlan(q.batchId, q.date),
    getCancellation(q.batchId, q.date),
    planBlockedReason(batch, q.date),
    db
      .select({ date: lessonPlans.date })
      .from(lessonPlans)
      .where(and(eq(lessonPlans.batchId, q.batchId), lt(lessonPlans.date, q.date)))
      .orderBy(desc(lessonPlans.date))
      .limit(1),
  ]);
  ok(res, {
    batch: {
      id: batch.id,
      name: batch.name,
      startTime: batch.startTime,
      endTime: batch.endTime,
    },
    date: q.date,
    isSessionDay: batch.weekdays.includes(isoWeekday(q.date)),
    cancelled: cancelled?.reason ?? null,
    /** Why the plan can't be edited on this day (not a session day / cancelled), else null. */
    lockedReason: blocked,
    /** The most recent earlier plan for this batch, to start a new day from. */
    previousPlanDate: previous?.date ?? null,
    plan,
  });
});

const zGrid = z
  .object({
    stageIds: z.array(zId).max(30),
    eventIds: z.array(zId).max(60),
    durations: z.record(zId, zMinutes).default({}),
    focus: zOptionalText(200),
    notes: zOptionalText(4000),
    cells: z
      .array(z.object({ eventId: zId, stageId: zId, content: z.string().max(2000) }))
      .max(1800),
  })
  .refine(
    (b) =>
      new Set(b.stageIds).size === b.stageIds.length &&
      new Set(b.eventIds).size === b.eventIds.length,
    { message: 'Stages and drills must not repeat' },
  );
const SavePlanBody = z.object({ batchId: zId, date: zIsoDate }).and(zGrid);

/** Every stage/drill in a plan must come from the planner's or the batch coach's library. */
async function assertLibrary(tx: DbOrTx, owners: string[], stageIds: string[], eventIds: string[]) {
  const [stages, events] = await Promise.all([
    stageIds.length
      ? tx
          .select({ id: lessonStages.id })
          .from(lessonStages)
          .where(and(inArray(lessonStages.coachId, owners), inArray(lessonStages.id, stageIds)))
      : [],
    eventIds.length
      ? tx
          .select({ id: lessonEvents.id })
          .from(lessonEvents)
          .where(and(inArray(lessonEvents.coachId, owners), inArray(lessonEvents.id, eventIds)))
      : [],
  ]);
  if (stages.length !== stageIds.length || events.length !== eventIds.length) {
    throw AppError.badRequest("Plan uses stages or drills that aren't in your library");
  }
}

/** Keeps only what belongs to the grid: cells on its rows/columns, minutes for its stages. */
function cleanGrid(input: Grid): Grid {
  const stageSet = new Set(input.stageIds);
  const eventSet = new Set(input.eventIds);
  const seen = new Set<string>();
  return {
    ...input,
    durations: Object.fromEntries(
      Object.entries(input.durations).filter(([id]) => stageSet.has(id)),
    ),
    // A cell with no text still means "this drill runs in this block".
    cells: input.cells
      .filter((c) => stageSet.has(c.stageId) && eventSet.has(c.eventId))
      .filter((c) => {
        const k = `${c.eventId}:${c.stageId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((c) => ({ ...c, content: c.content.trim() })),
  };
}

async function writePlan(
  tx: DbOrTx,
  coachId: string,
  input: { batchId: string; date: string } & Grid,
) {
  const grid = cleanGrid(input);
  const values = {
    stageIds: grid.stageIds,
    eventIds: grid.eventIds,
    durations: grid.durations,
    focus: grid.focus,
    notes: grid.notes,
  };
  const [plan] = await tx
    .insert(lessonPlans)
    .values({ batchId: input.batchId, coachId, date: input.date, ...values })
    .onConflictDoUpdate({
      target: [lessonPlans.batchId, lessonPlans.date],
      set: { ...values, coachId, updatedAt: new Date() },
    })
    .returning({ id: lessonPlans.id });

  await tx.delete(lessonPlanCells).where(eq(lessonPlanCells.planId, plan!.id));
  if (grid.cells.length)
    await tx.insert(lessonPlanCells).values(grid.cells.map((c) => ({ planId: plan!.id, ...c })));
}

/** Why a plan can't be written for this batch on this date, or null if it can. */
async function planBlockedReason(
  batch: { id: string; name: string; weekdays: number[] },
  date: IsoDate,
): Promise<string | null> {
  if (!batch.weekdays.includes(isoWeekday(date))) {
    return `${batch.name} doesn't run on this day, so it can't have a lesson plan.`;
  }
  const cancelled = await getCancellation(batch.id, date);
  if (cancelled) return `This session was cancelled (${cancelled.reason}).`;
  return null;
}

/** Saves the whole plan for a day (create or replace). */
lessonsRouter.put('/plans/day', requireCoach, async (req, res) => {
  const body = parse(SavePlanBody, req.body);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, body.batchId, { on: body.date });
  const blocked = await planBlockedReason(batch, body.date);
  if (blocked) throw AppError.unprocessable(blocked);

  await db.transaction(async (tx) => {
    await assertLibrary(tx, [user.id, batch.coachId], body.stageIds, body.eventIds);
    await writePlan(tx, user.id, body);
  });
  ok(res, await loadPlan(body.batchId, body.date));
});

lessonsRouter.delete('/plans/day', requireCoach, async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  await assertBatchAccess(currentUser(req), q.batchId, { on: q.date });
  await db
    .delete(lessonPlans)
    .where(and(eq(lessonPlans.batchId, q.batchId), eq(lessonPlans.date, q.date)));
  noContent(res);
});

/**
 * Writes one grid onto many sessions (other days, other batches of the same coach). Days a batch
 * doesn't run, cancelled days, days a substitute doesn't cover and (unless `overwrite`) days that
 * already have a plan are skipped.
 */
async function applyGrid(
  user: AuthUser,
  grid: Grid,
  targets: { batchId: string; dates: string[] }[],
  overwrite: boolean,
  skipSelf?: { batchId: string; date: string },
) {
  const copied: { batchId: string; date: string }[] = [];
  const skipped: { batchId: string; date: string }[] = [];
  const plans: { batch: Awaited<ReturnType<typeof assertBatchAccess>>; dates: string[] }[] = [];
  for (const t of targets) {
    const batch = await assertBatchAccess(user, t.batchId);
    const ok: string[] = [];
    for (const date of new Set(t.dates)) {
      const blocked =
        (skipSelf && skipSelf.batchId === t.batchId && skipSelf.date === date) ||
        !!(await planBlockedReason(batch, date)) ||
        (batch.coachId !== user.id && !(await isSubstituteFor(user.id, t.batchId, date)));
      if (blocked) skipped.push({ batchId: t.batchId, date });
      else ok.push(date);
    }
    plans.push({ batch, dates: ok });
  }
  await db.transaction(async (tx) => {
    for (const { batch, dates } of plans) {
      if (!dates.length) continue;
      await assertLibrary(tx, [user.id, batch.coachId], grid.stageIds, grid.eventIds);
      const existing = new Set(
        (
          await tx
            .select({ date: lessonPlans.date })
            .from(lessonPlans)
            .where(and(eq(lessonPlans.batchId, batch.id), inArray(lessonPlans.date, dates)))
        ).map((e) => e.date),
      );
      for (const date of dates) {
        if (existing.has(date) && !overwrite) {
          skipped.push({ batchId: batch.id, date });
          continue;
        }
        await writePlan(tx, user.id, { batchId: batch.id, date, ...grid });
        copied.push({ batchId: batch.id, date });
      }
    }
  });
  return { copied, skipped };
}

const CopyBody = z.object({
  batchId: zId,
  fromDate: zIsoDate,
  /** Target batch defaults to the source batch; may be another batch of the same coach. */
  toBatchId: zId.optional(),
  toDates: z.array(zIsoDate).min(1).max(31),
  overwrite: z.boolean().default(false),
});

/** Copies a day's plan to other days ("repeat for the week", "same as last session"). */
lessonsRouter.post('/plans/copy', requireCoach, async (req, res) => {
  const body = parse(CopyBody, req.body);
  const user = currentUser(req);
  await assertBatchAccess(user, body.batchId, { on: body.fromDate });
  const source = await loadPlan(body.batchId, body.fromDate);
  if (!source) throw AppError.notFound('Source plan');
  const result = await applyGrid(
    user,
    gridOf(source),
    [{ batchId: body.toBatchId ?? body.batchId, dates: body.toDates }],
    body.overwrite,
    { batchId: body.batchId, date: body.fromDate },
  );
  ok(res, { copied: result.copied.map((c) => c.date), skipped: result.skipped.map((s) => s.date) });
});

function gridOf(p: {
  stages: { id: string }[];
  events: { id: string }[];
  durations: Record<string, number>;
  focus: string | null;
  notes: string | null;
  cells: Cell[];
}): Grid {
  return {
    stageIds: p.stages.map((s) => s.id),
    eventIds: p.events.map((e) => e.id),
    durations: p.durations,
    focus: p.focus,
    notes: p.notes,
    cells: p.cells,
  };
}

// ─── Saved plans ─────────────────────────────────────────────────────────────

const SavedBody = z.union([
  /** Save an existing day's plan under a name. */
  z.object({ name: zName, from: z.object({ batchId: zId, date: zIsoDate }) }),
  /** Or build one directly. */
  z.object({ name: zName }).and(zGrid),
]);

async function loadSaved(coachId: string) {
  const rows = await db
    .select()
    .from(lessonPlanTemplates)
    .where(eq(lessonPlanTemplates.coachId, coachId))
    .orderBy(asc(lessonPlanTemplates.name));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      ...(await expandGrid(r)),
    })),
  );
}

async function ownSaved(user: AuthUser, id: string) {
  const [row] = await db.select().from(lessonPlanTemplates).where(eq(lessonPlanTemplates.id, id));
  if (!row || row.coachId !== user.id) throw AppError.notFound('Saved plan');
  return row;
}

lessonsRouter.get('/saved', async (req, res) => {
  const { batchId } = parse(z.object({ batchId: zId.optional() }), req.query);
  ok(res, await loadSaved(await libraryOwner(currentUser(req), batchId)));
});

lessonsRouter.post('/saved', requireCoach, async (req, res) => {
  const user = currentUser(req);
  const body = parse(SavedBody, req.body);
  let grid: Grid;
  if ('from' in body) {
    await assertBatchAccess(user, body.from.batchId, { on: body.from.date });
    const plan = await loadPlan(body.from.batchId, body.from.date);
    if (!plan) throw AppError.notFound('Plan');
    grid = gridOf(plan);
  } else {
    await assertLibrary(db, [user.id], body.stageIds, body.eventIds);
    grid = body;
  }
  const g = cleanGrid(grid);
  const [row] = await db
    .insert(lessonPlanTemplates)
    .values({ coachId: user.id, name: body.name, ...g })
    .returning();
  created(res, {
    id: row!.id,
    name: row!.name,
    updatedAt: row!.updatedAt,
    ...(await expandGrid(g)),
  });
});

lessonsRouter.patch('/saved/:id', requireCoach, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { name } = parse(z.object({ name: zName }), req.body);
  await ownSaved(currentUser(req), id);
  await db.update(lessonPlanTemplates).set({ name }).where(eq(lessonPlanTemplates.id, id));
  noContent(res);
});

lessonsRouter.delete('/saved/:id', requireCoach, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await ownSaved(currentUser(req), id);
  await db.delete(lessonPlanTemplates).where(eq(lessonPlanTemplates.id, id));
  noContent(res);
});

const ApplyBody = z.object({
  targets: z
    .array(z.object({ batchId: zId, dates: z.array(zIsoDate).min(1).max(31) }))
    .min(1)
    .max(20),
  overwrite: z.boolean().default(false),
});

/** Applies a saved plan to one or many sessions (e.g. the whole week). */
lessonsRouter.post('/saved/:id/apply', requireCoach, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ApplyBody, req.body);
  const user = currentUser(req);
  const t = await ownSaved(user, id);
  ok(res, await applyGrid(user, t, body.targets, body.overwrite));
});
