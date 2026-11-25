/**
 * Nightly notices to admins about sessions the academy still owes: never checked in, past the
 * coach's 30 days, or left over from a cycle that ended. Each is sent once.
 */
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batchCycles } from '../db/schema/index.js';
import { addDays, formatDisplayDate, todayInAppTz, type IsoDate } from '../lib/dates.js';
import { activeAdminIds, notifyOnce } from '../modules/push/push.service.js';
import { missedSessions } from '../modules/schedule/session-changes.js';

/** Cycles that ended this recently are announced (covers nights the job didn't run). */
const RECENT_DAYS = 7;

export async function sendMissedNotices(today: IsoDate = todayInAppTz(), now: Date = new Date()) {
  const admins = await activeAdminIds();
  const { open, unconfirmed } = await missedSessions({ role: 'admin' }, now);
  let sent = 0;
  const send = async (key: string, title: string, body: string, link: string) => {
    const message = { category: 'approvals' as const, icon: '📅', title, body, link, tag: key };
    if (await notifyOnce(key, admins, message)) sent++;
  };
  for (const s of unconfirmed)
    await send(
      `unconfirmed:${s.batch.id}:${s.date}`,
      `${s.batch.name} on ${formatDisplayDate(s.date)}: missed or held?`,
      `No check-in or attendance from ${s.batch.coach.name}. Confirm it.`,
      '/missed-sessions?tab=unconfirmed',
    );
  for (const s of open.filter((m) => m.overdue))
    await send(
      `missed-30:${s.batch.id}:${s.date}`,
      `${s.batch.name}: missed session not made up in 30 days`,
      `${formatDisplayDate(s.originalDate)} · ${s.batch.coach.name}. Reschedule it, book makeups, or close it.`,
      '/missed-sessions',
    );
  const owing = open.filter((m) => m.pending > 0);
  if (!owing.length) return { sent };
  const ended = await db
    .select()
    .from(batchCycles)
    .where(
      and(
        inArray(batchCycles.batchId, [...new Set(open.map((m) => m.batch.id))]),
        eq(batchCycles.status, 'completed'),
        gte(batchCycles.endsOn, addDays(today, -RECENT_DAYS)),
        lt(batchCycles.endsOn, today),
      ),
    );
  for (const c of ended) {
    const owed = owing.filter(
      (m) => m.batch.id === c.batchId && m.originalDate >= c.startsOn && m.originalDate <= c.endsOn,
    );
    if (owed.length)
      await send(
        `cycle-owed:${c.batchId}:${c.endsOn}`,
        `${owed[0]!.batch.name}: a cycle ended with sessions to reschedule`,
        `${owed.length} missed session${owed.length === 1 ? '' : 's'} up to ${formatDisplayDate(c.endsOn)} still to be held.`,
        '/missed-sessions',
      );
  }
  return { sent };
}
