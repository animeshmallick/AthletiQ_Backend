import { and, asc, desc, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  makeupSessions,
  studentAttendance,
  students,
  users,
  weeklyFeedback,
  type AttendanceSummarySnapshot,
} from '../../db/schema/index.js';
import {
  addDays,
  isoWeekday,
  startOfIsoWeek,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIsoDate } from '../../lib/validation.js';
import { currentUser, requireCoach } from '../../middleware/auth.js';
import { assertStudentAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { cancellationsIn } from '../attendance/cancellations.js';
import { memberSessions } from '../schedule/schedule.js';
import { answersSchema, CURRENT_WEEKLY_TEMPLATE, getTemplate } from './templates/index.js';
import type { AuthUser } from '../auth/auth.types.js';

export const feedbackRouter = Router();

/** Submitted feedback stays editable until the end of the following week. */
const EDIT_GRACE_DAYS = 13;

const zWeekStart = zIsoDate.refine((d) => isoWeekday(d) === 1, {
  message: 'Week must start on a Monday',
});

function weekEnd(weekStart: IsoDate): IsoDate {
  return addDays(weekStart, 6);
}

/** Enrollments overlapping the week, i.e. the student trained in that batch at some point. */
function overlapsWeek(weekStart: IsoDate) {
  return and(
    lte(enrollments.effectiveFrom, weekEnd(weekStart)),
    or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, weekStart)),
  );
}

/** Feedback opens once the week is over (the Monday after), never for the current or a future week. */
function weekCompleted(weekStart: IsoDate): boolean {
  return weekEnd(weekStart) < todayInAppTz();
}
const opensOn = (weekStart: IsoDate) => addDays(weekStart, 7);

async function attendanceForWeek(
  studentId: string,
  weekStart: IsoDate,
): Promise<AttendanceSummarySnapshot> {
  const end = weekEnd(weekStart);
  const [enrolls, makeups, marks] = await Promise.all([
    db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.studentId, studentId), overlapsWeek(weekStart))),
    db
      .select({ date: makeupSessions.date, batchId: makeupSessions.batchId })
      .from(makeupSessions)
      .where(
        and(
          eq(makeupSessions.studentId, studentId),
          eq(makeupSessions.status, 'approved'),
          gte(makeupSessions.date, weekStart),
          lte(makeupSessions.date, end),
        ),
      ),
    db
      .select({ status: studentAttendance.status })
      .from(studentAttendance)
      .where(
        and(
          eq(studentAttendance.studentId, studentId),
          gte(studentAttendance.date, weekStart),
          lte(studentAttendance.date, end),
        ),
      ),
  ]);

  // Cancelled sessions (rain, holidays) don't count as scheduled.
  const cancelled = await cancellationsIn(
    [...new Set([...enrolls.map((e) => e.batchId), ...makeups.map((m) => m.batchId)])],
    weekStart,
    end,
  );
  let scheduled = makeups.filter((m) => !cancelled.has(`${m.batchId}:${m.date}`)).length;
  // Home sessions as they actually ran (moved and extra sessions on their own day).
  for (const s of await memberSessions(enrolls, weekStart, end))
    if (!cancelled.has(`${s.batchId}:${s.date}`)) scheduled++;
  const count = (s: string) => marks.filter((m) => m.status === s).length;
  const summary = {
    scheduled,
    present: count('present'),
    late: count('late'),
    absent: count('absent'),
    excused: count('excused'),
    unmarked: 0,
  };
  summary.unmarked = Math.max(0, scheduled - marks.length);
  return summary;
}

/**
 * The batches a student was in that week, that this user writes about (coaches: their own), the
 * one to report on first. Also after the student left: the week's report is still to be written.
 */
