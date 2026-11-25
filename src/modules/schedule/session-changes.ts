/**
 * Rescheduling missed sessions, and (admins) moving or adding sessions.
 *
 *  - Coach, or the substitute covering that day: a missed (cancelled / not held) session, to any
 *    future day within 30 days of its original date. The batch's own coach also moves one that
 *    hasn't started (unless someone else moved it there). In effect at once; admins are told.
 *  - Admin: also further than 30 days, sessions moved by others, and extra sessions.
 *
 * Always at the same location, on a day the batch has no session, with the coach free then.
 * Warned (and confirmable): students outside their billing month, a shared ground, students with
 * another batch at that time. A session is identified by (batch, date); a moved one keeps the
 * roster and the cycle of its original day.
 */
import {
  aliasedTable,
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batchCycles,
  batchSubstitutions,
  batches,
  coachSessions,
  enrollments,
  locations,
  makeupSessions,
  sessionCancellations,
  sessionChanges,
  sessionPlans,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { clockLabel, timesOn, type DayTimes } from '../../lib/batch-times.js';
import {
  addDays,
  diffDays,
  eachDay,
  formatDisplayDate,
  instantAt,
  maxDate,
  minDate,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText, zTime } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { getBatchOrThrow, isAdmin, isSubstituteFor } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { cycleFor } from '../billing/cycle.js';
import { monthContaining } from '../cycles/cycle-math.js';
import { cycleProgress } from '../cycles/progress.js';
import { anchorOf } from '../cycles/cycles.js';
import { notifyAdmins, notifyInBackground, notifyUsers } from '../push/push.service.js';
import {
  belongsTo,
  isRegularDay,
  memberSessions,
  rosterDay,
  scheduleFor,
  sessionOn,
  type ScheduledSession,
} from './schedule.js';

/** Days after a missed session's original date in which a coach can reschedule it. */
export const RESCHEDULE_DAYS = 30;
/** How far from the original day an admin can place a session (and how far ahead extras go). */
export const ADMIN_DAYS = 90;
const LOCK = 0x53434847; // "SCHG": one schedule change at a time, so two can't claim a day.

type Batch = Awaited<ReturnType<typeof getBatchOrThrow>>;
type Slot = { date: IsoDate; startTime: string; endTime: string };

export interface ChangeRequest {
  /** The session being moved, by its current date; absent for a new extra session. */
  sessionDate?: IsoDate;
  date: IsoDate;
  startTime: string;
  endTime: string;
}

export interface Warning {
  code: 'outside-window' | 'location-overlap' | 'students-busy';
  message: string;
  students?: { id: string; fullName: string; detail: string }[];
}

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};
const norm = (t: string) => (t.length === 5 ? `${t}:00` : t);
const overlaps = (a: Omit<Slot, 'date'>, b: Omit<Slot, 'date'>) =>
  toMin(a.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(a.endTime);
const nice = formatDisplayDate;
const span = (t: Omit<Slot, 'date'>) => `${clockLabel(t.startTime)}–${clockLabel(t.endTime)}`;

/** The batch, locked: check-ins, attendance and cancellations of it wait for this change. */
async function batchIn(tx: DbOrTx, id: string): Promise<Batch> {
  const [b] = await tx.select().from(batches).where(eq(batches.id, id)).for('update');
  if (!b) throw AppError.notFound('Batch');
  return b;
}

/** Approved substitutions in effect on `date`. */
const covering = (date: IsoDate) =>
  and(
    eq(batchSubstitutions.status, 'approved'),
    lte(batchSubstitutions.fromDate, date),
    gte(batchSubstitutions.toDate, date),
  );

/** The coach running the batch's session on `date`: an approved substitute, else its coach. */
async function coachOn(batch: Batch, date: IsoDate, tx: DbOrTx): Promise<string> {
  const [sub] = await tx
    .select({ id: batchSubstitutions.substituteCoachId })
    .from(batchSubstitutions)
    .where(and(eq(batchSubstitutions.batchId, batch.id), covering(date)))
    .limit(1);
  return sub?.id ?? batch.coachId;
}

const timing = {
  id: batches.id,
  name: batches.name,
  weekdays: batches.weekdays,
  startTime: batches.startTime,
  endTime: batches.endTime,
  dayTimes: batches.dayTimes,
};

async function cancelledOn(batchIds: string[], date: IsoDate, tx: DbOrTx) {
  if (!batchIds.length) return new Set<string>();
  const rows = await tx
    .select({ batchId: sessionCancellations.batchId })
    .from(sessionCancellations)
    .where(
      and(inArray(sessionCancellations.batchId, batchIds), eq(sessionCancellations.date, date)),
    );
  return new Set(rows.map((r) => r.batchId));
}

/** The running (not cancelled) sessions of these batches that overlap a slot. */
async function running(where: SQL | undefined, at: Slot, tx: DbOrTx) {
  const list = await tx
    .select(timing)
    .from(batches)
    .where(and(eq(batches.isActive, true), where));
  const ids = list.map((b) => b.id);
  const [sched, off] = await Promise.all([
    scheduleFor(list, at.date, at.date, tx),
    cancelledOn(ids, at.date, tx),
  ]);
  return list.flatMap((b) => {
    const s = sched.get(b.id)?.[0];
    return s && !off.has(b.id) && overlaps(s, at) ? [{ batch: b, session: s }] : [];
  });
}

/** A session the coach runs at that time: own batches they still run that day, and covers. */
async function coachBusy(coachId: string, at: Slot, exceptBatch: string, tx: DbOrTx) {
  const subs = await tx
    .select({ batchId: batchSubstitutions.batchId, coach: batchSubstitutions.substituteCoachId })
    .from(batchSubstitutions)
    .where(covering(at.date));
  const covered = subs.filter((s) => s.coach !== coachId).map((s) => s.batchId);
  const mine = subs.filter((s) => s.coach === coachId).map((s) => s.batchId);
  const [first] = await running(
    and(
      ne(batches.id, exceptBatch),
      or(
        and(
          eq(batches.coachId, coachId),
          covered.length ? sql`${batches.id} not in ${covered}` : undefined,
        ),
        mine.length ? inArray(batches.id, mine) : undefined,
      ),
    ),
    at,
    tx,
  );
  return first ?? null;
}

async function hasRecords(batchId: string, date: IsoDate, tx: DbOrTx) {
  const marks = await tx.$count(
    studentAttendance,
    and(eq(studentAttendance.batchId, batchId), eq(studentAttendance.date, date)),
  );
  const checkIns = await tx.$count(
    coachSessions,
    and(eq(coachSessions.batchId, batchId), eq(coachSessions.date, date)),
  );
  return marks > 0 || checkIns > 0;
}

/**
 * Students of a session (by its roster day) who are still in the batch, with the billing month
 * the session belongs to.
 */
export async function affectedStudents(tx: DbOrTx, batchId: string, session: ScheduledSession) {
  return affectedOf(await currentMembers(tx, [batchId]), batchId, session);
}

/** Members of the batches who haven't left yet. */
async function currentMembers(tx: DbOrTx, batchIds: string[]) {
  const today = todayInAppTz();
  return tx
    .select({ e: enrollments, fullName: students.fullName, leftOn: students.leftOn })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        inArray(enrollments.batchId, batchIds),
        or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, today)),
        or(isNull(students.leftOn), gte(students.leftOn, today)),
      ),
    );
}

