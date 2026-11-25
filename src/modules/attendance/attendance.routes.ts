import { timesOn } from '../../lib/batch-times.js';
import { planStatusIn } from '../lessons/lessons.routes.js';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { COACH_ATTENDANCE_EDIT_WINDOW_DAYS } from '../../config/constants.js';
import { db } from '../../db/client.js';
import {
  batches,
  batchSubstitutions,
  coachSessions,
  locations,
  makeupSessions,
  sessionCancellations,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { addDays, diffDays, eachDay, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess, assertStudentAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { expectedRoster, rostersIn } from '../batches/roster.js';
import {
  requireSession,
  rosterDay,
  scheduleFor,
  sessionOn,
  sessionOrigin,
} from '../schedule/schedule.js';
import { cancellationsIn, getCancellation } from './cancellations.js';

export const attendanceRouter = Router();

const zStatus = z.enum(['present', 'absent', 'late', 'excused']);
type AttendanceStatus = z.infer<typeof zStatus>;
type Status = z.infer<typeof zStatus>;

function summarize(statuses: (Status | null)[]) {
  const s = { total: statuses.length, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const st of statuses) {
    if (st === null) s.unmarked++;
    else s[st]++;
  }
  return s;
}

// ─── Daily overview: every batch session for a date ──────────────────────────

/**
 * Every batch session on each day for this user (all batches for admins, own for coaches). About a
 * dozen database trips, however many days and batches.
 */
async function overviewRange(user: AuthUser, from: IsoDate, to: IsoDate) {
  const admin = isAdmin(user);
  const covers = and(
    eq(batchSubstitutions.status, 'approved'),
    lte(batchSubstitutions.fromDate, to),
    gte(batchSubstitutions.toDate, from),
  );
  const rows = await db
    .select({
      id: batches.id,
      name: batches.name,
      weekdays: batches.weekdays,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
      coachFeedback: batches.coachFeedback,
      coach: { id: users.id, name: users.name },
      location: {
        id: locations.id,
        name: locations.name,
        latitude: locations.latitude,
        longitude: locations.longitude,
      },
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(
      and(
        eq(batches.isActive, true),
        // Coaches: their own batches, plus batches they cover as a substitute.
        admin
          ? undefined
          : or(
              eq(batches.coachId, user.id),
              inArray(
                batches.id,
                db
                  .select({ id: batchSubstitutions.batchId })
                  .from(batchSubstitutions)
                  .where(and(eq(batchSubstitutions.substituteCoachId, user.id), covers)),
              ),
            ),
      ),
    );
  const ids = rows.map((b) => b.id);
  const within = (col: typeof studentAttendance.date | typeof coachSessions.date) =>
    and(gte(col, from), lte(col, to));
  const [schedule, cancelled, subs, marks, checkIns, plans, rosters] = await Promise.all([
    scheduleFor(rows, from, to),
    cancellationsIn(ids, from, to),
    ids.length
      ? db
          .select({
            batchId: batchSubstitutions.batchId,
            from: batchSubstitutions.fromDate,
            to: batchSubstitutions.toDate,
            id: users.id,
            name: users.name,
          })
          .from(batchSubstitutions)
          .innerJoin(users, eq(users.id, batchSubstitutions.substituteCoachId))
          .where(and(inArray(batchSubstitutions.batchId, ids), covers))
      : [],
    ids.length
      ? db
          .select({
            batchId: studentAttendance.batchId,
            date: studentAttendance.date,
            status: studentAttendance.status,
          })
          .from(studentAttendance)
          .where(and(inArray(studentAttendance.batchId, ids), within(studentAttendance.date)))
      : [],
    ids.length
      ? db
          .select()
          .from(coachSessions)
          .where(and(inArray(coachSessions.batchId, ids), within(coachSessions.date)))
      : [],
    // Every session follows its batch's lesson plan (or its own adjusted copy).
    planStatusIn(ids, from, to),
    rostersIn(rows, from, to),
  ]);
  const key = (r: { batchId: string; date: IsoDate }) => `${r.batchId}:${r.date}`;
  const marksAt = new Map<string, typeof marks>();
  for (const m of marks) marksAt.set(key(m), [...(marksAt.get(key(m)) ?? []), m]);
  const checkInAt = new Map(checkIns.map((c) => [key(c), c]));

  return eachDay(from, to).map((day) => {
    const sessions = rows.flatMap((row) => {
      // Each batch at its time on this day (moved and extra sessions at their own time).
      const session = schedule.get(row.id)?.find((x) => x.date === day);
      if (!session) return [];
      const sub = subs.find((x) => x.batchId === row.id && x.from <= day && x.to >= day);
      if (!admin && row.coach.id !== user.id && sub?.id !== user.id) return [];
      const { dayTimes: _dt, weekdays: _wd, ...b } = row;
      const at = `${row.id}:${day}`;
      const batchMarks = marksAt.get(at) ?? [];
      const expected = rosters.get(at)?.length ?? 0;
      const cs = checkInAt.get(at);
      const plan = plans(row.id, session);
      return [
        {
          batch: { ...b, startTime: session.startTime, endTime: session.endTime },
          expectedStudents: expected,
          marked: batchMarks.length,
          present: batchMarks.filter((m) => m.status === 'present' || m.status === 'late').length,
          attendanceComplete: expected > 0 && batchMarks.length >= expected,
          hasLessonPlan: plan.hasPlan,
          /** The plan adds up to this session's length (false after a timing change). */
          lessonPlanFits: plan.fits,
          /** This session's drills are filled in. */
          lessonPlanFilled: plan.filled,
          cancelled: cancelled.get(at) ?? null,
          /** Regular, moved here from another day/time, or an extra session. */
          origin: sessionOrigin(session),
          /** Who covers this session as a substitute coach, if anyone. */
          substitute: sub ? { id: sub.id, name: sub.name } : null,
          coachSession: cs ? { checkInAt: cs.checkInAt, flagged: !cs.checkInWithinFence } : null,
        },
      ];
    });
    return {
      date: day,
      sessions: sessions.sort((a, b) => a.batch.startTime.localeCompare(b.batch.startTime)),
    };
  });
}

export async function dayOverview(user: AuthUser, day: IsoDate) {
  return (await overviewRange(user, day, day))[0]!;
}

attendanceRouter.get('/overview', async (req, res) => {
  const { date } = parse(z.object({ date: zIsoDate.optional() }), req.query);
  ok(res, await dayOverview(currentUser(req), date ?? todayInAppTz()));
});

// ─── Calendar: day overviews for a range (week view) ─────────────────────────

const CalendarQuery = z
  .object({ from: zIsoDate, to: zIsoDate })
  .refine((q) => q.to >= q.from && diffDays(q.from, q.to) <= 41, {
    message: 'Pick a range of up to 6 weeks',
  });

attendanceRouter.get('/calendar', async (req, res) => {
  const q = parse(CalendarQuery, req.query);
  const user = currentUser(req);
  const days = await overviewRange(user, q.from, q.to);
  ok(res, { from: q.from, to: q.to, today: todayInAppTz(), days });
});

// ─── A single batch session ──────────────────────────────────────────────────

const SessionQuery = z.object({ batchId: zId, date: zIsoDate });

attendanceRouter.get('/session', async (req, res) => {
  const { batchId, date } = parse(SessionQuery, req.query);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, batchId, { on: date });

  const [session, roster, marks, cancellation, visit] = await Promise.all([
    sessionOn(batch, date),
    expectedRoster(batch, date),
    db
      .select({
        studentId: studentAttendance.studentId,
        status: studentAttendance.status,
        note: studentAttendance.note,
        isMakeup: studentAttendance.isMakeup,
        updatedAt: studentAttendance.updatedAt,
        fullName: students.fullName,
        code: students.code,
        phone: students.phone,
      })
      .from(studentAttendance)
      .innerJoin(students, eq(students.id, studentAttendance.studentId))
      .where(and(eq(studentAttendance.batchId, batchId), eq(studentAttendance.date, date))),
    getCancellation(batchId, date),
    user.role === 'coach' ? coachVisit(user.id, batchId, date) : null,
  ]);

  const byStudent = new Map(marks.map((m) => [m.studentId, m]));
  const rows = roster.map((r) => {
    const m = byStudent.get(r.studentId);
    byStudent.delete(r.studentId);
    return {
      ...r,
      status: m?.status ?? null,
      note: m?.note ?? null,
      markedAt: m?.updatedAt ?? null,
    };
  });
  // Students marked earlier who are no longer expected (e.g. later transferred) stay visible.
  for (const m of byStudent.values()) {
    rows.push({
      studentId: m.studentId,
      code: m.code,
      fullName: m.fullName,
      phone: m.phone,
      isMakeup: m.isMakeup,
      makeupReason: null,
      status: m.status,
      note: m.note,
      markedAt: m.updatedAt,
    });
  }

  const history = await recentAttendance(
    batchId,
    rows.map((r) => r.studentId),
    date,
  );
  const needsCheckIn = !!visit && !visit.checkedIn;
  const edit = canEdit(user.role, date);
  ok(res, {
    batch: {
      id: batch.id,
      name: batch.name,
      ...(session
        ? { startTime: session.startTime, endTime: session.endTime }
        : timesOn(batch, date)),
    },
    date,
    isScheduledDay: !!session,
    origin: session ? sessionOrigin(session) : null,
    cancelled: cancellation,
    editable: !cancellation && edit.allowed && !needsCheckIn,
    /** Coaches mark attendance only for sessions they checked in to. */
    needsCheckIn,
    lockedReason: cancellation
      ? null
      : !edit.allowed
        ? edit.reason
        : needsCheckIn
          ? 'Check in to this session to mark attendance.'
          : null,
    students: rows.map((r) => ({
      ...r,
      ...(history.get(r.studentId) ?? {
        recent: [],
        rate30: null,
        before30: { marked: 0, present: 0 },
      }),
    })),
    summary: summarize(rows.map((r) => r.status)),
  });
});

/**
 * Last 5 marks before `date` in this batch (newest first) and the attendance of the 29 days before
 * it, as counts too: with the mark for `date` added, that is the last 30 days.
 */
async function recentAttendance(batchId: string, studentIds: string[], date: IsoDate) {
  const out = new Map<
    string,
    {
      recent: { date: IsoDate; status: AttendanceStatus }[];
      rate30: number | null;
      before30: { marked: number; present: number };
    }
  >();
  if (!studentIds.length) return out;
  const from = addDays(date, -60);
  const rows = await db
    .select({
      studentId: studentAttendance.studentId,
      date: studentAttendance.date,
      status: studentAttendance.status,
    })
    .from(studentAttendance)
    .where(
      and(
        sql`coalesce(${studentAttendance.homeBatchId}, ${studentAttendance.batchId}) = ${batchId}`,
        inArray(studentAttendance.studentId, studentIds),
        gte(studentAttendance.date, from),
        lt(studentAttendance.date, date),
      ),
    )
    .orderBy(desc(studentAttendance.date));
  const from30 = addDays(date, -29);
  for (const id of studentIds) {
    const mine = rows.filter((r) => r.studentId === id);
    const last30 = mine.filter((r) => r.date >= from30 && r.status !== 'excused');
    const present = last30.filter((r) => r.status === 'present' || r.status === 'late').length;
    out.set(id, {
      recent: mine.slice(0, 5).map((r) => ({ date: r.date, status: r.status })),
      rate30: last30.length ? Math.round((present * 100) / last30.length) : null,
      before30: { marked: last30.length, present },
    });
  }
  return out;
}

/** Has this coach checked in (GPS) to the batch's session that day? */
async function coachVisit(coachId: string, batchId: string, date: IsoDate) {
  const row = await db.query.coachSessions.findFirst({
    columns: { id: true },
    where: and(
      eq(coachSessions.coachId, coachId),
      eq(coachSessions.batchId, batchId),
      eq(coachSessions.date, date),
    ),
  });
  return { checkedIn: !!row };
}

function canEdit(role: 'admin' | 'coach', date: string): { allowed: boolean; reason?: string } {
  const today = todayInAppTz();
  if (date > today)
    return { allowed: false, reason: 'Attendance cannot be marked for a future date' };
  if (role === 'coach' && diffDays(date, today) > COACH_ATTENDANCE_EDIT_WINDOW_DAYS) {
    return {
      allowed: false,
      reason:
        'Coaches can mark attendance on the day of the session. Ask an admin to change an earlier day.',
    };
  }
  return { allowed: true };
}

const MarkBody = z.object({
  batchId: zId,
  date: zIsoDate,
  records: z
    .array(z.object({ studentId: zId, status: zStatus.nullable(), note: zOptionalText(500) }))
    .min(1)
    .max(300),
});

/** Bulk upsert of a session's attendance. Idempotent — safe to retry from flaky mobile networks. */
attendanceRouter.put('/session', async (req, res) => {
  const body = parse(MarkBody, req.body);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, body.batchId, { on: body.date });

  // Everything to check, in one trip; judged in order below (and again under the lock).
  const [cancelled, session, visit, roster, existing] = await Promise.all([
    getCancellation(body.batchId, body.date),
    sessionOn(batch, body.date),
    user.role === 'coach' ? coachVisit(user.id, body.batchId, body.date) : null,
    expectedRoster(batch, body.date),
    db
      .select({ studentId: studentAttendance.studentId })
      .from(studentAttendance)
      .where(
        and(eq(studentAttendance.batchId, body.batchId), eq(studentAttendance.date, body.date)),
      ),
  ]);
  if (cancelled) throw AppError.unprocessable(`This session was cancelled (${cancelled.reason})`);
  const edit = canEdit(user.role, body.date);
  if (!edit.allowed) throw AppError.unprocessable(edit.reason!);
  if (!session) throw AppError.unprocessable(`${batch.name} does not run on this day`);
  if (visit && !visit.checkedIn)
    throw AppError.unprocessable('Check in to this session before marking attendance.');

  const expected = new Map(roster.map((r) => [r.studentId, r]));
  const alreadyMarked = new Set(existing.map((e) => e.studentId));

  const unknown = body.records.filter(
    (r) => !expected.has(r.studentId) && !alreadyMarked.has(r.studentId),
  );
  if (unknown.length) {
    throw AppError.unprocessable('Some students are not part of this session', {
      studentIds: unknown.map((u) => u.studentId),
    });
  }

  const marks = body.records.filter(
    (r): r is typeof r & { status: AttendanceStatus } => r.status !== null,
  );
  const clears = body.records.filter((r) => r.status === null).map((r) => r.studentId);
  await db.transaction(async (tx) => {
    // Serialised with cancelling or moving this session.
    const [locked] = await tx.select().from(batches).where(eq(batches.id, batch.id)).for('update');
    // It may have been moved away meanwhile.
    await requireSession(locked!, body.date, tx);
    const off = await tx.$count(
      sessionCancellations,
      and(eq(sessionCancellations.batchId, batch.id), eq(sessionCancellations.date, body.date)),
    );
    if (off) throw AppError.unprocessable('This session was cancelled');
    // Guests as booked now (a booking may have been cancelled meanwhile).
    const guests = new Map(
      (
        await tx
          .select({ id: makeupSessions.studentId, homeBatchId: makeupSessions.missedBatchId })
          .from(makeupSessions)
          .where(
            and(
              eq(makeupSessions.batchId, batch.id),
              eq(makeupSessions.date, body.date),
              eq(makeupSessions.status, 'approved'),
            ),
          )
      ).map((g) => [g.id, g.homeBatchId]),
    );
    const gone = marks.filter(
      (m) =>
        expected.get(m.studentId)?.isMakeup &&
        !guests.has(m.studentId) &&
        !alreadyMarked.has(m.studentId),
    );
    if (gone.length)
      throw AppError.unprocessable('Some students are not part of this session', {
        studentIds: gone.map((m) => m.studentId),
      });
    if (clears.length)
      await tx
        .delete(studentAttendance)
        .where(
          and(
            eq(studentAttendance.batchId, body.batchId),
            eq(studentAttendance.date, body.date),
            inArray(studentAttendance.studentId, clears),
          ),
        );
    if (marks.length)
      await tx
        .insert(studentAttendance)
        .values(
          marks.map((r) => ({
            batchId: body.batchId,
            studentId: r.studentId,
            date: body.date,
            status: r.status,
            note: r.note,
            isMakeup: expected.get(r.studentId)?.isMakeup ?? false,
            homeBatchId: expected.get(r.studentId)?.isMakeup
              ? (guests.get(r.studentId) ?? null)
              : null,
            markedById: user.id,
          })),
        )
        .onConflictDoUpdate({
          target: [studentAttendance.batchId, studentAttendance.studentId, studentAttendance.date],
          set: {
            status: sql`excluded.status`,
            note: sql`excluded.note`,
            markedById: user.id,
            updatedAt: new Date(),
          },
        });
    if (diffDays(body.date, todayInAppTz()) > COACH_ATTENDANCE_EDIT_WINDOW_DAYS) {
      await audit(
        {
          ...auditCtx(req),
          action: 'attendance.backdated_edit',
          entityType: 'batch',
          entityId: body.batchId,
          metadata: { date: body.date, count: body.records.length },
        },
        tx,
      );
    }
  });

  ok(res, { saved: body.records.length });
});

// ─── Student history ─────────────────────────────────────────────────────────

const RangeQuery = z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() });

