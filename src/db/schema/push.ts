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
