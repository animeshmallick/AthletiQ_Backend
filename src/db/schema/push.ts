import { index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, tz } from './_shared.js';
import { users } from './users.js';

export const devicePlatform = pgEnum('device_platform', ['android', 'ios', 'web']);

/**
 * Push notification targets (Firebase Cloud Messaging tokens), one row per installed app.
 * A token belongs to whoever signed in on that device most recently.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    platform: devicePlatform().notNull().default('android'),
    createdAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
  },
  (t) => [index('device_tokens_user_idx').on(t.userId)],
);

/**
 * Every scheduled/one-off alert is recorded under a unique key (e.g. "nocheckin:<batch>:<date>")
 * before it is sent, so nobody gets the same alert twice — even across restarts or servers.
 */
export const notificationLog = pgTable('notification_log', {
  key: text().primaryKey(),
  sentAt: tz().notNull().defaultNow(),
});

/**
 * The in-app notification inbox: every notification a person was sent, so nothing is lost when
 * it is swiped away on the phone (and people without push still see them). One row per person;
 * a newer notification with the same tag replaces an unread older one. Kept 60 days.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sessions | students | money | approvals | summaries */
    category: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    link: text(),
    tag: text(),
    readAt: tz(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId, t.readAt),
  ],
);
