/**
 * Making up a missed session student by student (mounted at /session-changes/missed):
 *
 *  GET    /students          every student of a missed session and how they stand
 *  GET    /options           sessions one student could attend instead
 *  POST   /makeups           books one (409 to confirm when that session is full)
 *  DELETE /makeups/:id       cancels a booking that wasn't held
 *  POST   /excuse, /unexcuse a student doesn't need it (with a reason), or does after all
 *
 * The batch's own coach uses batches they run themselves, within 30 days; admins any batch, up to
 * 90. Nothing is billed, refunded or re-split.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  makeupExcusals,
  makeupSessions,
  sessionCancellations,
  studentAttendance,
  students,
} from '../../db/schema/index.js';
import { addDays, formatDisplayDate, instantAt, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { getBatchOrThrow, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notifyAdmins, notifyInBackground, notifyUsers } from '../push/push.service.js';
import { makeupOptions, resolutionKey, resolutionsFor, type Resolution } from './makeups.js';
import { rosterDay, scheduleFor, type ScheduledSession } from './schedule.js';
import { ADMIN_DAYS, affectedStudents, lockSchedule, RESCHEDULE_DAYS } from './session-changes.js';

export const missedMakeupsRouter = Router();

type Batch = Awaited<ReturnType<typeof getBatchOrThrow>>;

const Key = z.object({ batchId: zId, originalDate: zIsoDate });
const StudentKey = Key.extend({ studentId: zId });

/** The batch's own coach, or an admin. */
async function homeBatch(user: AuthUser, batchId: string): Promise<Batch> {
  const b = await getBatchOrThrow(batchId);
  if (!isAdmin(user) && b.coachId !== user.id) throw AppError.notFound('Batch');
  return b;
}

const limitOf = (user: AuthUser, day: IsoDate) =>
  addDays(day, isAdmin(user) ? ADMIN_DAYS : RESCHEDULE_DAYS);

