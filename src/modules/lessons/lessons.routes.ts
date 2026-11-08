import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import { lessonEvents, lessonPlanCells, lessonPlans, lessonStages } from '../../db/schema/index.js';
import { diffDays, eachDay, isoWeekday, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zName, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireCoach } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { cancellationsIn, getCancellation } from '../attendance/cancellations.js';

export const lessonsRouter = Router();

/**
 * The grid library is personal to each coach. Admins may read any coach's library and plans
 * (pass `coachId`), but only the owning coach edits them.
 */
function libraryOwner(req: Request): string {
  const user = currentUser(req);
  if (!isAdmin(user)) return user.id;
  const { coachId } = parse(z.object({ coachId: zId }), req.query);
  return coachId;
}

// ─── Library: stages (columns) and events (rows) ─────────────────────────────

const LibraryItem = z.object({
  name: zName,
  description: zOptionalText(500),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #22c55e')
    .nullable()
    .optional(),
});
const LibraryPatch = LibraryItem.partial().extend({ isArchived: z.boolean().optional() });
const ReorderBody = z.object({ ids: z.array(zId).min(1).max(200) });

function libraryRoutes(kind: 'stages' | 'events') {
  const table = kind === 'stages' ? lessonStages : lessonEvents;
  const label = kind === 'stages' ? 'Stage' : 'Event';

  lessonsRouter.get(`/${kind}`, async (req, res) => {
    const owner = libraryOwner(req);
    const { includeArchived } = parse(
      z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      req.query,
    );
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
    const coachId = currentUser(req).id;
    const body = parse(LibraryItem, req.body);
    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${table.sortOrder}), -1)::int + 1` })
      .from(table)
      .where(eq(table.coachId, coachId));
    const values =
      kind === 'stages'
        ? { coachId, name: body.name, color: body.color ?? null, sortOrder: next }
        : { coachId, name: body.name, description: body.description, sortOrder: next };
    const [row] = await db
      .insert(table)
      .values(values as typeof table.$inferInsert)
      .returning();
    created(res, row);
  });

  lessonsRouter.put(`/${kind}/order`, requireCoach, async (req, res) => {
    const coachId = currentUser(req).id;
    const { ids } = parse(ReorderBody, req.body);
    await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.coachId, coachId), inArray(table.id, ids)));
      if (owned.length !== ids.length) throw AppError.badRequest(`Unknown ${kind} in order list`);
      await Promise.all(
        ids.map((id, i) => tx.update(table).set({ sortOrder: i }).where(eq(table.id, id))),
      );
    });
    noContent(res);
  });

  lessonsRouter.patch(`/${kind}/:id`, requireCoach, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(LibraryPatch, req.body);
    const changes =
      kind === 'stages'
        ? { name: body.name, color: body.color, isArchived: body.isArchived }
        : { name: body.name, description: body.description, isArchived: body.isArchived };
    const [row] = await db
      .update(table)
      .set(changes)
      .where(and(eq(table.id, id), eq(table.coachId, currentUser(req).id)))
      .returning();
    if (!row) throw AppError.notFound(label);
    ok(res, row);
  });
}

libraryRoutes('stages');
libraryRoutes('events');

// ─── Daily plans ─────────────────────────────────────────────────────────────

async function loadPlan(batchId: string, date: string, tx: DbOrTx = db) {
  const plan = await tx.query.lessonPlans.findFirst({
    where: and(eq(lessonPlans.batchId, batchId), eq(lessonPlans.date, date)),
  });
  if (!plan) return null;

  const [cells, stages, events] = await Promise.all([
    tx.select().from(lessonPlanCells).where(eq(lessonPlanCells.planId, plan.id)),
    plan.stageIds.length
      ? tx.select().from(lessonStages).where(inArray(lessonStages.id, plan.stageIds))
      : [],
    plan.eventIds.length
      ? tx.select().from(lessonEvents).where(inArray(lessonEvents.id, plan.eventIds))
      : [],
  ]);
  const byId = <T extends { id: string }>(rows: T[], ids: string[]) =>
    ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is T => Boolean(r));

  return {
    id: plan.id,
    batchId: plan.batchId,
    coachId: plan.coachId,
    date: plan.date,
    notes: plan.notes,
    updatedAt: plan.updatedAt,
    stages: byId(stages, plan.stageIds).map((s) => ({ id: s.id, name: s.name, color: s.color })),
    events: byId(events, plan.eventIds).map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
    })),
    cells: cells.map((c) => ({ eventId: c.eventId, stageId: c.stageId, content: c.content })),
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
      gridSize: sql<number>`(cardinality(${lessonPlans.stageIds}) * cardinality(${lessonPlans.eventIds}))::int`,
      filled: sql<number>`count(${lessonPlanCells.id})::int`,
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
        filledCells: p?.filled ?? 0,
        totalCells: p?.gridSize ?? 0,
      };
    }),
  });
});

lessonsRouter.get('/plans/day', async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  const batch = await assertBatchAccess(currentUser(req), q.batchId);
  const [plan, cancelled, blocked] = await Promise.all([
    loadPlan(q.batchId, q.date),
    getCancellation(q.batchId, q.date),
    planBlockedReason(batch, q.date),
  ]);
  ok(res, {
    batch: { id: batch.id, name: batch.name },
    date: q.date,
    isSessionDay: batch.weekdays.includes(isoWeekday(q.date)),
    cancelled: cancelled?.reason ?? null,
    /** Why the plan can't be edited on this day (not a session day / cancelled), else null. */
    lockedReason: blocked,
    plan,
  });
});

const SavePlanBody = z
  .object({
    batchId: zId,
    date: zIsoDate,
    stageIds: z.array(zId).max(30),
    eventIds: z.array(zId).max(60),
    notes: zOptionalText(4000),
    cells: z
      .array(z.object({ eventId: zId, stageId: zId, content: z.string().max(2000) }))
      .max(1800),
  })
  .refine(
    (b) =>
      new Set(b.stageIds).size === b.stageIds.length &&
      new Set(b.eventIds).size === b.eventIds.length,
    {
      message: 'Stages and events must not repeat',
    },
  );

async function assertOwnedLibrary(
  tx: DbOrTx,
  coachId: string,
  stageIds: string[],
  eventIds: string[],
) {
  const [stages, events] = await Promise.all([
    stageIds.length
      ? tx
          .select({ id: lessonStages.id })
          .from(lessonStages)
          .where(and(eq(lessonStages.coachId, coachId), inArray(lessonStages.id, stageIds)))
      : [],
    eventIds.length
      ? tx
          .select({ id: lessonEvents.id })
          .from(lessonEvents)
          .where(and(eq(lessonEvents.coachId, coachId), inArray(lessonEvents.id, eventIds)))
      : [],
  ]);
  if (stages.length !== stageIds.length || events.length !== eventIds.length) {
    throw AppError.badRequest('Plan references stages or events that are not in your library');
  }
}

async function writePlan(
  tx: DbOrTx,
  coachId: string,
  input: {
    batchId: string;
    date: string;
    stageIds: string[];
    eventIds: string[];
    notes: string | null;
    cells: { eventId: string; stageId: string; content: string }[];
  },
) {
  const [plan] = await tx
    .insert(lessonPlans)
    .values({
      batchId: input.batchId,
      coachId,
      date: input.date,
      stageIds: input.stageIds,
      eventIds: input.eventIds,
      notes: input.notes,
    })
    .onConflictDoUpdate({
      target: [lessonPlans.batchId, lessonPlans.date],
      set: {
        stageIds: input.stageIds,
        eventIds: input.eventIds,
        notes: input.notes,
        coachId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: lessonPlans.id });

  await tx.delete(lessonPlanCells).where(eq(lessonPlanCells.planId, plan!.id));
  const stageSet = new Set(input.stageIds);
  const eventSet = new Set(input.eventIds);
  const cells = input.cells
    .filter(
      (c) => stageSet.has(c.stageId) && eventSet.has(c.eventId) && c.content.trim().length > 0,
    )
    .map((c) => ({
      planId: plan!.id,
      eventId: c.eventId,
      stageId: c.stageId,
      content: c.content.trim(),
    }));
  if (cells.length) await tx.insert(lessonPlanCells).values(cells);
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

/** Saves the whole grid for a day (create or replace). Only the batch's coach can edit. */
lessonsRouter.put('/plans/day', requireCoach, async (req, res) => {
  const body = parse(SavePlanBody, req.body);
  const coachId = currentUser(req).id;
  const batch = await assertBatchAccess(currentUser(req), body.batchId);
  const blocked = await planBlockedReason(batch, body.date);
  if (blocked) throw AppError.unprocessable(blocked);

  await db.transaction(async (tx) => {
    await assertOwnedLibrary(tx, coachId, body.stageIds, body.eventIds);
    await writePlan(tx, coachId, body);
  });
  ok(res, await loadPlan(body.batchId, body.date));
});

lessonsRouter.delete('/plans/day', requireCoach, async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  await assertBatchAccess(currentUser(req), q.batchId);
  await db
    .delete(lessonPlans)
    .where(and(eq(lessonPlans.batchId, q.batchId), eq(lessonPlans.date, q.date)));
  noContent(res);
});

const CopyBody = z.object({
  batchId: zId,
  fromDate: zIsoDate,
  /** Target batch defaults to the source batch; may be another batch of the same coach. */
  toBatchId: zId.optional(),
  toDates: z.array(zIsoDate).min(1).max(31),
  overwrite: z.boolean().default(false),
});

/** Copies a day's plan to other days (e.g. "repeat for the rest of the week"). */
lessonsRouter.post('/plans/copy', requireCoach, async (req, res) => {
  const body = parse(CopyBody, req.body);
  const user = currentUser(req);
  await assertBatchAccess(user, body.batchId);
  const targetBatchId = body.toBatchId ?? body.batchId;
  const targetBatch =
    targetBatchId !== body.batchId
      ? await assertBatchAccess(user, targetBatchId)
      : await assertBatchAccess(user, body.batchId);

  const source = await loadPlan(body.batchId, body.fromDate);
  if (!source) throw AppError.notFound('Source plan');

  // Days the target batch doesn't run (or cancelled) are skipped. Checked before the transaction.
  const blocked = new Set<string>();
  for (const date of new Set(body.toDates)) {
    if (await planBlockedReason(targetBatch, date)) blocked.add(date);
  }

  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ date: lessonPlans.date })
      .from(lessonPlans)
      .where(and(eq(lessonPlans.batchId, targetBatchId), inArray(lessonPlans.date, body.toDates)));
    const existingDates = new Set(existing.map((e) => e.date));
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const date of [...new Set(body.toDates)]) {
      if (
        (date === body.fromDate && targetBatchId === body.batchId) ||
        (existingDates.has(date) && !body.overwrite) ||
        blocked.has(date)
      ) {
        skipped.push(date);
        continue;
      }
      await writePlan(tx, user.id, {
        batchId: targetBatchId,
        date,
        stageIds: source.stages.map((s) => s.id),
        eventIds: source.events.map((e) => e.id),
        notes: source.notes,
        cells: source.cells,
      });
      copied.push(date);
    }
    return { copied, skipped };
  });
  ok(res, result);
});
