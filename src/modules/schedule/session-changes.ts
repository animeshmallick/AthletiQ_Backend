/**
 * Rescheduling a session and adding extra sessions.
 *
 * Who: admins, the batch's coach, or an approved substitute for the session's day.
 *  - Admin → in effect immediately.
 *  - Coach / substitute with at least 24 hours' notice (counted to the earlier of the old and the
 *    new start) → in effect immediately, admins are told. Less notice → waits for an admin.
 *  - Pending requests expire when the session they're about was due to start.
 *
 * Where to: a future day within ±14 days of the regular day (extra sessions: any future day up to
 * 60 days ahead) that the batch doesn't normally run and has no other moved / extra session. A
 * same-day time change is allowed until the session starts. Same location (a batch has one).
 *
 * Blocked when the coach running it is busy then, or the session already started, was cancelled,
 * or has attendance / a check-in. Warned (can still go ahead) when another batch at the location
 * overlaps or some students have another batch then.
 *
 * Booked makeups and the session's own lesson-plan copy move with the session.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
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
  formatDisplayDate,
  instantAt,
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
import { notifyAdmins, notifyInBackground, notifyUsers } from '../push/push.service.js';
import {
  isRegularDay,
  memberSessions,
  rosterDay,
  scheduleFor,
  sessionOn,
  type ScheduledSession,
} from './schedule.js';

/** How far from its regular day a session can move. */
export const MOVE_WINDOW_DAYS = 14;
/** How far ahead an extra session can be planned. */
export const EXTRA_DAYS_AHEAD = 60;
/** Coaches with at least this much notice don't need an admin. */
export const NOTICE_HOURS = 24;
const LOCK = 0x53434847; // "SCHG": one schedule change at a time, so two can't claim a day.

type Batch = Awaited<ReturnType<typeof getBatchOrThrow>>;

export interface ChangeRequest {
  /** The session being moved, by its current date; absent for a new extra session. */
  sessionDate?: IsoDate;
  date: IsoDate;
  startTime: string;
  endTime: string;
  reason?: string | null;
}

export interface Warning {
  code: 'location-overlap' | 'students-busy';
  message: string;
  batches?: { id: string; name: string }[];
  students?: { id: string; fullName: string; batchName: string }[];
}

export interface Evaluation {
  errors: string[];
  warnings: Warning[];
  kind: 'reschedule' | 'extra';
  /** The regular day being moved (reschedule), else null. */
  originalDate: IsoDate | null;
  /** The session's current date when it is being moved again, or moved for the first time. */
  fromDate: IsoDate | null;
  /** An approved change this one replaces (moving a moved / extra session again). */
  replaces: string | null;
  needsApproval: boolean;
  noticeHours: number | null;
  /** Who runs the session on the new day. */
  coachId: string;
}

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};
const norm = (t: string) => (t.length === 5 ? `${t}:00` : t);
const overlaps = (
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
) => toMin(a.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(a.endTime);
const nice = (d: IsoDate) => formatDisplayDate(d);
const span = (t: { startTime: string; endTime: string }) =>
  `${clockLabel(t.startTime)}–${clockLabel(t.endTime)}`;

/** Loads a batch through the given handle (inside a transaction, never the pool). */
async function batchIn(tx: DbOrTx, id: string): Promise<Batch> {
  const b = await tx.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!b) throw AppError.notFound('Batch');
  return b;
}

/** The coach running the batch's session on `date`: an approved substitute, else its coach. */
async function coachOn(batch: Batch, date: IsoDate, tx: DbOrTx): Promise<string> {
  const [sub] = await tx
    .select({ id: batchSubstitutions.substituteCoachId })
    .from(batchSubstitutions)
    .where(
      and(
        eq(batchSubstitutions.batchId, batch.id),
        eq(batchSubstitutions.status, 'approved'),
        lte(batchSubstitutions.fromDate, date),
        gte(batchSubstitutions.toDate, date),
      ),
    )
    .limit(1);
  return sub?.id ?? batch.coachId;
}

const timing = {
  id: batches.id,
  name: batches.name,
  coachId: batches.coachId,
  locationId: batches.locationId,
  weekdays: batches.weekdays,
  startTime: batches.startTime,
  endTime: batches.endTime,
  dayTimes: batches.dayTimes,
};

