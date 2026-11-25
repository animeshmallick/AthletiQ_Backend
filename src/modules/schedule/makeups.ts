/**
 * Missed sessions made up one student at a time: each student attends another batch's session
 * (same location and sport) instead, or is marked as not needing it.
 *
 * A student's part of a missed session is identified by (home batch, its original day, student),
 * so it survives the session being rescheduled. It is:
 *  - booked:  their makeup session is still to come;
 *  - made-up: that session was held (a check-in or any attendance), whether or not they came;
 *  - lapsed:  that session was cancelled, dropped or never held: they need another one;
 *  - excused: not needed, with a reason.
 * Booked, made-up and excused students aren't expected at a rescheduled session.
 */
import { and, eq, gt, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  coachSessions,
  enrollments,
  makeupExcusals,
  makeupSessions,
  sessionCancellations,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { instantAt, maxDate, minDate, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import {
  belongsTo,
  memberSessions,
  rosterDay,
  scheduleFor,
  type ScheduledSession,
} from './schedule.js';

export type MakeupState = 'booked' | 'made-up' | 'lapsed' | 'excused';
export interface Resolution {
  state: MakeupState;
  studentId: string;
  missedBatchId: string;
  missedDate: IsoDate;
  reason: string | null;
  makeup: {
    id: string;
    batchId: string;
    batchName: string;
    date: IsoDate;
    startTime: string | null;
    endTime: string | null;
    mark: 'present' | 'late' | 'absent' | 'excused' | null;
  } | null;
}

export const resolutionKey = (batchId: string, day: IsoDate, studentId: string) =>
  `${batchId}:${day}:${studentId}`;

/** Settled, or on its way to be. */
export const isLive = (r: Resolution | undefined): r is Resolution => !!r && r.state !== 'lapsed';

const timing = {
  id: batches.id,
  name: batches.name,
  weekdays: batches.weekdays,
  startTime: batches.startTime,
  endTime: batches.endTime,
  dayTimes: batches.dayTimes,
  isActive: batches.isActive,
};

/** How each student's part of these batches' missed sessions stands. */
export async function resolutionsFor(
  batchIds: string[],
  { day, now = new Date(), tx = db }: { day?: IsoDate; now?: Date; tx?: DbOrTx } = {},
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  if (!batchIds.length) return out;
  const [rows, excused] = await Promise.all([
    tx
      .select()
      .from(makeupSessions)
      .where(
        and(
          inArray(makeupSessions.missedBatchId, batchIds),
          isNotNull(makeupSessions.missedDate),
          eq(makeupSessions.status, 'approved'),
          day ? eq(makeupSessions.missedDate, day) : undefined,
        ),
      ),
    tx
      .select()
      .from(makeupExcusals)
      .where(
        and(
          inArray(makeupExcusals.batchId, batchIds),
          day ? eq(makeupExcusals.date, day) : undefined,
        ),
      ),
  ]);
  if (rows.length) {
    const ids = [...new Set(rows.map((r) => r.batchId))];
    const days = [...new Set(rows.map((r) => r.date))];
    const from = days.reduce(minDate);
    const to = days.reduce(maxDate);
    const [list, off, checkIns, marks] = await Promise.all([
      tx.select(timing).from(batches).where(inArray(batches.id, ids)),
      tx
        .select({ batchId: sessionCancellations.batchId, date: sessionCancellations.date })
        .from(sessionCancellations)
        .where(
          and(inArray(sessionCancellations.batchId, ids), inArray(sessionCancellations.date, days)),
        ),
      tx
        .select({ batchId: coachSessions.batchId, date: coachSessions.date })
        .from(coachSessions)
        .where(and(inArray(coachSessions.batchId, ids), inArray(coachSessions.date, days))),
      tx
        .select({
          batchId: studentAttendance.batchId,
          date: studentAttendance.date,
          studentId: studentAttendance.studentId,
          status: studentAttendance.status,
        })
        .from(studentAttendance)
        .where(and(inArray(studentAttendance.batchId, ids), inArray(studentAttendance.date, days))),
    ]);
    const schedule = await scheduleFor(list, from, to, tx);
    const key = (r: { batchId: string; date: IsoDate }) => `${r.batchId}:${r.date}`;
    const cancelled = new Set(off.map(key));
    const held = new Set([...checkIns, ...marks].map(key));
    for (const r of rows) {
      const b = list.find((x) => x.id === r.batchId)!;
      const s = (schedule.get(r.batchId) ?? []).find((x) => x.date === r.date);
      const state: MakeupState = cancelled.has(key(r))
        ? 'lapsed'
        : held.has(key(r))
          ? 'made-up'
          : b.isActive && s && instantAt(s.date, s.endTime) > now
            ? 'booked'
            : 'lapsed';
      out.set(resolutionKey(r.missedBatchId!, r.missedDate!, r.studentId), {
        state,
        studentId: r.studentId,
        missedBatchId: r.missedBatchId!,
        missedDate: r.missedDate!,
        reason: r.reason,
        makeup: {
          id: r.id,
          batchId: b.id,
          batchName: b.name,
          date: r.date,
          startTime: s?.startTime ?? null,
          endTime: s?.endTime ?? null,
          mark: marks.find((m) => key(m) === key(r) && m.studentId === r.studentId)?.status ?? null,
        },
      });
    }
  }
  for (const e of excused)
    out.set(resolutionKey(e.batchId, e.date, e.studentId), {
      state: 'excused',
      studentId: e.studentId,
      missedBatchId: e.batchId,
      missedDate: e.date,
      reason: e.reason,
      makeup: null,
    });
  return out;
}

/** Students who aren't expected at the batch's session of `day` (its original day). */
export async function settledStudents(
  batchId: string,
  day: IsoDate,
  tx: DbOrTx = db,
): Promise<Set<string>> {
  const all = await resolutionsFor([batchId], { day, tx });
  return new Set([...all.values()].filter(isLive).map((r) => r.studentId));
}

/** The student leaves a batch: makeups booked for its missed sessions after `lastDay` go. */
export async function dropMakeups(
  tx: DbOrTx,
  studentId: string,
  homeBatchId: string,
  lastDay: IsoDate,
) {
  await tx
    .delete(makeupSessions)
    .where(
      and(
        eq(makeupSessions.studentId, studentId),
        eq(makeupSessions.missedBatchId, homeBatchId),
        gt(makeupSessions.date, lastDay),
      ),
    );
}

/** Removes this missed session's bookings that aren't made up (rescheduled / restored). */
export async function releaseBookings(
  tx: DbOrTx,
  batchId: string,
  day: IsoDate,
  states: MakeupState[],
): Promise<Resolution[]> {
  const gone = [...(await resolutionsFor([batchId], { day, tx })).values()].filter(
    (r) => r.makeup && states.includes(r.state),
  );
  if (gone.length)
    await tx.delete(makeupSessions).where(
      inArray(
        makeupSessions.id,
        gone.map((r) => r.makeup!.id),
      ),
    );
  return gone;
}

export interface MakeupOption {
  batch: { id: string; name: string; coachName: string };
  date: IsoDate;
  startTime: string;
  endTime: string;
  expected: number;
  capacity: number;
  full: boolean;
  /** Why this student can't take it, or null. */
  blocked: string | null;
}

const overlaps = (
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
) => a.startTime < b.endTime && b.startTime < a.endTime;

/**
 * Sessions the student could attend instead: other active batches at the same location and sport
 * (`coachId`: only that coach's), still to start, from the missed day up to `until`.
 */
export async function makeupOptions(
  {
    home,
    student,
    missedDay,
    until,
    coachId,
    only,
  }: {
    home: { id: string; locationId: string; sportId: string };
    student: { id: string; plannedEndOn: IsoDate | null };
    missedDay: IsoDate;
    until: IsoDate;
    coachId?: string;
    /** Just this session. */
    only?: { batchId: string; date: IsoDate };
  },
  { now = new Date(), tx = db }: { now?: Date; tx?: DbOrTx } = {},
): Promise<MakeupOption[]> {
  const from = only?.date ?? maxDate(todayInAppTz(now), missedDay);
  const to = only?.date ?? until;
  if (from > until || from < missedDay || to > until) return [];
  const list = await tx
    .select({ ...timing, capacity: batches.capacity, coachName: users.name })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      and(
        eq(batches.isActive, true),
        ne(batches.id, home.id),
        eq(batches.locationId, home.locationId),
        eq(batches.sportId, home.sportId),
        coachId ? eq(batches.coachId, coachId) : undefined,
        only ? eq(batches.id, only.batchId) : undefined,
      ),
    );
  if (!list.length) return [];
  const ids = list.map((b) => b.id);
  const range = { from, to };
  const [schedule, members, own, booked, mine, s] = await Promise.all([
    scheduleFor(list, from, to, tx),
    tx.select().from(enrollments).where(inArray(enrollments.batchId, ids)),
    tx.select().from(enrollments).where(eq(enrollments.studentId, student.id)),
    tx
      .select({
        batchId: makeupSessions.batchId,
        date: makeupSessions.date,
        n: sql<number>`count(*)::int`,
      })
      .from(makeupSessions)
      .where(
        and(
          inArray(makeupSessions.batchId, ids),
          eq(makeupSessions.status, 'approved'),
          gte(makeupSessions.date, range.from),
          lte(makeupSessions.date, range.to),
        ),
      )
      .groupBy(makeupSessions.batchId, makeupSessions.date),
    tx
      .select({ m: makeupSessions, batch: timing })
      .from(makeupSessions)
      .innerJoin(batches, eq(batches.id, makeupSessions.batchId))
      .where(
        and(
          eq(makeupSessions.studentId, student.id),
          eq(makeupSessions.status, 'approved'),
          gte(makeupSessions.date, range.from),
          lte(makeupSessions.date, range.to),
        ),
      ),
    tx.query.students.findFirst({ where: eq(students.id, student.id) }),
  ]);
  const homeIds = [...new Set(own.map((e) => e.batchId))];
  const allIds = [...new Set([...ids, ...homeIds])];
  const [off, ownSessions, settled, mineAt] = await Promise.all([
    tx
      .select({ batchId: sessionCancellations.batchId, date: sessionCancellations.date })
      .from(sessionCancellations)
      .where(
        and(
          inArray(sessionCancellations.batchId, allIds),
          gte(sessionCancellations.date, range.from),
          lte(sessionCancellations.date, range.to),
        ),
      ),
    memberSessions(own, from, to, tx),
    resolutionsFor(homeIds, { now, tx }),
    scheduleFor(
      mine.map((x) => x.batch),
      from,
      to,
      tx,
    ),
  ]);
  const cancelled = new Set(off.map((c) => `${c.batchId}:${c.date}`));
  const runs = (x: ScheduledSession) => !cancelled.has(`${x.batchId}:${x.date}`);
  // Sessions they are really expected at: not cancelled, and not made up elsewhere.
  const busyWith = ownSessions.filter(
    (x) => runs(x) && !isLive(settled.get(resolutionKey(x.batchId, rosterDay(x), student.id))),
  );
  const nameOf = new Map([...list, ...mine.map((x) => x.batch)].map((b) => [b.id, b.name]));
  const out: MakeupOption[] = [];
  for (const b of list)
    for (const x of schedule.get(b.id) ?? []) {
      if (!runs(x) || instantAt(x.date, x.startTime) <= now) continue;
      // Their own batch that day: they are there anyway.
      if (own.some((e) => belongsTo(e, x))) continue;
      const clash = busyWith.find((y) => y.date === x.date && overlaps(x, y));
      const taken = mine.find(({ m }) => m.date === x.date && m.batchId === b.id);
      const other = mine.find(({ m }) => {
        const y = (mineAt.get(m.batchId) ?? []).find((z) => z.date === m.date);
        return m.date === x.date && y && runs(y) && overlaps(x, y);
      });
      const lastDay = [student.plannedEndOn, s?.leftOn].filter((d): d is IsoDate => !!d);
      const expected =
        members.filter(
          (e) => belongsTo(e, x) && (!e.plannedEndOn || e.plannedEndOn >= rosterDay(x)),
        ).length + (booked.find((k) => k.batchId === b.id && k.date === x.date)?.n ?? 0);
      out.push({
        batch: { id: b.id, name: b.name, coachName: b.coachName },
        date: x.date,
        startTime: x.startTime,
        endTime: x.endTime,
        expected,
        capacity: b.capacity,
        full: expected >= b.capacity,
        blocked: lastDay.some((d) => d < x.date)
          ? 'After their last day'
          : taken
            ? 'Already booked into this session'
            : clash
              ? `Has ${(await nameFor(clash.batchId, nameOf, tx)) ?? 'another batch'} then`
              : other
                ? `Has a makeup in ${nameOf.get(other.m.batchId)} then`
                : null,
      });
    }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

async function nameFor(id: string, known: Map<string, string>, tx: DbOrTx) {
  if (!known.has(id)) {
    const [b] = await tx.select({ name: batches.name }).from(batches).where(eq(batches.id, id));
    if (b) known.set(id, b.name);
  }
  return known.get(id);
}
