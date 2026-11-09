/**
 * Everything a student report needs, loaded in bulk (one query per kind of data, for any number
 * of students) and turned into insights: attendance, streaks, fees, feedback trends, history.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  batches,
  enrollments,
  feePlans,
  invoices,
  makeupSessions,
  payments,
  studentAttendance,
  students,
  users,
  weeklyFeedback,
} from '../../db/schema/index.js';
import { addDays, diffDays, formatDisplayDate, isoWeekday, type IsoDate } from '../../lib/dates.js';
import { getTemplate } from '../feedback/templates/index.js';
import { loadProgress, type SportProgress } from '../skills/progress.js';

const ATTENDED = new Set(['present', 'late']);
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface MonthRow {
  month: string; // YYYY-MM
  present: number;
  late: number;
  absent: number;
  excused: number;
  rate: number | null;
}

export interface TimelineEvent {
  date: string; // ISO date or timestamp
  kind:
    | 'joined'
    | 'batch'
    | 'left'
    | 'rejoined'
    | 'makeup'
    | 'invoice'
    | 'payment'
    | 'feedback'
    | 'note';
  title: string;
  detail?: string;
}

export interface StudentReport {
  student: {
    id: string;
    code: string;
    fullName: string;
    dateOfBirth: string | null;
    age: number | null;
    gender: string | null;
    guardianName: string | null;
    phone: string;
    alternatePhone: string | null;
    email: string | null;
    address: string | null;
    medicalNotes: string | null;
    joiningDate: string;
    status: 'active' | 'left';
    leftOn: string | null;
    leftReason: string | null;
    tenureDays: number;
    feePlan: string;
    monthlyFee: number;
    monthlyDiscount: number;
  };
  current: { batchName: string; coachName: string; trainingDays: number[]; since: string } | null;
  enrollments: {
    batchName: string;
    coachName: string;
    trainingDays: number[];
    from: string;
    to: string | null;
    reason: string | null;
  }[];
  attendance: {
    present: number;
    late: number;
    absent: number;
    excused: number;
    counted: number;
    rate: number | null;
    rate30: number | null;
    rate90: number | null;
    currentStreak: number;
    longestStreak: number;
    lastAttended: string | null;
    makeupsAttended: number;
    byMonth: MonthRow[];
    byWeekday: { weekday: number; rate: number | null; counted: number }[];
  };
  fees: {
    billed: number;
    paid: number;
    outstanding: number;
    overdue: number;
    overdueCount: number;
    invoicesCount: number;
    onTimeRate: number | null;
    avgDaysToPay: number | null;
    invoices: {
      number: string;
      period: string;
      issueDate: string;
      dueDate: string;
      amount: number;
      status: string;
      paidOn: string | null;
      mode: string | null;
    }[];
  };
  feedback: {
    count: number;
    skills: { label: string; average: number; first: number; latest: number; max: number }[];
    overall: number | null;
    weeks: {
      weekStart: string;
      coachName: string;
      ratings: { label: string; value: number; max: number }[];
      notes: { label: string; value: string }[];
    }[];
  };
  makeups: { date: string; batchName: string; missedDate: string | null; reason: string | null }[];
  /** Monthly skill assessments, per sport (oldest first). */
  skills: SportProgress[];
  timeline: TimelineEvent[];
  insights: string[];
}

function age(dob: string | null, today: IsoDate) {
  if (!dob) return null;
  let a = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  if (today.slice(5) < dob.slice(5)) a--;
  return a;
}

