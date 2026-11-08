/**
 * Morning push for coaches: "Today: Batch One at 5:00 pm, …". Skips cancelled sessions and
 * coaches with nothing scheduled. Safe to run more than once (it only sends notifications).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batches, sessionCancellations } from '../db/schema/index.js';
import { isoWeekday, todayInAppTz } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { notifyUsers, pushEnabled } from '../modules/push/push.service.js';

/** "17:00:00" → "5:00 pm" */
export function clock(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

export async function sendSessionReminders(today = todayInAppTz()) {
  if (!pushEnabled()) return { coaches: 0 };
  const weekday = isoWeekday(today);
  const [active, cancelled] = await Promise.all([
    db.select().from(batches).where(eq(batches.isActive, true)),
    db
      .select({ batchId: sessionCancellations.batchId })
      .from(sessionCancellations)
      .where(and(eq(sessionCancellations.date, today))),
  ]);
  const off = new Set(cancelled.map((c) => c.batchId));
  const byCoach = new Map<string, typeof active>();
  for (const b of active) {
    if (!b.weekdays.includes(weekday) || off.has(b.id)) continue;
    byCoach.set(b.coachId, [...(byCoach.get(b.coachId) ?? []), b]);
  }
  for (const [coachId, list] of byCoach) {
    list.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const n = list.length;
    await notifyUsers([coachId], {
      title: n === 1 ? 'You have 1 session today' : `You have ${n} sessions today`,
      body: list.map((b) => `${b.name} at ${clock(b.startTime)}`).join(' · '),
      link: '/',
      tag: `sessions-${today}`,
    });
  }
  logger.info({ coaches: byCoach.size, date: today }, 'Session reminders sent');
  return { coaches: byCoach.size };
}
