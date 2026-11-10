import { arrayContains, and, count, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { deviceTokens, notificationLog, notifications, users } from '../../db/schema/index.js';
import { logger } from '../../lib/logger.js';
import { createFcmSender, parseServiceAccount, type PushMessage, type PushSender } from './fcm.js';

export type DevicePlatform = (typeof deviceTokens.$inferInsert)['platform'];

let sender: PushSender | null | undefined;
let misconfigured = false;

/**
 * Push is enabled only when FCM_SERVICE_ACCOUNT is configured; otherwise every send is a no-op.
 * A malformed key disables push (logged once) instead of breaking the requests that notify.
 */
function getSender(): PushSender | null {
  if (sender === undefined) {
    try {
      const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
      sender = sa ? createFcmSender(sa) : null;
      misconfigured = false;
      logger.info({ enabled: !!sender }, 'Push notifications');
    } catch (err) {
      sender = null;
      misconfigured = true;
      logger.error({ err }, 'FCM_SERVICE_ACCOUNT is invalid; push notifications are disabled');
    }
  }
  return sender;
}

/** Test hook: inject a fake sender (or null to disable). */
export function setPushSender(fn: PushSender | null | undefined): void {
  sender = fn;
}

export const pushEnabled = () => getSender() !== null;

/** For /ready: is FCM configured, and does the key parse? (Never throws.) */
export function pushStatus(): 'enabled' | 'disabled' | 'misconfigured' {
  if (pushEnabled()) return 'enabled';
  return misconfigured ? 'misconfigured' : 'disabled';
}

export async function registerDevice(userId: string, token: string, platform: DevicePlatform) {
  await db
    .insert(deviceTokens)
    .values({ userId, token, platform })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: { userId, platform, lastSeenAt: new Date() },
    });
}

export async function unregisterDevice(userId: string, token: string) {
  await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)));
}

const KEEP_DAYS = 60;

/** The title as people see it: the icon (emoji) first. */
export const withIcon = (m: Pick<PushMessage, 'icon' | 'title'>) =>
  m.icon ? `${m.icon} ${m.title}` : m.title;

/**
 * Saves the notification to each person's in-app inbox (a newer one with the same tag replaces
 * an unread older one). Returns each person's inbox id.
 */
async function saveToInbox(userIds: string[], m: PushMessage) {
  if (m.tag)
    await db
      .delete(notifications)
      .where(
        and(
          inArray(notifications.userId, userIds),
          eq(notifications.tag, m.tag),
          isNull(notifications.readAt),
        ),
      );
  const rows = await db
    .insert(notifications)
    .values(
      userIds.map((userId) => ({
        userId,
        category: m.category,
        title: withIcon(m),
        body: m.body,
        link: m.link ?? null,
        tag: m.tag ?? null,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  if (Math.random() < 0.02)
    await db
      .delete(notifications)
      .where(lt(notifications.createdAt, sql`now() - make_interval(days => ${KEEP_DAYS})`));
  return new Map(rows.map((r) => [r.userId, r.id]));
}

/** Unread inbox counts, for the app icon badge. */
async function unreadCounts(userIds: string[]) {
  const rows = await db
    .select({ userId: notifications.userId, n: count() })
    .from(notifications)
    .where(and(inArray(notifications.userId, userIds), isNull(notifications.readAt)))
    .groupBy(notifications.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

/**
 * Notifies people: saved to their in-app inbox, then pushed to every device they're signed in on
 * (with their unread count as the app badge). Prunes tokens FCM reports as gone.
 */
export async function notifyUsers(userIds: string[], message: PushMessage) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return { sent: 0, removed: 0 };
  const inbox = await saveToInbox(ids, message);
  const send = getSender();
  if (!send) return { sent: 0, removed: 0 };
  const [rows, unread] = await Promise.all([
    db
      .select({ token: deviceTokens.token, userId: deviceTokens.userId })
      .from(deviceTokens)
      .where(inArray(deviceTokens.userId, ids)),
    unreadCounts(ids),
  ]);
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    rows.map(async ({ token, userId }) => {
      try {
        const result = await send(token, {
          ...message,
          badge: unread.get(userId) ?? 0,
          notificationId: inbox.get(userId),
        });
        if (result === 'ok') sent++;
        else if (result === 'invalid-token') dead.push(token);
      } catch (err) {
        logger.warn({ err }, 'Push send failed');
      }
    }),
  );
  if (dead.length) await db.delete(deviceTokens).where(inArray(deviceTokens.token, dead));
  return { sent, removed: dead.length };
}

export async function activeAdminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(arrayContains(users.roles, ['admin']), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}

/**
 * Sends an alert only the first time its key is seen (e.g. "nocheckin:<batch>:<date>").
 * The key is claimed before sending, so concurrent runs or restarts never double-notify.
 */
export async function notifyOnce(key: string, userIds: string[], message: PushMessage) {
  if (userIds.length === 0) return false;
  const claimed = await db
    .insert(notificationLog)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: notificationLog.key });
  if (!claimed.length) return false;
  await notifyUsers(userIds, message);
  return true;
}

export async function notifyAdmins(message: PushMessage) {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(arrayContains(users.roles, ['admin']), eq(users.status, 'active')));
  return notifyUsers(
    admins.map((a) => a.id),
    message,
  );
}

/** Fire-and-forget from request handlers: a notification problem never fails or delays a request. */
export function notifyInBackground(task: () => Promise<unknown>): void {
  task().catch((err: unknown) => logger.warn({ err }, 'Notification failed'));
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

/** A person's latest notifications and how many are unread. */
export async function inboxFor(userId: string, limit = 50) {
  const [items, unread] = await Promise.all([
    db
      .select({
        id: notifications.id,
        category: notifications.category,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(limit),
    unreadCounts([userId]),
  ]);
  return { items, unread: unread.get(userId) ?? 0 };
}

/** Marks some (or all) of a person's notifications read. */
export async function markRead(userId: string, ids?: string[]) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids) : undefined,
      ),
    );
}
