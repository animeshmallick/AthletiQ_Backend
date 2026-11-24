/**
 * "What needs my attention right now?" — one answer used by the header bell, the tab badges and
 * the scheduled alerts. Coaches get their own sessions; admins get academy-wide items.
 */
import { and, count, eq, isNull, lt, sql } from 'drizzle-orm';
import { APP_TIMEZONE } from '../../config/constants.js';
import { db } from '../../db/client.js';
import {
  coachSessions,
  invoices,
  batchSubstitutions,
  makeupSessions,
  registrationRequests,
  sessionChanges,
  batches,
  courseRounds,
  studentCredits,
  sessionShortfalls,
} from '../../db/schema/index.js';
import { formatInr } from '../../lib/money.js';
import { endOfMonth, todayInAppTz } from '../../lib/dates.js';

const endOfMonthDay = (d: string) => Number(endOfMonth(d).slice(8, 10));
import { dayOverview } from '../attendance/attendance.routes.js';
import type { AuthUser } from '../auth/auth.types.js';
import { lastCompletedWeek, weekBoard } from '../feedback/feedback.routes.js';
import { pendingAssessments } from '../skills/reminders.js';

export type TaskSeverity = 'critical' | 'warning' | 'info';

export interface Task {
  /** Stable id (also the dedupe key for alerts). */
  id: string;
  kind:
    | 'check-in'
    | 'missed-check-in'
    | 'attendance'
    | 'lesson-plan'
    | 'feedback'
    | 'registrations'
    | 'flagged-check-ins'
    | 'overdue-fees'
    | 'makeup-requests'
    | 'substitute-requests'
    | 'reschedule-requests'
    | 'course-setup'
    | 'course-decisions'
    | 'refunds-due'
    | 'session-shortfalls'
    | 'delivery-risk'
    | 'skill-assessments';
  severity: TaskSeverity;
  title: string;
  detail: string;
  /** In-app link that resolves the task. */
  link: string;
  /** Which screen's badge this counts toward. */
  screen: string;
  /** How many things this item stands for (e.g. 3 overdue invoices). Defaults to 1. */
  count?: number;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Minutes since midnight in IST. */
export function istMinutes(now: Date = new Date()): number {
  const [h = 0, m = 0] = clock.format(now).split(':').map(Number);
  return (h % 24) * 60 + m;
}

export const toMinutes = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

export { clockLabel } from '../../lib/batch-times.js';
import { clockLabel } from '../../lib/batch-times.js';

const SEVERITY_ORDER: Record<TaskSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Session-level tasks for today (shared by coach and admin views). */
async function sessionTasks(user: AuthUser, now: Date): Promise<Task[]> {
  const today = todayInAppTz(now);
  const mins = istMinutes(now);
  const admin = user.role === 'admin';
  const { sessions } = await dayOverview(user, today);
  const tasks: Task[] = [];
  for (const s of sessions) {
    if (s.cancelled) continue;
    const b = s.batch;
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    const at = clockLabel(b.startTime);
    const who = admin ? `${b.coach.name} · ` : '';
    const attendanceLink = `/attendance?batch=${b.id}&date=${today}`;

    if (!s.coachSession) {
      if (mins >= start + 30) {
        tasks.push({
          id: `missed-check-in:${b.id}:${today}`,
          kind: 'missed-check-in',
          severity: 'critical',
          title: admin ? `${b.coach.name} hasn't checked in` : `You haven't checked in`,
          detail: `${b.name} started at ${at} · ${b.location.name}`,
          link: admin ? `/calendar?date=${today}&view=day` : '/',
          screen: admin ? '/calendar' : '/',
        });
      } else if (!admin) {
        // Every session today needs its own check-in: "now" from 15 minutes before it starts,
        // "later today" before that.
        tasks.push({
          id: `check-in:${b.id}:${today}`,
          kind: 'check-in',
          severity: mins >= start - 15 ? 'warning' : 'info',
          title: `Check in to ${b.name}`,
          detail: `${mins < start ? `Starts at ${at}` : `Started at ${at}`} · ${b.location.name}`,
          link: '/',
          screen: '/',
        });
      }
    }
    // Attendance: once the session has started. Coaches can mark it once checked in, until the
    // end of the day (even after checking out); unmarked late on, it's an admin follow-up too.
    if (mins >= start && s.expectedStudents > 0 && s.marked < s.expectedStudents) {
      if (admin ? mins >= end + 30 : !!s.coachSession) {
        tasks.push({
          id: `attendance:${b.id}:${today}`,
          kind: 'attendance',
          severity: mins >= end ? 'warning' : 'info',
          title: admin ? `Attendance not marked` : `Mark attendance for ${b.name}`,
          detail: `${who}${b.name} · ${s.marked} of ${s.expectedStudents} marked`,
          link: attendanceLink,
          screen: '/attendance',
        });
      }
    }
    // The batch needs a lesson plan (or its plan no longer fits the session). Not for
    // attendance-only batches.
    if (!admin && b.coachFeedback && mins < end && (!s.hasLessonPlan || !s.lessonPlanFits)) {
      tasks.push({
        id: `lesson-plan:${b.id}:${today}`,
        kind: 'lesson-plan',
        severity: 'info',
        title: s.hasLessonPlan
          ? `Update the lesson plan for ${b.name}`
          : `Set up the lesson plan for ${b.name}`,
        detail: s.hasLessonPlan
          ? `It no longer adds up to the session length · ${at}`
          : `Session at ${at}`,
        link: `/lesson-plans?batch=${b.id}&plan=1`,
        screen: '/lesson-plans',
      });
    }
  }
  return tasks;
}

export async function tasksFor(user: AuthUser, now: Date = new Date()) {
  const tasks = await sessionTasks(user, now);
  const today = todayInAppTz(now);

  if (user.role === 'coach') {
    // Students who may get fewer sessions than they pay for this month: add an extra session.
    const [risk] = await db
      .select({ n: count() })
      .from(sessionShortfalls)
      .innerJoin(batches, eq(batches.id, sessionShortfalls.batchId))
      .where(and(eq(sessionShortfalls.status, 'at_risk'), eq(batches.coachId, user.id)));
    if (risk!.n > 0)
      tasks.push({
        id: 'delivery-risk',
        kind: 'delivery-risk',
        severity: 'warning',
        title: `${risk!.n} student${risk!.n === 1 ? '' : 's'} may miss sessions this month`,
        detail: 'Fewer sessions are scheduled than they pay for. Add an extra session.',
        link: '/delivery',
        screen: '/delivery',
        count: risk!.n,
      });
    const board = await weekBoard(user, lastCompletedWeek());
    const open = board.summary.pending + board.summary.draft;
    if (open > 0) {
      tasks.push({
        id: `feedback:${board.weekStart}`,
        kind: 'feedback',
        severity: 'info',
        title: `${open} weekly report${open === 1 ? '' : 's'} to send`,
        detail: `For the week of ${board.weekStart}`,
        link: '/feedback',
        screen: '/feedback',
        count: open,
      });
    }
    // Monthly skill assessments: a reminder from the 15th until they're all done.
    const day = Number(today.slice(8, 10));
    if (day >= 15) {
      const pending = await pendingAssessments(user.id, today);
      if (pending > 0) {
        const daysLeft = endOfMonthDay(today) - day;
        tasks.push({
          id: `skills:${today.slice(0, 7)}`,
          kind: 'skill-assessments',
          severity: daysLeft <= 4 ? 'warning' : 'info',
          title: `${pending} student${pending === 1 ? '' : 's'} to assess this month`,
          detail:
            daysLeft === 0
              ? 'Last day of the month'
              : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left this month`,
          link: '/skills',
          screen: '/skills',
          count: pending,
        });
      }
    }
  } else {
    const [
      [regs],
      [flags],
      [overdue],
      [makeups],
      [subs],
      [moves],
      [setup],
      [decisions],
      [shorts],
      [refunds],
    ] = await Promise.all([
      db
        .select({ n: count() })
        .from(registrationRequests)
        .where(eq(registrationRequests.status, 'pending')),
      db
        .select({ n: count() })
        .from(coachSessions)
        .where(and(eq(coachSessions.checkInWithinFence, false), isNull(coachSessions.reviewedAt))),
      db
        .select({ n: count() })
        .from(invoices)
        .where(and(eq(invoices.status, 'due'), lt(invoices.dueDate, today))),
      db.select({ n: count() }).from(makeupSessions).where(eq(makeupSessions.status, 'pending')),
      db
        .select({ n: count() })
        .from(batchSubstitutions)
        .where(eq(batchSubstitutions.status, 'pending')),
      db.select({ n: count() }).from(sessionChanges).where(eq(sessionChanges.status, 'pending')),
      db
        .select({ n: count() })
        .from(batches)
        .where(and(eq(batches.isActive, true), isNull(batches.courseMonths))),
      db.select({ n: count() }).from(courseRounds).where(eq(courseRounds.status, 'awaiting')),
      db
        .select({ n: count() })
        .from(sessionShortfalls)
        .where(eq(sessionShortfalls.status, 'short')),
      db
        .select({ n: count(), total: sql<number>`coalesce(sum(${studentCredits.amount}), 0)::int` })
        .from(studentCredits)
        .where(eq(studentCredits.status, 'refund_due')),
    ]);
    if (shorts!.n > 0) {
      tasks.push({
        id: 'session-shortfalls',
        kind: 'session-shortfalls',
        severity: 'warning',
        title: `${shorts!.n} month${shorts!.n === 1 ? '' : 's'} delivered short`,
        detail: 'Students got fewer sessions than paid for: discount, extra session or dismiss',
        link: '/delivery',
        screen: '/delivery',
        count: shorts!.n,
      });
    }
    if (decisions!.n > 0) {
      tasks.push({
        id: 'course-decisions',
        kind: 'course-decisions',
        severity: 'warning',
        title: `${decisions!.n} completed course${decisions!.n === 1 ? '' : 's'} to decide`,
        detail: 'Re-admit, move to another batch, or leave (paused from the roster meanwhile)',
        link: '/courses',
        screen: '/courses',
        count: decisions!.n,
      });
    }
    if (refunds!.n > 0) {
      tasks.push({
        id: 'refunds-due',
        kind: 'refunds-due',
        severity: 'warning',
        title: `${refunds!.n} refund${refunds!.n === 1 ? '' : 's'} owed · ${formatInr(refunds!.total)}`,
        detail: 'Unused course months owed back to families',
        link: '/courses?tab=credits',
        screen: '/courses',
        count: refunds!.n,
      });
    }
    if (setup!.n > 0) {
      tasks.push({
        id: 'course-setup',
        kind: 'course-setup',
        severity: 'info',
        title: `Set up the course for ${setup!.n} batch${setup!.n === 1 ? '' : 'es'}`,
        detail: 'Choose each batch’s course length in months',
        link: '/batches',
        screen: '/batches',
        count: setup!.n,
      });
    }
    if (moves!.n > 0) {
      tasks.push({
        id: 'reschedule-requests',
        kind: 'reschedule-requests',
        severity: 'warning',
        title: `${moves!.n} session change${moves!.n === 1 ? '' : 's'} to review`,
        detail: 'Coaches asked to move a session or add an extra one at short notice',
        link: '/session-changes',
        screen: '/session-changes',
        count: moves!.n,
      });
    }
    if (subs!.n > 0) {
      tasks.push({
        id: 'substitute-requests',
        kind: 'substitute-requests',
        severity: 'warning',
        title: `${subs!.n} substitute request${subs!.n === 1 ? '' : 's'} to review`,
        detail: 'Coaches asked for someone to cover their batch',
        link: '/substitutions',
        screen: '/substitutions',
        count: subs!.n,
      });
    }
    if (makeups!.n > 0) {
      tasks.push({
        id: 'makeup-requests',
        kind: 'makeup-requests',
        severity: 'warning',
        title: `${makeups!.n} makeup request${makeups!.n === 1 ? '' : 's'} to review`,
        detail: 'Coaches asked to add students to a session',
        link: '/makeups',
        screen: '/makeups',
        count: makeups!.n,
      });
    }
    if (regs!.n > 0) {
      tasks.push({
        id: 'registrations',
        kind: 'registrations',
        severity: 'warning',
        title: `${regs!.n} registration${regs!.n === 1 ? '' : 's'} to review`,
        detail: 'New sign-ups waiting for approval',
        link: '/registrations',
        screen: '/registrations',
        count: regs!.n,
      });
    }
    if (flags!.n > 0) {
      tasks.push({
        id: 'flagged-check-ins',
        kind: 'flagged-check-ins',
        severity: 'warning',
        title: `${flags!.n} flagged check-in${flags!.n === 1 ? '' : 's'}`,
        detail: 'Coaches checked in away from the batch location',
        link: '/coach-sessions',
        screen: '/coach-sessions',
        count: flags!.n,
      });
    }
    if (overdue!.n > 0) {
      tasks.push({
        id: 'overdue-fees',
        kind: 'overdue-fees',
        severity: 'warning',
        title: `${overdue!.n} overdue invoice${overdue!.n === 1 ? '' : 's'}`,
        detail: 'Fees past their due date',
        link: '/finance?tab=invoices&status=overdue',
        screen: '/finance',
        count: overdue!.n,
      });
    }
  }

  tasks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  // Badge counts per screen; aggregate items (registrations, overdue…) count their real number.
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.screen] = (counts[t.screen] ?? 0) + (t.count ?? 1);
  return { generatedAt: now.toISOString(), total: tasks.length, counts, items: tasks };
}
