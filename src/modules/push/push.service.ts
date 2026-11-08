import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { deviceTokens, users } from '../../db/schema/index.js';
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

/** Sends to every device of the given users; prunes tokens FCM reports as gone. */
export async function notifyUsers(userIds: string[], message: PushMessage) {
  const send = getSender();
  if (!send || userIds.length === 0) return { sent: 0, removed: 0 };
  const rows = await db
    .select({ token: deviceTokens.token })
    .from(deviceTokens)
    .where(inArray(deviceTokens.userId, [...new Set(userIds)]));
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    rows.map(async ({ token }) => {
      try {
        const result = await send(token, message);
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

export async function notifyAdmins(message: PushMessage) {
  if (!getSender()) return { sent: 0, removed: 0 };
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
  return notifyUsers(
    admins.map((a) => a.id),
    message,
  );
}

/** Fire-and-forget from request handlers: a notification problem never fails or delays a request. */
export function notifyInBackground(task: () => Promise<unknown>): void {
  if (!getSender()) return;
  task().catch((err: unknown) => logger.warn({ err }, 'Notification failed'));
}