async function weekBatches(user: AuthUser, studentId: string, weekStart: IsoDate) {
  const rows = await db
    .select({ batchId: enrollments.batchId })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(
      and(
        eq(enrollments.studentId, studentId),
        overlapsWeek(weekStart),
        isAdmin(user) ? undefined : eq(batches.coachId, user.id),
      ),
    )
    .orderBy(desc(batches.coachFeedback), desc(enrollments.effectiveFrom));
  return rows.map((r) => r.batchId);
}

/** The week's report for these batches: each coach writes one per student. */
async function weekReport(studentId: string, weekStart: IsoDate, batchIds: string[]) {
  if (!batchIds.length) return undefined;
  return db.query.weeklyFeedback.findFirst({
    where: and(
      eq(weeklyFeedback.studentId, studentId),
      eq(weeklyFeedback.weekStart, weekStart),
      inArray(weeklyFeedback.batchId, batchIds),
    ),
    orderBy: [desc(weeklyFeedback.updatedAt)],
  });
}

// ─── Template ────────────────────────────────────────────────────────────────

feedbackRouter.get('/template', (_req, res) => {
  ok(res, CURRENT_WEEKLY_TEMPLATE);
});

// ─── Week board: who still needs feedback ────────────────────────────────────

const WeekQuery = z.object({
  weekStart: zWeekStart.optional(),
  coachId: zId.optional(),
  batchId: zId.optional(),
});

/** The most recent completed week (feedback is written once a week is over). */
export const lastCompletedWeek = () => startOfIsoWeek(addDays(todayInAppTz(), -7));

/** Students due a weekly report for a week, with their report status (coach scope or all). */
export async function weekBoard(
  user: AuthUser,
  weekStart: IsoDate,
  q: { coachId?: string; batchId?: string } = {},
) {
  const filters: SQL[] = [
    overlapsWeek(weekStart)!,
    lte(students.joiningDate, weekEnd(weekStart)),
    eq(batches.coachFeedback, true),
  ];
  if (!isAdmin(user)) filters.push(eq(batches.coachId, user.id));
  else if (q.coachId) filters.push(eq(batches.coachId, q.coachId));
  if (q.batchId) filters.push(eq(batches.id, q.batchId));

  const rows = await db
    // Each coach reports on the student once a week, whatever batches they share.
    .selectDistinctOn([students.id, batches.coachId], {
      studentId: students.id,
      code: students.code,
      fullName: students.fullName,
      batchId: batches.id,
      batchName: batches.name,
      coachId: batches.coachId,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(and(...filters))
    .orderBy(students.id, batches.coachId, desc(enrollments.effectiveFrom));

  const existing = rows.length
    ? await db
        .select({
          studentId: weeklyFeedback.studentId,
          id: weeklyFeedback.id,
          status: weeklyFeedback.status,
          submittedAt: weeklyFeedback.submittedAt,
          coachName: users.name,
          batchCoachId: batches.coachId,
        })
        .from(weeklyFeedback)
        .innerJoin(users, eq(users.id, weeklyFeedback.coachId))
        .innerJoin(batches, eq(batches.id, weeklyFeedback.batchId))
        .where(
          and(
            eq(weeklyFeedback.weekStart, weekStart),
            inArray(
              weeklyFeedback.studentId,
              rows.map((r) => r.studentId),
            ),
          ),
        )
    : [];
  const byStudent = new Map(existing.map((e) => [`${e.studentId}:${e.batchCoachId}`, e]));

  const items = rows
    .map((r) => {
      const fb = byStudent.get(`${r.studentId}:${r.coachId}`);
      return {
        ...r,
        feedbackId: fb?.id ?? null,
        status: fb?.status ?? ('pending' as const),
        submittedAt: fb?.submittedAt ?? null,
        writtenBy: fb?.coachName ?? null,
      };
    })
    .sort((a, b) => a.batchName.localeCompare(b.batchName) || a.fullName.localeCompare(b.fullName));

  return {
    weekStart,
    weekEnd: weekEnd(weekStart),
    students: items,
    summary: {
      total: items.length,
      submitted: items.filter((i) => i.status === 'submitted').length,
      draft: items.filter((i) => i.status === 'draft').length,
      pending: items.filter((i) => i.status === 'pending').length,
    },
  };
}

feedbackRouter.get('/week', async (req, res) => {
  const user = currentUser(req);
  const q = parse(WeekQuery, req.query);
  const weekStart = q.weekStart ?? lastCompletedWeek();
  if (weekStart > todayInAppTz())
    throw AppError.badRequest('Feedback cannot be written for a future week');
  ok(res, await weekBoard(user, weekStart, q));
});

// ─── Single report ───────────────────────────────────────────────────────────

const ReportParams = z.object({ studentId: zId, weekStart: zWeekStart });

feedbackRouter.get('/students/:studentId/weeks/:weekStart', async (req, res) => {
  const { studentId, weekStart } = parse(ReportParams, req.params);
  const { batchId } = parse(z.object({ batchId: zId.optional() }), req.query);
  const user = currentUser(req);
  const mine = await weekBatches(user, studentId, weekStart);
  if (!mine.length) await assertStudentAccess(user, studentId);

  const student = await db.query.students.findFirst({ where: eq(students.id, studentId) });
  if (!student) throw AppError.notFound('Student');

  // An admin opens the report of one of the batches; a coach, their own.
  let batchIds = mine;
  if (isAdmin(user) && batchId) {
    const b = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
    const theirs = await db
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.coachId, b?.coachId ?? user.id));
    batchIds = theirs.map((x) => x.id);
  }
  const fb = await weekReport(studentId, weekStart, batchIds);
  const template = fb ? getTemplate(fb.templateKey, fb.templateVersion) : CURRENT_WEEKLY_TEMPLATE;
  const attendance =
    fb?.status === 'submitted' && fb.attendanceSummary
      ? fb.attendanceSummary
      : await attendanceForWeek(studentId, weekStart);

  ok(res, {
    student: { id: student.id, code: student.code, fullName: student.fullName },
    weekStart,
    weekEnd: weekEnd(weekStart),
    template,
    feedback: fb ?? null,
    attendance,
    weekCompleted: weekCompleted(weekStart),
    opensOn: opensOn(weekStart),
    editable:
      weekCompleted(weekStart) &&
      (!fb || fb.status === 'draft' || todayInAppTz() <= addDays(weekStart, EDIT_GRACE_DAYS)),
  });
});

