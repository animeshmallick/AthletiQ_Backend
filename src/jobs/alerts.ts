/**
 * Time-based alerts. Designed not to spam:
 *  - each alert fires at most once (unique key in notification_log),
 *  - only inside a short window around the moment it's about (a restart never sends stale alerts),
 *  - admins get one evening digest instead of a stream of small updates,
 *  - coaches get one weekly feedback nudge, only if reports are still open.
 */
import { arrayContains, and, count, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  batches,
  invoices,
  notificationLog,
  payments,
  students,
  users,
} from '../db/schema/index.js';
import { addDays, startOfIsoWeek, todayInAppTz } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { formatInr } from '../lib/money.js';
import { dayOverview } from '../modules/attendance/attendance.routes.js';
import type { AuthUser } from '../modules/auth/auth.types.js';
import { lastCompletedWeek, weekBoard } from '../modules/feedback/feedback.routes.js';
import {
  activeAdminIds,
  notifyOnce,
  notifyUsers,
  pushEnabled,
} from '../modules/push/push.service.js';
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
 *  - 30 min after the end with anything pending (attendance, plan) → coach + admins.
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
          category: 'sessions',
          icon: '⏰',
          actions: [{ label: 'Check in', link: '/' }],
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
        category: 'sessions',
        icon: '📍',
        actions: [{ label: 'Check in now', link: '/' }],
        title: `You haven't checked in to ${b.name}`,
        body: `It started at ${at}. Check in at ${b.location.name} so attendance can be marked.`,
        link: '/',
        tag: `session-${b.id}`,
      });
      const admin = await notifyOnce(`nocheckin-admin:${b.id}:${today}`, admins, {
        category: 'sessions',
        icon: '⚠️',
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
      if (!s.hasLessonPlan) pending.push('no lesson plan');
      if (pending.length) {
        const coach = await notifyOnce(`wrapup-coach:${b.id}:${today}`, [b.coach.id], {
          category: 'sessions',
          icon: '📝',
          actions: [{ label: 'Finish up', link: attendanceLink }],
          title: `${b.name}: ${pending.length} thing${pending.length === 1 ? '' : 's'} left for today`,
          body: pending.join(' · '),
          link: attendanceLink,
          tag: `wrapup-${b.id}`,
        });
        const admin = await notifyOnce(`wrapup-admin:${b.id}:${today}`, admins, {
          category: 'sessions',
          icon: '📝',
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
    category: 'summaries',
    icon: '📊',
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
    .where(and(arrayContains(users.roles, ['coach']), eq(users.status, 'active')));
  let nudged = 0;
  for (const c of coaches) {
    const board = await weekBoard({ ...c, role: 'coach' }, weekStart);
    const open = board.summary.pending + board.summary.draft;
    if (!open) continue;
    if (
      await notifyOnce(`feedback:${c.id}:${weekStart}`, [c.id], {
        category: 'summaries',
        icon: '✍️',
        actions: [{ label: 'Write reports', link: '/feedback' }],
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

/**
 * 10 am daily: tell each coach about their students whose fees just passed 7 days overdue.
 * Every invoice is reported once (claimed in notification_log), grouped into one push per coach.
 */
export async function sendOverdueNotices(now: Date = new Date()) {
  if (!pushEnabled()) return { coaches: 0 };
  const cutoff = addDays(todayInAppTz(now), -7);
  const rows = await db
    .select({
      invoiceId: invoices.id,
      studentId: students.id,
      fullName: students.fullName,
      coachId: batches.coachId,
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    // The coach of the batch the invoice bills.
    .innerJoin(batches, eq(batches.id, invoices.batchId))
    .where(
      and(eq(invoices.status, 'due'), lte(invoices.dueDate, cutoff), eq(students.status, 'active')),
    );
  if (!rows.length) return { coaches: 0 };
  const claimed = new Set(
    (
      await db
        .insert(notificationLog)
        .values(rows.map((r) => ({ key: `overdue7:${r.invoiceId}` })))
        .onConflictDoNothing()
        .returning({ key: notificationLog.key })
    ).map((r) => r.key.slice('overdue7:'.length)),
  );
  const byCoach = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!claimed.has(r.invoiceId)) continue;
    const names = byCoach.get(r.coachId) ?? new Map<string, string>();
    names.set(r.studentId, r.fullName);
    byCoach.set(r.coachId, names);
  }
  for (const [coachId, names] of byCoach) {
    const list = [...names.values()];
    const [first] = [...names.keys()];
    await notifyUsers([coachId], {
      category: 'money',
      icon: '💸',
      title:
        list.length === 1
          ? `${list[0]}'s fees are over a week overdue`
          : `${list.length} students' fees are over a week overdue`,
      body:
        list.length === 1
          ? 'A gentle word with the parents at the next session may help.'
          : `${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}`,
      link: list.length === 1 ? `/students/${first}` : '/finance?tab=invoices&status=overdue',
      tag: 'overdue',
    });
  }
  return { coaches: byCoach.size };
}

/** Monday 9 am: last week's fees in one push for admins. */
export async function sendWeeklyFeesSummary(now: Date = new Date()) {
  if (!pushEnabled()) return { sent: false };
  const from = addDays(startOfIsoWeek(todayInAppTz(now)), -7);
  const to = addDays(from, 6);
  const today = todayInAppTz(now);
  const [[paid], [billed], [overdue]] = await Promise.all([
    db
      .select({
        total: sql<number>`coalesce(sum(${payments.amount}), 0)::int`,
        n: count(),
      })
      .from(payments)
      .where(
        and(gte(payments.paidOn, from), lte(payments.paidOn, to), eq(payments.status, 'completed')),
      ),
    db
      .select({
        total: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
        n: count(),
      })
      .from(invoices)
      .where(
        and(
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
          inArray(invoices.status, ['due', 'paid']),
        ),
      ),
    db
      .select({
        total: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
        n: count(),
      })
      .from(invoices)
      .where(and(eq(invoices.status, 'due'), lt(invoices.dueDate, today))),
  ]);
  const sent = await notifyOnce(`fees-week:${from}`, await activeAdminIds(), {
    category: 'summaries',
    icon: '💰',
    title: `Last week: ${formatInr(paid!.total)} collected`,
    body: [
      `${paid!.n} payment${paid!.n === 1 ? '' : 's'}`,
      `${formatInr(billed!.total)} billed (${billed!.n} invoice${billed!.n === 1 ? '' : 's'})`,
      overdue!.n
        ? `${formatInr(overdue!.total)} overdue across ${overdue!.n} invoice${overdue!.n === 1 ? '' : 's'}`
        : 'nothing overdue',
    ].join(' · '),
    link: '/finance',
    tag: 'fees-week',
  });
  return { sent };
}

/** Logged-and-swallowed runner for cron. */
export function runSafely(name: string, job: () => Promise<unknown>) {
  job().catch((err: unknown) => logger.error({ err }, `${name} failed`));
}