function affectedOf(
  members: Awaited<ReturnType<typeof currentMembers>>,
  batchId: string,
  session: ScheduledSession,
) {
  const day = rosterDay(session);
  return members
    .filter(
      ({ e, leftOn }) =>
        e.batchId === batchId &&
        e.effectiveFrom <= day &&
        (!e.effectiveTo || e.effectiveTo >= day) &&
        (!e.plannedEndOn || e.plannedEndOn >= day) &&
        (!leftOn || leftOn >= day) &&
        belongsTo(e, session),
    )
    .map(({ e, fullName }) => {
      const month = cycleFor(anchorOf(e), monthContaining(anchorOf(e), day));
      // Their month, or their last day when they leave before it ends.
      const until = e.plannedEndOn ? minDate(e.plannedEndOn, month.periodEnd) : month.periodEnd;
      return { id: e.studentId, fullName, until, enrollment: e };
    });
}
type Affected = Awaited<ReturnType<typeof affectedStudents>>;

async function busyStudents(list: Affected, batchId: string, at: Slot, tx: DbOrTx) {
  if (!list.length) return [];
  const others = await tx
    .select({ e: enrollments, name: batches.name })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(
      and(
        inArray(
          enrollments.studentId,
          list.map((s) => s.id),
        ),
        ne(enrollments.batchId, batchId),
        eq(batches.isActive, true),
        lte(enrollments.effectiveFrom, at.date),
        or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, at.date)),
      ),
    );
  if (!others.length) return [];
  const sessions = await memberSessions(
    others.map((o) => o.e),
    at.date,
    at.date,
    tx,
  );
  const hits = sessions.filter((s) => overlaps(s, at));
  return list.flatMap((s) => {
    const o = others.find((x) => x.e.studentId === s.id && hits.some((h) => belongsTo(x.e, h)));
    return o ? [{ id: s.id, fullName: s.fullName, detail: o.name }] : [];
  });
}