const SaveBody = z.object({
  answers: z.record(z.string(), z.unknown()),
  submit: z.boolean().default(false),
});

/** Saves a draft or submits. Written by a coach the student trained with that week. */
feedbackRouter.put('/students/:studentId/weeks/:weekStart', requireCoach, async (req, res) => {
  const { studentId, weekStart } = parse(ReportParams, req.params);
  const body = parse(SaveBody, req.body);
  const user = currentUser(req);
  const mine = await weekBatches(user, studentId, weekStart);
  if (!mine.length) await assertStudentAccess(user, studentId);
  if (!weekCompleted(weekStart)) {
    throw AppError.unprocessable(
      `Feedback for this week opens on ${opensOn(weekStart)}, once the week is over.`,
    );
  }

  const existing = await weekReport(studentId, weekStart, mine);
  if (existing?.status === 'submitted' && todayInAppTz() > addDays(weekStart, EDIT_GRACE_DAYS)) {
    throw AppError.unprocessable(
      'This report is locked. Feedback can be edited until the end of the following week.',
    );
  }

  const template = existing
    ? getTemplate(existing.templateKey, existing.templateVersion)
    : CURRENT_WEEKLY_TEMPLATE;
  if (!template)
    throw new AppError('INTERNAL', 'Feedback template version is missing from the registry');
  // A submitted report cannot be downgraded to a draft.
  const submitting = body.submit || existing?.status === 'submitted';
  const answers = parse(answersSchema(template, submitting), body.answers);

  // The report already started, else the coach's batch the student was in that week.
  const batchId = existing?.batchId ?? mine[0];
  if (!batchId) throw AppError.unprocessable('Student was not enrolled during this week');

  const attendance = await attendanceForWeek(studentId, weekStart);
  const now = new Date();
  const [saved] = await db
    .insert(weeklyFeedback)
    .values({
      studentId,
      weekStart,
      batchId,
      coachId: user.id,
      templateKey: template.key,
      templateVersion: template.version,
      answers,
      attendanceSummary: attendance,
      status: submitting ? 'submitted' : 'draft',
      submittedAt: submitting ? now : null,
    })
    .onConflictDoUpdate({
      target: [weeklyFeedback.studentId, weeklyFeedback.batchId, weeklyFeedback.weekStart],
      set: {
        answers,
        attendanceSummary: attendance,
        coachId: user.id,
        status: submitting ? 'submitted' : 'draft',
        submittedAt: submitting ? (existing?.submittedAt ?? now) : null,
        updatedAt: now,
      },
    })
    .returning();

  if (body.submit && existing?.status !== 'submitted') {
    await audit({
      ...auditCtx(req),
      action: 'feedback.submitted',
      entityType: 'student',
      entityId: studentId,
      metadata: { weekStart },
    });
  }
  ok(res, saved);
});

