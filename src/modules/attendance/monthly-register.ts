/**
 * A batch's attendance register for one month, with its insights (nothing about money).
 *
 * Everyone who was a member at any time that month is listed; the days outside their membership
 * are blank. Attendance % = present + late of present + late + absent (excused and unmarked
 * sessions don't count). A missed session made up in another batch shows on the missed day;
 * guests from other batches aren't listed.
 */
import { and, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  batches,
  batchSubstitutions,
  coachSessions,
  enrollments,
  locations,
  makeupSessions,
  sessionCancellations,
  sports,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import {
  addDays,
  instantAt,
  isoWeekday,
  startOfIsoWeek,
  startOfMonth,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import {
  belongsTo,
  rosterDay,
  scheduleFor,
  sessionOrigin,
  type ScheduledSession,
} from '../schedule/schedule.js';

export type Mark = 'present' | 'late' | 'absent' | 'excused';
/** held · cancelled · unrecorded (over, nothing recorded) · upcoming */
export type RegisterState = 'held' | 'cancelled' | 'unrecorded' | 'upcoming';

const LOW = 60;
const GOOD = 80;
/** Minutes after the start that a check-in still counts as on time. */
const GRACE = 10;
/** A run of absences worth a call. */
const RUN = 3;
/** Sessions last month needed to compare with it. */
const ENOUGH = 3;

const pct = (n: number, d: number) => (d ? Math.round((n * 100) / d) : null);
const came = (m: Mark | undefined) => m === 'present' || m === 'late';
const counts = (m: Mark | undefined) => came(m) || m === 'absent';

export const monthOf = (day: IsoDate): IsoDate => startOfMonth(day);
export function monthAfter(month: IsoDate, n: number): IsoDate {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}
const lastDay = (month: IsoDate) => addDays(monthAfter(month, 1), -1);

const istMinutes = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The batches whose registers are kept, with what a tile shows about them. */
export async function registerBatches(where?: SQL) {
  return db
    .select({
      id: batches.id,
      name: batches.name,
      weekdays: batches.weekdays,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
      capacity: batches.capacity,
      isActive: batches.isActive,
      coachId: batches.coachId,
      coachName: users.name,
      locationName: locations.name,
      sportName: sports.name,
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .where(where)
    .orderBy(batches.name);
}
export type RegisterBatch = Awaited<ReturnType<typeof registerBatches>>[number];

/** Everything recorded for these batches over the month and the one before it. */
async function load(list: RegisterBatch[], month: IsoDate) {
  const ids = list.map((b) => b.id);
  const from = monthAfter(month, -1);
  const to = lastDay(month);
  const own = {
    studentId: studentAttendance.studentId,
    status: studentAttendance.status,
    note: studentAttendance.note,
  };
  const [schedule, members, cancels, checkIns, marks, madeUp, heldRows, subs] = await Promise.all([
    scheduleFor(list, from, to),
    db
      .select({
        e: enrollments,
        fullName: students.fullName,
        code: students.code,
        leftOn: students.leftOn,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(
        and(
          inArray(enrollments.batchId, ids),
          lte(enrollments.effectiveFrom, to),
          or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, from)),
        ),
      ),
    db
      .select()
      .from(sessionCancellations)
      .where(
        and(
          inArray(sessionCancellations.batchId, ids),
          gte(sessionCancellations.date, from),
          lte(sessionCancellations.date, to),
        ),
      ),
    db
      .select({
        batchId: coachSessions.batchId,
        date: coachSessions.date,
        at: coachSessions.checkInAt,
        start: coachSessions.scheduledStart,
        coachName: users.name,
      })
      .from(coachSessions)
      .innerJoin(users, eq(users.id, coachSessions.coachId))
      .where(
        and(
          inArray(coachSessions.batchId, ids),
          gte(coachSessions.date, from),
          lte(coachSessions.date, to),
        ),
      ),
    db
      .select({ ...own, batchId: studentAttendance.batchId, date: studentAttendance.date })
      .from(studentAttendance)
      .where(
        and(
          inArray(studentAttendance.batchId, ids),
          isNull(studentAttendance.homeBatchId),
          gte(studentAttendance.date, from),
          lte(studentAttendance.date, to),
        ),
      ),
    db
      .select({
        ...own,
        batchId: makeupSessions.missedBatchId,
        missedDate: makeupSessions.missedDate,
        date: makeupSessions.date,
        in: batches.name,
      })
      .from(makeupSessions)
      .innerJoin(
        studentAttendance,
        and(
          eq(studentAttendance.studentId, makeupSessions.studentId),
          eq(studentAttendance.batchId, makeupSessions.batchId),
          eq(studentAttendance.date, makeupSessions.date),
        ),
      )
      .innerJoin(batches, eq(batches.id, makeupSessions.batchId))
      .where(
        and(
          inArray(makeupSessions.missedBatchId, ids),
          eq(makeupSessions.status, 'approved'),
          gte(makeupSessions.missedDate, from),
          lte(makeupSessions.missedDate, to),
        ),
      ),
    // Any attendance (guests too) means the session was held.
    db
      .selectDistinct({ batchId: studentAttendance.batchId, date: studentAttendance.date })
      .from(studentAttendance)
      .where(
        and(
          inArray(studentAttendance.batchId, ids),
          gte(studentAttendance.date, from),
          lte(studentAttendance.date, to),
        ),
      ),
    db
      .select({
        batchId: batchSubstitutions.batchId,
        from: batchSubstitutions.fromDate,
        to: batchSubstitutions.toDate,
        name: users.name,
      })
      .from(batchSubstitutions)
      .innerJoin(users, eq(users.id, batchSubstitutions.substituteCoachId))
      .where(
        and(
          inArray(batchSubstitutions.batchId, ids),
          eq(batchSubstitutions.status, 'approved'),
          lte(batchSubstitutions.fromDate, to),
          gte(batchSubstitutions.toDate, from),
        ),
      ),
  ]);
  return { schedule, members, cancels, checkIns, marks, madeUp, heldRows, subs };
}
type Loaded = Awaited<ReturnType<typeof load>>;

function build(b: RegisterBatch, month: IsoDate, all: Loaded, now: Date) {
  const today = todayInAppTz(now);
  const mine = <T extends { batchId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.batchId === b.id);
  const timetable = all.schedule.get(b.id) ?? [];
  const cancelOn = new Map(mine(all.cancels).map((c) => [c.date, c]));
  const checkInOn = new Map(mine(all.checkIns).map((c) => [c.date, c]));
  const heldOn = new Set([...checkInOn.keys(), ...mine(all.heldRows).map((h) => h.date)]);
  const subs = mine(all.subs);
  const members = all.members.filter((m) => m.e.batchId === b.id);
  const marks = new Map<string, { status: Mark; note: string | null; madeUp?: string }>();
  for (const m of mine(all.marks))
    marks.set(`${m.date}:${m.studentId}`, { status: m.status, note: m.note });
  for (const m of mine(all.madeUp)) {
    const s = timetable.find((x) => rosterDay(x) === m.missedDate);
    const key = `${s?.date ?? m.missedDate}:${m.studentId}`;
    if (!marks.has(key))
      marks.set(key, { status: m.status, note: m.note, madeUp: `${m.in} on ${m.date}` });
  }
  const markOf = (date: IsoDate, id: string) => marks.get(`${date}:${id}`);

  const stateOf = (s: ScheduledSession): RegisterState =>
    cancelOn.has(s.date)
      ? 'cancelled'
      : heldOn.has(s.date)
        ? 'held'
        : instantAt(s.date, s.endTime) > now
          ? 'upcoming'
          : 'unrecorded';
  const inMonth = (d: IsoDate) => monthOf(d) === month;
  const list = timetable.filter((s) => inMonth(s.date));
  const before = timetable.filter((s) => !inMonth(s.date));

  // ── Students: members at any time in the month, or with a mark in it ──
  const ids = new Set([
    ...members
      .filter(
        ({ e }) => e.effectiveFrom <= lastDay(month) && (!e.effectiveTo || e.effectiveTo >= month),
      )
      .map(({ e }) => e.studentId),
    ...mine(all.marks)
      .filter((m) => inMonth(m.date))
      .map((m) => m.studentId)
      .filter((id) => members.some(({ e }) => e.studentId === id)),
  ]);
  const expects = (id: string, s: ScheduledSession) =>
    members.some(({ e, leftOn }) => {
      const day = rosterDay(s);
      return (
        e.studentId === id &&
        belongsTo(e, s) &&
        (!e.plannedEndOn || e.plannedEndOn >= day) &&
        (!leftOn || leftOn >= day)
      );
    });

  const tally = (id: string, sessions: ScheduledSession[]) => {
    const t = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
    for (const s of sessions) {
      const m = markOf(s.date, id)?.status;
      if (m) t[m]++;
      else if (stateOf(s) === 'held' && expects(id, s)) t.unmarked++;
    }
    const counted = t.present + t.late + t.absent;
    return { ...t, counted, attended: t.present + t.late, rate: pct(t.present + t.late, counted) };
  };

  const rows = [...ids]
    .map((id) => {
      const own = members.filter(({ e }) => e.studentId === id);
      const first = own.map(({ e }) => e.effectiveFrom).sort()[0]!;
      const open = own.some(({ e }) => !e.effectiveTo);
      const last = own
        .map(({ e }) => e.effectiveTo ?? '')
        .sort()
        .at(-1)!;
      const cells: Record<
        IsoDate,
        { mark: Mark | null; note?: string; madeUp?: string } | undefined
      > = {};
      for (const s of list) {
        const m = markOf(s.date, id);
        if (m)
          cells[s.date] = {
            mark: m.status,
            ...(m.note ? { note: m.note } : {}),
            ...(m.madeUp ? { madeUp: m.madeUp } : {}),
          };
        else if (expects(id, s)) cells[s.date] = { mark: null };
      }
      // Runs over counted sessions, oldest first.
      let run = 0;
      let best = 0;
      let missing = 0;
      let longestMissing = 0;
      for (const s of list) {
        const m = markOf(s.date, id)?.status;
        if (!counts(m)) continue;
        if (came(m)) {
          run++;
          missing = 0;
        } else {
          missing++;
          run = 0;
        }
        best = Math.max(best, run);
        longestMissing = Math.max(longestMissing, missing);
      }
      const t = tally(id, list);
      // Too few sessions last month say nothing about a change.
      const lastMonth = tally(id, before);
      const previous = lastMonth.counted >= ENOUGH ? lastMonth.rate : null;
      return {
        studentId: id,
        fullName: own[0]!.fullName,
        code: own[0]!.code,
        joinedOn: first >= month ? first : null,
        leftOn: !open && last <= lastDay(month) && last >= month ? last : null,
        cells,
        ...t,
        previousRate: previous,
        change: t.rate !== null && previous !== null ? t.rate - previous : null,
        bestStreak: best,
        absentRun: missing,
        longestAbsence: longestMissing,
        lastAttended:
          [...list].reverse().find((s) => came(markOf(s.date, id)?.status))?.date ?? null,
      };
    })
    .sort((a, c) => a.fullName.localeCompare(c.fullName));

  // ── Sessions ──
  const sessions = list.map((s) => {
    const state = stateOf(s);
    const expected = rows.filter((r) => expects(r.studentId, s)).length;
    // What happened in the room: marks of this session, not makeups elsewhere.
    const here = rows
      .map((r) => markOf(s.date, r.studentId))
      .filter((m) => m && !m.madeUp)
      .map((m) => m!.status);
    const n = (m: Mark) => here.filter((x) => x === m).length;
    const c = checkInOn.get(s.date);
    const late = c ? toMin(istMinutes.format(c.at)) - toMin(c.start) : 0;
    return {
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      origin: sessionOrigin(s),
      state,
      reason: cancelOn.get(s.date)?.reason ?? null,
      substitute: subs.find((x) => x.from <= s.date && x.to >= s.date)?.name ?? null,
      checkedIn: c ? { coachName: c.coachName, lateBy: late > GRACE ? late : 0 } : null,
      expected,
      marked: here.length,
      present: n('present'),
      late: n('late'),
      absent: n('absent'),
      excused: n('excused'),
      rate: pct(n('present') + n('late'), n('present') + n('late') + n('absent')),
    };
  });

  // ── Insights ──
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((x, r) => x + f(r), 0);
  const attended = sum((r) => r.attended);
  const counted = sum((r) => r.counted);
  const rate = pct(attended, counted);
  const prev = rows.length
    ? [...new Set(members.map(({ e }) => e.studentId))].map((id) => tally(id, before))
    : [];
  const previousCounted = prev.reduce((x, t) => x + t.counted, 0);
  const previousRate =
    previousCounted >= ENOUGH
      ? pct(
          prev.reduce((x, t) => x + t.attended, 0),
          previousCounted,
        )
      : null;
  const held = sessions.filter((s) => s.state === 'held');
  const withRate = held.filter((s) => s.rate !== null);
  const group = (key: (s: (typeof sessions)[number]) => string) => {
    const out = new Map<string, { sessions: number; attended: number; counted: number }>();
    for (const s of withRate) {
      const g = out.get(key(s)) ?? { sessions: 0, attended: 0, counted: 0 };
      g.sessions++;
      g.attended += s.present + s.late;
      g.counted += s.present + s.late + s.absent;
      out.set(key(s), g);
    }
    return [...out.entries()].sort(([x], [y]) => x.localeCompare(y));
  };
  const person = (r: (typeof rows)[number]) => ({
    studentId: r.studentId,
    fullName: r.fullName,
    rate: r.rate,
    change: r.change,
    attended: r.attended,
    counted: r.counted,
    absentRun: r.absentRun,
    bestStreak: r.bestStreak,
    late: r.late,
    lastAttended: r.lastAttended,
  });
  const rated = rows.filter((r) => r.rate !== null);
  const byRate = [...rated].sort(
    (x, y) => y.rate! - x.rate! || y.counted - x.counted || x.fullName.localeCompare(y.fullName),
  );
  const best = withRate.reduce<(typeof sessions)[number] | null>(
    (m, s) => (!m || s.rate! > m.rate! ? s : m),
    null,
  );
  const worst = withRate.reduce<(typeof sessions)[number] | null>(
    (m, s) => (!m || s.rate! < m.rate! ? s : m),
    null,
  );
  const checked = held.filter((s) => s.checkedIn);
  const expectedMarks = held.reduce((x, s) => x + s.expected, 0);
  const actualMarks = held.reduce((x, s) => x + Math.min(s.marked, s.expected), 0);

  return {
    batch: {
      id: b.id,
      name: b.name,
      coach: { id: b.coachId, name: b.coachName },
      location: b.locationName,
      sport: b.sportName,
      weekdays: b.weekdays,
      startTime: b.startTime,
      endTime: b.endTime,
      dayTimes: b.dayTimes,
      capacity: b.capacity,
      isActive: b.isActive,
    },
    month,
    today,
    sessions,
    students: rows,
    summary: {
      students: rows.length,
      rate,
      previousRate,
      change: rate !== null && previousRate !== null ? rate - previousRate : null,
      present: sum((r) => r.present),
      late: sum((r) => r.late),
      absent: sum((r) => r.absent),
      excused: sum((r) => r.excused),
      madeUp: rows.reduce((n, r) => n + Object.values(r.cells).filter((c) => c?.madeUp).length, 0),
      sessions: sessions.length,
      held: held.length,
      cancelled: sessions.filter((s) => s.state === 'cancelled').length,
      unrecorded: sessions.filter((s) => s.state === 'unrecorded').length,
      upcoming: sessions.filter((s) => s.state === 'upcoming').length,
      moved: sessions.filter((s) => s.origin.kind === 'moved').length,
      extra: sessions.filter((s) => s.origin.kind === 'extra').length,
      covered: held.filter((s) => s.substitute).length,
      averagePresent: withRate.length
        ? Math.round(
            (withRate.reduce((x, s) => x + s.present + s.late, 0) / withRate.length) * 10,
          ) / 10
        : null,
      /** Marks made of the marks due in sessions held. */
      completeness: pct(actualMarks, expectedMarks),
      unmarked: expectedMarks - actualMarks,
      punctuality: pct(checked.filter((s) => !s.checkedIn!.lateBy).length, checked.length),
      checkIns: checked.length,
    },
    insights: {
      byWeekday: group((s) => String(isoWeekday(s.date))).map(([weekday, g]) => ({
        weekday: Number(weekday),
        sessions: g.sessions,
        rate: pct(g.attended, g.counted),
      })),
      byWeek: group((s) => startOfIsoWeek(s.date)).map(([week, g]) => ({
        week,
        sessions: g.sessions,
        rate: pct(g.attended, g.counted),
      })),
      bands: {
        excellent: rated.filter((r) => r.rate! >= 90).length,
        good: rated.filter((r) => r.rate! >= GOOD && r.rate! < 90).length,
        fair: rated.filter((r) => r.rate! >= LOW && r.rate! < GOOD).length,
        low: rated.filter((r) => r.rate! < LOW).length,
        none: rows.length - rated.length,
      },
      best: best ? { date: best.date, rate: best.rate } : null,
      worst:
        worst && best && worst.date !== best.date ? { date: worst.date, rate: worst.rate } : null,
      top: byRate.slice(0, 5).map(person),
      perfect: rated.filter((r) => r.rate === 100 && r.counted >= 2).map(person),
      low: [...byRate]
        .reverse()
        .filter((r) => r.rate! < LOW)
        .map(person),
      absentRuns: rows
        .filter((r) => r.absentRun >= RUN && !r.leftOn)
        .sort((x, y) => y.absentRun - x.absentRun)
        .map(person),
      improved: rows
        .filter((r) => (r.change ?? 0) >= 10)
        .sort((x, y) => y.change! - x.change!)
        .slice(0, 5)
        .map(person),
      declined: rows
        .filter((r) => (r.change ?? 0) <= -10)
        .sort((x, y) => x.change! - y.change!)
        .slice(0, 5)
        .map(person),
      oftenLate: rows
        .filter((r) => r.late >= 2)
        .sort((x, y) => y.late - x.late)
        .slice(0, 5)
        .map(person),
      neverMarked: rows.filter((r) => r.counted + r.excused === 0 && r.unmarked > 0).map(person),
      joined: rows.filter((r) => r.joinedOn).length,
      left: rows.filter((r) => r.leftOn).length,
    },
  };
}
export type MonthlyRegister = ReturnType<typeof build>;

export async function monthlyRegister(
  b: RegisterBatch,
  month: IsoDate,
  now: Date = new Date(),
): Promise<MonthlyRegister> {
  return build(b, month, await load([b], month), now);
}

/** A tile per batch: the month at a glance. */
export async function registerTiles(list: RegisterBatch[], month: IsoDate, now: Date = new Date()) {
  if (!list.length) return [];
  const all = await load(list, month);
  return list
    .map((b) => build(b, month, all, now))
    .filter((r) => r.batch.isActive || r.summary.held > 0)
    .map(({ students: _s, sessions, insights, ...r }) => ({
      ...r,
      low: insights.low.length,
      absentRuns: insights.absentRuns.length,
      perfect: insights.perfect.length,
      /** Each session's attendance, for the little trend. */
      trend: sessions
        .filter((s) => s.state === 'held' && s.rate !== null)
        .map((s) => ({ date: s.date, rate: s.rate })),
    }));
}