/** Why the batch can't have this session on that day and time, or null. */
async function slotBlocker(
  batch: Batch,
  at: Slot,
  current: ScheduledSession | null,
  allowSameDay: boolean,
  now: Date,
  tx: DbOrTx,
): Promise<string | null> {
  if (instantAt(at.date, at.startTime) <= now) return 'Choose a time in the future.';
  const original = current ? rosterDay(current) : null;
  const sameDay = allowSameDay && original === at.date;
  if (!sameDay && isRegularDay(batch, at.date))
    return `${batch.name} already runs on ${nice(at.date)}. Choose a day it doesn’t run.`;
  const [taken] = await tx
    .select({ id: sessionChanges.id })
    .from(sessionChanges)
    .where(
      and(
        eq(sessionChanges.batchId, batch.id),
        eq(sessionChanges.date, at.date),
        eq(sessionChanges.status, 'approved'),
        current?.changeId ? ne(sessionChanges.id, current.changeId) : undefined,
      ),
    );
  if (taken) return `${batch.name} already has a session on ${nice(at.date)}.`;
  const coachId = await coachOn(batch, at.date, tx);
  const busy = await coachBusy(coachId, at, batch.id, tx);
  if (busy) return `The coach already has ${busy.batch.name} at ${span(busy.session)} that day.`;
  return null;
}

/** Whether this user made the change. */
const requestedBy = async (changeId: string, userId: string, tx: DbOrTx) =>
  (await tx.$count(
    sessionChanges,
    and(eq(sessionChanges.id, changeId), eq(sessionChanges.requestedById, userId)),
  )) > 0;

/** Checks a change without making it. */
export async function evaluate(
  user: AuthUser,
  batch: Batch,
  req: ChangeRequest,
  { now = new Date(), tx = db }: { now?: Date; tx?: DbOrTx } = {},
) {
  const errors: string[] = [];
  const warnings: Warning[] = [];
  const at: Slot = { date: req.date, startTime: norm(req.startTime), endTime: norm(req.endTime) };
  const admin = isAdmin(user);

  const current = req.sessionDate ? await sessionOn(batch, req.sessionDate, tx) : null;
  if (req.sessionDate && !current)
    throw AppError.unprocessable(`${batch.name} has no session on ${nice(req.sessionDate)}`);
  const extra = !current || current.kind === 'extra';
  const original = current ? rosterDay(current) : null;
  const [cancellation] = current
    ? await tx
        .select()
        .from(sessionCancellations)
        .where(
          and(
            eq(sessionCancellations.batchId, batch.id),
            eq(sessionCancellations.date, current.date),
          ),
        )
    : [];
  const missed = !!cancellation;

  if (!admin && extra) errors.push('Only an admin can add or move extra sessions.');
  else if (!admin && !missed && batch.coachId !== user.id)
    errors.push('Substitutes can only reschedule missed sessions. Ask the coach or an admin.');
  else if (
    !admin &&
    !missed &&
    current?.changeId &&
    !(await requestedBy(current.changeId, user.id, tx))
  )
    errors.push('Someone else moved this session. Ask an admin to move it again.');
  if (toMin(at.endTime) <= toMin(at.startTime))
    errors.push('The session must end after it starts.');
  if (!batch.isActive) errors.push(`${batch.name} is inactive.`);

  if (current) {
    if (cancellation?.closedAt)
      errors.push('This missed session was closed, so it isn’t rescheduled any more.');
    if (!missed && instantAt(current.date, current.startTime) <= now)
      errors.push('This session has already started.');
    if (await hasRecords(batch.id, current.date, tx))
      errors.push('Attendance or a check-in is already recorded for this session.');
    if (
      current.date === at.date &&
      current.startTime === at.startTime &&
      current.endTime === at.endTime
    )
      errors.push('That is when the session already runs.');
    if (missed && at.date <= original!) errors.push('Choose a day after the missed session.');
    // A missed session goes back to its own day only by undoing, or it would be cancelled there.
    if (
      !missed &&
      current.date !== original &&
      at.date === original &&
      (await cancelledOn([batch.id], at.date, tx)).size
    )
      errors.push('It was cancelled that day. Undo the reschedule instead.');
    const limit = admin ? ADMIN_DAYS : RESCHEDULE_DAYS;
    if (Math.abs(diffDays(original!, at.date)) > limit)
      errors.push(
        admin
          ? `Choose a day within ${ADMIN_DAYS} days of ${nice(original!)}.`
          : `It can be rescheduled up to ${nice(addDays(original!, RESCHEDULE_DAYS))}. Ask an admin for a later day.`,
      );
  } else if (diffDays(todayInAppTz(now), at.date) > ADMIN_DAYS)
    errors.push(`Extra sessions can be planned up to ${ADMIN_DAYS} days ahead.`);

  const blocked = await slotBlocker(batch, at, current, !missed && !extra, now, tx);
  if (blocked) errors.push(blocked);

  const affected = await affectedStudents(
    tx,
    batch.id,
    current ?? {
      batchId: batch.id,
      ...at,
      kind: 'extra',
      originalDate: null,
      changeId: null,
    },
  );
  const outside = current ? affected.filter((s) => at.date > s.until) : [];
  if (outside.length)
    warnings.push({
      code: 'outside-window',
      message: `After the billing month of ${outside.length} student${outside.length === 1 ? '' : 's'}. They can still attend, free.`,
      students: outside.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        detail: `until ${nice(s.until)}`,
      })),
    });
  const sharing = await running(
    and(eq(batches.locationId, batch.locationId), ne(batches.id, batch.id)),
    at,
    tx,
  );
  if (sharing.length)
    warnings.push({
      code: 'location-overlap',
      message: `${sharing.map((s) => s.batch.name).join(', ')} also run${sharing.length === 1 ? 's' : ''} at this location then.`,
    });
  const clashing = await busyStudents(affected, batch.id, at, tx);
  if (clashing.length)
    warnings.push({
      code: 'students-busy',
      message: `${clashing.length} student${clashing.length === 1 ? ' has' : 's have'} another batch then.`,
      students: clashing,
    });

  return {
    errors,
    warnings,
    kind: extra ? ('extra' as const) : ('reschedule' as const),
    originalDate: extra ? null : original,
    fromDate: current?.date ?? null,
    replaces: current?.changeId ?? null,
    missed,
    affected: affected.length,
  };
}

