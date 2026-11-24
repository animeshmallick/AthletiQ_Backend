import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { batches, enrollments, makeupSessions, students } from '../../db/schema/index.js';
import { sessionOn } from '../schedule/schedule.js';
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
    or(isNull(enrollments.plannedEndOn), gte(enrollments.plannedEndOn, date)),
    lte(students.joiningDate, date),
    or(isNull(students.leftOn), gte(students.leftOn, date)),
  );
}

/**
 * Who is expected at the batch's session on `date`, given what kind of session it is:
 *  - regular: members on that day whose training days include its weekday;
 *  - moved:   members on the *original* day (the session they were booked into);
 *  - extra:   every member on that day.
 */
async function homeFilter(batchId: string, date: IsoDate) {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  const session = batch ? await sessionOn(batch, date) : null;
  // No session that day (not a batch day, or moved away): nobody from the batch is expected.
  if (!session) return sql`false`;
  if (session.kind === 'extra') return enrolledOn(batchId, date);
  const day = session.kind === 'moved' ? session.originalDate! : date;
  return and(enrolledOn(batchId, day), sql`${isoWeekday(day)} = any(${enrollments.trainingDays})`);
}

/**
 * Students expected at a batch session: home-batch students (see `homeFilter`), plus students
 * with a one-off makeup booked into this batch for that date.
 */
export async function expectedRoster(batchId: string, date: IsoDate): Promise<RosterEntry[]> {
  const home = await homeFilter(batchId, date);

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
      .where(home)
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
      .where(
        and(
          eq(makeupSessions.batchId, batchId),
          eq(makeupSessions.date, date),
          eq(makeupSessions.status, 'approved'),
        ),
      )
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
