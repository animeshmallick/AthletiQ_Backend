/**
 * The batch timetable as it actually runs: regular weekdays, minus sessions moved away, plus
 * sessions moved in and extra sessions. Every "does this batch run on this day, and when?"
 * question goes through here, so rescheduling works the same everywhere (attendance, check-in,
 * lesson plans, alerts, reports…).
 *
 * A session is identified by (batch, date). A moved session takes its new date, which is always a
 * day the batch doesn't normally run, so that pair stays unique.
 */
import { and, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { batches, sessionChanges } from '../../db/schema/index.js';
import { timesOn, type DayTimes } from '../../lib/batch-times.js';
import { eachDay, isoWeekday, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';

export interface BatchTiming {
  id: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  dayTimes?: DayTimes | null;
}

export interface ChangeRow {
  id: string;
  batchId: string;
  kind: 'reschedule' | 'extra';
  originalDate: IsoDate | null;
  date: IsoDate;
  startTime: string;
  endTime: string;
}

export type SessionKind = 'regular' | 'moved' | 'extra';

export interface ScheduledSession {
  batchId: string;
  date: IsoDate;
  startTime: string;
  endTime: string;
  /** regular: the batch's own day. moved: a regular session at another day/time. extra: one-off. */
  kind: SessionKind;
  /** For a moved session, the regular day it replaces (same as `date` for a time-only change). */
  originalDate: IsoDate | null;
  changeId: string | null;
}

/** Is `date` one of the batch's regular weekdays? */
export const isRegularDay = (b: Pick<BatchTiming, 'weekdays'>, date: IsoDate) =>
  b.weekdays.includes(isoWeekday(date));

/**
 * The sessions of one batch between `from` and `to` (inclusive), given its approved changes.
 * Pure: unit-tested without a database. Cancellations are not applied here (a cancelled session
 * is still a session of the timetable, shown as cancelled).
 */
export function buildSessions(
  batch: BatchTiming,
  changes: ChangeRow[],
  from: IsoDate,
  to: IsoDate,
): ScheduledSession[] {
  const mine = changes.filter((c) => c.batchId === batch.id);
  const movedAway = new Set(
    mine.filter((c) => c.kind === 'reschedule').map((c) => c.originalDate as IsoDate),
  );
  const changed = new Map<IsoDate, ScheduledSession>();
  for (const c of mine) {
    if (c.date < from || c.date > to) continue;
    changed.set(c.date, {
      batchId: batch.id,
      date: c.date,
      startTime: c.startTime,
      endTime: c.endTime,
      kind: c.kind === 'extra' ? 'extra' : 'moved',
      originalDate: c.originalDate,
      changeId: c.id,
    });
  }
  const out: ScheduledSession[] = [];
  for (const d of eachDay(from, to)) {
    const change = changed.get(d);
    // A change on a day is the session that day (never two sessions of one batch on a day).
    if (change) out.push(change);
    else if (isRegularDay(batch, d) && !movedAway.has(d))
      out.push({
        batchId: batch.id,
        date: d,
        ...timesOn(batch, d),
        kind: 'regular',
        originalDate: null,
        changeId: null,
      });
  }
  return out;
}

/** Approved changes of these batches that add or remove a session between `from` and `to`. */
export async function approvedChanges(
  batchIds: string[],
  from: IsoDate,
  to: IsoDate,
  tx: DbOrTx = db,
): Promise<ChangeRow[]> {
  if (!batchIds.length) return [];
  return tx
    .select({
      id: sessionChanges.id,
      batchId: sessionChanges.batchId,
      kind: sessionChanges.kind,
      originalDate: sessionChanges.originalDate,
      date: sessionChanges.date,
      startTime: sessionChanges.startTime,
      endTime: sessionChanges.endTime,
    })
    .from(sessionChanges)
    .where(
      and(
        inArray(sessionChanges.batchId, batchIds),
        eq(sessionChanges.status, 'approved'),
        or(
          and(gte(sessionChanges.date, from), lte(sessionChanges.date, to)),
          and(gte(sessionChanges.originalDate, from), lte(sessionChanges.originalDate, to)),
        ),
      ),
    );
}

/** Sessions of several batches over a range, keyed by batch id. */
export async function scheduleFor(
  list: BatchTiming[],
  from: IsoDate,
  to: IsoDate,
  tx: DbOrTx = db,
): Promise<Map<string, ScheduledSession[]>> {
  const changes = await approvedChanges(
    list.map((b) => b.id),
    from,
    to,
    tx,
  );
  return new Map(list.map((b) => [b.id, buildSessions(b, changes, from, to)]));
}

/** The batch's session on `date`, or null when it doesn't run that day. */
export async function sessionOn(
  batch: BatchTiming,
  date: IsoDate,
  tx: DbOrTx = db,
): Promise<ScheduledSession | null> {
  const changes = await approvedChanges([batch.id], date, date, tx);
  return buildSessions(batch, changes, date, date)[0] ?? null;
}

/**
 * SQL filter for a query over `batches`: the batch may have a session on `day` (a regular weekday
 * or an approved change landing on it). Narrow the result with `sessionsOnDay`, which also drops
 * regular sessions that were moved away.
 */
export function mayRunOnSql(day: IsoDate): SQL {
  return sql`(${isoWeekday(day)} = any(${batches.weekdays}) or exists (
    select 1 from ${sessionChanges} sc
    where sc.batch_id = ${batches.id} and sc.date = ${day} and sc.status = 'approved'))`;
}

/** Each batch paired with its session on `day`; batches without one are left out. */
export async function sessionsOnDay<B extends BatchTiming>(
  list: B[],
  day: IsoDate,
  tx: DbOrTx = db,
): Promise<{ batch: B; session: ScheduledSession }[]> {
  const byBatch = await scheduleFor(list, day, day, tx);
  return list.flatMap((batch) => {
    const session = byBatch.get(batch.id)?.[0];
    return session ? [{ batch, session }] : [];
  });
}

/** The batch's session on `date`; throws 422 when it doesn't run that day. */
export async function requireSession(
  batch: BatchTiming & { name: string },
  date: IsoDate,
  tx: DbOrTx = db,
): Promise<ScheduledSession> {
  const s = await sessionOn(batch, date, tx);
  if (!s) throw AppError.unprocessable(`${batch.name} does not run on this day`);
  return s;
}

/** What the API tells clients about where a session came from. */
export function sessionOrigin(s: ScheduledSession) {
  return { kind: s.kind, originalDate: s.originalDate, changeId: s.changeId };
}

export interface Membership {
  batchId: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  trainingDays: number[];
}

/**
 * The day that decides who a session belongs to: a moved session keeps the roster of the day it
 * was moved from; regular and extra sessions use their own day.
 */
export const rosterDay = (s: ScheduledSession) =>
  s.kind === 'moved' ? (s.originalDate as IsoDate) : s.date;

/** Is this member expected at the session (enrolled on its roster day, and trains that weekday)? */
export function belongsTo(m: Membership, s: ScheduledSession): boolean {
  if (m.batchId !== s.batchId) return false;
  const day = rosterDay(s);
  if (day < m.effectiveFrom || (m.effectiveTo !== null && day > m.effectiveTo)) return false;
  return s.kind === 'extra' || m.trainingDays.includes(isoWeekday(day));
}

/**
 * The home-batch sessions (dated `from`–`to`) these memberships are expected at, oldest first.
 * Cancellations are not removed here.
 */
export async function memberSessions(
  memberships: Membership[],
  from: IsoDate,
  to: IsoDate,
  tx: DbOrTx = db,
): Promise<ScheduledSession[]> {
  const ids = [...new Set(memberships.map((m) => m.batchId))];
  if (!ids.length || to < from) return [];
  const list = await tx
    .select({
      id: batches.id,
      weekdays: batches.weekdays,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
    })
    .from(batches)
    .where(inArray(batches.id, ids));
  const byBatch = await scheduleFor(list, from, to, tx);
  return [...byBatch.values()]
    .flat()
    .filter((s) => memberships.some((m) => belongsTo(m, s)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}
