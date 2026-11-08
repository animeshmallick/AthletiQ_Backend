/**
 * "What needs my attention right now?" — one answer used by the header bell, the tab badges and
 * the scheduled alerts. Coaches get their own sessions; admins get academy-wide items.
 */
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import { APP_TIMEZONE } from '../../config/constants.js';
import { db } from '../../db/client.js';
import {
  coachSessions,
  invoices,
  makeupSessions,
  registrationRequests,
} from '../../db/schema/index.js';
import { todayInAppTz } from '../../lib/dates.js';
import { dayOverview } from '../attendance/attendance.routes.js';
import type { AuthUser } from '../auth/auth.types.js';
import { lastCompletedWeek, weekBoard } from '../feedback/feedback.routes.js';

export type TaskSeverity = 'critical' | 'warning' | 'info';

export interface Task {
  /** Stable id (also the dedupe key for alerts). */
  id: string;
  kind:
    | 'check-in'
    | 'missed-check-in'
    | 'attendance'
    | 'lesson-plan'
    | 'check-out'
    | 'feedback'
    | 'registrations'
    | 'flagged-check-ins'
    | 'overdue-fees'
    | 'makeup-requests';
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

/** "17:00:00" → "5:00 pm" */
export function clockLabel(t: string): string {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

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
      } else if (!admin && mins >= start - 15) {
        tasks.push({
          id: `check-in:${b.id}:${today}`,
          kind: 'check-in',
          severity: 'warning',
          title: `Check in to ${b.name}`,
          detail: `${mins < start ? `Starts at ${at}` : `Started at ${at}`} · ${b.location.name}`,
          link: '/',
          screen: '/',
        });
      }
    }
    // Attendance: once the session has started (coaches need to be checked in to mark it).
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
    if (!admin && !s.hasLessonPlan && mins < end) {
      tasks.push({
        id: `lesson-plan:${b.id}:${today}`,
        kind: 'lesson-plan',
        severity: 'info',
        title: `Add today's plan for ${b.name}`,
        detail: `Session at ${at}`,
        link: `/lesson-plans?batch=${b.id}&date=${today}`,
        screen: '/lesson-plans',
      });
    }
    if (s.coachSession && !s.coachSession.checkOutAt && mins >= end + 15) {
      tasks.push({
        id: `check-out:${b.id}:${today}`,
        kind: 'check-out',
        severity: 'warning',
        title: admin ? `${b.coach.name} hasn't checked out` : `Check out of ${b.name}`,
        detail: `Session ended at ${clockLabel(b.endTime)}`,
        link: admin ? `/coach-sessions` : '/',
        screen: admin ? '/coach-sessions' : '/',
      });
    }
  }
  return tasks;
}

export async function tasksFor(user: AuthUser, now: Date = new Date()) {
  const tasks = await sessionTasks(user, now);
  const today = todayInAppTz(now);

  if (user.role === 'coach') {
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
  } else {
    const [[regs], [flags], [overdue], [makeups]] = await Promise.all([
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
    ]);
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
        link: '/invoices?status=overdue',
        screen: '/invoices',
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
