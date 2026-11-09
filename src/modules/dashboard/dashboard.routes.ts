/**
 * GET /api/v1/dashboard — insights for the Today screen, scoped to the user
 * (coaches: their batches; admins: the whole academy). A handful of aggregate queries.
 */
import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import {
  batches,
  coachSessions,
  enrollments,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { addDays, startOfMonth, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { ok } from '../../lib/http.js';
import { currentUser } from '../../middleware/auth.js';
import type { AuthUser } from '../auth/auth.types.js';
import { lastCompletedWeek, weekBoard } from '../feedback/feedback.routes.js';

export const dashboardRouter = Router();

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);

/** Next birthday from `today`: days away (0 = today) and the age they turn. */
export function nextBirthday(dob: IsoDate, today: IsoDate): { inDays: number; turning: number } {
  const year = Number(today.slice(0, 4));
  let next = `${year}${dob.slice(4)}`;
  if (dob.slice(5) === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) {
    next = `${year}-03-01`;
  }
  if (next < today) next = `${year + 1}${dob.slice(4)}`;
  return {
    inDays: Math.round(
      (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    ),
    turning: Number(next.slice(0, 4)) - Number(dob.slice(0, 4)),
  };
}

export async function dashboardFor(user: AuthUser, today: IsoDate = todayInAppTz()) {
  const admin = user.role === 'admin';
  const monthStart = startOfMonth(today);
  const from30 = addDays(today, -29);
  const from14 = addDays(today, -13);

  // Batches in scope.
  const scope = await db
    .select({
      id: batches.id,
      name: batches.name,
      capacity: batches.capacity,
      coachId: batches.coachId,
      coachName: users.name,
      startTime: batches.startTime,
    })
    .from(batches)
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      admin
        ? eq(batches.isActive, true)
        : and(eq(batches.isActive, true), eq(batches.coachId, user.id)),
    );
  const ids = scope.map((b) => b.id);
  const none = ids.length === 0;
  const inScope = (col: Parameters<typeof inArray>[0]): SQL =>
    none ? sql`false` : inArray(col, ids);

  const [members, attendanceRows, perStudent, coachRows, newThisMonth, leftThisMonth, coachCount] =
    await Promise.all([
      // Current members per batch + student info (birthdays).
      db
        .select({
          batchId: enrollments.batchId,
          studentId: students.id,
          fullName: students.fullName,
          dateOfBirth: students.dateOfBirth,
        })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(
          and(
            inScope(enrollments.batchId),
            isNull(enrollments.effectiveTo),
            eq(students.status, 'active'),
          ),
        ),
      // Attendance per day (last 30 days) and per batch.
      db
        .select({
          date: studentAttendance.date,
          batchId: studentAttendance.batchId,
          attended: sql<number>`count(*) filter (where ${studentAttendance.status} in ('present','late'))::int`,
          absent: sql<number>`count(*) filter (where ${studentAttendance.status} = 'absent')::int`,
        })
        .from(studentAttendance)
        .where(
          and(
            inScope(studentAttendance.batchId),
            gte(studentAttendance.date, from30),
            lte(studentAttendance.date, today),
          ),
        )
        .groupBy(studentAttendance.date, studentAttendance.batchId),
      // Attendance per student (last 30 days) — for students who need attention.
      db
        .select({
          studentId: studentAttendance.studentId,
          fullName: students.fullName,
          attended: sql<number>`count(*) filter (where ${studentAttendance.status} in ('present','late'))::int`,
          counted: sql<number>`count(*) filter (where ${studentAttendance.status} in ('present','late','absent'))::int`,
        })
        .from(studentAttendance)
        .innerJoin(students, eq(students.id, studentAttendance.studentId))
        .where(
          and(
            inScope(studentAttendance.batchId),
            gte(studentAttendance.date, from30),
            eq(students.status, 'active'),
          ),
        )
        .groupBy(studentAttendance.studentId, students.fullName),
      // Coach sessions this month: count, minutes, on time (≤10 min after start), flagged.
      db
        .select({
          coachId: coachSessions.coachId,
          sessions: count(),
          minutes: sql<number>`coalesce(sum(extract(epoch from (${coachSessions.checkOutAt} - ${coachSessions.checkInAt})) / 60), 0)::int`,
          onTime: sql<number>`count(*) filter (where (${coachSessions.checkInAt} at time zone 'Asia/Kolkata')::time <= ${batches.startTime} + interval '10 minutes')::int`,
          flagged: sql<number>`count(*) filter (where ${coachSessions.checkInWithinFence} = false or ${coachSessions.checkOutWithinFence} = false)::int`,
        })
        .from(coachSessions)
        .innerJoin(batches, eq(batches.id, coachSessions.batchId))
        .where(and(inScope(coachSessions.batchId), gte(coachSessions.date, monthStart)))
        .groupBy(coachSessions.coachId),
      db
        .select({ n: countDistinct(students.id) })
        .from(students)
        .innerJoin(
          enrollments,
          and(eq(enrollments.studentId, students.id), isNull(enrollments.effectiveTo)),
        )
        .where(and(inScope(enrollments.batchId), gte(students.joiningDate, monthStart))),
      admin
        ? db.select({ n: count() }).from(students).where(gte(students.leftOn, monthStart))
        : Promise.resolve([{ n: 0 }]),
      admin
        ? db
            .select({ n: count() })
            .from(users)
            .where(and(eq(users.role, 'coach'), eq(users.status, 'active')))
        : Promise.resolve([{ n: 0 }]),
    ]);

  // Attendance: 30-day rate and a 14-day daily trend.
  let attended = 0;
  let absent = 0;
  const byDay = new Map<string, { a: number; b: number }>();
  const byBatch = new Map<string, { a: number; b: number }>();
  for (const r of attendanceRows) {
    attended += r.attended;
    absent += r.absent;
    const d = byDay.get(r.date) ?? { a: 0, b: 0 };
    d.a += r.attended;
    d.b += r.attended + r.absent;
    byDay.set(r.date, d);
    const bb = byBatch.get(r.batchId) ?? { a: 0, b: 0 };
    bb.a += r.attended;
    bb.b += r.attended + r.absent;
    byBatch.set(r.batchId, bb);
  }
  const trend: { date: string; rate: number | null }[] = [];
  for (let d = from14; d <= today; d = addDays(d, 1)) {
    const v = byDay.get(d);
    trend.push({ date: d, rate: v ? pct(v.a, v.b) : null });
  }

  const memberCount = new Map<string, number>();
  for (const m of members) memberCount.set(m.batchId, (memberCount.get(m.batchId) ?? 0) + 1);
  const capacity = scope.reduce((n, b) => n + b.capacity, 0);
  const cappedMembers = scope.reduce((n, b) => n + (memberCount.get(b.id) ?? 0), 0);

  const batchHealth = scope
    .map((b) => {
      const a = byBatch.get(b.id);
      const enrolled = memberCount.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        coachName: b.coachName,
        enrolled,
        capacity: b.capacity,
        fill: pct(enrolled, b.capacity),
        attendanceRate: a ? pct(a.a, a.b) : null,
      };
    })
    .sort((x, y) => (x.attendanceRate ?? 101) - (y.attendanceRate ?? 101));

  const needsAttention = perStudent
    .filter((s) => s.counted >= 3 && (pct(s.attended, s.counted) ?? 100) < 60)
    .map((s) => ({
      studentId: s.studentId,
      fullName: s.fullName,
      attended: s.attended,
      counted: s.counted,
      rate: pct(s.attended, s.counted)!,
    }))
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 6);

  const seen = new Set<string>();
  const birthdays = members
    .filter((m) => m.dateOfBirth && !seen.has(m.studentId) && seen.add(m.studentId))
    .map((m) => ({
      studentId: m.studentId,
      fullName: m.fullName,
      ...nextBirthday(m.dateOfBirth!, today),
    }))
    .filter((b) => b.inDays <= 7)
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, 6);

  const coachStats = new Map(coachRows.map((c) => [c.coachId, c]));
  const coaches = admin
    ? [...new Map(scope.map((b) => [b.coachId, b.coachName])).entries()]
        .map(([id, name]) => {
          const c = coachStats.get(id);
          const theirs = scope.filter((b) => b.coachId === id);
          return {
            id,
            name,
            batches: theirs.length,
            students: theirs.reduce((n, b) => n + (memberCount.get(b.id) ?? 0), 0),
            sessions: c?.sessions ?? 0,
            hours: Math.round(((c?.minutes ?? 0) / 60) * 10) / 10,
            onTimeRate: c ? pct(c.onTime, c.sessions) : null,
            flagged: c?.flagged ?? 0,
          };
        })
        .sort((a, b) => b.sessions - a.sessions)
    : [];
  const mine = coachStats.get(user.id);

  return {
    today,
    people: {
      activeStudents: new Set(members.map((m) => m.studentId)).size,
      newThisMonth: newThisMonth[0]?.n ?? 0,
      leftThisMonth: leftThisMonth[0]?.n ?? 0,
      activeCoaches: coachCount[0]?.n ?? 0,
      activeBatches: scope.length,
      fillRate: capacity ? pct(cappedMembers, capacity) : null,
    },
    attendance: { rate30d: pct(attended, attended + absent), attended, absent, trend },
    myMonth: admin
      ? null
      : {
          sessions: mine?.sessions ?? 0,
          hours: Math.round(((mine?.minutes ?? 0) / 60) * 10) / 10,
          onTimeRate: mine ? pct(mine.onTime, mine.sessions) : null,
          flagged: mine?.flagged ?? 0,
        },
    feedback: admin ? null : (await weekBoard(user, lastCompletedWeek())).summary,
    batchHealth,
    coaches,
    needsAttention,
    birthdays,
  };
}

dashboardRouter.get('/', async (req, res) => {
  ok(res, await dashboardFor(currentUser(req)));
});
