/**
 * How each cycle went: sessions conducted by the academy (a check-in or any attendance, whoever
 * came), and what this student did. A rescheduled session belongs to the cycle of its original day.
 */
import { and, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  batches,
  coachSessions,
  enrollments,
  sessionCancellations,
  studentAttendance,
} from '../../db/schema/index.js';
import { addDays, instantAt, minDate, type IsoDate } from '../../lib/dates.js';
import { isLive, resolutionKey, resolutionsFor } from '../schedule/makeups.js';
import { belongsTo, rosterDay, scheduleFor } from '../schedule/schedule.js';
import type { Cycle } from './cycles.js';

export type Mark = 'present' | 'late' | 'absent' | 'excused';
export type SessionState = 'held' | 'missed' | 'closed' | 'unconfirmed' | 'upcoming';

export interface CycleSession {
  date: IsoDate;
  /** For a rescheduled session, the day it was moved from. */
  originalDate: IsoDate | null;
  kind: 'regular' | 'moved' | 'extra';
  startTime: string;
  endTime: string;
  state: SessionState;
  reason: string | null;
  mark: Mark | null;
  /** Made up (or to be made up) in another batch. */
  makeup: { batchName: string; date: IsoDate } | null;
}

export interface CycleProgress {
  target: number;
  conducted: number;
  attended: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  missed: number;
  unconfirmed: number;
  upcoming: number;
  /** Attended of conducted, in percent. */
  rate: number | null;
  sessions: CycleSession[];
}

/** Sessions can be held this long after the cycle they belong to (reschedules). */
const SPILL_DAYS = 90;

export async function cycleProgress(
  cycles: Cycle[],
  now: Date = new Date(),
): Promise<Map<string, CycleProgress>> {
  const out = new Map<string, CycleProgress>();
  if (!cycles.length) return out;
  const batchIds = [...new Set(cycles.map((c) => c.batchId))];
  const studentIds = [...new Set(cycles.map((c) => c.studentId))];
  const from = cycles.map((c) => c.startsOn).reduce(minDate);
  const to = addDays(
    cycles.map((c) => c.endsOn).reduce((a, b) => (a > b ? a : b)),
    SPILL_DAYS,
  );
  const inRange = (col: typeof studentAttendance.date) => and(gte(col, from), lte(col, to));
  const [list, members, cancels, checkIns, marks] = await Promise.all([
    db.select().from(batches).where(inArray(batches.id, batchIds)),
    db
      .select()
      .from(enrollments)
      .where(
        inArray(
          enrollments.id,
          cycles.map((c) => c.enrollmentId),
        ),
      ),
    db
      .select()
      .from(sessionCancellations)
      .where(
        and(
          inArray(sessionCancellations.batchId, batchIds),
          gte(sessionCancellations.date, from),
          lte(sessionCancellations.date, to),
        ),
      ),
    db
      .select({ batchId: coachSessions.batchId, date: coachSessions.date })
      .from(coachSessions)
      .where(
        and(
          inArray(coachSessions.batchId, batchIds),
          gte(coachSessions.date, from),
          lte(coachSessions.date, to),
        ),
      ),
    db
      .select({
        batchId: studentAttendance.batchId,
        studentId: studentAttendance.studentId,
        date: studentAttendance.date,
        status: studentAttendance.status,
      })
      .from(studentAttendance)
      .where(and(inArray(studentAttendance.batchId, batchIds), inRange(studentAttendance.date))),
  ]);
  const [schedule, settled] = await Promise.all([
    scheduleFor(list, from, to),
    resolutionsFor(batchIds, { now }),
  ]);
  const off = new Map(cancels.map((c) => [`${c.batchId}:${c.date}`, c]));
  const held = new Set([...checkIns, ...marks].map((r) => `${r.batchId}:${r.date}`));
  const wanted = new Set(studentIds);
  const markOf = new Map(
    marks
      .filter((m) => wanted.has(m.studentId))
      .map((m) => [`${m.batchId}:${m.date}:${m.studentId}`, m.status]),
  );

  for (const c of cycles) {
    const e = members.find((m) => m.id === c.enrollmentId);
    const last = c.endedOn ?? c.endsOn;
    const sessions: CycleSession[] = [];
    for (const s of schedule.get(c.batchId) ?? []) {
      const day = rosterDay(s);
      const own = markOf.get(`${c.batchId}:${s.date}:${c.studentId}`) ?? null;
      const found = settled.get(resolutionKey(c.batchId, day, c.studentId));
      // Made up elsewhere: what counts is that session (unless they came to this one after all).
      const r = isLive(found) && !own ? found : undefined;
      const mark = r?.makeup ? r.makeup.mark : own;
      if (day < c.startsOn || day > last) continue;
      if (!e || (!belongsTo(e, s) && !own)) continue;
      const key = `${c.batchId}:${s.date}`;
      const x = off.get(key);
      const state: SessionState = r
        ? r.state === 'made-up'
          ? 'held'
          : r.state === 'booked'
            ? 'upcoming'
            : 'closed'
        : x
          ? x.closedAt
            ? 'closed'
            : 'missed'
          : held.has(key)
            ? 'held'
            : instantAt(s.date, s.endTime) > now
              ? 'upcoming'
              : 'unconfirmed';
      sessions.push({
        date: s.date,
        originalDate: s.kind === 'moved' ? s.originalDate : null,
        kind: s.kind,
        startTime: s.startTime,
        endTime: s.endTime,
        state,
        reason:
          r?.state === 'excused'
            ? `Not needed: ${r.reason}`
            : x
              ? (x.closedReason ?? x.reason)
              : null,
        mark,
        makeup: r?.makeup ? { batchName: r.makeup.batchName, date: r.makeup.date } : null,
      });
    }
    const n = (f: (s: CycleSession) => boolean) => sessions.filter(f).length;
    const status = (m: Mark) => n((s) => s.state === 'held' && s.mark === m);
    const conducted = n((s) => s.state === 'held');
    const present = status('present');
    const late = status('late');
    out.set(c.id, {
      target: c.perMonth * c.months,
      conducted,
      attended: present + late,
      present,
      late,
      absent: status('absent'),
      excused: status('excused'),
      missed: n((s) => s.state === 'missed' || s.state === 'closed'),
      unconfirmed: n((s) => s.state === 'unconfirmed'),
      upcoming: n((s) => s.state === 'upcoming'),
      rate: conducted ? Math.round(((present + late) * 100) / conducted) : null,
      sessions,
    });
  }
  return out;
}
