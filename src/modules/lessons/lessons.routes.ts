/**
 * Lesson plans: one plan per batch. A plan is an ordered list of timed blocks, each holding its
 * drills. Every session of the batch follows the plan; a coach can adjust a single session (its
 * own copy), and reset it back. The blocks must add up to exactly the session length — on every
 * day the batch runs for the batch plan, and on that day for a session.
 *
 *  GET    /lessons/batch-plan?batchId           the batch's plan (+ session lengths, can-edit)
 *  PUT    /lessons/batch-plan                   replace it (the batch's own coach)
 *  POST   /lessons/batch-plan/copy              copy to other batches of the same session length
 *  GET    /lessons/session?batchId&date         that day's plan (its own copy, else the batch's)
 *  PUT    /lessons/session                      adjust that day (coach or covering substitute)
 *  DELETE /lessons/session?batchId&date         back to the batch plan
 *  GET    /lessons/overview                     each batch: plan status, totals, adjusted days
 */
import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batchPlanBlocks,
  batchPlanDrills,
  batchPlans,
  batches,
  locations,
  sessionPlans,
  sports,
  users,
  type SessionBlock,
} from '../../db/schema/index.js';
import { timesOn } from '../../lib/batch-times.js';
import {
  addDays,
  diffDays,
  eachDay,
  isoWeekday,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { noContent, ok } from '../../lib/http.js';
import { parse, zId, zIsoDate, zName, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireCoach } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin, isSubstituteFor } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { cancellationsIn, getCancellation } from '../attendance/cancellations.js';

export const lessonsRouter = Router();

type BatchRow = Awaited<ReturnType<typeof assertBatchAccess>>;
type Timed = Pick<BatchRow, 'weekdays' | 'startTime' | 'endTime' | 'dayTimes'>;

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

/** Minutes each day the batch runs (ISO weekday → minutes), and the one length if all agree. */
export function sessionLengths(b: Timed) {
  const byDay: Record<string, number> = {};
  for (const d of [...b.weekdays].sort()) {
    const t = timesOn(b, d);
    byDay[String(d)] = toMin(t.endTime) - toMin(t.startTime);
  }
  const lengths = [...new Set(Object.values(byDay))];
  return { byDay, minutes: lengths.length === 1 ? lengths[0]! : null };
}

const sumMinutes = (blocks: { minutes: number }[]) => blocks.reduce((n, b) => n + b.minutes, 0);
const WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ─── Shapes ──────────────────────────────────────────────────────────────────

const zMinutes = z.number().int().min(1).max(600);
const zDrill = z.object({
  name: zName,
  minutes: zMinutes.nullable().optional(),
  reps: zOptionalText(60),
  note: zOptionalText(500),
});
const zBlock = z.object({
  name: zName,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #22c55e')
    .nullable()
    .optional(),
  minutes: zMinutes,
  drills: z.array(zDrill).max(30).default([]),
});
const zBlocks = z.array(zBlock).min(1, 'Add at least one block').max(20);
type BlocksInput = z.infer<typeof zBlocks>;

/** A block's drills must fit inside it (when drills have their own minutes). */
function checkDrillMinutes(blocks: BlocksInput) {
  for (const b of blocks) {
    const used = b.drills.reduce((n, d) => n + (d.minutes ?? 0), 0);
    if (used > b.minutes)
      throw AppError.unprocessable(
        `${b.name}: its drills take ${used} min, more than the block's ${b.minutes} min.`,
      );
  }
}

// ─── Batch plan ──────────────────────────────────────────────────────────────