attendanceRouter.get('/students/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const q = parse(RangeQuery, req.query);
  await assertStudentAccess(currentUser(req), id);
  const to = q.to ?? todayInAppTz();
  const from = q.from ?? addDays(to, -29);
  if (diffDays(from, to) > 366) throw AppError.badRequest('Date range cannot exceed one year');

  const records = await db
    .select({
      date: studentAttendance.date,
      status: studentAttendance.status,
      note: studentAttendance.note,
      isMakeup: studentAttendance.isMakeup,
      batchId: batches.id,
      batchName: batches.name,
    })
    .from(studentAttendance)
    .innerJoin(batches, eq(batches.id, studentAttendance.batchId))
    .where(
      and(
        eq(studentAttendance.studentId, id),
        gte(studentAttendance.date, from),
        lte(studentAttendance.date, to),
      ),
    )
    .orderBy(asc(studentAttendance.date));

  const summary = summarize(records.map((r) => r.status));
  const attended = summary.present + summary.late;
  const countable = summary.total - summary.excused;
  ok(res, {
    from,
    to,
    records,
    summary: {
      ...summary,
      attendanceRate: countable > 0 ? Math.round((attended / countable) * 1000) / 10 : null,
    },
  });
});

// ─── Batch register (students × dates matrix) ────────────────────────────────