/** The coach's other sessions on `date` (own batches they still run that day + batches covered). */
async function coachBusy(
  coachId: string,
  date: IsoDate,
  exceptBatch: string,
  tx: DbOrTx,
): Promise<{ name: string; startTime: string; endTime: string }[]> {
  const covered = tx
    .select({ id: batchSubstitutions.batchId })
    .from(batchSubstitutions)
    .where(
      and(
        eq(batchSubstitutions.status, 'approved'),
        lte(batchSubstitutions.fromDate, date),
        gte(batchSubstitutions.toDate, date),
      ),
    );
  const coverSubs = tx
    .select({ id: batchSubstitutions.batchId })
    .from(batchSubstitutions)
    .where(
      and(
        eq(batchSubstitutions.substituteCoachId, coachId),
        eq(batchSubstitutions.status, 'approved'),
        lte(batchSubstitutions.fromDate, date),
        gte(batchSubstitutions.toDate, date),
      ),
    );
  const list = await tx
    .select(timing)
    .from(batches)
    .where(
      and(
        eq(batches.isActive, true),
        ne(batches.id, exceptBatch),
        or(
          // Their own batch, unless someone else covers it that day…
          and(eq(batches.coachId, coachId), sql`${batches.id} not in ${covered}`),
          // …or a batch they cover.
          inArray(batches.id, coverSubs),
        ),
      ),
    );
  const sched = await scheduleFor(list, date, date, tx);
  const cancelled = await cancelledOn(
    list.map((b) => b.id),
    date,
    tx,
  );
  return list.flatMap((b) => {
    const s = sched.get(b.id)?.[0];
    return s && !cancelled.has(b.id)
      ? [{ name: b.name, startTime: s.startTime, endTime: s.endTime }]
      : [];
  });
}

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

/** Attendance marks or a check-in on the batch's session that day (it happened). */
async function hasRecords(batchId: string, date: IsoDate, tx: DbOrTx) {
  const [marks, checkIns] = await Promise.all([
    tx.$count(
      studentAttendance,
      and(eq(studentAttendance.batchId, batchId), eq(studentAttendance.date, date)),
    ),
    tx.$count(coachSessions, and(eq(coachSessions.batchId, batchId), eq(coachSessions.date, date))),
  ]);
  return marks > 0 || checkIns > 0;
}

/** Students of the session who have another batch overlapping the new time. */
async function busyStudents(
  batch: Batch,
  rosterOn: IsoDate,
  at: { date: IsoDate; startTime: string; endTime: string },
  tx: DbOrTx,
) {
  const members = await tx
    .select({
      studentId: enrollments.studentId,
      trainingDays: enrollments.trainingDays,
      fullName: students.fullName,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        eq(enrollments.batchId, batch.id),
        lte(enrollments.effectiveFrom, rosterOn),
        or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, rosterOn)),
        or(isNull(students.leftOn), gte(students.leftOn, rosterOn)),
      ),
    );
  const ids = members.map((m) => m.studentId);
  if (!ids.length) return [];
  const others = await tx
    .select({
      studentId: enrollments.studentId,
      batchId: enrollments.batchId,
      effectiveFrom: enrollments.effectiveFrom,
      effectiveTo: enrollments.effectiveTo,
      trainingDays: enrollments.trainingDays,
      batchName: batches.name,
    })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(
      and(
        inArray(enrollments.studentId, ids),
        ne(enrollments.batchId, batch.id),
        eq(batches.isActive, true),
        lte(enrollments.effectiveFrom, at.date),
        or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, at.date)),
      ),
    );
  const out: { id: string; fullName: string; batchName: string }[] = [];
  for (const m of members) {
    const mine = others.filter((o) => o.studentId === m.studentId);
    if (!mine.length) continue;
    const sessions = await memberSessions(mine, at.date, at.date, tx);
    const clash = sessions.find((s) => overlaps(s, at));
    if (clash)
      out.push({
        id: m.studentId,
        fullName: m.fullName,
        batchName: mine.find((o) => o.batchId === clash.batchId)!.batchName,
      });
  }
  return out;
}

