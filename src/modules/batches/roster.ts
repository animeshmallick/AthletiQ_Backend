import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { enrollments, makeupSessions, students } from '../../db/schema/index.js';
import { isoWeekday, type IsoDate } from '../../lib/dates.js';

export interface RosterEntry {
  studentId: string;
  code: string;
  fullName: string;
  phone: string;
  isMakeup: boolean;
  makeupReason: string | null;
}

/** Predicate: student was enrolled (and not yet left) in the batch on `date`. */
function enrolledOn(batchId: string, date: IsoDate) {
  return and(
    eq(enrollments.batchId, batchId),
    lte(enrollments.effectiveFrom, date),
    or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, date)),
    lte(students.joiningDate, date),
    or(isNull(students.leftOn), gte(students.leftOn, date)),
  );
}

/**
 * Students expected at a batch session: home-batch students whose training days include the
 * session's weekday, plus students with a one-off makeup booked into this batch for that date.
 */
export async function expectedRoster(batchId: string, date: IsoDate): Promise<RosterEntry[]> {
  const weekday = isoWeekday(date);

  const [regular, makeups] = await Promise.all([
    db
      .select({
        studentId: students.id,
        code: students.code,
        fullName: students.fullName,
        phone: students.phone,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(and(enrolledOn(batchId, date), sql`${weekday} = any(${enrollments.trainingDays})`))
      .orderBy(asc(students.fullName)),
    db
      .select({
        studentId: students.id,
        code: students.code,
        fullName: students.fullName,
        phone: students.phone,
        reason: makeupSessions.reason,
      })
      .from(makeupSessions)
      .innerJoin(students, eq(students.id, makeupSessions.studentId))
      .where(and(eq(makeupSessions.batchId, batchId), eq(makeupSessions.date, date)))
      .orderBy(asc(students.fullName)),
  ]);

  const seen = new Set(regular.map((r) => r.studentId));
  return [
    ...regular.map((r) => ({ ...r, isMakeup: false, makeupReason: null })),
    ...makeups
      .filter((m) => !seen.has(m.studentId))
      .map(({ reason, ...m }) => ({ ...m, isMakeup: true, makeupReason: reason })),
  ];
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