/**
 * Days a missed session can go to, and the "smart" ones: inside the billing month of every
 * student it affects.
 */
export async function smartDates(
  user: AuthUser,
  batch: Batch,
  sessionDate: IsoDate,
  time: { startTime?: string; endTime?: string },
  now: Date = new Date(),
) {
  const current = await sessionOn(batch, sessionDate);
  if (!current)
    throw AppError.unprocessable(`${batch.name} has no session on ${nice(sessionDate)}`);
  const original = rosterDay(current);
  const affected = await affectedStudents(db, batch.id, current);
  const from = maxDate(todayInAppTz(now), addDays(original, 1));
  const to = addDays(original, RESCHEDULE_DAYS);
  const slot = {
    startTime: norm(time.startTime ?? current.startTime),
    endTime: norm(time.endTime ?? current.endTime),
  };
  const days = [];
  for (const date of from <= to ? eachDay(from, to) : []) {
    const blocked = await slotBlocker(batch, { date, ...slot }, current, false, now, db);
    const outside = affected.filter((s) => date > s.until).map((s) => s.fullName);
    days.push({
      date,
      blocked,
      outside,
      smart: !blocked && !outside.length && affected.length > 0,
    });
  }
  const smart = days.filter((d) => d.smart).length;
  return {
    sessionDate,
    originalDate: original,
    students: affected.length,
    days,
    message: !affected.length
      ? 'No students are affected by this session.'
      : smart
        ? null
        : 'No day suits every student’s billing month. You can still pick any available day.',
  };
}

/** Moves booked makeups and the session's own lesson plan from one day to another. */
async function carryOver(batchId: string, from: IsoDate, to: IsoDate, tx: DbOrTx) {
  if (from === to) return;
  await tx
    .delete(makeupSessions)
    .where(
      and(
        eq(makeupSessions.batchId, batchId),
        eq(makeupSessions.date, to),
        eq(makeupSessions.status, 'rejected'),
      ),
    );
  await tx
    .update(makeupSessions)
    .set({ date: to })
    .where(and(eq(makeupSessions.batchId, batchId), eq(makeupSessions.date, from)));
  await tx
    .delete(sessionPlans)
    .where(and(eq(sessionPlans.batchId, batchId), eq(sessionPlans.date, to)));
  await tx
    .update(sessionPlans)
    .set({ date: to })
    .where(and(eq(sessionPlans.batchId, batchId), eq(sessionPlans.date, from)));
}