export async function loadBatchPlan(batchId: string, tx: DbOrTx = db) {
  const [plan] = await tx
    .select({
      id: batchPlans.id,
      focus: batchPlans.focus,
      notes: batchPlans.notes,
      updatedAt: batchPlans.updatedAt,
      updatedById: users.id,
      updatedByName: users.name,
    })
    .from(batchPlans)
    .leftJoin(users, eq(users.id, batchPlans.updatedById))
    .where(eq(batchPlans.batchId, batchId));
  if (!plan) return null;
  const blocks = await tx
    .select()
    .from(batchPlanBlocks)
    .where(eq(batchPlanBlocks.planId, plan.id))
    .orderBy(asc(batchPlanBlocks.sortOrder));
  const drills = blocks.length
    ? await tx
        .select()
        .from(batchPlanDrills)
        .where(
          inArray(
            batchPlanDrills.blockId,
            blocks.map((b) => b.id),
          ),
        )
        .orderBy(asc(batchPlanDrills.sortOrder))
    : [];
  const shaped = blocks.map((b) => ({
    id: b.id,
    name: b.name,
    color: b.color,
    minutes: b.minutes,
    drills: drills
      .filter((d) => d.blockId === b.id)
      .map((d) => ({ id: d.id, name: d.name, minutes: d.minutes, reps: d.reps, note: d.note })),
  }));
  return {
    focus: plan.focus,
    notes: plan.notes,
    updatedAt: plan.updatedAt,
    updatedBy:
      plan.updatedById && plan.updatedByName
        ? { id: plan.updatedById, name: plan.updatedByName }
        : null,
    totalMinutes: sumMinutes(shaped),
    blocks: shaped,
  };
}

/** Writes a batch's plan (replacing what was there). */
export async function writeBatchPlan(
  tx: DbOrTx,
  batchId: string,
  userId: string | null,
  body: { focus?: string | null; notes?: string | null; blocks: BlocksInput },
) {
  const values = { focus: body.focus ?? null, notes: body.notes ?? null, updatedById: userId };
  const [plan] = await tx
    .insert(batchPlans)
    .values({ batchId, ...values })
    .onConflictDoUpdate({ target: batchPlans.batchId, set: { ...values, updatedAt: new Date() } })
    .returning({ id: batchPlans.id });
  await tx.delete(batchPlanBlocks).where(eq(batchPlanBlocks.planId, plan!.id));
  for (const [i, b] of body.blocks.entries()) {
    const [block] = await tx
      .insert(batchPlanBlocks)
      .values({
        planId: plan!.id,
        name: b.name,
        color: b.color ?? null,
        minutes: b.minutes,
        sortOrder: i,
      })
      .returning({ id: batchPlanBlocks.id });
    if (b.drills.length)
      await tx.insert(batchPlanDrills).values(
        b.drills.map((d, j) => ({
          blockId: block!.id,
          name: d.name,
          minutes: d.minutes ?? null,
          reps: d.reps ?? null,
          note: d.note ?? null,
          sortOrder: j,
        })),
      );
  }
}

/** Why a plan with this total can't be the batch's plan, or null. */
export function batchPlanMismatch(batch: Timed & { name: string }, total: number): string | null {
  const { byDay, minutes } = sessionLengths(batch);
  if (minutes === null) {
    const days = Object.entries(byDay)
      .map(([d, m]) => `${WEEKDAY[Number(d)]} ${m} min`)
      .join(', ');
    return `${batch.name}'s days aren't the same length (${days}). Make them equal to give it one plan.`;
  }
  if (total !== minutes)
    return `The blocks add up to ${total} min, but each session is ${minutes} min.`;
  return null;
}

/** The batch's main coach edits its plan (not admins, not substitutes). */
const canEditPlan = (user: AuthUser, batch: BatchRow) =>
  user.role === 'coach' && batch.coachId === user.id;

const batchInfo = (b: BatchRow) => {
  const lengths = sessionLengths(b);
  return {
    id: b.id,
    name: b.name,
    weekdays: b.weekdays,
    sessionMinutes: lengths.minutes,
    minutesByDay: lengths.byDay,
  };
};

lessonsRouter.get('/batch-plan', async (req, res) => {
  const { batchId } = parse(z.object({ batchId: zId }), req.query);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, batchId);
  const plan = await loadBatchPlan(batchId);
  ok(res, {
    batch: batchInfo(batch),
    plan,
    /** Why the plan doesn't fit the sessions (e.g. after a timing change), else null. */
    mismatch: plan ? batchPlanMismatch(batch, plan.totalMinutes) : null,
    canEdit: canEditPlan(user, batch),
  });
});

const PlanBody = z.object({
  batchId: zId,
  focus: zOptionalText(200),
  notes: zOptionalText(4000),
  blocks: zBlocks,
});

