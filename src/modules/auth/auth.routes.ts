import { Router, type CookieOptions, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../../config/constants.js';
import { AppError } from '../../lib/errors.js';
import { noContent, ok } from '../../lib/http.js';
import { parse, zEmail, zPassword } from '../../lib/validation.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import * as auth from './auth.service.js';

export const authRouter = Router();

/**
 * Clients:
 *  - Web: refresh token lives in an httpOnly cookie scoped to /api/v1/auth; access token in memory.
 *  - Mobile (send `X-Client-Type: mobile`): refresh token is returned in the body and sent back in
 *    the body of /auth/refresh and /auth/logout.
 */
function isMobile(req: Request): boolean {
  return req.get('x-client-type')?.toLowerCase() === 'mobile';
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_CROSS_SITE ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function client(req: Request): auth.ClientInfo {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

function sendAuth(req: Request, res: Response, result: auth.AuthResult) {
  const body = {
    user: result.user,
    accessToken: result.accessToken,
    accessTokenExpiresIn: result.accessTokenExpiresIn,
  };
  if (isMobile(req)) {
    return ok(res, {
      ...body,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
    });
  }
  res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    ...cookieOptions(),
    expires: result.refreshTokenExpiresAt,
  });
  return ok(res, body);
}

function readRefreshToken(req: Request): string | undefined {
  if (isMobile(req)) {
    const body = req.body as { refreshToken?: unknown } | undefined;
    return typeof body?.refreshToken === 'string' ? body.refreshToken : undefined;
  }
  // Cookie-based refresh requires a custom header: forces a CORS preflight, blocking CSRF.
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    throw AppError.forbidden('Missing X-Requested-With header');
  }
  const cookies = req.cookies as Record<string, string | undefined>;
  return cookies[REFRESH_COOKIE_NAME];
}

const LoginBody = z.object({
  email: zEmail,
  password: z.string().min(1, 'Password is required').max(128),
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = parse(LoginBody, req.body);
  sendAuth(req, res, await auth.login(email, password, client(req)));
});

authRouter.post('/refresh', async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) throw AppError.unauthenticated('Session expired. Please sign in again.');
  try {
    sendAuth(req, res, await auth.refresh(token, client(req)));
  } catch (err) {
    if (!isMobile(req)) res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  let token: string | undefined;
  try {
    token = readRefreshToken(req);
  } catch {
    token = undefined;
  }
  await auth.logout(token);
  if (!isMobile(req)) res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
  noContent(res);
});

authRouter.get('/me', requireAuth, async (req, res) => {
  ok(res, await auth.getMe(currentUser(req).id, currentUser(req).role));
});

const SwitchRoleBody = z.object({ role: z.enum(['admin', 'coach']) });

/** People with several roles (admin and coach) switch which one this sign-in uses. */
authRouter.post('/switch-role', async (req, res) => {
  const { role } = parse(SwitchRoleBody, req.body);
  const token = readRefreshToken(req);
  if (!token) throw AppError.unauthenticated('Session expired. Please sign in again.');
  sendAuth(req, res, await auth.switchRole(token, role, client(req)));
});

const TokenQuery = z.object({ token: z.string().min(10).max(200) });
const TokenPasswordBody = z.object({ token: z.string().min(10).max(200), password: zPassword });

authRouter.get('/invite', authLimiter, async (req, res) => {
  const { token } = parse(TokenQuery, req.query);
  ok(res, await auth.inspectOneTimeToken(token, 'invite'));
});

authRouter.post('/accept-invite', authLimiter, async (req, res) => {
  const { token, password } = parse(TokenPasswordBody, req.body);
  sendAuth(req, res, await auth.completeTokenFlow(token, 'invite', password, client(req)));
});

authRouter.get('/password-reset', authLimiter, async (req, res) => {
  const { token } = parse(TokenQuery, req.query);
  ok(res, await auth.inspectOneTimeToken(token, 'password_reset'));
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = parse(TokenPasswordBody, req.body);
  sendAuth(req, res, await auth.completeTokenFlow(token, 'password_reset', password, client(req)));
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: zPassword,
});

authRouter.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = parse(ChangePasswordBody, req.body);
  sendAuth(
    req,
    res,
    await auth.changePassword(
      currentUser(req).id,
      currentPassword,
      newPassword,
      client(req),
      currentUser(req).role,
    ),
  );
});
