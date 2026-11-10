import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Role } from '../modules/auth/auth.types.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

/**
 * Verifies the access token and re-checks the user in the database so that disabling a user or
 * changing their password takes effect immediately (not only after the token expires).
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = extractBearer(req);
  if (!token) throw AppError.unauthenticated();

  const claims = await verifyAccessToken(token);
  if (!claims) throw AppError.unauthenticated('Your session has expired');

  const [user] = await db
    .select({
      id: users.id,
      roles: users.roles,
      name: users.name,
      email: users.email,
      status: users.status,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  // The token's role must still be one the person holds (an admin may have removed it).
  if (
    user?.status !== 'active' ||
    user.tokenVersion !== claims.tv ||
    !user.roles.includes(claims.role)
  ) {
    throw AppError.unauthenticated('Your session has expired');
  }

  req.user = {
    id: user.id,
    role: claims.role,
    roles: user.roles,
    name: user.name,
    email: user.email,
  };
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw AppError.unauthenticated();
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireCoach = requireRole('coach');

/** Returns the authenticated user or throws (for use inside handlers after `requireAuth`). */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthenticated();
  return req.user;
}
