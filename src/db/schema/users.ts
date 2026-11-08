import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authTokenType, id, timestamps, tz, userRole, userStatus } from './_shared.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    phone: text(),
    role: userRole().notNull(),
    status: userStatus().notNull().default('invited'),
    /** Null until the user accepts their invite and sets a password. */
    passwordHash: text(),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: tz(),
    lastLoginAt: tz(),
    /** Bumped on password change / forced logout; embedded in access tokens. */
    tokenVersion: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    index('users_role_idx').on(t.role),
  ],
);

/**
 * Refresh-token sessions with rotation. Each refresh issues a new row in the same `familyId`;
 * presenting an already-rotated token revokes the whole family (token theft detection).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid().notNull(),
    tokenHash: text().notNull(),
    expiresAt: tz().notNull(),
    revokedAt: tz(),
    replacedById: uuid(),
    userAgent: text(),
    ipAddress: text(),
    lastUsedAt: tz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
  ],
);

/** One-time tokens for coach invitations and password resets (stored hashed). */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenType().notNull(),
    tokenHash: text().notNull(),
    expiresAt: tz().notNull(),
    usedAt: tz(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash),
    index('auth_tokens_user_type_idx').on(t.userId, t.type),
  ],
);