/** The missed session (wherever it now sits), its cancellation, and how each student stands. */
async function load(batch: Batch, day: IsoDate, tx: DbOrTx = db) {
  const around = (
    await scheduleFor([batch], addDays(day, -ADMIN_DAYS), addDays(day, ADMIN_DAYS), tx)
  ).get(batch.id);
  const session = around?.find((s) => rosterDay(s) === day);
  if (!session)
    throw AppError.unprocessable(
      `${batch.name} has no session on ${formatDisplayDate(day)} to make up`,
    );
  const [cancellation] = await tx
    .select()
    .from(sessionCancellations)
    .where(
      and(eq(sessionCancellations.batchId, batch.id), eq(sessionCancellations.date, session.date)),
    );
  const [people, all, marked] = await Promise.all([
    affectedStudents(tx, batch.id, session),
    resolutionsFor([batch.id], { day, tx }),
    tx
      .select({ studentId: studentAttendance.studentId })
      .from(studentAttendance)
      .where(
        and(eq(studentAttendance.batchId, batch.id), eq(studentAttendance.date, session.date)),
      ),
  ]);
  const came = new Set(marked.map((m) => m.studentId));
  const of = (id: string) => all.get(resolutionKey(batch.id, day, id));
  return { session, cancellation, people, of, came };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** Whether this student's part is still open (the session is missed, or their makeup fell through). */
function needsOne(l: Loaded, studentId: string, now = new Date()): boolean {
  if (l.cancellation) return !l.cancellation.closedAt;
  // Rescheduled and over without them, because they were booked elsewhere.
  return (
    l.of(studentId)?.state === 'lapsed' &&
    !l.came.has(studentId) &&
    instantAt(l.session.date, l.session.endTime) <= now
  );
}

function studentOf(l: Loaded, studentId: string) {
  const s = l.people.find((p) => p.id === studentId);
  if (!s) throw AppError.unprocessable('This student isn’t part of that session.');
  return s;
}

function assertOpen(l: Loaded, studentId: string) {
  const s = studentOf(l, studentId);
  const r = l.of(studentId);
  if (r?.state === 'made-up')
    throw AppError.conflict(`${s.fullName} already made it up in ${r.makeup!.batchName}.`);
  if (r?.state === 'booked')
    throw AppError.conflict(
      `${s.fullName} is already booked into ${r.makeup!.batchName}. Cancel that first.`,
    );
  if (r?.state === 'excused')
    throw AppError.conflict(`${s.fullName} is marked as not needing it. Undo that first.`);
  if (!needsOne(l, studentId))
    throw AppError.unprocessable(
      l.cancellation
        ? 'This missed session was closed.'
        : 'This session isn’t missed: it runs, or was held, with its own students.',
    );
  return s;
}

const view = (p: { id: string; fullName: string }, r: Resolution | undefined) => ({
  id: p.id,
  fullName: p.fullName,
  state: !r || r.state === 'lapsed' ? ('pending' as const) : r.state,
  /** They had one, but that session was cancelled or not held. */
  lapsed: r?.state === 'lapsed',
  reason: r?.state === 'excused' ? r.reason : null,
  makeup: r?.makeup ?? null,
});

missedMakeupsRouter.get('/students', async (req, res) => {
  const q = parse(Key, req.query);
  const user = currentUser(req);
  const batch = await homeBatch(user, q.batchId);
  const l = await load(batch, q.originalDate);
  const session: ScheduledSession = l.session;
  ok(res, {
    batch: { id: batch.id, name: batch.name },
    date: session.date,
    originalDate: q.originalDate,
    startTime: session.startTime,
    endTime: session.endTime,
    reason: l.cancellation?.reason ?? null,
    until: limitOf(user, q.originalDate),
    students: l.people
      // A rescheduled session: only students whose makeup stands or fell through.
      .filter((p) => l.cancellation || l.of(p.id))
      .map((p) => view(p, l.of(p.id)))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  });
});

missedMakeupsRouter.get('/options', async (req, res) => {
  const q = parse(StudentKey, req.query);
  const user = currentUser(req);
  const batch = await homeBatch(user, q.batchId);
  const s = assertOpen(await load(batch, q.originalDate), q.studentId);
  ok(
    res,
    await makeupOptions({
      home: batch,
      student: { id: s.id, plannedEndOn: s.enrollment.plannedEndOn },
      missedDay: q.originalDate,
      until: limitOf(user, q.originalDate),
      coachId: isAdmin(user) ? undefined : user.id,
    }),
  );
});

const BookBody = StudentKey.extend({
  toBatchId: zId,
  toDate: zIsoDate,
  /** The session is full; they go ahead. */
  confirm: z.boolean().optional(),
});

missedMakeupsRouter.post('/makeups', async (req, res) => {
  const body = parse(BookBody, req.body);
  const user = currentUser(req);
  await homeBatch(user, body.batchId);
  const done = await db.transaction(async (tx) => {
    await lockSchedule(tx);
    // Both sessions stay as they are until this is in (always in the same order).
    const locked = await tx
      .select()
      .from(batches)
      .where(inArray(batches.id, [body.batchId, body.toBatchId]))
      .orderBy(asc(batches.id))
      .for('update');
    const batch = locked.find((b) => b.id === body.batchId)!;
    const l = await load(batch, body.originalDate, tx);
    const s = assertOpen(l, body.studentId);
    const until = limitOf(user, body.originalDate);
    if (body.toDate > until)
      throw AppError.unprocessable(
        `Choose a session up to ${formatDisplayDate(until)}.${isAdmin(user) ? '' : ' Ask an admin for a later one.'}`,
      );
    const [option] = await makeupOptions(
      {
        home: batch,
        student: { id: s.id, plannedEndOn: s.enrollment.plannedEndOn },
        missedDay: body.originalDate,
        until,
        coachId: isAdmin(user) ? undefined : user.id,
        only: { batchId: body.toBatchId, date: body.toDate },
      },
      { tx },
    );
    if (!option)
      throw AppError.unprocessable(
        'That session can’t be used: it must be another of your batches at the same location and sport, still to start.',
      );
    if (option.blocked) throw AppError.unprocessable(`${s.fullName}: ${option.blocked}.`);
    if (option.full && !body.confirm)
      throw AppError.conflict(
        `${option.batch.name} is full that day (${option.expected} of ${option.capacity}). Add ${s.fullName} anyway?`,
        { warnings: [{ code: 'full' }] },
      );
    // The one that fell through gives way.
    const before = l.of(body.studentId)?.makeup;
    if (before) await tx.delete(makeupSessions).where(eq(makeupSessions.id, before.id));
    const [row] = await tx
      .insert(makeupSessions)
      .values({
        studentId: body.studentId,
        batchId: body.toBatchId,
        date: body.toDate,
        missedBatchId: body.batchId,
        missedDate: body.originalDate,
        reason: `Missed ${batch.name} on ${formatDisplayDate(body.originalDate)}`,
        createdById: user.id,
      })
      .returning();
    await audit(
      {
        ...auditCtx(req),
        action: 'student.makeup_booked',
        entityType: 'student',
        entityId: body.studentId,
        metadata: {
          missedBatchId: body.batchId,
          missedDate: body.originalDate,
          batchId: body.toBatchId,
          date: body.toDate,
          full: option.full,
        },
      },
      tx,
    );
    return { row: row!, student: s.fullName, option, homeName: batch.name };
  });
  const { option, student, homeName } = done;
  notifyInBackground(async () => {
    const to = await getBatchOrThrow(body.toBatchId);
    const home = await getBatchOrThrow(body.batchId);
    const people = [...new Set([to.coachId, home.coachId])].filter((id) => id !== user.id);
    await notifyUsers(people, {
      category: 'sessions',
      icon: '🔁',
      title: `${student} makes up a session in ${option.batch.name}`,
      body: `${formatDisplayDate(option.date)} · missed ${homeName} on ${formatDisplayDate(body.originalDate)}`,
      link: `/attendance?batch=${body.toBatchId}&date=${body.toDate}`,
      tag: `makeup-${done.row.id}`,
    });
  });
  created(res, done.row);
});

missedMakeupsRouter.delete('/makeups/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const found = await db.query.makeupSessions.findFirst({ where: eq(makeupSessions.id, id) });
  if (!found?.missedBatchId || !found.missedDate) throw AppError.notFound('Makeup session');
  await homeBatch(user, found.missedBatchId);
  await db.transaction(async (tx) => {
    await lockSchedule(tx);
    // Attendance there waits for this.
    await tx
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.id, found.batchId))
      .for('update');
    const all = await resolutionsFor([found.missedBatchId!], { day: found.missedDate!, tx });
    const r = [...all.values()].find((x) => x.makeup?.id === id);
    if (!r) throw AppError.notFound('Makeup session');
    if (r.state === 'made-up')
      throw AppError.conflict(
        'That session was held, so it counts. Correct its attendance instead.',
      );
    await tx.delete(makeupSessions).where(eq(makeupSessions.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'student.makeup_cancelled',
        entityType: 'student',
        entityId: found.studentId,
        metadata: {
          batchId: found.batchId,
          date: found.date,
          missedBatchId: found.missedBatchId,
          missedDate: found.missedDate,
        },
      },
      tx,
    );
  });
  noContent(res);
});

