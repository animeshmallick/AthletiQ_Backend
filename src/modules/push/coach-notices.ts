/**
 * Event pushes for coaches about their own batches: assigned, changed, moved away, new students.
 * All are fire-and-forget (see notifyInBackground) and no-ops when push isn't configured.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { dayPhrase, onDay } from '../../lib/dates.js';
import { batches, enrollments, locations, students } from '../../db/schema/index.js';
import { clockLabel } from '../tasks/tasks.service.js';
import { notifyUsers } from './push.service.js';

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const daysLabel = (days: number[]) =>
  [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY[d])
    .join(' · ');

type BatchRow = typeof batches.$inferSelect;

async function batchWithLocation(batchId: string) {
  const [row] = await db
    .select({ batch: batches, location: locations.name })
    .from(batches)
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(eq(batches.id, batchId));
  return row;
}

const schedule = (b: BatchRow, location: string) =>
  `${daysLabel(b.weekdays)} · ${clockLabel(b.startTime)}–${clockLabel(b.endTime)} · ${location}`;

/** A batch was created for, or reassigned to, this coach. */
export async function noticeBatchAssigned(batchId: string, previousCoachId?: string) {
  const row = await batchWithLocation(batchId);
  if (!row) return;
  const { batch: b, location } = row;
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.batchId, b.id), isNull(enrollments.effectiveTo)));
  await notifyUsers([b.coachId], {
    title: `New batch assigned: ${b.name}`,
    body: `${schedule(b, location)}${n ? ` · ${n} student${n === 1 ? '' : 's'}` : ''}`,
    link: `/batches/${b.id}`,
    tag: `batch-${b.id}`,
  });
  if (previousCoachId && previousCoachId !== b.coachId) {
    await notifyUsers([previousCoachId], {
      title: `${b.name} moved to another coach`,
      body: 'It no longer appears in your schedule.',
      link: '/calendar',
      tag: `batch-${b.id}`,
    });
  }
}

/** The coach's batch changed (time, days, location or name). */
export async function noticeBatchChanged(
  before: BatchRow,
  batchId: string,
  opts: { studentsUpdated?: boolean } = {},
) {
  const row = await batchWithLocation(batchId);
  if (!row) return;
  const { batch: b, location } = row;
  const changes: string[] = [];
  if (before.name !== b.name) changes.push(`renamed from ${before.name}`);
  if (before.startTime !== b.startTime || before.endTime !== b.endTime) {
    changes.push(`now ${clockLabel(b.startTime)}–${clockLabel(b.endTime)}`);
  }
  if (before.weekdays.join() !== b.weekdays.join()) {
    changes.push(
      `days now ${daysLabel(b.weekdays)}${opts.studentsUpdated ? ' (students updated)' : ''}`,
    );
  }
  if (before.locationId !== b.locationId) changes.push(`location now ${location}`);
  if (before.isActive && !b.isActive) changes.push('batch closed');
  if (!changes.length) return;
  await notifyUsers([b.coachId], {
    title: `${b.name} was updated`,
    body: changes.join(' · '),
    link: `/batches/${b.id}`,
    tag: `batch-${b.id}`,
  });
}

/** A student joined (or moved into) one of the coach's batches. */
export async function noticeStudentJoined(studentId: string) {
  const [row] = await db
    .select({
      name: students.fullName,
      batchId: batches.id,
      batchName: batches.name,
      coachId: batches.coachId,
      days: enrollments.trainingDays,
      from: enrollments.effectiveFrom,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(and(eq(enrollments.studentId, studentId), isNull(enrollments.effectiveTo)));
  if (!row) return;
  await notifyUsers([row.coachId], {
    title: `New student in ${row.batchName}`,
    body: `${row.name} · ${daysLabel(row.days)} from ${dayPhrase(row.from)}`,
    link: `/students/${studentId}`,
    tag: `student-${studentId}`,
  });
}

async function studentName(studentId: string) {
  const s = await db.query.students.findFirst({ where: eq(students.id, studentId) });
  return s?.fullName ?? 'A student';
}

/** A student left the academy → the coach of the batch they were in. */
export async function noticeStudentLeft(studentId: string, batchId: string, leftOn: string) {
  const b = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!b) return;
  await notifyUsers([b.coachId], {
    title: `${await studentName(studentId)} left the academy`,
    body: `${b.name} · last day ${dayPhrase(leftOn)}`,
    link: `/students/${studentId}`,
    tag: `student-${studentId}`,
  });
}

/** A student moved to another batch → the coach of the batch they moved out of. */
export async function noticeStudentMovedOut(
  studentId: string,
  fromBatchId: string,
  toBatchId: string,
  from: string,
) {
  const [a, b] = await Promise.all([
    db.query.batches.findFirst({ where: eq(batches.id, fromBatchId) }),
    db.query.batches.findFirst({ where: eq(batches.id, toBatchId) }),
  ]);
  if (!a || !b || a.coachId === b.coachId) return; // same coach also gets the "joined" notice
  await notifyUsers([a.coachId], {
    title: `${await studentName(studentId)} moved out of ${a.name}`,
    body: `Now in ${b.name} from ${dayPhrase(from)}`,
    link: `/batches/${a.id}`,
    tag: `student-${studentId}`,
  });
}

/** Someone other than the coach cancelled (or restored) one of their sessions. */
export async function noticeSessionCancelled(
  batchId: string,
  date: string,
  byUserId: string,
  reason: string | null,
  restored = false,
) {
  const row = await batchWithLocation(batchId);
  if (!row || row.batch.coachId === byUserId) return;
  const { batch: b } = row;
  await notifyUsers([b.coachId], {
    title: restored
      ? `${b.name} is on again ${onDay(date)}`
      : `${b.name} is cancelled ${onDay(date)}`,
    body: restored
      ? `The session is running again · ${clockLabel(b.startTime)}–${clockLabel(b.endTime)}`
      : `Reason: ${reason ?? 'not given'}`,
    link: `/calendar?date=${date}&view=day`,
    tag: `session-${b.id}-${date}`,
  });
}

/** An admin booked a makeup student into a coach's batch (coach requests notify on approval). */
export async function noticeMakeupBooked(
  studentId: string,
  batchId: string,
  date: string,
  byUserId: string,
) {
  const b = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!b || b.coachId === byUserId) return;
  await notifyUsers([b.coachId], {
    title: `Makeup student in ${b.name}`,
    body: `${await studentName(studentId)} joins ${onDay(date)}`,
    link: `/attendance?batch=${b.id}&date=${date}`,
    tag: `makeup-${studentId}-${date}`,
  });
}
