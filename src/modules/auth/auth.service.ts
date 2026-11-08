import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import {
  INVITE_TOKEN_TTL_HOURS,
  LOGIN_LOCKOUT_MINUTES,
  MAX_FAILED_LOGINS,
  PASSWORD_RESET_TOKEN_TTL_HOURS,
} from '../../config/constants.js';
import { db, type DbOrTx } from '../../db/client.js';
import { authTokens, sessions, users } from '../../db/schema/index.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.service.js';
import type { PublicUser } from './auth.types.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';

type UserRow = typeof users.$inferSelect;

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const INVALID_CREDENTIALS = 'Incorrect email or password';

// ─── Sessions ────────────────────────────────────────────────────────────────

async function issueSession(
  user: UserRow,
  client: ClientInfo,
  familyId: string = randomUUID(),
  tx: DbOrTx = db,
): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const [row] = await tx
    .insert(sessions)
    .values({
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt,
      userAgent: client.userAgent?.slice(0, 300) ?? null,
      ipAddress: client.ip,
    })
    .returning({ id: sessions.id });
  return { sessionId: row!.id, refreshToken, expiresAt };
}

async function buildAuthResult(
  user: UserRow,
  session: { refreshToken: string; expiresAt: Date },
): Promise<AuthResult> {
  const { token, expiresIn } = await signAccessToken({
    sub: user.id,
    role: user.role,
    tv: user.tokenVersion,
  });
  return {
    user: toPublicUser(user),
    accessToken: token,
    accessTokenExpiresIn: expiresIn,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
  };
}

// ─── Login / refresh / logout ────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
  client: ClientInfo,
): Promise<AuthResult> {
  const user = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${email.toLowerCase()}`,
  });

  if (!user?.passwordHash) {
    await verifyPassword(await getDummyHash(), password); // equalise timing
    throw AppError.unauthenticated(INVALID_CREDENTIALS);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(
      'RATE_LIMITED',
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db
      .update(users)
      .set({
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    if (lock) {
      await audit({
        actorId: user.id,
        action: 'auth.locked',
        entityType: 'user',
        entityId: user.id,
        ipAddress: client.ip,
      });
    }
    throw AppError.unauthenticated(INVALID_CREDENTIALS);
  }

  if (user.status === 'disabled') {
    throw AppError.forbidden('Your account has been disabled. Please contact your administrator.');
  }

  const [updated] = await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();

  const session = await issueSession(updated!, client);
  await audit({
    actorId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    ipAddress: client.ip,
  });
  return buildAuthResult(updated!, session);
}

/**
 * Rotates a refresh token. If a token that was already rotated is presented again, the whole
 * session family is revoked — someone is replaying a stolen token.
 */
export async function refresh(refreshToken: string, client: ClientInfo): Promise<AuthResult> {
  const tokenHash = sha256(refreshToken);
  const expired = () => AppError.unauthenticated('Session expired. Please sign in again.');

  const outcome = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .for('update');

    if (!session) return { kind: 'invalid' as const };

    if (session.revokedAt) {
      // A rotated token presented again means it was copied: revoke the family (committed below,
      // outside this transaction, so the revocation is not rolled back by the error response).
      return session.replacedById
        ? { kind: 'reuse' as const, session }
        : { kind: 'invalid' as const };
    }
    if (session.expiresAt <= new Date()) return { kind: 'invalid' as const };

    const user = await tx.query.users.findFirst({ where: eq(users.id, session.userId) });
    if (user?.status !== 'active') return { kind: 'invalid' as const };

    const next = await issueSession(user, client, session.familyId, tx);
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), replacedById: next.sessionId, lastUsedAt: new Date() })
      .where(eq(sessions.id, session.id));

    return { kind: 'ok' as const, result: await buildAuthResult(user, next) };
  });

  if (outcome.kind === 'ok') return outcome.result;

  if (outcome.kind === 'reuse') {
    const { session } = outcome;
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)));
    logger.warn(
      { userId: session.userId, familyId: session.familyId },
      'Refresh token reuse detected',
    );
    await audit({
      actorId: session.userId,
      action: 'auth.token_reuse',
      entityType: 'session',
      entityId: session.id,
      ipAddress: client.ip,
    });
  }
  throw expired();
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256(refreshToken)), isNull(sessions.revokedAt)));
}

/** Revokes every session and invalidates outstanding access tokens for a user. */
export async function revokeAllSessions(userId: string, tx: DbOrTx = db): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await tx
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
}

// ─── One-time tokens (invite / password reset) ───────────────────────────────

export async function createOneTimeToken(
  userId: string,
  type: 'invite' | 'password_reset',
  createdById: string | null,
  tx: DbOrTx = db,
): Promise<{ token: string; url: string; expiresAt: Date }> {
  // Invalidate earlier unused tokens of the same type.
  await tx
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.usedAt)),
    );

  const token = randomToken(32);
  const ttlHours = type === 'invite' ? INVITE_TOKEN_TTL_HOURS : PASSWORD_RESET_TOKEN_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await tx
    .insert(authTokens)
    .values({ userId, type, tokenHash: sha256(token), expiresAt, createdById });

  const path = type === 'invite' ? 'accept-invite' : 'reset-password';
  return { token, url: `${env.APP_URL}/${path}?token=${encodeURIComponent(token)}`, expiresAt };
}

/** Looks up a valid token without consuming it (lets the web app show who is accepting). */
export async function inspectOneTimeToken(token: string, type: 'invite' | 'password_reset') {
  const row = await db
    .select({ name: users.name, email: users.email, expiresAt: authTokens.expiresAt })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.tokenHash, sha256(token)),
        eq(authTokens.type, type),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row[0])
    throw AppError.badRequest('This link is invalid or has expired. Ask your admin for a new one.');
  return row[0];
}

/** Consumes an invite or reset token and sets the password. Signs the user in. */
export async function completeTokenFlow(
  token: string,
  type: 'invite' | 'password_reset',
  password: string,
  client: ClientInfo,
): Promise<AuthResult> {
  const passwordHash = await hashPassword(password);

  const user = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.type, type)))
      .for('update');

    if (!row || row.usedAt || row.expiresAt <= new Date()) {
      throw AppError.badRequest(
        'This link is invalid or has expired. Ask your admin for a new one.',
      );
    }

    const existing = await tx.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!existing || existing.status === 'disabled') {
      throw AppError.forbidden('This account is disabled. Please contact your administrator.');
    }

    await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
    await revokeAllSessions(row.userId, tx);
    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        status: 'active',
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, row.userId))
      .returning();

    await audit(
      {
        actorId: row.userId,
        action: type === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
        entityType: 'user',
        entityId: row.userId,
        ipAddress: client.ip,
      },
      tx,
    );
    return updated!;
  });

  const session = await issueSession(user, client);
  return buildAuthResult(user, session);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  client: ClientInfo,
): Promise<AuthResult> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.passwordHash) throw AppError.unauthenticated();
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError('VALIDATION_ERROR', 'Current password is incorrect', {
      fields: [{ path: 'currentPassword', message: 'Current password is incorrect' }],
    });
  }
  if (currentPassword === newPassword) {
    throw AppError.badRequest('New password must be different from the current one');
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await db.transaction(async (tx) => {
    await revokeAllSessions(userId, tx);
    const [u] = await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId))
      .returning();
    await audit(
      {
        actorId: userId,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: userId,
        ipAddress: client.ip,
      },
      tx,
    );
    return u!;
  });

  // Keep the current device signed in with a fresh session.
  const session = await issueSession(updated, client);
  return buildAuthResult(updated, session);
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.unauthenticated();
  return toPublicUser(user);
}