/** Other batches at the same location running at an overlapping time that day. */
async function locationOverlap(
  batch: Batch,
  at: { date: IsoDate; startTime: string; endTime: string },
  tx: DbOrTx,
) {
  const list = await tx
    .select(timing)
    .from(batches)
    .where(
      and(
        eq(batches.locationId, batch.locationId),
        eq(batches.isActive, true),
        ne(batches.id, batch.id),
      ),
    );
  const sched = await scheduleFor(list, at.date, at.date, tx);
  const cancelled = await cancelledOn(
    list.map((b) => b.id),
    at.date,
    tx,
  );
  return list.filter((b) => {
    const s = sched.get(b.id)?.[0];
    return s && !cancelled.has(b.id) && overlaps(s, at);
  });
}

/**
 * Checks a change without making it: blocking errors, confirmable warnings, and whether it needs
 * an admin. `ignoreChange` leaves a pending request out of the "day already taken" check (when
 * it is the one being approved).
 */
export async function evaluate(
  user: AuthUser,
  batch: Batch,
  req: ChangeRequest,
  {
    now = new Date(),
    tx = db,
    ignoreChange,
  }: { now?: Date; tx?: DbOrTx; ignoreChange?: string } = {},
): Promise<Evaluation> {
  const errors: string[] = [];
  const warnings: Warning[] = [];
  const at = { date: req.date, startTime: norm(req.startTime), endTime: norm(req.endTime) };
  const admin = isAdmin(user);

  let current: ScheduledSession | null = null;
  if (req.sessionDate) {
    current = await sessionOn(batch, req.sessionDate, tx);
    if (!current)
      throw AppError.unprocessable(`${batch.name} has no session on ${nice(req.sessionDate)}`);
  }
  const kind: Evaluation['kind'] = current?.kind === 'extra' || !current ? 'extra' : 'reschedule';
  const originalDate = kind === 'reschedule' ? (current!.originalDate ?? current!.date) : null;

  if (toMin(at.endTime) <= toMin(at.startTime))
    errors.push('The session must end after it starts.');
  if (!batch.isActive) errors.push(`${batch.name} is inactive.`);

  // The session being moved must not have started, been cancelled or have records.
  if (current) {
    if (instantAt(current.date, current.startTime) <= now)
      errors.push('This session has already started.');
    if ((await cancelledOn([batch.id], current.date, tx)).size)
      errors.push('This session was cancelled. Restore it before moving it.');
    if (await hasRecords(batch.id, current.date, tx))
      errors.push('Attendance or a check-in is already recorded for this session.');
    if (
      current.date === at.date &&
      current.startTime === at.startTime &&
      current.endTime === at.endTime
    )
      errors.push('That is when the session already runs.');
  }

  // The new day and time.
  if (instantAt(at.date, at.startTime) <= now) errors.push('Choose a time in the future.');
  if (originalDate) {
    if (Math.abs(diffDays(originalDate, at.date)) > MOVE_WINDOW_DAYS)
      errors.push(`A session can move up to ${MOVE_WINDOW_DAYS} days from its regular day.`);
  } else if (diffDays(todayInAppTz(now), at.date) > EXTRA_DAYS_AHEAD) {
    errors.push(`Extra sessions can be planned up to ${EXTRA_DAYS_AHEAD} days ahead.`);
  }
  const sameDay = originalDate === at.date;
  if (!sameDay && isRegularDay(batch, at.date))
    errors.push(`${batch.name} already runs on ${nice(at.date)}. Choose a day it doesn't run.`);
  if (!sameDay) {
    const taken = await tx
      .select({ id: sessionChanges.id, status: sessionChanges.status })
      .from(sessionChanges)
      .where(
        and(
          eq(sessionChanges.batchId, batch.id),
          eq(sessionChanges.date, at.date),
          inArray(sessionChanges.status, ['pending', 'approved']),
          current?.changeId ? ne(sessionChanges.id, current.changeId) : undefined,
          ignoreChange ? ne(sessionChanges.id, ignoreChange) : undefined,
        ),
      );
    if (taken.length)
      errors.push(
        taken[0]!.status === 'pending'
          ? `A change to ${nice(at.date)} is already waiting for approval.`
          : `${batch.name} already has a moved or extra session on ${nice(at.date)}.`,
      );
  }
  if (originalDate && !current?.changeId) {
    // A regular session with a pending request can't get a second one.
    const [pending] = await tx
      .select({ id: sessionChanges.id })
      .from(sessionChanges)
      .where(
        and(
          eq(sessionChanges.batchId, batch.id),
          eq(sessionChanges.originalDate, originalDate),
          eq(sessionChanges.status, 'pending'),
          ignoreChange ? ne(sessionChanges.id, ignoreChange) : undefined,
        ),
      );
    if (pending) errors.push('A change to this session is already waiting for approval.');
  }

  // The coach running it must be free then.
  const coachId = await coachOn(batch, at.date, tx);
  const busy = (await coachBusy(coachId, at.date, batch.id, tx)).find((b) => overlaps(b, at));
  if (busy)
    errors.push(
      `${coachId === user.id ? 'You' : 'The coach'} already coach${coachId === user.id ? '' : 'es'} ${busy.name} at ${span(busy)} that day.`,
    );

  // Warnings.
  const sharing = await locationOverlap(batch, at, tx);
  if (sharing.length)
    warnings.push({
      code: 'location-overlap',
      message: `${sharing.map((b) => b.name).join(', ')} also run${sharing.length === 1 ? 's' : ''} at this location then.`,
      batches: sharing.map((b) => ({ id: b.id, name: b.name })),
    });
  const rosterOn = current ? rosterDay(current) : at.date;
  const clashing = await busyStudents(batch, rosterOn, at, tx);
  if (clashing.length)
    warnings.push({
      code: 'students-busy',
      message: `${clashing.length} student${clashing.length === 1 ? ' has' : 's have'} another batch then.`,
      students: clashing,
    });

  // Notice and approval.
  const starts = [instantAt(at.date, at.startTime)];
  if (current) starts.push(instantAt(current.date, current.startTime));
  const earliest = Math.min(...starts.map((d) => d.getTime()));
  const noticeHours = Math.floor((earliest - now.getTime()) / 3_600_000);
  const needsApproval = !admin && noticeHours < NOTICE_HOURS;
  if (needsApproval && current?.changeId)
    errors.push(
      'This session was already moved. With less than 24 hours to go, ask an admin to change it.',
    );

  return {
    errors,
    warnings,
    kind,
    originalDate,
    fromDate: current?.date ?? null,
    replaces: current?.changeId ?? null,
    needsApproval,
    noticeHours,
    coachId,
  };
}