/**
 * A moved / extra session leaves its day: a cancellation recorded there goes with it (the audit
 * log keeps it), so a later session on that day doesn't start out cancelled.
 */
async function vacate(tx: DbOrTx, changeId: string) {
  const [c] = await tx
    .update(sessionChanges)
    .set({ status: 'cancelled' })
    .where(eq(sessionChanges.id, changeId))
    .returning();
  if (c && c.date !== c.originalDate)
    await tx
      .delete(sessionCancellations)
      .where(
        and(eq(sessionCancellations.batchId, c.batchId), eq(sessionCancellations.date, c.date)),
      );
}

// ─── Listing ─────────────────────────────────────────────────────────────────

const requester = aliasedTable(users, 'requester');
const coach = aliasedTable(users, 'coach');

interface Person {
  id: string;
  name: string;
}
interface ChangeRowFull extends Slot {
  id: string;
  kind: 'reschedule' | 'extra';
  originalDate: IsoDate | null;
  status: 'approved' | 'cancelled';
  reason: string | null;
  createdAt: Date;
  batch: {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    dayTimes: DayTimes;
  };
  location: Person;
  coach: Person;
  requestedBy: Person;
}

export async function listChanges(where: SQL | undefined) {
  const rows: ChangeRowFull[] = await db
    .select({
      id: sessionChanges.id,
      kind: sessionChanges.kind,
      originalDate: sessionChanges.originalDate,
      date: sessionChanges.date,
      startTime: sessionChanges.startTime,
      endTime: sessionChanges.endTime,
      status: sessionChanges.status,
      reason: sessionChanges.reason,
      createdAt: sessionChanges.createdAt,
      batch: {
        id: batches.id,
        name: batches.name,
        startTime: batches.startTime,
        endTime: batches.endTime,
        dayTimes: batches.dayTimes,
      },
      location: { id: locations.id, name: locations.name },
      coach: { id: coach.id, name: coach.name },
      requestedBy: { id: requester.id, name: requester.name },
    })
    .from(sessionChanges)
    .innerJoin(batches, eq(batches.id, sessionChanges.batchId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(requester, eq(requester.id, sessionChanges.requestedById))
    .where(where)
    .orderBy(desc(sessionChanges.date))
    .limit(300);
  return rows.map(({ batch, ...r }) => ({
    ...r,
    batch: { id: batch.id, name: batch.name, startTime: batch.startTime, endTime: batch.endTime },
    from: r.originalDate ? { date: r.originalDate, ...timesOn(batch, r.originalDate) } : null,
  }));
}
type ChangeView = Awaited<ReturnType<typeof listChanges>>[number];

async function one(id: string) {
  const [row] = await listChanges(eq(sessionChanges.id, id));
  if (!row) throw AppError.notFound('Session change');
  return row;
}

const describe = (r: ChangeView) =>
  r.kind === 'extra'
    ? `Extra session ${nice(r.date)} ${span(r)}`
    : r.originalDate === r.date
      ? `${nice(r.date)} now ${span(r)}`
      : `${nice(r.originalDate!)} → ${nice(r.date)} ${span(r)}`;

/** Tells the batch's coach, that day's substitute and (for a coach's change) the admins. */
function notice(r: ChangeView, actor: AuthUser, title: string) {
  notifyInBackground(async () => {
    const [sub] = await db
      .select({ id: batchSubstitutions.substituteCoachId })
      .from(batchSubstitutions)
      .where(and(eq(batchSubstitutions.batchId, r.batch.id), covering(r.date)));
    const message = {
      category: 'sessions' as const,
      icon: '🗓️',
      title: `${title} · ${r.batch.name}`,
      body: `${describe(r)}${r.reason ? ` — ${r.reason}` : ''}`,
      link: `/batches/${r.batch.id}`,
      tag: `session-change-${r.id}`,
    };
    const people = [r.coach.id, sub?.id].filter((x): x is string => !!x && x !== actor.id);
    await notifyUsers(people, message);
    if (!isAdmin(actor)) await notifyAdmins({ ...message, body: `${actor.name}: ${message.body}` });
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const ChangeBody = z.object({
  sessionDate: zIsoDate.optional(),
  date: zIsoDate,
  startTime: zTime,
  endTime: zTime,
  reason: zOptionalText(300),
  /** The caller saw the warnings and goes ahead. */
  confirm: z.boolean().optional(),
});

/** Admins, the batch's coach, or its substitute on the session's day. */
async function assertMayChange(user: AuthUser, batchId: string, day: IsoDate) {
  const batch = await getBatchOrThrow(batchId);
  if (isAdmin(user) || batch.coachId === user.id) return batch;
  if (await isSubstituteFor(user.id, batchId, day)) return batch;
  throw AppError.notFound('Batch');
}

/** Mounted at /batches. */
export const batchSessionChangesRouter = Router();

batchSessionChangesRouter.get('/:id/session-changes', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const batch = await getBatchOrThrow(id);
  if (!isAdmin(user) && batch.coachId !== user.id && !(await isSubstituteFor(user.id, id)))
    throw AppError.notFound('Batch');
  ok(
    res,
    await listChanges(
      and(
        eq(sessionChanges.batchId, id),
        eq(sessionChanges.status, 'approved'),
        gte(sessionChanges.date, addDays(todayInAppTz(), -30)),
      ),
    ),
  );
});

const SmartQuery = z.object({
  sessionDate: zIsoDate,
  startTime: zTime.optional(),
  endTime: zTime.optional(),
});

batchSessionChangesRouter.get('/:id/smart-dates', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const q = parse(SmartQuery, req.query);
  const user = currentUser(req);
  const batch = await assertMayChange(user, id, q.sessionDate);
  ok(res, await smartDates(user, batch, q.sessionDate, q));
});

batchSessionChangesRouter.post('/:id/session-changes/preview', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ChangeBody, req.body);
  const user = currentUser(req);
  const batch = await assertMayChange(user, id, body.sessionDate ?? body.date);
  const e = await evaluate(user, batch, body);
  ok(res, { ok: !e.errors.length, ...e });
});

batchSessionChangesRouter.post('/:id/session-changes', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ChangeBody, req.body);
  const user = currentUser(req);
  await assertMayChange(user, id, body.sessionDate ?? body.date);

  const { changeId, kind } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const batch = await batchIn(tx, id);
    const e = await evaluate(user, batch, body, { tx });
    if (e.errors.length) throw AppError.unprocessable(e.errors[0]!, { errors: e.errors });
    if (e.warnings.length && !body.confirm)
      throw AppError.conflict(`Please confirm: ${e.warnings.map((w) => w.message).join(' ')}`, {
        warnings: e.warnings,
      });
    // Moving a moved / extra session again: the old change steps aside first.
    if (e.replaces) await vacate(tx, e.replaces);
    const [row] = await tx
      .insert(sessionChanges)
      .values({
        batchId: id,
        kind: e.kind,
        originalDate: e.originalDate,
        date: body.date,
        startTime: norm(body.startTime),
        endTime: norm(body.endTime),
        reason: body.reason ?? null,
        requestedById: user.id,
      })
      .returning({ id: sessionChanges.id });
    if (e.fromDate) await carryOver(id, e.fromDate, body.date, tx);
    await audit(
      {
        ...auditCtx(req),
        action: e.kind === 'extra' ? 'session.extra_added' : 'session.rescheduled',
        entityType: 'batch',
        entityId: id,
        metadata: { changeId: row!.id, ...e, ...body },
      },
      tx,
    );
    return { changeId: row!.id, kind: e.kind };
  });

  const row = await one(changeId);
  notice(row, user, kind === 'extra' ? 'Extra session' : 'Session rescheduled');
  created(res, row);
});

