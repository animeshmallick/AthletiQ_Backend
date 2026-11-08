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