const ExcuseBody = StudentKey.extend({
  reason: z.string().trim().min(3, 'Please give a reason').max(300),
});

missedMakeupsRouter.post('/excuse', async (req, res) => {
  const body = parse(ExcuseBody, req.body);
  const user = currentUser(req);
  const batch = await homeBatch(user, body.batchId);
  const name = await db.transaction(async (tx) => {
    await lockSchedule(tx);
    const l = await load(batch, body.originalDate, tx);
    const s = assertOpen(l, body.studentId);
    const before = l.of(body.studentId)?.makeup;
    if (before) await tx.delete(makeupSessions).where(eq(makeupSessions.id, before.id));
    await tx.insert(makeupExcusals).values({
      batchId: body.batchId,
      date: body.originalDate,
      studentId: body.studentId,
      reason: body.reason,
      createdById: user.id,
    });
    await audit(
      {
        ...auditCtx(req),
        action: 'student.makeup_not_needed',
        entityType: 'student',
        entityId: body.studentId,
        metadata: { batchId: body.batchId, missedDate: body.originalDate, reason: body.reason },
      },
      tx,
    );
    return s.fullName;
  });
  if (!isAdmin(user))
    notifyInBackground(() =>
      notifyAdmins({
        category: 'sessions',
        icon: '📝',
        title: `${name} won’t make up ${batch.name}`,
        body: `${formatDisplayDate(body.originalDate)} · ${user.name}: ${body.reason}`,
        link: `/students/${body.studentId}`,
        tag: `excuse-${body.batchId}-${body.originalDate}-${body.studentId}`,
      }),
    );
  created(res, { excused: true });
});

missedMakeupsRouter.post('/unexcuse', async (req, res) => {
  const body = parse(StudentKey, req.body);
  const user = currentUser(req);
  const batch = await homeBatch(user, body.batchId);
  await db.transaction(async (tx) => {
    await lockSchedule(tx);
    const l = await load(batch, body.originalDate, tx);
    studentOf(l, body.studentId);
    if (!l.cancellation && instantAt(l.session.date, l.session.startTime) <= new Date())
      throw AppError.conflict('The rescheduled session has already started.');
    const [gone] = await tx
      .delete(makeupExcusals)
      .where(
        and(
          eq(makeupExcusals.batchId, body.batchId),
          eq(makeupExcusals.date, body.originalDate),
          eq(makeupExcusals.studentId, body.studentId),
        ),
      )
      .returning();
    if (!gone) throw AppError.notFound('Student');
    await audit(
      {
        ...auditCtx(req),
        action: 'student.makeup_needed',
        entityType: 'student',
        entityId: body.studentId,
        metadata: { batchId: body.batchId, missedDate: body.originalDate },
      },
      tx,
    );
  });
  ok(res, { excused: false });
});

/** Tells home coaches that a session their students were booked into won't run. */
export async function noticeMakeupsLost(batchId: string, date: IsoDate, actorId: string) {
  const rows = await db
    .select({ name: students.fullName, home: batches.name, coachId: batches.coachId })
    .from(makeupSessions)
    .innerJoin(students, eq(students.id, makeupSessions.studentId))
    .innerJoin(batches, eq(batches.id, makeupSessions.missedBatchId))
    .where(and(eq(makeupSessions.batchId, batchId), eq(makeupSessions.date, date)));
  for (const coachId of new Set(rows.map((r) => r.coachId))) {
    if (coachId === actorId) continue;
    const mine = rows.filter((r) => r.coachId === coachId);
    await notifyUsers([coachId], {
      category: 'sessions',
      icon: '🔁',
      title: 'A makeup session was cancelled',
      body: `${mine.map((r) => `${r.name} (${r.home})`).join(', ')}: book another one.`,
      link: '/missed-sessions',
      tag: `makeup-lost-${batchId}-${date}`,
    });
  }
}
