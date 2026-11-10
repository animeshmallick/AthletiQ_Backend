/**
 * Everything about one batch for its details page: who is in it (with each student's attendance,
 * fees, level and tenure), how it is doing (attendance trend, sessions held / cancelled /
 * covered, coach punctuality, skills, joins and leaves, and — for admins — fees), and its
 * upcoming and recent sessions.
 */
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  batchSubstitutions,
  coachSessions,
  enrollments,
  invoices,
  sessionPlans,
  skillAssessments,
  studentAttendance,
  students,
  users,
} from '../../db/schema/index.js';
import { timesOn, type DayTimes } from '../../lib/batch-times.js';
import {
  addDays,
  eachDay,
  isoWeekday,
  startOfIsoWeek,
  startOfMonth,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { cancellationsIn } from '../attendance/cancellations.js';
import { loadBatchPlan } from '../lessons/lessons.routes.js';
import { effectiveMonthlyFee } from '../students/students.service.js';

export interface BatchForInsights {
  id: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  dayTimes: DayTimes;
  capacity: number;
  feePlanMonthlyFee: number;
}

const pct = (n: number, d: number) => (d ? Math.round((n * 100) / d) : null);
const PRESENT = sql`${studentAttendance.status} in ('present', 'late')`;

export async function batchInsights(
  b: BatchForInsights,
  opts: { includeMoney: boolean; today?: IsoDate },
) {
  const today = opts.today ?? todayInAppTz();
  const from30 = addDays(today, -29);
  const from8w = startOfIsoWeek(addDays(today, -7 * 7));
  const from90 = addDays(today, -89);
  const month = startOfMonth(today);

  const [members, attendance, lastSeen, fees, levels, checkIns, recentMarks, plans, subs, moves] =
    await Promise.all([
      // Current members.
      db
        .select({
          enrollmentId: enrollments.id,
          studentId: students.id,
          code: students.code,
          registrationNo: students.registrationNo,
          fullName: students.fullName,
          phone: students.phone,
          guardianName: students.guardianName,
          gender: students.gender,
          dateOfBirth: students.dateOfBirth,
          joinedBatch: enrollments.effectiveFrom,
          joinedAcademy: students.joiningDate,
          customMonthlyFee: enrollments.customMonthlyFee,
          monthlyDiscount: enrollments.monthlyDiscount,
        })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(and(eq(enrollments.batchId, b.id), isNull(enrollments.effectiveTo)))
        .orderBy(asc(students.fullName)),
      // Per-student attendance, last 30 days.
      db
        .select({
          studentId: studentAttendance.studentId,
          marked: sql<number>`count(*)::int`,
          present: sql<number>`count(*) filter (where ${PRESENT})::int`,
        })
        .from(studentAttendance)
        .where(
          and(
            eq(studentAttendance.batchId, b.id),
            gte(studentAttendance.date, from30),
            lte(studentAttendance.date, today),
          ),
        )
        .groupBy(studentAttendance.studentId),
      // Last time each student attended this batch.
      db
        .select({
          studentId: studentAttendance.studentId,
          last: sql<IsoDate>`max(${studentAttendance.date})`,
        })
        .from(studentAttendance)
        .where(and(eq(studentAttendance.batchId, b.id), PRESENT))
        .groupBy(studentAttendance.studentId),
      // Unpaid fees per student for this batch.
      db
        .select({
          studentId: invoices.studentId,
          due: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due'), 0)::int`,
          overdue: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due' and ${invoices.dueDate} < ${today}), 0)::int`,
          oldestDueId: sql<
            string | null
          >`(array_agg(${invoices.id} order by ${invoices.dueDate}) filter (where ${invoices.status} = 'due'))[1]`,
          lastPaidAt: sql<string | null>`max(${invoices.paidAt})`,
          monthIssued: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.issueDate} >= ${month} and ${invoices.status} <> 'cancelled'), 0)::int`,
          monthCollected: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.issueDate} >= ${month} and ${invoices.status} = 'paid'), 0)::int`,
        })
        .from(invoices)
        .where(eq(invoices.batchId, b.id))
        .groupBy(invoices.studentId),
      // Latest skill assessment per student in this batch.
      db
        .selectDistinctOn([skillAssessments.studentId], {
          studentId: skillAssessments.studentId,
          month: skillAssessments.month,
          levelName: skillAssessments.levelName,
          levelCode: skillAssessments.levelCode,
          average: skillAssessments.average,
        })
        .from(skillAssessments)
        .where(eq(skillAssessments.batchId, b.id))
        .orderBy(skillAssessments.studentId, desc(skillAssessments.month)),
      // Coach check-ins in the last 30 days (with the coach who checked in).
      db
        .select({
          date: coachSessions.date,
          coachName: users.name,
          onTime: sql<boolean>`(${coachSessions.checkInAt} at time zone 'Asia/Kolkata')::time <= ${coachSessions.scheduledStart} + interval '10 minutes'`,
        })
        .from(coachSessions)
        .innerJoin(users, eq(users.id, coachSessions.coachId))
        .where(and(eq(coachSessions.batchId, b.id), gte(coachSessions.date, from8w))),
      // Attendance per session, last 8 weeks.
      db
        .select({
          date: studentAttendance.date,
          marked: sql<number>`count(*)::int`,
          present: sql<number>`count(*) filter (where ${PRESENT})::int`,
        })
        .from(studentAttendance)
        .where(and(eq(studentAttendance.batchId, b.id), gte(studentAttendance.date, from8w)))
        .groupBy(studentAttendance.date),
      // Days adjusted on their own; every other session follows the batch's plan.
      db
        .select({ date: sessionPlans.date })
        .from(sessionPlans)
        .where(and(eq(sessionPlans.batchId, b.id), gte(sessionPlans.date, from8w))),
      // Approved substitutions touching the last 8 weeks or the next week.
      db
        .select({
          fromDate: batchSubstitutions.fromDate,
          toDate: batchSubstitutions.toDate,
          name: users.name,
        })
        .from(batchSubstitutions)
        .innerJoin(users, eq(users.id, batchSubstitutions.substituteCoachId))
        .where(
          and(
            eq(batchSubstitutions.batchId, b.id),
            eq(batchSubstitutions.status, 'approved'),
            gte(batchSubstitutions.toDate, from8w),
            lte(batchSubstitutions.fromDate, addDays(today, 14)),
          ),
        ),
      // Joins and leaves, last 90 days.
      db
        .select({ from: enrollments.effectiveFrom, to: enrollments.effectiveTo })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.batchId, b.id),
            or(gte(enrollments.effectiveFrom, from90), gte(enrollments.effectiveTo, from90)),
          ),
        ),
    ]);

  const cancelled = await cancellationsIn([b.id], from8w, addDays(today, 14));
  const byStudent = <T extends { studentId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.studentId, r]));
  const att = byStudent(attendance);
  const seen = byStudent(lastSeen);
  const fee = byStudent(fees);
  const lvl = byStudent(levels);

  const roster = members.map((m) => {
    const a = att.get(m.studentId);
    const f = fee.get(m.studentId);
    const l = lvl.get(m.studentId);
    const monthly = effectiveMonthlyFee(b.feePlanMonthlyFee, m.customMonthlyFee, m.monthlyDiscount);
    return {
      studentId: m.studentId,
      enrollmentId: m.enrollmentId,
      code: m.code,
      registrationNo: m.registrationNo,
      fullName: m.fullName,
      phone: m.phone,
      guardianName: m.guardianName,
      gender: m.gender,
      dateOfBirth: m.dateOfBirth,
      joinedBatch: m.joinedBatch,
      joinedAcademy: m.joinedAcademy,
      daysInBatch: Math.max(
        0,
        Math.round((Date.parse(today) - Date.parse(m.joinedBatch)) / 86_400_000),
      ),
      attendance: {
        marked: a?.marked ?? 0,
        present: a?.present ?? 0,
        rate: pct(a?.present ?? 0, a?.marked ?? 0),
      },
      lastAttended: seen.get(m.studentId)?.last ?? null,
      fees: {
        monthly: monthly.total,
        due: f?.due ?? 0,
        overdue: f?.overdue ?? 0,
        status: f?.overdue ? 'overdue' : f?.due ? 'due' : monthly.total === 0 ? 'free' : 'paid',
        unpaidInvoiceId: f?.oldestDueId ?? null,
        lastPaidAt: f?.lastPaidAt ?? null,
      },
      level: l
        ? { name: l.levelName, code: l.levelCode, month: l.month, average: l.average }
        : null,
      assessedThisMonth: l?.month === month,
    };
  });

  // ── Sessions ──
  const scheduled = (from: IsoDate, to: IsoDate) =>
    eachDay(from, to).filter((d) => b.weekdays.includes(isoWeekday(d)));
  const marksOn = new Map(recentMarks.map((r) => [r.date, r]));
  const checkInOn = new Map(checkIns.map((c) => [c.date, c]));
  const planOn = new Set(plans.map((p) => p.date));
  const hasBatchPlan = !!(await loadBatchPlan(b.id))?.blocks.length;
  const subOn = (d: IsoDate) => subs.find((s) => s.fromDate <= d && s.toDate >= d)?.name ?? null;
  const session = (d: IsoDate) => {
    const m = marksOn.get(d);
    const c = checkInOn.get(d);
    return {
      date: d,
      ...timesOn(b, d),
      cancelled: cancelled.get(`${b.id}:${d}`) ?? null,
      substitute: subOn(d),
      marked: m?.marked ?? 0,
      present: m?.present ?? 0,
      checkedIn: !!c,
      onTime: c ? c.onTime : null,
      hasPlan: hasBatchPlan || planOn.has(d),
    };
  };
  const past8w = scheduled(from8w, today).map(session);
  const last30 = past8w.filter((s) => s.date >= from30);
  const held = (s: (typeof past8w)[number]) => !s.cancelled && (s.marked > 0 || s.checkedIn);

  // Weekly attendance trend (last 8 weeks).
  const weeks = new Map<
    string,
    { week: IsoDate; sessions: number; marked: number; present: number }
  >();
  for (const s of past8w) {
    const w = startOfIsoWeek(s.date);
    const row = weeks.get(w) ?? { week: w, sessions: 0, marked: 0, present: 0 };
    if (held(s)) row.sessions++;
    row.marked += s.marked;
    row.present += s.present;
    weeks.set(w, row);
  }

  const checked30 = last30.filter((s) => s.checkedIn);
  const marked30 = last30.reduce((n, s) => n + s.marked, 0);
  const present30 = last30.reduce((n, s) => n + s.present, 0);
  const levelMix = new Map<
    string,
    { code: string | null; name: string | null; students: number }
  >();
  for (const r of roster) {
    if (!r.level) continue;
    const k = r.level.code ?? r.level.name ?? '?';
    const row = levelMix.get(k) ?? { code: r.level.code, name: r.level.name, students: 0 };
    row.students++;
    levelMix.set(k, row);
  }
  const money = opts.includeMoney
    ? {
        expectedMonthly: roster.reduce((n, r) => n + r.fees.monthly, 0),
        monthIssued: fees.reduce((n, f) => n + f.monthIssued, 0),
        monthCollected: fees.reduce((n, f) => n + f.monthCollected, 0),
        outstanding: fees.reduce((n, f) => n + f.due, 0),
        overdue: fees.reduce((n, f) => n + f.overdue, 0),
      }
    : null;

  return {
    summary: {
      students: roster.length,
      capacity: b.capacity,
      seatsLeft: Math.max(0, b.capacity - roster.length),
      attendanceRate: pct(present30, marked30),
      sessions30: {
        scheduled: last30.filter((s) => s.date < today || held(s)).length,
        held: last30.filter(held).length,
        cancelled: last30.filter((s) => s.cancelled).length,
        missed: last30.filter((s) => s.date < today && !s.cancelled && !held(s)).length,
        covered: last30.filter((s) => s.substitute && !s.cancelled).length,
        withPlan: last30.filter((s) => s.hasPlan).length,
      },
      checkIns30: {
        total: checked30.length,
        onTime: checked30.filter((s) => s.onTime).length,
        rate: pct(checked30.filter((s) => s.onTime).length, checked30.length),
      },
      skills: {
        assessedThisMonth: roster.filter((r) => r.assessedThisMonth).length,
        levels: [...levelMix.values()].sort((x, y) => (x.code ?? '').localeCompare(y.code ?? '')),
      },
      movement90: {
        joined: moves.filter((m) => m.from >= from90).length,
        left: moves.filter((m) => m.to && m.to >= from90).length,
      },
      fees: {
        // Counts are fine for coaches (who follows up), amounts only for admins.
        studentsOverdue: roster.filter((r) => r.fees.status === 'overdue').length,
        studentsDue: roster.filter((r) => r.fees.status === 'due').length,
        money,
      },
    },
    trend: [...weeks.values()].map((w) => ({ ...w, rate: pct(w.present, w.marked) })),
    upcoming: scheduled(today, addDays(today, 14)).slice(0, 7).map(session),
    recent: past8w
      .filter((s) => s.date < today)
      .reverse()
      .slice(0, 10),
    roster: roster.map((r) =>
      // Coaches see each student's fee status but not amounts.
      opts.includeMoney
        ? r
        : { ...r, fees: { ...r.fees, monthly: null, due: null, overdue: null } },
    ),
  };
}

export type BatchInsights = Awaited<ReturnType<typeof batchInsights>>;