/** Longest and current runs of attended sessions (absences break a run; excused do not count). */
export function streaks(marks: { date: string; status: string }[]) {
  let longest = 0;
  let run = 0;
  for (const m of [...marks].sort((a, b) => a.date.localeCompare(b.date))) {
    if (m.status === 'excused') continue;
    if (ATTENDED.has(m.status)) {
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { current: run, longest };
}

const ACTION_LABEL: Record<string, string> = {
  'student.created': 'Enrolled at the academy',
  'student.transferred': 'Moved to another batch',
  'student.training_days_changed': 'Training days changed',
  'student.left': 'Left the academy',
  'student.rejoined': 'Rejoined the academy',
  'student.makeup_booked': 'Makeup session booked',
  'student.makeup_requested': 'Makeup session requested',
  'student.makeup_approved': 'Makeup approved',
  'student.makeup_rejected': 'Makeup not approved',
  'student.makeup_cancelled': 'Makeup cancelled',
  'student.updated': 'Profile updated',
};
const KIND: Record<string, TimelineEvent['kind']> = {
  'student.created': 'joined',
  'student.transferred': 'batch',
  'student.training_days_changed': 'batch',
  'student.left': 'left',
  'student.rejoined': 'rejoined',
  'student.makeup_booked': 'makeup',
  'student.makeup_requested': 'makeup',
  'student.makeup_approved': 'makeup',
  'student.makeup_rejected': 'makeup',
  'student.makeup_cancelled': 'makeup',
};

export const MODE_LABEL: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

/**
 * Builds reports for these students. `batchIds` limits attendance, makeups, feedback and fees to
 * those batches (null = everything since joining).
 */
export async function loadStudentReports(
  studentIds: string[],
  batchIds: string[] | null,
  today: IsoDate,
): Promise<StudentReport[]> {
  if (studentIds.length === 0) return [];
  const inBatches = (col: Parameters<typeof inArray>[0]): SQL | undefined =>
    batchIds ? inArray(col, batchIds) : undefined;

  const [people, enrolls, marks, bills, makeups, feedback, history, progress] = await Promise.all([
    db
      .select({ s: students, plan: feePlans.name, planFee: feePlans.monthlyFee })
      .from(students)
      .innerJoin(feePlans, eq(feePlans.id, students.feePlanId))
      .where(inArray(students.id, studentIds)),
    db
      .select({
        studentId: enrollments.studentId,
        batchId: enrollments.batchId,
        batchName: batches.name,
        coachName: users.name,
        trainingDays: enrollments.trainingDays,
        from: enrollments.effectiveFrom,
        to: enrollments.effectiveTo,
        reason: enrollments.reason,
      })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .innerJoin(users, eq(users.id, batches.coachId))
      .where(inArray(enrollments.studentId, studentIds))
      .orderBy(asc(enrollments.effectiveFrom)),
    db
      .select({
        studentId: studentAttendance.studentId,
        date: studentAttendance.date,
        status: studentAttendance.status,
        isMakeup: studentAttendance.isMakeup,
      })
      .from(studentAttendance)
      .where(
        and(inArray(studentAttendance.studentId, studentIds), inBatches(studentAttendance.batchId)),
      ),
    db
      .select({
        studentId: invoices.studentId,
        number: invoices.number,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        amount: invoices.totalAmount,
        status: invoices.status,
        paidOn: payments.paidOn,
        mode: payments.mode,
      })
      .from(invoices)
      .leftJoin(
        payments,
        and(eq(payments.invoiceId, invoices.id), eq(payments.status, 'completed')),
      )
      .where(and(inArray(invoices.studentId, studentIds), inBatches(invoices.batchId)))
      .orderBy(asc(invoices.issueDate)),
    db
      .select({
        studentId: makeupSessions.studentId,
        date: makeupSessions.date,
        batchName: batches.name,
        missedDate: makeupSessions.missedDate,
        reason: makeupSessions.reason,
      })
      .from(makeupSessions)
      .innerJoin(batches, eq(batches.id, makeupSessions.batchId))
      .where(
        and(
          inArray(makeupSessions.studentId, studentIds),
          eq(makeupSessions.status, 'approved'),
          inBatches(makeupSessions.batchId),
        ),
      )
      .orderBy(asc(makeupSessions.date)),
    db
      .select({
        studentId: weeklyFeedback.studentId,
        weekStart: weeklyFeedback.weekStart,
        coachName: users.name,
        templateKey: weeklyFeedback.templateKey,
        templateVersion: weeklyFeedback.templateVersion,
        answers: weeklyFeedback.answers,
        submittedAt: weeklyFeedback.submittedAt,
      })
      .from(weeklyFeedback)
      .innerJoin(users, eq(users.id, weeklyFeedback.coachId))
      .where(
        and(
          inArray(weeklyFeedback.studentId, studentIds),
          eq(weeklyFeedback.status, 'submitted'),
          inBatches(weeklyFeedback.batchId),
        ),
      )
      .orderBy(asc(weeklyFeedback.weekStart)),
    db
      .select({
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
        actor: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(and(eq(auditLogs.entityType, 'student'), inArray(auditLogs.entityId, studentIds)))
      .orderBy(asc(auditLogs.createdAt)),
    loadProgress(studentIds),
  ]);

  const group = <T extends { studentId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.studentId, [...(m.get(r.studentId) ?? []), r]);
    return m;
  };
  const enrollBy = group(enrolls);
  const marksBy = group(marks);
  const billsBy = group(bills);
  const makeupsBy = group(makeups);
  const feedbackBy = group(feedback);
  const historyBy = new Map<string, typeof history>();
  for (const h of history) {
    if (!h.entityId) continue;
    historyBy.set(h.entityId, [...(historyBy.get(h.entityId) ?? []), h]);
  }

  const reports = people.map(({ s, plan, planFee }) => {
    // ── Attendance ──
    const sMarks = marksBy.get(s.id) ?? [];
    const count = (rows: typeof sMarks) => {
      const c = { present: 0, late: 0, absent: 0, excused: 0 };
      for (const r of rows) c[r.status]++;
      return { ...c, counted: c.present + c.late + c.absent };
    };
    const all = count(sMarks);
    const since = (days: number) => sMarks.filter((m) => m.date >= addDays(today, -days + 1));
    const c30 = count(since(30));
    const c90 = count(since(90));
    const months = new Map<string, MonthRow>();
    for (const m of sMarks) {
      const key = m.date.slice(0, 7);
      const row = months.get(key) ?? {
        month: key,
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        rate: null,
      };
      row[m.status]++;
      months.set(key, row);
    }
    const byMonth = [...months.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((r) => ({ ...r, rate: pct(r.present + r.late, r.present + r.late + r.absent) }));
    const byWeekday = [1, 2, 3, 4, 5, 6, 7]
      .map((weekday) => {
        const c = count(sMarks.filter((m) => isoWeekday(m.date) === weekday));
        return { weekday, counted: c.counted, rate: pct(c.present + c.late, c.counted) };
      })
      .filter((w) => w.counted > 0);
    const { current: currentStreak, longest: longestStreak } = streaks(sMarks);
    const lastAttended =
      [...sMarks]
        .filter((m) => ATTENDED.has(m.status))
        .sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? null;

    // ── Fees ──
    const sBills = (billsBy.get(s.id) ?? []).filter((b) => b.status !== 'cancelled');
    const billed = sBills.reduce((n, b) => n + b.amount, 0);
    const paidBills = sBills.filter((b) => b.status === 'paid' && b.paidOn);
    const paid = paidBills.reduce((n, b) => n + b.amount, 0);
    const dueBills = sBills.filter((b) => b.status === 'due');
    const overdueBills = dueBills.filter((b) => b.dueDate < today);
    const onTime = paidBills.filter((b) => b.paidOn! <= b.dueDate).length;
    const daysToPay = paidBills.map((b) => Math.max(0, diffDays(b.issueDate, b.paidOn!)));

    // ── Feedback ──
    const sFeedback = feedbackBy.get(s.id) ?? [];
    const skillSeries = new Map<string, { label: string; max: number; values: number[] }>();
    const weeks = sFeedback.map((f) => {
      const tpl = getTemplate(f.templateKey, f.templateVersion);
      const ratings: { label: string; value: number; max: number }[] = [];
      const notes: { label: string; value: string }[] = [];
      for (const section of tpl?.sections ?? []) {
        for (const field of section.fields) {
          const v = f.answers[field.id];
          if (v === undefined || v === null || v === '') continue;
          if (field.type === 'rating' && typeof v === 'number') {
            ratings.push({ label: field.label, value: v, max: field.max });
            const series = skillSeries.get(field.id) ?? {
              label: field.label,
              max: field.max,
              values: [],
            };
            series.values.push(v);
            skillSeries.set(field.id, series);
          } else if (field.type === 'text' || field.type === 'textarea') {
            if (typeof v === 'string') notes.push({ label: field.label, value: v });
          } else if (field.type === 'select' || field.type === 'multiselect') {
            const vals = Array.isArray(v) ? v : [v];
            const labels = vals.map(
              (x) => field.options.find((o) => o.value === x)?.label ?? String(x),
            );
            notes.push({ label: field.label, value: labels.join(', ') });
          } else if (field.type === 'boolean') {
            notes.push({ label: field.label, value: v ? 'Yes' : 'No' });
          }
        }
      }
      return { weekStart: f.weekStart, coachName: f.coachName, ratings, notes };
    });
    const skills = [...skillSeries.values()].map((x) => ({
      label: x.label,
      max: x.max,
      average: round1(x.values.reduce((a, b) => a + b, 0) / x.values.length),
      first: x.values[0]!,
      latest: x.values.at(-1)!,
    }));
    const overall = skills.length
      ? round1(skills.reduce((n, x) => n + x.average, 0) / skills.length)
      : null;

    // ── History ──
    const sEnrolls = enrollBy.get(s.id) ?? [];
    const current = sEnrolls.find((e) => e.to === null) ?? null;
    const sMakeups = makeupsBy.get(s.id) ?? [];
    const timeline: TimelineEvent[] = [];
    timeline.push({
      date: s.joiningDate,
      kind: 'joined',
      title: 'Joined the academy',
      detail: plan,
    });
    sEnrolls.forEach((e, i) => {
      if (i === 0 && e.from === s.joiningDate) return;
      timeline.push({
        date: e.from,
        kind: 'batch',
        title: `${i === 0 ? 'Started in' : 'Moved to'} ${e.batchName}`,
        detail: `Coach ${e.coachName}${e.reason ? ` · ${e.reason}` : ''}`,
      });
    });
    for (const h of historyBy.get(s.id) ?? []) {
      if (['student.created', 'student.transferred', 'student.updated'].includes(h.action))
        continue; // covered by joining/enrolment rows, or too noisy
      const meta = h.metadata ?? {};
      const reason = typeof meta.reason === 'string' ? meta.reason : undefined;
      timeline.push({
        date: h.createdAt.toISOString(),
        kind: KIND[h.action] ?? 'note',
        title: ACTION_LABEL[h.action] ?? h.action.replace(/[._]/g, ' '),
        detail: [h.actor ? `by ${h.actor}` : null, reason].filter(Boolean).join(' · ') || undefined,
      });
    }
    for (const b of sBills) {
      timeline.push({
        date: b.issueDate,
        kind: 'invoice',
        title: `Invoice ${b.number}`,
        detail: `${formatDisplayDate(b.periodStart)} to ${formatDisplayDate(b.periodEnd)}`,
      });
      if (b.paidOn) {
        timeline.push({
          date: b.paidOn,
          kind: 'payment',
          title: `Fee paid for ${b.number}`,
          detail: b.mode ? (MODE_LABEL[b.mode] ?? b.mode) : undefined,
        });
      }
    }
    for (const f of sFeedback) {
      timeline.push({
        date: f.submittedAt?.toISOString() ?? f.weekStart,
        kind: 'feedback',
        title: `Weekly report sent (week of ${formatDisplayDate(f.weekStart)})`,
        detail: `by ${f.coachName}`,
      });
    }
    if (
      s.status === 'left' &&
      s.leftOn &&
      !(historyBy.get(s.id) ?? []).some((h) => h.action === 'student.left')
    ) {
      timeline.push({
        date: s.leftOn,
        kind: 'left',
        title: 'Left the academy',
        detail: s.leftReason ?? undefined,
      });
    }
    timeline.sort((a, b) => a.date.localeCompare(b.date));

    const rate = pct(all.present + all.late, all.counted);
    const report: StudentReport = {
      student: {
        id: s.id,
        code: s.code,
        fullName: s.fullName,
        dateOfBirth: s.dateOfBirth,
        age: age(s.dateOfBirth, today),
        gender: s.gender,
        guardianName: s.guardianName,
        phone: s.phone,
        alternatePhone: s.alternatePhone,
        email: s.email,
        address: s.address,
        medicalNotes: s.medicalNotes,
        joiningDate: s.joiningDate,
        status: s.status,
        leftOn: s.leftOn,
        leftReason: s.leftReason,
        tenureDays: Math.max(0, diffDays(s.joiningDate, s.leftOn ?? today)),
        feePlan: plan,
        monthlyFee: s.customMonthlyFee ?? planFee,
        monthlyDiscount: s.monthlyDiscount,
      },
      current: current
        ? {
            batchName: current.batchName,
            coachName: current.coachName,
            trainingDays: current.trainingDays,
            since: current.from,
          }
        : null,
      enrollments: sEnrolls.map((e) => ({
        batchName: e.batchName,
        coachName: e.coachName,
        trainingDays: e.trainingDays,
        from: e.from,
        to: e.to,
        reason: e.reason,
      })),
      attendance: {
        ...all,
        rate,
        rate30: pct(c30.present + c30.late, c30.counted),
        rate90: pct(c90.present + c90.late, c90.counted),
        currentStreak,
        longestStreak,
        lastAttended,
        makeupsAttended: sMarks.filter((m) => m.isMakeup && ATTENDED.has(m.status)).length,
        byMonth,
        byWeekday,
      },
      fees: {
        billed,
        paid,
        outstanding: dueBills.reduce((n, b) => n + b.amount, 0),
        overdue: overdueBills.reduce((n, b) => n + b.amount, 0),
        overdueCount: overdueBills.length,
        invoicesCount: sBills.length,
        onTimeRate: pct(onTime, paidBills.length),
        avgDaysToPay: daysToPay.length
          ? Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length)
          : null,
        invoices: sBills.map((b) => ({
          number: b.number,
          period: `${b.periodStart} to ${b.periodEnd}`,
          issueDate: b.issueDate,
          dueDate: b.dueDate,
          amount: b.amount,
          status: b.status === 'due' && b.dueDate < today ? 'overdue' : b.status,
          paidOn: b.paidOn,
          mode: b.mode ? (MODE_LABEL[b.mode] ?? b.mode) : null,
        })),
      },
      feedback: { count: sFeedback.length, skills, overall, weeks },
      makeups: sMakeups.map((m) => ({
        date: m.date,
        batchName: m.batchName,
        missedDate: m.missedDate,
        reason: m.reason,
      })),
      // Within a batch scope, only assessments made in those batches.
      skills: (progress.get(s.id) ?? [])
        .map((p) => ({
          ...p,
          assessments: batchIds
            ? p.assessments.filter((x) => batchIds.includes(x.batchId))
            : p.assessments,
        }))
        .filter((p) => p.assessments.length),
      timeline,
      insights: [],
    };
    report.insights = insightsFor(report);
    return report;
  });

  // Keep the caller's order (e.g. alphabetical).
  const order = new Map(studentIds.map((id, i) => [id, i]));
  return reports.sort((a, b) => order.get(a.student.id)! - order.get(b.student.id)!);
}

const WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Plain-language highlights shown at the top of a report. */
export function insightsFor(r: StudentReport): string[] {
  const out: string[] = [];
  const a = r.attendance;
  if (a.rate !== null) {
    out.push(
      `Attended ${a.present + a.late} of ${a.counted} sessions (${a.rate}%)${a.late ? `, ${a.late} late` : ''}.`,
    );
    if (a.rate30 !== null && a.rate !== null && Math.abs(a.rate30 - a.rate) >= 10) {
      out.push(
        `Attendance in the last 30 days is ${a.rate30}%, ${a.rate30 > a.rate ? 'up' : 'down'} from ${a.rate}% overall.`,
      );
    }
    if (a.longestStreak >= 5)
      out.push(`Longest run of sessions without missing: ${a.longestStreak}.`);
    const days = a.byWeekday.filter((w) => w.counted >= 3 && w.rate !== null);
    if (days.length >= 2) {
      const worst = days.reduce((x, y) => (y.rate! < x.rate! ? y : x));
      const best = days.reduce((x, y) => (y.rate! > x.rate! ? y : x));
      if (best.rate! - worst.rate! >= 20) {
        out.push(
          `Most regular on ${WEEKDAY[best.weekday]}s (${best.rate}%), least on ${WEEKDAY[worst.weekday]}s (${worst.rate}%).`,
        );
      }
    }
  } else {
    out.push('No attendance recorded yet.');
  }
  const f = r.feedback;
  if (f.skills.length) {
    const top = f.skills.reduce((x, y) => (y.average > x.average ? y : x));
    const low = f.skills.reduce((x, y) => (y.average < x.average ? y : x));
    out.push(`Strongest area: ${top.label} (${top.average}/${top.max}).`);
    if (low.label !== top.label) out.push(`Focus area: ${low.label} (${low.average}/${low.max}).`);
    const improved = f.skills.filter((x) => x.latest > x.first).map((x) => x.label);
    if (f.count >= 2 && improved.length)
      out.push(`Improved since the first report: ${improved.join(', ')}.`);
  }
  const fee = r.fees;
  if (fee.overdueCount)
    out.push(`${fee.overdueCount} invoice${fee.overdueCount === 1 ? ' is' : 's are'} overdue.`);
  else if (fee.invoicesCount && fee.outstanding === 0) out.push('All fees are paid up.');
  if (fee.onTimeRate !== null && fee.invoicesCount >= 3)
    out.push(`Pays on time ${fee.onTimeRate}% of the time.`);
  if (r.makeups.length)
    out.push(`${r.makeups.length} makeup session${r.makeups.length === 1 ? '' : 's'} taken.`);
  return out;
}
