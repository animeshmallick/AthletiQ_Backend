/**
 * Time-based alerts. Designed not to spam:
 *  - each alert fires at most once (unique key in notification_log),
 *  - only inside a short window around the moment it's about (a restart never sends stale alerts),
 *  - admins get one evening digest instead of a stream of small updates,
 *  - coaches get one weekly feedback nudge, only if reports are still open.
 */
import { and, count, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invoices, payments, users } from '../db/schema/index.js';
import { todayInAppTz } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { formatInr } from '../lib/money.js';
import { dayOverview } from '../modules/attendance/attendance.routes.js';
import type { AuthUser } from '../modules/auth/auth.types.js';
import { lastCompletedWeek, weekBoard } from '../modules/feedback/feedback.routes.js';
import { activeAdminIds, notifyOnce, pushEnabled } from '../modules/push/push.service.js';
import { clockLabel, istMinutes, toMinutes } from '../modules/tasks/tasks.service.js';

/** Reads everything (admin scope) without being a real user. */
const SYSTEM: AuthUser = {
  id: '00000000-0000-0000-0000-000000000000',
  role: 'admin',
  name: 'System',
  email: 'system@athletiq.local',
};

/**
 * Every minute:
 *  - 15 min before a session → coach reminder,
 *  - 30 min after start with no check-in → coach + admins,
 *  - 30 min after the end with anything pending (attendance, check-out, plan) → coach + admins.
 */
export async function runSessionAlerts(now: Date = new Date()) {
  if (!pushEnabled()) return { sent: 0 };
  const today = todayInAppTz(now);
  const mins = istMinutes(now);
  const { sessions } = await dayOverview(SYSTEM, today);
  const admins = await activeAdminIds();
  let sent = 0;

  for (const s of sessions) {
    if (s.cancelled) continue;
    const b = s.batch;
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    const at = clockLabel(b.startTime);
    const attendanceLink = `/attendance?batch=${b.id}&date=${today}`;

    if (!s.coachSession && mins >= start - 15 && mins < start) {
      if (
        await notifyOnce(`remind:${b.id}:${today}`, [b.coach.id], {
          title: `${b.name} starts at ${at}`,
          body: `In ${start - mins} min at ${b.location.name}. Check in when you arrive.`,
          link: '/',
          tag: `session-${b.id}`,
        })
      )
        sent++;
    }

    if (!s.coachSession && mins >= start + 30 && mins < end) {
      const coach = await notifyOnce(`nocheckin-coach:${b.id}:${today}`, [b.coach.id], {
        title: `You haven't checked in to ${b.name}`,
        body: `It started at ${at}. Check in at ${b.location.name} so attendance can be marked.`,
        link: '/',
        tag: `session-${b.id}`,
      });
      const admin = await notifyOnce(`nocheckin-admin:${b.id}:${today}`, admins, {
        title: `${b.coach.name} hasn't checked in`,
        body: `${b.name} started at ${at} · ${b.location.name}`,
        link: `/calendar?date=${today}&view=day`,
        tag: `nocheckin-${b.id}`,
      });
      sent += Number(coach) + Number(admin);
    }

    if (mins >= end + 30 && mins < end + 120) {
      const pending: string[] = [];
      if (!s.coachSession) pending.push('no check-in');
      if (s.expectedStudents > 0 && s.marked < s.expectedStudents) {
        pending.push(`attendance ${s.marked}/${s.expectedStudents}`);
      }
      if (s.coachSession && !s.coachSession.checkOutAt) pending.push('not checked out');
      if (!s.hasLessonPlan) pending.push('no lesson plan');
      if (pending.length) {
        const coach = await notifyOnce(`wrapup-coach:${b.id}:${today}`, [b.coach.id], {
          title: `${b.name}: ${pending.length} thing${pending.length === 1 ? '' : 's'} left for today`,
          body: pending.join(' · '),
          link: attendanceLink,
          tag: `wrapup-${b.id}`,
        });
        const admin = await notifyOnce(`wrapup-admin:${b.id}:${today}`, admins, {
          title: `${b.name} (${b.coach.name}) has pending items`,
          body: pending.join(' · '),
          link: `/calendar?date=${today}&view=day`,
          tag: `wrapup-${b.id}`,
        });
        sent += Number(coach) + Number(admin);
      }
    }
  }
  return { sent };
}

/** 8 pm: one summary of the day for admins (instead of many small pushes). */
export async function sendAdminDigest(now: Date = new Date()) {
  if (!pushEnabled()) return { sent: false };
  const today = todayInAppTz(now);
  const { sessions } = await dayOverview(SYSTEM, today);
  const live = sessions.filter((s) => !s.cancelled);
  const missed = live.filter((s) => !s.coachSession).length;
  const unmarked = live.filter(
    (s) => s.expectedStudents > 0 && s.marked < s.expectedStudents,
  ).length;
  const [[collected], [overdue]] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.paidOn, today), eq(payments.status, 'completed'))),
    db
      .select({ n: count() })
      .from(invoices)
      .where(and(eq(invoices.status, 'due'), lt(invoices.dueDate, today))),
  ]);
  const parts = [
    `${live.length} session${live.length === 1 ? '' : 's'}`,
    missed ? `${missed} missed check-in${missed === 1 ? '' : 's'}` : null,
    unmarked ? `${unmarked} without full attendance` : null,
    `${formatInr(collected!.total)} collected`,
    overdue!.n ? `${overdue!.n} overdue invoice${overdue!.n === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const sent = await notifyOnce(`digest:${today}`, await activeAdminIds(), {
    title: 'Today at the academy',
    body: parts.join(' · '),
    link: '/',
    tag: 'digest',
  });
  return { sent };
}

/** Monday 10 am: one nudge per coach who still has last week's reports open. */
export async function sendFeedbackReminders() {
  if (!pushEnabled()) return { coaches: 0 };
  const weekStart = lastCompletedWeek();
  const coaches = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.role, 'coach'), eq(users.status, 'active')));
  let nudged = 0;
  for (const c of coaches) {
    const board = await weekBoard({ ...c, role: 'coach' }, weekStart);
    const open = board.summary.pending + board.summary.draft;
    if (!open) continue;
    if (
      await notifyOnce(`feedback:${c.id}:${weekStart}`, [c.id], {
        title: `${open} weekly report${open === 1 ? '' : 's'} to send`,
        body: 'Last week is done. Parents are waiting to hear how it went.',
        link: '/feedback',
        tag: 'feedback',
      })
    )
      nudged++;
  }
  return { coaches: nudged };
}

/** Logged-and-swallowed runner for cron. */
export function runSafely(name: string, job: () => Promise<unknown>) {
  job().catch((err: unknown) => logger.error({ err }, `${name} failed`));
}