lessonsRouter.put('/batch-plan', requireCoach, async (req, res) => {
  const body = parse(PlanBody, req.body);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, body.batchId, { mainOnly: true });
  if (!canEditPlan(user, batch))
    throw AppError.forbidden("Only the batch's coach can change its plan");
  checkDrillMinutes(body.blocks);
  const mismatch = batchPlanMismatch(batch, sumMinutes(body.blocks));
  if (mismatch) throw AppError.unprocessable(mismatch);
  await db.transaction((tx) => writeBatchPlan(tx, batch.id, user.id, body));
  await audit({
    ...auditCtx(req),
    action: 'lesson_plan.saved',
    entityType: 'batch',
    entityId: batch.id,
    metadata: {
      blocks: body.blocks.length,
      drills: body.blocks.reduce((n, b) => n + b.drills.length, 0),
    },
  });
  ok(res, {
    batch: batchInfo(batch),
    plan: await loadBatchPlan(batch.id),
    mismatch: null,
    canEdit: true,
  });
});

const CopyBody = z.object({
  fromBatchId: zId,
  toBatchIds: z.array(zId).min(1).max(50),
  /** Replace plans the target batches already have. */
  overwrite: z.boolean().default(false),
});

/** Copies a batch's plan to the coach's other batches whose sessions are the same length. */
lessonsRouter.post('/batch-plan/copy', requireCoach, async (req, res) => {
  const body = parse(CopyBody, req.body);
  const user = currentUser(req);
  const from = await assertBatchAccess(user, body.fromBatchId);
  const source = await loadBatchPlan(from.id);
  if (!source) throw AppError.notFound('Lesson plan');
  const copied: string[] = [];
  const skipped: { batchId: string; reason: string }[] = [];
  for (const id of [...new Set(body.toBatchIds)].filter((x) => x !== from.id)) {
    const target = await assertBatchAccess(user, id, { mainOnly: true });
    if (!canEditPlan(user, target)) {
      skipped.push({ batchId: id, reason: 'Not your batch' });
      continue;
    }
    const mismatch = batchPlanMismatch(target, source.totalMinutes);
    if (mismatch) {
      skipped.push({ batchId: id, reason: mismatch });
      continue;
    }
    const [existing] = await db
      .select({ id: batchPlans.id })
      .from(batchPlans)
      .where(eq(batchPlans.batchId, id));
    if (existing && !body.overwrite) {
      skipped.push({ batchId: id, reason: 'Already has a plan' });
      continue;
    }
    await db.transaction((tx) => writeBatchPlan(tx, id, user.id, source));
    copied.push(id);
  }
  if (copied.length)
    await audit({
      ...auditCtx(req),
      action: 'lesson_plan.copied',
      entityType: 'batch',
      entityId: from.id,
      metadata: { to: copied },
    });
  ok(res, { copied, skipped });
});

// ─── One session ─────────────────────────────────────────────────────────────

/** Why this day can't have a session plan (not a session day / cancelled), or null. */
async function sessionBlocked(batch: BatchRow, date: IsoDate): Promise<string | null> {
  if (!batch.weekdays.includes(isoWeekday(date)))
    return `${batch.name} doesn't run on ${WEEKDAY[isoWeekday(date)]}s.`;
  const cancelled = await getCancellation(batch.id, date);
  if (cancelled) return `This session was cancelled (${cancelled.reason}).`;
  return null;
}

const dayMinutes = (batch: Timed, date: IsoDate) => {
  const t = timesOn(batch, date);
  return toMin(t.endTime) - toMin(t.startTime);
};