/** Mounted at /session-changes. */
export const sessionChangesRouter = Router();

/**
 * Undoes a change before its session starts: a rescheduled session goes back to its original day
 * (missed again, if it was missed); an extra session is dropped. Coaches: reschedules
 * of missed sessions, and their own moves in advance.
 */
sessionChangesRouter.post('/:id/cancel', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const c = await tx.query.sessionChanges.findFirst({ where: eq(sessionChanges.id, id) });
    if (!c) throw AppError.notFound('Session change');
    const batch = await batchIn(tx, c.batchId);
    const mine =
      isAdmin(user) ||
      (c.kind === 'reschedule' &&
        (batch.coachId === user.id || (await coachOn(batch, c.date, tx)) === user.id));
    if (!mine) throw AppError.notFound('Session change');
    if (c.status !== 'approved') throw AppError.conflict('This change was already undone');
    if (instantAt(c.date, c.startTime) <= now)
      throw AppError.conflict('This session has already started.');
    if (await hasRecords(c.batchId, c.date, tx))
      throw AppError.conflict('Attendance or a check-in is already recorded for this session.');
    if (c.kind === 'reschedule') {
      const [missed] = await tx
        .select({ id: sessionCancellations.id })
        .from(sessionCancellations)
        .where(
          and(
            eq(sessionCancellations.batchId, c.batchId),
            eq(sessionCancellations.date, c.originalDate!),
          ),
        );
      const back = timesOn(batch, c.originalDate!).startTime;
      if (!missed && instantAt(c.originalDate!, back) <= now)
        throw AppError.conflict('The regular time has passed, so the session can’t go back.');
      // A coach can't undo someone else's move in advance.
      if (!missed && !isAdmin(user) && c.requestedById !== user.id)
        throw AppError.forbidden('Ask an admin to undo this move.');
      await carryOver(c.batchId, c.date, c.originalDate!, tx);
    } else
      await tx
        .delete(sessionPlans)
        .where(and(eq(sessionPlans.batchId, c.batchId), eq(sessionPlans.date, c.date)));
    await vacate(tx, c.id);
    await audit(
      {
        ...auditCtx(req),
        action: 'session.change_undone',
        entityType: 'batch',
        entityId: c.batchId,
        metadata: { changeId: id, date: c.date, originalDate: c.originalDate },
      },
      tx,
    );
  });
  const row = await one(id);
  notice(row, user, row.kind === 'extra' ? 'Extra session dropped' : 'Reschedule undone');
  ok(res, row);
});

