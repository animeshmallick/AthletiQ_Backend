import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authTokenType, id, timestamps, tz, userRole, userStatus } from './_shared.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    phone: text(),
    /** The role the user last signed in as (their default next time). Always one of `roles`. */
    lastRole: userRole().notNull(),
    /** Every role the person holds; someone can be both an admin and a coach. */
    roles: userRole().array().notNull(),
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
    index('users_last_role_idx').on(t.lastRole),
    // One account per person: a phone number belongs to one account only.
    uniqueIndex('users_phone_uq').on(t.phone),
    check('users_last_role_in_roles', sql`${t.lastRole} = any(${t.roles})`),
    // Coach, admin, or both — never empty and never the same role twice.
    check(
      'users_roles_valid',
      sql`cardinality(${t.roles}) between 1 and 2 and (cardinality(${t.roles}) = 1 or ${t.roles}[1] <> ${t.roles}[2])`,
    ),
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
    /** The role this sign-in is using (people with several roles switch between them). */
    role: userRole(),
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