lessonsRouter.get('/session', async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, q.batchId, { on: q.date });
  const [own] = await db
    .select()
    .from(sessionPlans)
    .where(and(eq(sessionPlans.batchId, batch.id), eq(sessionPlans.date, q.date)));
  const plan = await loadBatchPlan(batch.id);
  // Not filled in yet: the batch plan's blocks with no drills picked. The coach picks the day's
  // drills from each block's list (drillOptions) when filling it in.
  const blocks: SessionBlock[] = own
    ? own.blocks
    : (plan?.blocks ?? []).map((b) => ({
        name: b.name,
        color: b.color,
        minutes: b.minutes,
        drills: [],
      }));
  const drillOptions: Record<
    string,
    { name: string; minutes: number | null; reps: string | null; note: string | null }[]
  > = {};
  for (const b of plan?.blocks ?? [])
    drillOptions[b.name] = b.drills.map((d) => ({
      name: d.name,
      minutes: d.minutes,
      reps: d.reps,
      note: d.note,
    }));
  const coach = user.role === 'coach';
  const substitute = coach && batch.coachId !== user.id;
  ok(res, {
    batch: batchInfo(batch),
    date: q.date,
    minutes: dayMinutes(batch, q.date),
    lockedReason: await sessionBlocked(batch, q.date),
    /** 'session': filled in for this day; 'batch': not filled yet (batch blocks); 'none': no plan. */
    source: own ? 'session' : plan ? 'batch' : 'none',
    /** Each block's drills in the batch plan, to pick from (by block name). */
    drillOptions,
    focus: plan?.focus ?? null,
    note: own?.note ?? null,
    blocks,
    totalMinutes: sumMinutes(blocks),
    canAdjust: coach && (!substitute || (await isSubstituteFor(user.id, batch.id, q.date))),
  });
});

const SessionBody = z.object({
  batchId: zId,
  date: zIsoDate,
  note: zOptionalText(1000),
  blocks: zBlocks,
});

lessonsRouter.put('/session', requireCoach, async (req, res) => {
  const body = parse(SessionBody, req.body);
  const user = currentUser(req);
  // The batch's coach, or a substitute covering that day.
  const batch = await assertBatchAccess(user, body.batchId, { on: body.date });
  const blocked = await sessionBlocked(batch, body.date);
  if (blocked) throw AppError.unprocessable(blocked);
  checkDrillMinutes(body.blocks);
  const length = dayMinutes(batch, body.date);
  const total = sumMinutes(body.blocks);
  if (total !== length)
    throw AppError.unprocessable(
      `The blocks add up to ${total} min, but this session is ${length} min.`,
    );
  const blocks: SessionBlock[] = body.blocks.map((b) => ({
    name: b.name,
    color: b.color ?? null,
    minutes: b.minutes,
    drills: b.drills.map((d) => ({
      name: d.name,
      minutes: d.minutes ?? null,
      reps: d.reps ?? null,
      note: d.note ?? null,
    })),
  }));
  await db
    .insert(sessionPlans)
    .values({
      batchId: batch.id,
      date: body.date,
      coachId: user.id,
      blocks,
      note: body.note ?? null,
    })
    .onConflictDoUpdate({
      target: [sessionPlans.batchId, sessionPlans.date],
      set: { blocks, note: body.note ?? null, coachId: user.id, updatedAt: new Date() },
    });
  noContent(res);
});

lessonsRouter.delete('/session', requireCoach, async (req, res) => {
  const q = parse(z.object({ batchId: zId, date: zIsoDate }), req.query);
  const batch = await assertBatchAccess(currentUser(req), q.batchId, { on: q.date });
  await db
    .delete(sessionPlans)
    .where(and(eq(sessionPlans.batchId, batch.id), eq(sessionPlans.date, q.date)));
  noContent(res);
});

// ─── Overview ────────────────────────────────────────────────────────────────

