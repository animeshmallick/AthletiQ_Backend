import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { COACH_ATTENDANCE_EDIT_WINDOW_DAYS } from '../../config/constants.js';
import { db } from '../../db/client.js';
import {
  batches,
  coachSessions,
  lessonPlans,
  locations,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { addDays, diffDays, eachDay, isoWeekday, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess, assertStudentAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { expectedRoster } from '../batches/roster.js';

export const attendanceRouter = Router();

const zStatus = z.enum(['present', 'absent', 'late', 'excused']);
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

attendanceRouter.get('/overview', async (req, res) => {
  const user = currentUser(req);
  const { date } = parse(z.object({ date: zIsoDate.optional() }), req.query);
  const day = date ?? todayInAppTz();
  const weekday = isoWeekday(day);

  const filters: SQL[] = [eq(batches.isActive, true), sql`${weekday} = any(${batches.weekdays})`];
  if (!isAdmin(user)) filters.push(eq(batches.coachId, user.id));

  const sessionBatches = await db
    .select({
      id: batches.id,
      name: batches.name,
      startTime: batches.startTime,
      endTime: batches.endTime,
      coach: { id: users.id, name: users.name },
      location: { id: locations.id, name: locations.name },
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(and(...filters))
    .orderBy(asc(batches.startTime));

  const ids = sessionBatches.map((b) => b.id);
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
          .where(and(inArray(lessonPlans.batchId, ids), eq(lessonPlans.date, day)))
      : [],
    Promise.all(ids.map((id) => expectedRoster(id, day))),
  ]);

  ok(res, {
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
        coachSession: cs
          ? {
              checkInAt: cs.checkInAt,
              checkOutAt: cs.checkOutAt,
              flagged: !cs.checkInWithinFence || cs.checkOutWithinFence === false,
            }
          : null,
      };
    }),
  });
});

// ─── A single batch session ──────────────────────────────────────────────────

const SessionQuery = z.object({ batchId: zId, date: zIsoDate });

attendanceRouter.get('/session', async (req, res) => {
  const { batchId, date } = parse(SessionQuery, req.query);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, batchId);

  const [roster, marks] = await Promise.all([
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

  ok(res, {
    batch: { id: batch.id, name: batch.name, startTime: batch.startTime, endTime: batch.endTime },
    date,
    isScheduledDay: batch.weekdays.includes(isoWeekday(date)),
    editable: canEdit(user.role, date).allowed,
    students: rows,
    summary: summarize(rows.map((r) => r.status)),
  });
});

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
    .array(z.object({ studentId: zId, status: zStatus, note: zOptionalText(500) }))
    .min(1)
    .max(300),
});

/** Bulk upsert of a session's attendance. Idempotent — safe to retry from flaky mobile networks. */
attendanceRouter.put('/session', async (req, res) => {
  const body = parse(MarkBody, req.body);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, body.batchId);

  const edit = canEdit(user.role, body.date);
  if (!edit.allowed) throw AppError.unprocessable(edit.reason!);
  if (!batch.weekdays.includes(isoWeekday(body.date))) {
    throw AppError.unprocessable(`${batch.name} does not run on this day`);
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

  await db.transaction(async (tx) => {
    await tx
      .insert(studentAttendance)
      .values(
        body.records.map((r) => ({
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
  const batch = await assertBatchAccess(currentUser(req), q.batchId);

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
  ok(res, {
    batch: { id: batch.id, name: batch.name },
    dates: sessionDates,
    students: [...byStudent.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
  });
});
