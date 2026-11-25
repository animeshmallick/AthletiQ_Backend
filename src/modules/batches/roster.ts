import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { enrollments, makeupSessions, students } from '../../db/schema/index.js';
import { isoWeekday, type IsoDate } from '../../lib/dates.js';
import { isLive, resolutionKey, resolutionsFor } from '../schedule/makeups.js';
import { rosterDay, scheduleFor, type BatchTiming } from '../schedule/schedule.js';

export interface RosterEntry {
  studentId: string;
  code: string;
  fullName: string;
  phone: string;
  isMakeup: boolean;
  makeupReason: string | null;
  /** Making up a missed session of this batch. */
  homeBatchId?: string | null;
}

/**
 * Who is expected at every session of these batches between two days, by `batchId:date`:
 *  - regular: members on that day whose training days include its weekday;
 *  - moved:   members on the *original* day (the session they were booked into);
 *  - extra:   every member on that day;
 *  - plus students with a one-off makeup booked into it.
 * Students who made the session up elsewhere (or don't need it) aren't expected. A day without a
 * session expects only its makeups. A few queries, however many batches and days.
 */
export async function rostersIn(list: BatchTiming[], from: IsoDate, to: IsoDate) {
  const out = new Map<string, RosterEntry[]>();
  const ids = list.map((b) => b.id);
  if (!ids.length) return out;
  const who = {
    studentId: students.id,
    code: students.code,
    fullName: students.fullName,
    phone: students.phone,
  };
  const [schedule, settled, members, makeups] = await Promise.all([
    scheduleFor(list, from, to),
    resolutionsFor(ids),
    db
      .select({
        ...who,
        batchId: enrollments.batchId,
        effectiveFrom: enrollments.effectiveFrom,
        effectiveTo: enrollments.effectiveTo,
        plannedEndOn: enrollments.plannedEndOn,
        trainingDays: enrollments.trainingDays,
        joinedOn: students.joiningDate,
        leftOn: students.leftOn,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(inArray(enrollments.batchId, ids))
      .orderBy(asc(students.fullName)),
    db
      .select({
        ...who,
        batchId: makeupSessions.batchId,
        date: makeupSessions.date,
        reason: makeupSessions.reason,
        homeBatchId: makeupSessions.missedBatchId,
      })
      .from(makeupSessions)
      .innerJoin(students, eq(students.id, makeupSessions.studentId))
      .where(
        and(
          inArray(makeupSessions.batchId, ids),
          gte(makeupSessions.date, from),
          lte(makeupSessions.date, to),
          eq(makeupSessions.status, 'approved'),
        ),
      )
      .orderBy(asc(students.fullName)),
  ]);
  const membersOf = new Map<string, typeof members>(ids.map((id) => [id, []]));
  for (const m of members) membersOf.get(m.batchId)!.push(m);
  for (const b of list)
    for (const s of schedule.get(b.id) ?? []) {
      const day = rosterDay(s);
      const weekday = isoWeekday(day);
      const rows: RosterEntry[] = [];
      for (const m of membersOf.get(b.id)!)
        if (
          m.effectiveFrom <= day &&
          (!m.effectiveTo || m.effectiveTo >= day) &&
          (!m.plannedEndOn || m.plannedEndOn >= day) &&
          m.joinedOn <= day &&
          (!m.leftOn || m.leftOn >= day) &&
          (s.kind === 'extra' || m.trainingDays.includes(weekday)) &&
          !isLive(settled.get(resolutionKey(b.id, day, m.studentId)))
        )
          rows.push({
            studentId: m.studentId,
            code: m.code,
            fullName: m.fullName,
            phone: m.phone,
            isMakeup: false,
            makeupReason: null,
          });
      out.set(`${b.id}:${s.date}`, rows);
    }
  for (const { batchId, date, reason, homeBatchId, ...m } of makeups) {
    const key = `${batchId}:${date}`;
    const rows = out.get(key) ?? [];
    if (!rows.some((r) => r.studentId === m.studentId))
      rows.push({ ...m, isMakeup: true, makeupReason: reason, homeBatchId });
    out.set(key, rows);
  }
  return out;
}

/** Students expected at one batch session (see `rostersIn`). */
export async function expectedRoster(batch: BatchTiming, date: IsoDate): Promise<RosterEntry[]> {
  return (await rostersIn([batch], date, date)).get(`${batch.id}:${date}`) ?? [];
}

/** Students currently (today-open) enrolled in a batch, regardless of weekday. */
export async function currentMembers(batchId: string) {
  return db
    .select({
      studentId: students.id,
      code: students.code,
      fullName: students.fullName,
      phone: students.phone,
      trainingDays: enrollments.trainingDays,
      effectiveFrom: enrollments.effectiveFrom,
      status: students.status,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(and(eq(enrollments.batchId, batchId), isNull(enrollments.effectiveTo)))
    .orderBy(asc(students.fullName));
}