/** Moves booked makeups and the session's own lesson plan from one day to another. */
async function carryOver(batchId: string, from: IsoDate, to: IsoDate, tx: DbOrTx) {
  if (from === to) return;
  // Rejected requests on the new day would collide; they're history only.
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

/** Puts an approved change into effect (or its replacement), carrying makeups and plans along. */
async function putInEffect(
  tx: DbOrTx,
  batchId: string,
  e: Pick<Evaluation, 'fromDate' | 'replaces'>,
  to: IsoDate,
) {
  if (e.fromDate) await carryOver(batchId, e.fromDate, to, tx);
}

// ─── Listing ─────────────────────────────────────────────────────────────────

const requester = aliasedTable(users, 'requester');
const reviewer = aliasedTable(users, 'reviewer');
const coach = aliasedTable(users, 'coach');

const select = {
  id: sessionChanges.id,
  kind: sessionChanges.kind,
  originalDate: sessionChanges.originalDate,
  date: sessionChanges.date,
  startTime: sessionChanges.startTime,
  endTime: sessionChanges.endTime,
  status: sessionChanges.status,
  reason: sessionChanges.reason,
  reviewNote: sessionChanges.reviewNote,
  reviewedAt: sessionChanges.reviewedAt,
  createdAt: sessionChanges.createdAt,
  batch: {
    id: batches.id,
    name: batches.name,
    weekdays: batches.weekdays,
    startTime: batches.startTime,
    endTime: batches.endTime,
    dayTimes: batches.dayTimes,
  },
  location: {
    id: batches.locationId,
    name: sql<string>`(select l.name from ${locations} l where l.id = ${batches.locationId})`,
  },
  coach: { id: coach.id, name: coach.name },
  requestedBy: { id: requester.id, name: requester.name },
  reviewedBy: { id: reviewer.id, name: reviewer.name },
};

interface Person {
  id: string;
  name: string;
}
/** One change with its batch and people (typed by hand: inference gives up on four joins). */
interface ChangeRowFull {
  id: string;
  kind: 'reschedule' | 'extra';
  originalDate: IsoDate | null;
  date: IsoDate;
  startTime: string;
  endTime: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  reason: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  batch: {
    id: string;
    name: string;
    weekdays: number[];
    startTime: string;
    endTime: string;
    dayTimes: DayTimes;
  };
  location: Person;
  coach: Person;
  requestedBy: Person;
  reviewedBy: { id: string | null; name: string | null } | null;
}

export async function listChanges(where: SQL | undefined) {
  const rows: ChangeRowFull[] = await db
    .select(select)
    .from(sessionChanges)
    .innerJoin(batches, eq(batches.id, sessionChanges.batchId))
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(requester, eq(requester.id, sessionChanges.requestedById))
    .leftJoin(reviewer, eq(reviewer.id, sessionChanges.reviewedById))
    .where(where)
    .orderBy(
      sql`case ${sessionChanges.status} when 'pending' then 0 when 'approved' then 1 else 2 end`,
      desc(sessionChanges.date),
    )
    .limit(300);
  return rows.map(({ batch, ...r }) => ({
    ...r,
    batch: { id: batch.id, name: batch.name, startTime: batch.startTime, endTime: batch.endTime },
    reviewedBy: r.reviewedBy?.id ? r.reviewedBy : null,
    /** The regular time of the moved session (reschedule), for "from → to" labels. */
    from:
      r.originalDate && r.kind === 'reschedule'
        ? { date: r.originalDate, ...timesOn(batch, r.originalDate) }
        : null,
  }));
}
type ChangeView = Awaited<ReturnType<typeof listChanges>>[number];

async function one(id: string) {
  const [row] = await listChanges(eq(sessionChanges.id, id));
  if (!row) throw AppError.notFound('Session change');
  return row;
}

/** Changes a coach can see: their batches' (as coach) and the ones they asked for. */
function visibleTo(user: AuthUser): SQL | undefined {
  if (isAdmin(user)) return undefined;
  return or(eq(batches.coachId, user.id), eq(sessionChanges.requestedById, user.id));
}

// ─── Notices ─────────────────────────────────────────────────────────────────

const LINK = '/session-changes';
const describe = (r: ChangeView) =>
  r.kind === 'extra'
    ? `Extra session ${nice(r.date)} ${span(r)}`
    : r.originalDate === r.date
      ? `${nice(r.date)} now ${span(r)}`
      : `${nice(r.originalDate!)} → ${nice(r.date)} ${span(r)}`;

function noticePeople(r: ChangeView, actorId: string, title: string) {
  notifyInBackground(async () => {
    const people = [...new Set([r.coach.id, r.requestedBy.id])].filter((x) => x !== actorId);
    // A substitute covering the new day hears about it too.
    const [sub] = await db
      .select({ id: batchSubstitutions.substituteCoachId })
      .from(batchSubstitutions)
      .where(
        and(
          eq(batchSubstitutions.batchId, r.batch.id),
          eq(batchSubstitutions.status, 'approved'),
          lte(batchSubstitutions.fromDate, r.date),
          gte(batchSubstitutions.toDate, r.date),
        ),
      );
    if (sub && sub.id !== actorId && !people.includes(sub.id)) people.push(sub.id);
    if (!people.length) return;
    await notifyUsers(people, {
      category: 'sessions',
      icon: '🗓️',
      title: `${title} · ${r.batch.name}`,
      body: `${describe(r)}${r.reviewNote ? ` — ${r.reviewNote}` : r.reason ? ` — ${r.reason}` : ''}`,
      link: `/batches/${r.batch.id}`,
      tag: `session-change-${r.id}`,
    });
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
  const q = parse(z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() }), req.query);
  const user = currentUser(req);
  const batch = await getBatchOrThrow(id);
  if (!isAdmin(user) && batch.coachId !== user.id && !(await isSubstituteFor(user.id, id)))
    throw AppError.notFound('Batch');
  const from = q.from ?? addDays(todayInAppTz(), -30);
  const to = q.to ?? addDays(todayInAppTz(), EXTRA_DAYS_AHEAD);
  ok(
    res,
    await listChanges(
      and(
        eq(sessionChanges.batchId, id),
        or(
          and(gte(sessionChanges.date, from), lte(sessionChanges.date, to)),
          and(gte(sessionChanges.originalDate, from), lte(sessionChanges.originalDate, to)),
        ),
      ),
    ),
  );
});