// ─── Missed sessions ─────────────────────────────────────────────────────────

/** Whose missed sessions: every batch's (the nightly job too), or a coach's own. */
type MissedScope = { role: 'admin' } | Pick<AuthUser, 'id' | 'role'>;
const missedScope = (user: MissedScope) =>
  'id' in user && user.role !== 'admin' ? eq(batches.coachId, user.id) : undefined;

/**
 * Missed sessions not yet rescheduled or closed (open), and ended sessions with neither a check-in
 * nor attendance that an admin still has to confirm (unconfirmed). Batches with a course only,
 * from the day it was set up.
 */
export async function missedSessions(user: MissedScope, now: Date = new Date()) {
  const today = todayInAppTz(now);
  const list = await db
    .select({
      ...timing,
      courseSetOn: batches.courseSetOn,
      coach: { id: users.id, name: users.name },
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      and(eq(batches.isActive, true), sql`${batches.courseMonths} is not null`, missedScope(user)),
    );
  if (!list.length) return { open: [], unconfirmed: [] };
  const ids = list.map((b) => b.id);
  const from = addDays(today, -ADMIN_DAYS);
  const inRange = <T extends { batchId: string; date: IsoDate }>(rows: T[]) =>
    new Map(rows.map((r) => [`${r.batchId}:${r.date}`, r]));
  const [members, schedule, cancels, checkIns, marks] = await Promise.all([
    currentMembers(db, ids),
    scheduleFor(list, from, addDays(today, ADMIN_DAYS)),
    db
      .select()
      .from(sessionCancellations)
      .where(and(inArray(sessionCancellations.batchId, ids), gte(sessionCancellations.date, from))),
    db
      .select({ batchId: coachSessions.batchId, date: coachSessions.date })
      .from(coachSessions)
      .where(and(inArray(coachSessions.batchId, ids), gte(coachSessions.date, from))),
    db
      .selectDistinct({ batchId: studentAttendance.batchId, date: studentAttendance.date })
      .from(studentAttendance)
      .where(and(inArray(studentAttendance.batchId, ids), gte(studentAttendance.date, from))),
  ]);
  const off = inRange(cancels);
  const held = inRange([...checkIns, ...marks]);
  const open = [];
  const unconfirmed = [];
  for (const b of list) {
    for (const s of schedule.get(b.id) ?? []) {
      if (b.courseSetOn && rosterDay(s) < b.courseSetOn) continue;
      const key = `${b.id}:${s.date}`;
      const c = off.get(key);
      if (c ? c.closedAt : held.has(key) || instantAt(s.date, s.endTime) > now) continue;
      const people = affectedOf(members, b.id, s);
      if (!people.length) continue;
      const original = rosterDay(s);
      const row = {
        batch: { id: b.id, name: b.name, coach: b.coach },
        date: s.date,
        originalDate: original,
        startTime: s.startTime,
        endTime: s.endTime,
        students: people.length,
        reason: c?.reason ?? null,
        missed: c?.missed ?? false,
        /** Coaches can reschedule until here; then only admins. */
        coachUntil: addDays(original, RESCHEDULE_DAYS),
        overdue: addDays(original, RESCHEDULE_DAYS) < today,
      };
      if (c) open.push(row);
      else unconfirmed.push(row);
    }
  }
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  return { open: open.sort(byDate), unconfirmed: unconfirmed.sort(byDate) };
}

/**
 * A missed session is optional when every student expected still gets their full count in that
 * cycle without it (a 13th or 14th session was missed).
 */
async function markOptional<
  T extends { batch: { id: string }; date: IsoDate; originalDate: IsoDate },
>(open: T[]): Promise<(T & { optional: boolean })[]> {
  if (!open.length) return [];
  const first = open.map((m) => m.originalDate).reduce(minDate);
  const cycles = await db
    .select()
    .from(batchCycles)
    .where(
      and(
        inArray(batchCycles.batchId, [...new Set(open.map((m) => m.batch.id))]),
        gte(batchCycles.endsOn, first),
        inArray(batchCycles.status, ['active', 'completed']),
      ),
    );
  const progress = await cycleProgress(cycles);
  return open.map((m) => {
    const hit = cycles
      .filter((c) => c.batchId === m.batch.id)
      .flatMap((c) => progress.get(c.id) ?? [])
      .filter((p) => p.sessions.some((s) => s.date === m.date));
    return {
      ...m,
      optional: hit.length > 0 && hit.every((p) => p.conducted + p.upcoming >= p.target),
    };
  });
}

sessionChangesRouter.get('/missed', async (req, res) => {
  const { open, unconfirmed } = await missedSessions(currentUser(req));
  ok(res, { open: await markOptional(open), unconfirmed });
});

const KeyBody = z.object({ batchId: zId, date: zIsoDate });

/** Admin: an unconfirmed session was missed (it can then be rescheduled). */
sessionChangesRouter.post('/missed/confirm', requireAdmin, async (req, res) => {
  const body = parse(KeyBody, req.body);
  const user = currentUser(req);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const batch = await batchIn(tx, body.batchId);
    const s = await sessionOn(batch, body.date, tx);
    if (!s) throw AppError.unprocessable(`${batch.name} has no session that day`);
    if (instantAt(s.date, s.endTime) > new Date())
      throw AppError.unprocessable('This session isn’t over yet.');
    if (await hasRecords(batch.id, body.date, tx))
      throw AppError.conflict('Attendance or a check-in is recorded, so it was held.');
    const [row] = await tx
      .insert(sessionCancellations)
      .values({
        ...body,
        reason: 'Missed by the coach',
        missed: true,
        cancelledById: user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw AppError.conflict('This session is already marked as missed');
    await audit(
      {
        ...auditCtx(req),
        action: 'session.missed_confirmed',
        entityType: 'batch',
        entityId: batch.id,
        metadata: body,
      },
      tx,
    );
  });
  const batch = await getBatchOrThrow(body.batchId);
  notifyInBackground(() =>
    notifyUsers([batch.coachId], {
      category: 'sessions',
      icon: '📅',
      title: `${batch.name} was missed on ${nice(body.date)}`,
      body: `Reschedule it by ${nice(addDays(body.date, RESCHEDULE_DAYS))}.`,
      link: '/missed-sessions',
      tag: `missed-${batch.id}-${body.date}`,
    }),
  );
  ok(res, { confirmed: true });
});

const CloseBody = KeyBody.extend({
  reason: z.string().trim().min(3, 'Please give a reason').max(300),
});

/** Admin: a missed session won't be rescheduled. */
sessionChangesRouter.post('/missed/close', requireAdmin, async (req, res) => {
  const { batchId, date, reason } = parse(CloseBody, req.body);
  const user = currentUser(req);
  const [row] = await db
    .update(sessionCancellations)
    .set({ closedAt: new Date(), closedById: user.id, closedReason: reason })
    .where(
      and(
        eq(sessionCancellations.batchId, batchId),
        eq(sessionCancellations.date, date),
        isNull(sessionCancellations.closedAt),
      ),
    )
    .returning();
  if (!row) throw AppError.notFound('Missed session');
  await audit({
    ...auditCtx(req),
    action: 'session.missed_closed',
    entityType: 'batch',
    entityId: batchId,
    metadata: { date, reason },
  });
  ok(res, { closed: true });
});
