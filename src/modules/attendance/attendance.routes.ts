import { timesOn } from '../../lib/batch-times.js';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { COACH_ATTENDANCE_EDIT_WINDOW_DAYS } from '../../config/constants.js';
import { db } from '../../db/client.js';
import {
  batches,
  coachSessions,
  lessonPlanCells,
  lessonPlans,
  locations,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import {
  addDays,
  diffDays,
  eachDay,
  isoWeekday,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess, assertStudentAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { expectedRoster } from '../batches/roster.js';
import { coveredBy, substitutesOn } from '../substitutions/coverage.js';
import { assertNotCancelled, cancellationsIn, getCancellation } from './cancellations.js';

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

/** Every batch session on one day for this user (all batches for admins, own for coaches). */
export async function dayOverview(user: AuthUser, day: IsoDate) {
  const weekday = isoWeekday(day);

  const filters: SQL[] = [eq(batches.isActive, true), sql`${weekday} = any(${batches.weekdays})`];
  // Coaches: their own batches, plus batches they cover as a substitute that day.
  if (!isAdmin(user)) filters.push(or(eq(batches.coachId, user.id), coveredBy(user.id, day))!);

  const rows = await db
    .select({
      id: batches.id,
      name: batches.name,
      startTime: batches.startTime,
      endTime: batches.endTime,
      dayTimes: batches.dayTimes,
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
    .where(and(...filters));
  // Each batch at its time on this day.
  const sessionBatches = rows
    .map(({ dayTimes, ...b }) => ({ ...b, ...timesOn({ ...b, dayTimes }, day) }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const ids = sessionBatches.map((b) => b.id);
  const [cancelled, subs] = await Promise.all([
    cancellationsIn(ids, day, day),
    substitutesOn(ids, day),
  ]);
  const [marks, checkIns, plans, rosters] = await Promise.all([
    ids.length
      ? db
          .select({ batchId: studentAttendance.batchId, status: studentAttendance.status })
          .from(studentAttendance)
          .where(and(inArray(studentAttendance.batchId, ids), eq(studentAttendance.date, day)))
      : [],
    ids.length
      ? db
          .select()
          .from(coachSessions)
          .where(and(inArray(coachSessions.batchId, ids), eq(coachSessions.date, day)))
      : [],
    ids.length
      ? db
          .select({ batchId: lessonPlans.batchId })
          .from(lessonPlans)
          .where(
            and(
              inArray(lessonPlans.batchId, ids),
              eq(lessonPlans.date, day),
              // An empty plan is still pending.
              sql`(exists (select 1 from ${lessonPlanCells} c where c.plan_id = ${lessonPlans.id}) or coalesce(btrim(${lessonPlans.focus}), '') <> '' or coalesce(btrim(${lessonPlans.notes}), '') <> '')`,
            ),
          )
      : [],
    Promise.all(ids.map((id) => expectedRoster(id, day))),
  ]);

  return {
    date: day,
    sessions: sessionBatches.map((b, i) => {
      const batchMarks = marks.filter((m) => m.batchId === b.id);
      const expected = rosters[i]!.length;
      const cs = checkIns.find((c) => c.batchId === b.id);
      return {
        batch: b,
        expectedStudents: expected,
        marked: batchMarks.length,
        present: batchMarks.filter((m) => m.status === 'present' || m.status === 'late').length,
        attendanceComplete: expected > 0 && batchMarks.length >= expected,
        hasLessonPlan: plans.some((p) => p.batchId === b.id),
        cancelled: cancelled.get(`${b.id}:${day}`) ?? null,
        /** Who covers this session as a substitute coach, if anyone. */
        substitute: subs.get(b.id) ?? null,
        coachSession: cs
          ? {
              checkInAt: cs.checkInAt,
              checkOutAt: cs.checkOutAt,
              flagged: !cs.checkInWithinFence || cs.checkOutWithinFence === false,
            }
          : null,
      };
    }),
  };
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
  const dates: IsoDate[] = [];
  for (let d = q.from; d <= q.to; d = addDays(d, 1)) dates.push(d);
  const days = await Promise.all(dates.map((d) => dayOverview(user, d)));
  ok(res, { from: q.from, to: q.to, today: todayInAppTz(), days });
});

// ─── A single batch session ──────────────────────────────────────────────────

const SessionQuery = z.object({ batchId: zId, date: zIsoDate });

attendanceRouter.get('/session', async (req, res) => {
  const { batchId, date } = parse(SessionQuery, req.query);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, batchId, { on: date });

  const [roster, marks, cancellation] = await Promise.all([
    expectedRoster(batchId, date),
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
  const visit = user.role === 'coach' ? await coachVisit(user.id, batchId, date) : null;
  const needsCheckIn = !!visit && !visit.checkedIn;
  // After checking out, coaches can still mark the rest of the day; it locks from the next day.
  const checkedOut = !!visit?.checkedOut && date < todayInAppTz();
  const edit = canEdit(user.role, date);
  ok(res, {
    batch: { id: batch.id, name: batch.name, ...timesOn(batch, date) },
    date,
    isScheduledDay: batch.weekdays.includes(isoWeekday(date)),
    cancelled: cancellation,
    editable: !cancellation && edit.allowed && !needsCheckIn && !checkedOut,
    /** Coaches mark attendance only for sessions they checked in to. */
    needsCheckIn,
    lockedReason: cancellation
      ? null
      : !edit.allowed
        ? edit.reason
        : needsCheckIn
          ? 'Check in to this session to mark attendance.'
          : checkedOut
            ? CHECKED_OUT_LOCK
            : null,
    students: rows.map((r) => ({
      ...r,
      ...(history.get(r.studentId) ?? { recent: [], rate30: null }),
    })),
    summary: summarize(rows.map((r) => r.status)),
  });
});

/** Last 5 marks before `date` in this batch (newest first) and the 30-day attendance rate. */
async function recentAttendance(batchId: string, studentIds: string[], date: IsoDate) {
  const out = new Map<
    string,
    { recent: { date: IsoDate; status: AttendanceStatus }[]; rate30: number | null }
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
        eq(studentAttendance.batchId, batchId),
        inArray(studentAttendance.studentId, studentIds),
        gte(studentAttendance.date, from),
        lt(studentAttendance.date, date),
      ),
    )
    .orderBy(desc(studentAttendance.date));
  const from30 = addDays(date, -30);
  for (const id of studentIds) {
    const mine = rows.filter((r) => r.studentId === id);
    const last30 = mine.filter((r) => r.date >= from30);
    const present = last30.filter((r) => r.status === 'present' || r.status === 'late').length;
    out.set(id, {
      recent: mine.slice(0, 5).map((r) => ({ date: r.date, status: r.status })),
      rate30: last30.length ? Math.round((present * 100) / last30.length) : null,
    });
  }
  return out;
}

const CHECKED_OUT_LOCK =
  'You checked out of this session and the day is over, so attendance is locked. Ask an admin to make changes.';

/** Has this coach checked in (GPS) to the batch's session that day, and checked out since? */
async function coachVisit(coachId: string, batchId: string, date: IsoDate) {
  const row = await db.query.coachSessions.findFirst({
    columns: { id: true, checkOutAt: true },
    where: and(
      eq(coachSessions.coachId, coachId),
      eq(coachSessions.batchId, batchId),
      eq(coachSessions.date, date),
    ),
  });
  return { checkedIn: !!row, checkedOut: !!row?.checkOutAt };
}

function canEdit(role: 'admin' | 'coach', date: string): { allowed: boolean; reason?: string } {
  const today = todayInAppTz();
  if (date > today)
    return { allowed: false, reason: 'Attendance cannot be marked for a future date' };
  if (role === 'coach' && diffDays(date, today) > COACH_ATTENDANCE_EDIT_WINDOW_DAYS) {
    return {
      allowed: false,
      reason: `Coaches can edit attendance up to ${COACH_ATTENDANCE_EDIT_WINDOW_DAYS} day(s) after the session. Ask an admin to correct older records.`,
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

  await assertNotCancelled(body.batchId, body.date);
  const edit = canEdit(user.role, body.date);
  if (!edit.allowed) throw AppError.unprocessable(edit.reason!);
  if (!batch.weekdays.includes(isoWeekday(body.date))) {
    throw AppError.unprocessable(`${batch.name} does not run on this day`);
  }
  if (user.role === 'coach') {
    const visit = await coachVisit(user.id, body.batchId, body.date);
    if (!visit.checkedIn) {
      throw AppError.unprocessable('Check in to this session before marking attendance.');
    }
    // After checking out, coaches can still mark it the same day; after that only admins can.
    if (visit.checkedOut && body.date < todayInAppTz())
      throw AppError.unprocessable(CHECKED_OUT_LOCK);
  }

  const roster = await expectedRoster(body.batchId, body.date);
  const expected = new Map(roster.map((r) => [r.studentId, r]));
  const existing = await db
    .select({ studentId: studentAttendance.studentId })
    .from(studentAttendance)
    .where(and(eq(studentAttendance.batchId, body.batchId), eq(studentAttendance.date, body.date)));
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

  const sessionDates = eachDay(q.from, q.to).filter((d) => batch.weekdays.includes(isoWeekday(d)));
  const records = await db
    .select({
      studentId: studentAttendance.studentId,
      date: studentAttendance.date,
      status: studentAttendance.status,
      fullName: students.fullName,
      code: students.code,
    })
    .from(studentAttendance)
    .innerJoin(students, eq(students.id, studentAttendance.studentId))
    .where(
      and(
        eq(studentAttendance.batchId, q.batchId),
        gte(studentAttendance.date, q.from),
        lte(studentAttendance.date, q.to),
      ),
    );

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
    cancelled,
    students: [...byStudent.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
  });
});