// ─── Student feedback history ────────────────────────────────────────────────

feedbackRouter.get('/students/:studentId', async (req, res) => {
  const { studentId } = parse(z.object({ studentId: zId }), req.params);
  await assertStudentAccess(currentUser(req), studentId);
  const rows = await db
    .select({
      id: weeklyFeedback.id,
      weekStart: weeklyFeedback.weekStart,
      status: weeklyFeedback.status,
      submittedAt: weeklyFeedback.submittedAt,
      answers: weeklyFeedback.answers,
      attendanceSummary: weeklyFeedback.attendanceSummary,
      templateKey: weeklyFeedback.templateKey,
      templateVersion: weeklyFeedback.templateVersion,
      coach: { id: users.id, name: users.name },
      batchName: batches.name,
    })
    .from(weeklyFeedback)
    .innerJoin(users, eq(users.id, weeklyFeedback.coachId))
    .innerJoin(batches, eq(batches.id, weeklyFeedback.batchId))
    .where(eq(weeklyFeedback.studentId, studentId))
    .orderBy(desc(weeklyFeedback.weekStart))
    .limit(104);
  ok(res, rows);
});

/** Trend of rating fields across weeks, for progress charts. */
feedbackRouter.get('/students/:studentId/trends', async (req, res) => {
  const { studentId } = parse(z.object({ studentId: zId }), req.params);
  await assertStudentAccess(currentUser(req), studentId);
  const rows = await db
    .select({
      weekStart: weeklyFeedback.weekStart,
      answers: weeklyFeedback.answers,
      key: weeklyFeedback.templateKey,
      version: weeklyFeedback.templateVersion,
    })
    .from(weeklyFeedback)
    .where(and(eq(weeklyFeedback.studentId, studentId), eq(weeklyFeedback.status, 'submitted')))
    .orderBy(asc(weeklyFeedback.weekStart))
    .limit(52);

  const series = new Map<
    string,
    { id: string; label: string; points: { weekStart: string; value: number }[] }
  >();
  for (const r of rows) {
    const t = getTemplate(r.key, r.version);
    for (const f of t?.sections.flatMap((s) => s.fields) ?? []) {
      const v = r.answers[f.id];
      if (f.type !== 'rating' || typeof v !== 'number') continue;
      const s = series.get(f.id) ?? { id: f.id, label: f.label, points: [] };
      s.points.push({ weekStart: r.weekStart, value: v });
      series.set(f.id, s);
    }
  }
  ok(res, [...series.values()]);
});