/** Every batch in view with its plan status (none / ready / needs updating) and adjusted days. */
lessonsRouter.get('/overview', async (req, res) => {
  const user = currentUser(req);
  const rows = await db
    .select({
      id: batches.id,
      name: batches.name,
      weekdays: batches.weekdays,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
      coachId: batches.coachId,
      coachFeedback: batches.coachFeedback,
      coachName: users.name,
      sport: sports.name,
      location: locations.name,
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(
      and(eq(batches.isActive, true), isAdmin(user) ? undefined : eq(batches.coachId, user.id)),
    )
    .orderBy(asc(batches.name));
  const ids = rows.map((r) => r.id);
  const since = addDays(todayInAppTz(), -30);
  const [plans, blocks, drills, adjusted] = ids.length
    ? await Promise.all([
        db
          .select({
            id: batchPlans.id,
            batchId: batchPlans.batchId,
            updatedAt: batchPlans.updatedAt,
          })
          .from(batchPlans)
          .where(inArray(batchPlans.batchId, ids)),
        db
          .select({
            planId: batchPlanBlocks.planId,
            n: count(),
            minutes: sql<number>`sum(${batchPlanBlocks.minutes})::int`,
          })
          .from(batchPlanBlocks)
          .innerJoin(batchPlans, eq(batchPlans.id, batchPlanBlocks.planId))
          .where(inArray(batchPlans.batchId, ids))
          .groupBy(batchPlanBlocks.planId),
        db
          .select({ planId: batchPlanBlocks.planId, n: count() })
          .from(batchPlanDrills)
          .innerJoin(batchPlanBlocks, eq(batchPlanBlocks.id, batchPlanDrills.blockId))
          .innerJoin(batchPlans, eq(batchPlans.id, batchPlanBlocks.planId))
          .where(inArray(batchPlans.batchId, ids))
          .groupBy(batchPlanBlocks.planId),
        db
          .select({ batchId: sessionPlans.batchId, n: count() })
          .from(sessionPlans)
          .where(and(inArray(sessionPlans.batchId, ids), gte(sessionPlans.date, since)))
          .groupBy(sessionPlans.batchId),
      ])
    : [[], [], [], []];
  ok(res, {
    batches: rows.map((b) => {
      const plan = plans.find((p) => p.batchId === b.id);
      const bl = plan ? blocks.find((x) => x.planId === plan.id) : undefined;
      const lengths = sessionLengths(b);
      const total = bl?.minutes ?? 0;
      return {
        id: b.id,
        name: b.name,
        sport: b.sport,
        location: b.location,
        coach: { id: b.coachId, name: b.coachName },
        attendanceOnly: !b.coachFeedback,
        sessionMinutes: lengths.minutes,
        status: !plan ? 'none' : lengths.minutes === total ? 'ready' : 'needs-update',
        totalMinutes: total,
        blocks: bl?.n ?? 0,
        drills: plan ? (drills.find((x) => x.planId === plan.id)?.n ?? 0) : 0,
        adjustedDays: adjusted.find((x) => x.batchId === b.id)?.n ?? 0,
        updatedAt: plan?.updatedAt ?? null,
      };
    }),
  });
});

/** For the day overview and to-dos: does each session have a plan, and does it fit the day? */
export async function planStatusFor(
  list: { id: string; startTime: string; endTime: string }[],
  day: IsoDate,
) {
  const out = new Map<string, { hasPlan: boolean; fits: boolean; filled: boolean }>();
  const ids = list.map((b) => b.id);
  if (!ids.length) return out;
  const [plans, own] = await Promise.all([
    db
      .select({
        batchId: batchPlans.batchId,
        minutes: sql<number>`coalesce(sum(${batchPlanBlocks.minutes}), 0)::int`,
      })
      .from(batchPlans)
      .leftJoin(batchPlanBlocks, eq(batchPlanBlocks.planId, batchPlans.id))
      .where(inArray(batchPlans.batchId, ids))
      .groupBy(batchPlans.batchId),
    db
      .select({ batchId: sessionPlans.batchId })
      .from(sessionPlans)
      .where(and(inArray(sessionPlans.batchId, ids), eq(sessionPlans.date, day))),
  ]);
  for (const b of list) {
    const length = toMin(b.endTime) - toMin(b.startTime);
    const adjusted = own.some((o) => o.batchId === b.id);
    const plan = plans.find((p) => p.batchId === b.id);
    out.set(b.id, {
      hasPlan: adjusted || !!plan,
      fits: adjusted || (!!plan && plan.minutes === length),
      /** The coach picked this day's drills. */
      filled: adjusted,
    });
  }
  return out;
}

// ─── Insights ────────────────────────────────────────────────────────────────

const InsightsQuery = z
  .object({ from: zIsoDate, to: zIsoDate, batchId: zId.optional() })
  .refine((q) => q.to >= q.from && diffDays(q.from, q.to) <= 180, {
    message: 'Choose a range of up to six months',
  });

/**
 * How lesson planning is going: per batch, how many of its held sessions (up to today, not
 * cancelled) had their drills filled in; the drills used most; week by week; and recent sessions
 * still not filled in. Admins see every batch, coaches their own.
 */
lessonsRouter.get('/insights', async (req, res) => {
  const q = parse(InsightsQuery, req.query);
  const user = currentUser(req);
  const today = todayInAppTz();
  const to = q.to > today ? today : q.to;
  const list = await db
    .select({
      id: batches.id,
      name: batches.name,
      weekdays: batches.weekdays,
      coachFeedback: batches.coachFeedback,
    })
    .from(batches)
    .where(
      and(
        eq(batches.isActive, true),
        // Attendance-only batches have no plans to fill in.
        eq(batches.coachFeedback, true),
        isAdmin(user) ? undefined : eq(batches.coachId, user.id),
        q.batchId ? eq(batches.id, q.batchId) : undefined,
      ),
    )
    .orderBy(asc(batches.name));
  const ids = list.map((b) => b.id);
  const [cancelled, filled] =
    ids.length && to >= q.from
      ? await Promise.all([
          cancellationsIn(ids, q.from, to),
          db
            .select({
              batchId: sessionPlans.batchId,
              date: sessionPlans.date,
              blocks: sessionPlans.blocks,
            })
            .from(sessionPlans)
            .where(
              and(
                inArray(sessionPlans.batchId, ids),
                gte(sessionPlans.date, q.from),
                lte(sessionPlans.date, to),
              ),
            ),
        ])
      : [new Map<string, string>(), []];

  const days = to >= q.from ? eachDay(q.from, to) : [];
  const filledKey = new Set(filled.map((f) => `${f.batchId}:${f.date}`));
  const weekOf = (d: IsoDate) => addDays(d, 1 - isoWeekday(d));
  const weeks = new Map<string, { start: IsoDate; sessions: number; filled: number }>();
  const unfilled: { batchId: string; batchName: string; date: IsoDate }[] = [];
  const perBatch = list.map((b) => {
    let sessions = 0;
    let done = 0;
    for (const d of days) {
      if (!b.weekdays.includes(isoWeekday(d)) || cancelled.has(`${b.id}:${d}`)) continue;
      sessions++;
      const isFilled = filledKey.has(`${b.id}:${d}`);
      if (isFilled) done++;
      else unfilled.push({ batchId: b.id, batchName: b.name, date: d });
      const w = weeks.get(weekOf(d)) ?? { start: weekOf(d), sessions: 0, filled: 0 };
      w.sessions++;
      if (isFilled) w.filled++;
      weeks.set(w.start, w);
    }
    return {
      id: b.id,
      name: b.name,
      sessions,
      filled: done,
      rate: sessions ? done / sessions : null,
    };
  });

  // Drills actually run (from filled-in sessions), most used first.
  const drills = new Map<
    string,
    { name: string; block: string; sessions: number; batches: Set<string> }
  >();
  const blockMinutes = new Map<string, { name: string; color: string | null; minutes: number }>();
  for (const f of filled)
    for (const block of f.blocks) {
      const bm = blockMinutes.get(block.name) ?? {
        name: block.name,
        color: block.color,
        minutes: 0,
      };
      bm.minutes += block.minutes;
      blockMinutes.set(block.name, bm);
      for (const d of block.drills) {
        const key = d.name.trim().toLowerCase();
        const row = drills.get(key) ?? {
          name: d.name.trim(),
          block: block.name,
          sessions: 0,
          batches: new Set<string>(),
        };
        row.sessions++;
        row.batches.add(f.batchId);
        drills.set(key, row);
      }
    }
  const totalSessions = perBatch.reduce((n, b) => n + b.sessions, 0);
  const totalFilled = perBatch.reduce((n, b) => n + b.filled, 0);
  ok(res, {
    from: q.from,
    to,
    totals: {
      sessions: totalSessions,
      filled: totalFilled,
      rate: totalSessions ? totalFilled / totalSessions : null,
      drills: drills.size,
    },
    batches: perBatch,
    weeks: [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start)),
    drills: [...drills.values()]
      .map((d) => ({ name: d.name, block: d.block, sessions: d.sessions, batches: d.batches.size }))
      .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
      .slice(0, 15),
    blocks: [...blockMinutes.values()].sort((a, b) => b.minutes - a.minutes),
    // Most recent first.
    unfilled: unfilled.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
  });
});
