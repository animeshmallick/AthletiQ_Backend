import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import type { Role } from './auth.types.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'athletiq-api';
const AUDIENCE = 'athletiq-clients';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  /** User token version; bumping it invalidates all outstanding access tokens. */
  tv: number;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = env.ACCESS_TOKEN_TTL_MINUTES * 60;
  const token = await new SignJWT({ role: claims.role, tv: claims.tv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(secret);
  return { token, expiresIn };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    if (payload.role !== 'admin' && payload.role !== 'coach') return null;
    if (typeof payload.tv !== 'number') return null;
    return { sub: payload.sub, role: payload.role, tv: payload.tv };
  } catch {
    return null;
  }
}