batchSessionChangesRouter.post('/:id/session-changes/preview', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ChangeBody, req.body);
  const user = currentUser(req);
  const batch = await assertMayChange(user, id, body.sessionDate ?? body.date);
  const e = await evaluate(user, batch, body);
  ok(res, {
    ok: !e.errors.length,
    errors: e.errors,
    warnings: e.warnings,
    kind: e.kind,
    originalDate: e.originalDate,
    needsApproval: e.needsApproval,
    noticeHours: e.noticeHours,
  });
});

batchSessionChangesRouter.post('/:id/session-changes', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ChangeBody, req.body);
  const user = currentUser(req);
  const batch = await assertMayChange(user, id, body.sessionDate ?? body.date);

  const { changeId, e } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const e = await evaluate(user, batch, body, { tx });
    if (e.errors.length) throw AppError.unprocessable(e.errors[0]!, { errors: e.errors });
    if (e.warnings.length && !body.confirm)
      throw AppError.conflict('Please confirm: ' + e.warnings.map((w) => w.message).join(' '), {
        warnings: e.warnings,
      });
    const approved = !e.needsApproval;
    // Moving a moved / extra session again: the old change steps aside first, which frees its
    // day (live changes are unique per batch and day).
    if (e.replaces)
      await tx
        .update(sessionChanges)
        .set({ status: 'cancelled' })
        .where(eq(sessionChanges.id, e.replaces));
    const [row] = await tx
      .insert(sessionChanges)
      .values({
        batchId: batch.id,
        kind: e.kind,
        originalDate: e.originalDate,
        date: body.date,
        startTime: norm(body.startTime),
        endTime: norm(body.endTime),
        status: approved ? 'approved' : 'pending',
        reason: body.reason ?? null,
        requestedById: user.id,
        reviewedById: approved ? user.id : null,
        reviewedAt: approved ? new Date() : null,
      })
      .returning({ id: sessionChanges.id });
    if (approved) await putInEffect(tx, batch.id, e, body.date);
    await audit(
      {
        ...auditCtx(req),
        action: approved ? 'session.rescheduled' : 'session.reschedule_requested',
        entityType: 'batch',
        entityId: batch.id,
        metadata: {
          changeId: row!.id,
          kind: e.kind,
          from: e.fromDate,
          originalDate: e.originalDate,
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          replaces: e.replaces,
          noticeHours: e.noticeHours,
          warnings: e.warnings.map((w) => w.code),
        },
      },
      tx,
    );
    return { changeId: row!.id, e };
  });

  const row = await one(changeId);
  if (e.needsApproval)
    notifyInBackground(() =>
      notifyAdmins({
        category: 'approvals',
        icon: '🗓️',
        actions: [{ label: 'Review', link: LINK }],
        title: `${row.kind === 'extra' ? 'Extra session' : 'Reschedule'} request · ${row.batch.name}`,
        body: `${user.name ?? 'A coach'}: ${describe(row)} (${e.noticeHours} h notice)`,
        link: LINK,
        tag: `session-change-${changeId}`,
      }),
    );
  else {
    if (!isAdmin(user))
      notifyInBackground(() =>
        notifyAdmins({
          category: 'sessions',
          icon: '🗓️',
          title: `${row.kind === 'extra' ? 'Extra session added' : 'Session moved'} · ${row.batch.name}`,
          body: `${user.name ?? 'A coach'}: ${describe(row)}`,
          link: `/batches/${row.batch.id}`,
          tag: `session-change-${changeId}`,
        }),
      );
    noticePeople(row, user.id, row.kind === 'extra' ? 'Extra session added' : 'Session moved');
  }
  created(res, { ...row, warnings: e.warnings });
});

