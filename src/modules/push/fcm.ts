/**
 * Minimal Firebase Cloud Messaging (HTTP v1) client: signs a service-account JWT with `jose`,
 * exchanges it for an OAuth access token (cached ~1 h) and sends one message per device token.
 * No Firebase Admin SDK needed.
 */
import { importPKCS8, SignJWT } from 'jose';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * What a notification is about. Each is its own channel on Android (people can mute one, e.g.
 * money updates, and keep session reminders) and sets sound and priority on iPhone:
 *  - sessions: starts, check-in, cancellations, wrap-up (urgent, with sound)
 *  - students: joined, left, moved, makeups
 *  - money: fees received, shares, cash held, overdue fees
 *  - approvals: sign-ups, substitute and makeup requests (admins)
 *  - summaries: morning schedule, daily digest, weekly numbers (quiet)
 */
export const PUSH_CATEGORIES = ['sessions', 'students', 'money', 'approvals', 'summaries'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export interface PushAction {
  /** Button text, e.g. "Check in". */
  label: string;
  /** In-app path it opens. */
  link: string;
}

export interface PushMessage {
  category: PushCategory;
  /** An emoji shown before the title, so the kind of notification reads at a glance. */
  icon?: string;
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped, e.g. "/registrations". */
  link?: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag?: string;
  /** Up to two buttons on the notification (where the platform shows them). */
  actions?: PushAction[];
  /** The person's unread count, shown on the app icon. Set per person when sending. */
  badge?: number;
  /** The inbox entry (marks it read when opened). Set per person when sending. */
  notificationId?: string;
}

/** Per category: Android importance/priority and iPhone interruption level and sound. */
const STYLE: Record<
  PushCategory,
  { priority: 'high' | 'normal'; level: 'time-sensitive' | 'active' | 'passive'; sound: boolean }
> = {
  sessions: { priority: 'high', level: 'time-sensitive', sound: true },
  students: { priority: 'high', level: 'active', sound: true },
  money: { priority: 'high', level: 'active', sound: true },
  approvals: { priority: 'high', level: 'active', sound: true },
  summaries: { priority: 'normal', level: 'passive', sound: false },
};

/** The FCM v1 message for one device. Exported for tests. */
export function fcmMessage(token: string, m: PushMessage) {
  const style = STYLE[m.category];
  const actions = (m.actions ?? []).slice(0, 2);
  const data: Record<string, string> = {
    link: m.link ?? '/',
    category: m.category,
    ...(m.notificationId ? { notificationId: m.notificationId } : {}),
    ...(actions.length ? { actions: JSON.stringify(actions) } : {}),
  };
  return {
    token,
    notification: { title: m.icon ? `${m.icon} ${m.title}` : m.title, body: m.body },
    data,
    android: {
      priority: style.priority,
      notification: {
        channel_id: m.category,
        tag: m.tag,
        color: '#4f46e5',
        icon: 'ic_stat_notify',
        ...(style.sound ? { default_sound: true } : {}),
        ...(m.badge !== undefined ? { notification_count: m.badge } : {}),
      },
    },
    apns: {
      headers: {
        'apns-priority': style.priority === 'high' ? '10' : '5',
        'apns-push-type': 'alert',
        ...(m.tag ? { 'apns-collapse-id': m.tag.slice(0, 64) } : {}),
      },
      payload: {
        aps: {
          // Stacks by category in Notification Centre.
          'thread-id': m.category,
          'interruption-level': style.level,
          ...(style.sound ? { sound: 'default' } : {}),
          ...(m.badge !== undefined ? { badge: m.badge } : {}),
        },
      },
    },
    // Browsers / iPhone Home Screen app: deliver promptly, drop after a day.
    webpush: {
      headers: { Urgency: style.priority === 'high' ? 'high' : 'normal', TTL: '86400' },
    },
  };
}

export type SendResult = 'ok' | 'invalid-token' | 'error';
export type PushSender = (token: string, message: PushMessage) => Promise<SendResult>;
type FetchFn = typeof fetch;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Accepts the service-account JSON as-is or base64-encoded (handier in .env files). */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text) as Partial<ServiceAccount>;
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT must contain project_id, client_email and private_key');
  }
  return json as ServiceAccount;
}

export function createFcmSender(sa: ServiceAccount, fetchFn: FetchFn = fetch): PushSender {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const key = await importPKCS8(sa.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) throw new Error(`FCM auth failed with HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  return async (token, message) => {
    const res = await fetchFn(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: fcmMessage(token, message) }),
      },
    );
    if (res.ok) return 'ok';
    // Uninstalled app / expired token: FCM answers 404 UNREGISTERED (or 400 for malformed tokens).
    const detail = await res.text();
    if (res.status === 404 || /UNREGISTERED|registration token/i.test(detail)) {
      return 'invalid-token';
    }
    return 'error';
  };
}
