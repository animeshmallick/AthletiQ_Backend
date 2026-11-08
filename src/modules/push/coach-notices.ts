/**
 * Event pushes for coaches about their own batches: assigned, changed, moved away, new students.
 * All are fire-and-forget (see notifyInBackground) and no-ops when push isn't configured.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { batches, enrollments, locations, students } from '../../db/schema/index.js';
import { clockLabel } from '../tasks/tasks.service.js';
import { notifyUsers } from './push.service.js';

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const daysLabel = (days: number[]) =>
  [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY[d])
    .join(' · ');

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

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
    body: `${row.name} · ${daysLabel(row.days)} from ${shortDate(row.from)}`,
    link: `/students/${studentId}`,
    tag: `student-${studentId}`,
  });
}