/** Mounted at /session-changes. */
export const sessionChangesRouter = Router();

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(),
  batchId: zId.optional(),
});

sessionChangesRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  await expireStale();
  ok(
    res,
    await listChanges(
      and(
        visibleTo(user),
        q.status ? eq(sessionChanges.status, q.status) : undefined,
        q.batchId ? eq(sessionChanges.batchId, q.batchId) : undefined,
      ),
    ),
  );
});

const ReviewBody = z.object({ note: zOptionalText(300), confirm: z.boolean().optional() });

sessionChangesRouter.post('/:id/approve', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { note, confirm } = parse(ReviewBody, req.body ?? {});
  const user = currentUser(req);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const c = await tx.query.sessionChanges.findFirst({ where: eq(sessionChanges.id, id) });
    if (!c) throw AppError.notFound('Session change');
    if (c.status !== 'pending') throw AppError.conflict(`This request was already ${c.status}`);
    const batch = await batchIn(tx, c.batchId);
    // Re-check now: things may have changed since it was asked for.
    const e = await evaluate(
      user,
      batch,
      {
        sessionDate: c.originalDate ?? undefined,
        date: c.date,
        startTime: c.startTime,
        endTime: c.endTime,
      },
      { tx, ignoreChange: c.id },
    );
    if (e.errors.length) throw AppError.unprocessable(e.errors[0]!, { errors: e.errors });
    if (e.warnings.length && !confirm)
      throw AppError.conflict('Please confirm: ' + e.warnings.map((w) => w.message).join(' '), {
        warnings: e.warnings,
      });
    await tx
      .update(sessionChanges)
      .set({
        status: 'approved',
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      })
      .where(eq(sessionChanges.id, id));
    await putInEffect(tx, c.batchId, e, c.date);
    await audit(
      {
        ...auditCtx(req),
        action: 'session.reschedule_approved',
        entityType: 'batch',
        entityId: c.batchId,
        metadata: { changeId: id, note: note ?? null },
      },
      tx,
    );
  });
  const row = await one(id);
  noticePeople(
    row,
    user.id,
    row.kind === 'extra' ? 'Extra session approved' : 'Reschedule approved',
  );
  ok(res, row);
});