const RegisterQuery = z.object({ batchId: zId, from: zIsoDate, to: zIsoDate });

attendanceRouter.get('/register', async (req, res) => {
  const q = parse(RegisterQuery, req.query);
  if (q.to < q.from) throw AppError.badRequest('"to" must be on or after "from"');
  if (diffDays(q.from, q.to) > 62) throw AppError.badRequest('Date range cannot exceed 62 days');
  // The full register is the batch's history: its own coach and admins only.
  const batch = await assertBatchAccess(currentUser(req), q.batchId, { mainOnly: true });

  const sessions = (await scheduleFor([batch], q.from, q.to)).get(batch.id) ?? [];
  const sessionDates = sessions.map((s) => s.date);
  const shown = {
    studentId: studentAttendance.studentId,
    status: studentAttendance.status,
    fullName: students.fullName,
    code: students.code,
  };
  const [own, madeUp] = await Promise.all([
    // Guests making up another batch's session count there.
    db
      .select({ ...shown, date: studentAttendance.date })
      .from(studentAttendance)
      .innerJoin(students, eq(students.id, studentAttendance.studentId))
      .where(
        and(
          eq(studentAttendance.batchId, q.batchId),
          isNull(studentAttendance.homeBatchId),
          gte(studentAttendance.date, q.from),
          lte(studentAttendance.date, q.to),
        ),
      ),
    // Made up elsewhere: shown on the missed session.
    db
      .select({ ...shown, date: makeupSessions.missedDate })
      .from(makeupSessions)
      .innerJoin(
        studentAttendance,
        and(
          eq(studentAttendance.studentId, makeupSessions.studentId),
          eq(studentAttendance.batchId, makeupSessions.batchId),
          eq(studentAttendance.date, makeupSessions.date),
        ),
      )
      .innerJoin(students, eq(students.id, makeupSessions.studentId))
      .where(
        and(
          eq(makeupSessions.missedBatchId, q.batchId),
          gte(makeupSessions.missedDate, q.from),
          lte(makeupSessions.missedDate, q.to),
        ),
      ),
  ]);
  const dayOf = (day: IsoDate) => sessions.find((s) => rosterDay(s) === day)?.date ?? day;
  const records = [...own, ...madeUp.map((m) => ({ ...m, date: dayOf(m.date!) }))];

  const byStudent = new Map<
    string,
    { studentId: string; fullName: string; code: string; marks: Record<string, Status> }
  >();
  for (const r of records) {
    const entry = byStudent.get(r.studentId) ?? {
      studentId: r.studentId,
      fullName: r.fullName,
      code: r.code,
      marks: {},
    };
    entry.marks[r.date] = r.status;
    byStudent.set(r.studentId, entry);
  }
  const cancelledByKey = await cancellationsIn([q.batchId], q.from, q.to);
  const cancelled: Record<string, string> = {};
  for (const [key, reason] of cancelledByKey) cancelled[key.slice(key.indexOf(':') + 1)] = reason;
  ok(res, {
    batch: { id: batch.id, name: batch.name },
    dates: sessionDates,
    /** Moved / extra sessions in the range, by date. */
    origins: Object.fromEntries(
      sessions.filter((s) => s.kind !== 'regular').map((s) => [s.date, sessionOrigin(s)]),
    ),
    cancelled,
    students: [...byStudent.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
  });
});