sessionChangesRouter.post('/:id/reject', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { note } = parse(ReviewBody, req.body ?? {});
  const user = currentUser(req);
  const [done] = await db
    .update(sessionChanges)
    .set({
      status: 'rejected',
      reviewedById: user.id,
      reviewedAt: new Date(),
      reviewNote: note ?? null,
    })
    .where(and(eq(sessionChanges.id, id), eq(sessionChanges.status, 'pending')))
    .returning();
  if (!done) {
    await one(id);
    throw AppError.conflict('This request was already handled');
  }
  await audit({
    ...auditCtx(req),
    action: 'session.reschedule_rejected',
    entityType: 'batch',
    entityId: done.batchId,
    metadata: { changeId: id, note: note ?? null },
  });
  const row = await one(id);
  noticePeople(row, user.id, 'Reschedule declined');
  ok(res, row);
});

/**
 * Withdraws a pending request, or reverts an approved change before the session starts: a moved
 * session goes back to its regular day and time (makeups and plan with it); an extra session is
 * dropped (not while makeups are booked into it).
 */
sessionChangesRouter.post('/:id/cancel', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { note } = parse(ReviewBody, req.body ?? {});
  const user = currentUser(req);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const c = await tx.query.sessionChanges.findFirst({ where: eq(sessionChanges.id, id) });
    if (!c) throw AppError.notFound('Session change');
    const batch = await batchIn(tx, c.batchId);
    const mine =
      isAdmin(user) ||
      c.requestedById === user.id ||
      batch.coachId === user.id ||
      (await coachOn(batch, c.date, tx)) === user.id;
    if (!mine) throw AppError.notFound('Session change');
    if (!['pending', 'approved'].includes(c.status))
      throw AppError.conflict(`This change is already ${c.status}`);
    if (c.status === 'approved') {
      if (instantAt(c.date, c.startTime) <= now)
        throw AppError.conflict('This session has already started.');
      if (await hasRecords(c.batchId, c.date, tx))
        throw AppError.conflict('Attendance or a check-in is already recorded for this session.');
      if (c.kind === 'reschedule') {
        const back = timesOn(batch, c.originalDate!).startTime;
        if (instantAt(c.originalDate!, back) <= now)
          throw AppError.conflict('The regular time has passed, so the session can’t go back.');
        await carryOver(c.batchId, c.date, c.originalDate!, tx);
      } else {
        const booked = await tx.$count(
          makeupSessions,
          and(
            eq(makeupSessions.batchId, c.batchId),
            eq(makeupSessions.date, c.date),
            inArray(makeupSessions.status, ['pending', 'approved']),
          ),
        );
        if (booked)
          throw AppError.conflict(
            `${booked} makeup${booked === 1 ? ' is' : 's are'} booked into this extra session. Move or cancel ${booked === 1 ? 'it' : 'them'} first.`,
          );
        await tx
          .delete(sessionPlans)
          .where(and(eq(sessionPlans.batchId, c.batchId), eq(sessionPlans.date, c.date)));
      }
    }
    await tx
      .update(sessionChanges)
      .set({ status: 'cancelled', reviewNote: note ?? c.reviewNote })
      .where(eq(sessionChanges.id, id));
    await audit(
      {
        ...auditCtx(req),
        action:
          c.status === 'approved' ? 'session.reschedule_reverted' : 'session.reschedule_withdrawn',
        entityType: 'batch',
        entityId: c.batchId,
        metadata: { changeId: id, note: note ?? null },
      },
      tx,
    );
  });
  const row = await one(id);
  noticePeople(
    row,
    user.id,
    row.kind === 'extra' ? 'Extra session cancelled' : 'Session back to its usual time',
  );
  ok(res, row);
});

/** Pending requests whose session was due to start: expired. Safe to run any time. */
export async function expireStale(now: Date = new Date()): Promise<number> {
  const pending = await db
    .select({
      id: sessionChanges.id,
      date: sessionChanges.date,
      startTime: sessionChanges.startTime,
      originalDate: sessionChanges.originalDate,
      batchId: sessionChanges.batchId,
    })
    .from(sessionChanges)
    .where(
      and(
        eq(sessionChanges.status, 'pending'),
        lte(sessionChanges.date, addDays(todayInAppTz(now), 1)),
      ),
    )
    .orderBy(asc(sessionChanges.date));
  // Plus pending moves whose regular day comes first.
  const early = await db
    .select({
      id: sessionChanges.id,
      date: sessionChanges.date,
      startTime: sessionChanges.startTime,
      originalDate: sessionChanges.originalDate,
      batchId: sessionChanges.batchId,
    })
    .from(sessionChanges)
    .where(
      and(
        eq(sessionChanges.status, 'pending'),
        lte(sessionChanges.originalDate, addDays(todayInAppTz(now), 1)),
      ),
    );
  const all = new Map([...pending, ...early].map((r) => [r.id, r]));
  if (!all.size) return 0;
  const batchRows = await db
    .select(timing)
    .from(batches)
    .where(inArray(batches.id, [...new Set([...all.values()].map((r) => r.batchId))]));
  const byId = new Map(batchRows.map((b) => [b.id, b]));
  const stale: string[] = [];
  for (const r of all.values()) {
    const starts = [instantAt(r.date, r.startTime)];
    const b = byId.get(r.batchId);
    if (r.originalDate && b)
      starts.push(instantAt(r.originalDate, timesOn(b, r.originalDate).startTime));
    if (Math.min(...starts.map((d) => d.getTime())) <= now.getTime()) stale.push(r.id);
  }
  if (stale.length)
    await db
      .update(sessionChanges)
      .set({ status: 'expired' })
      .where(and(inArray(sessionChanges.id, stale), eq(sessionChanges.status, 'pending')));
  return stale.length;
}
