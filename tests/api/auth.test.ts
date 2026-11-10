import { describe, expect, it } from '@jest/globals';
import { eq, isNotNull } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client';
import { auditLogs, sessions, users } from '../../src/db/schema';
import { as, getApp, makeUser, PASSWORD } from '../helpers/factories';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

function refreshCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('atq_rt='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0]!;
}

describe('POST /auth/login', () => {
  it('signs in with valid credentials and sets an httpOnly refresh cookie', async () => {
    const coach = await makeUser('coach', { withPassword: true, email: 'Coach@Example.com' });
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'coach@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.data.user).toMatchObject({
      id: coach.id,
      role: 'coach',
      email: 'Coach@Example.com',
    });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/atq_rt=.+; Path=\/api\/v1\/auth; Expires=.+; HttpOnly; SameSite=Lax/);

    const u = await db.query.users.findFirst({ where: eq(users.id, coach.id) });
    expect(u?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('returns the refresh token in the body for mobile clients', async () => {
    await makeUser('coach', { withPassword: true, email: 'm@example.com' });
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'm@example.com', password: PASSWORD })
      .expect(200);
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('uses one generic message for unknown email and wrong password', async () => {
    await makeUser('coach', { withPassword: true, email: 'c@example.com' });
    const a = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'x@example.com', password: 'whatever1' })
      .expect(401);
    const b = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'c@example.com', password: 'wrongpass1' })
      .expect(401);
    expect(a.body.error.message).toBe('Incorrect email or password');
    expect(b.body.error.message).toBe(a.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    await makeUser('coach', { withPassword: true, email: 'lock@example.com' });
    for (let i = 0; i < 5; i++) {
      await request(getApp())
        .post('/api/v1/auth/login')
        .send({ email: 'lock@example.com', password: 'wrongpass1' })
        .expect(401);
    }
    const locked = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'lock@example.com', password: PASSWORD })
      .expect(429);
    expect(locked.body.error.message).toMatch(/Too many failed attempts. Try again in 15 minutes/);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.locked'));
    expect(logs).toHaveLength(1);
  });

  it('refuses disabled accounts and invited users without a password', async () => {
    await makeUser('coach', { withPassword: true, email: 'off@example.com', status: 'disabled' });
    await makeUser('coach', { email: 'inv@example.com', status: 'invited' });
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'off@example.com', password: PASSWORD })
      .expect(403);
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'inv@example.com', password: PASSWORD })
      .expect(401);
  });

  it('validates input', async () => {
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'bad' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'email',
      'password',
    ]);
  });
});

describe('POST /auth/refresh', () => {
  async function login(email = 'r@example.com') {
    await makeUser('coach', { withPassword: true, email });
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    return refreshCookie(res);
  }

  it('rotates the refresh token', async () => {
    const cookie = await login();
    const res = await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set(XHR)
      .expect(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(res)).not.toBe(cookie);
  });

  it('requires the X-Requested-With header for cookie refresh (CSRF guard)', async () => {
    const cookie = await login();
    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(403);
  });

  it('detects reuse of a rotated token and revokes the whole session family', async () => {
    const first = await login();
    const second = refreshCookie(
      await request(getApp())
        .post('/api/v1/auth/refresh')
        .set('Cookie', first)
        .set(XHR)
        .expect(200),
    );

    // Replaying the old token well after it was rotated — e.g. stolen — kills every session in
    // the family.
    await db
      .update(sessions)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(isNotNull(sessions.revokedAt));
    const replay = await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('Cookie', first)
      .set(XHR)
      .expect(401);
    expect(replay.headers['set-cookie']?.[0]).toMatch(/atq_rt=;/);
    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', second).set(XHR).expect(401);
    const reuse = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.token_reuse'));
    expect(reuse).toHaveLength(1);
  });

  it('forgives the same token presented again within seconds (two tabs, a lost response)', async () => {
    const first = await login('g@example.com');
    const refresh = (cookie: string) =>
      request(getApp()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(XHR);
    const a = refreshCookie(await refresh(first).expect(200));
    // The other tab sent the old cookie at the same time: it gets its own new session.
    const b = refreshCookie(await refresh(first).expect(200));
    expect(b).not.toBe(a);
    // Both stay signed in, and nothing was flagged.
    await refresh(a).expect(200);
    await refresh(b).expect(200);
    const reuse = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.token_reuse'));
    expect(reuse).toHaveLength(0);
  });

  it('rejects missing, unknown and expired tokens', async () => {
    await request(getApp()).post('/api/v1/auth/refresh').set(XHR).expect(401);
    await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'atq_rt=nope')
      .set(XHR)
      .expect(401);
    const cookie = await login();
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(XHR).expect(401);
  });

  it('rejects refresh once the user is disabled', async () => {
    const cookie = await login('d@example.com');
    await db.update(users).set({ status: 'disabled' });
    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(XHR).expect(401);
  });

  it('supports body-based refresh and logout for mobile', async () => {
    await makeUser('coach', { withPassword: true, email: 'mob@example.com' });
    const login = await request(getApp())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'mob@example.com', password: PASSWORD });
    const rt = login.body.data.refreshToken as string;
    const refreshed = await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: rt })
      .expect(200);
    const rt2 = refreshed.body.data.refreshToken as string;
    expect(rt2).not.toBe(rt);
    await request(getApp())
      .post('/api/v1/auth/logout')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: rt2 })
      .expect(204);
    await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: rt2 })
      .expect(401);
    await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({})
      .expect(401);
  });
});

describe('logout and /me', () => {
  it('revokes the session and clears the cookie', async () => {
    await makeUser('coach', { withPassword: true, email: 'lo@example.com' });
    const cookie = refreshCookie(
      await request(getApp())
        .post('/api/v1/auth/login')
        .send({ email: 'lo@example.com', password: PASSWORD }),
    );
    const res = await request(getApp())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set(XHR)
      .expect(204);
    expect(res.headers['set-cookie']?.[0]).toMatch(/atq_rt=;/);
    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(XHR).expect(401);
    // Logging out without a token (or without the header) is a harmless no-op.
    await request(getApp()).post('/api/v1/auth/logout').expect(204);
  });

  it('returns the current user and rejects stale tokens', async () => {
    const coach = await makeUser('coach');
    const api = await as(coach);
    const me = await api.get('/api/v1/auth/me').expect(200);
    expect(me.body.data).toMatchObject({ id: coach.id, role: 'coach' });

    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, coach.id));
    await api.get('/api/v1/auth/me').expect(401);

    await request(getApp())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    await request(getApp()).get('/api/v1/auth/me').set('Authorization', 'Basic abc').expect(401);
  });
});

describe('invites, password resets and password change', () => {
  it('lets an invited coach accept the invite, set a password and sign in', async () => {
    const admin = await makeUser('admin');
    const created = await (
      await as(admin)
    )
      .post('/api/v1/users', { name: 'New Coach', email: 'new@example.com', phone: '9876543210' })
      .expect(201);
    const inviteUrl = created.body.data.inviteUrl as string;
    expect(inviteUrl).toMatch(/^https:\/\/app\.test\/accept-invite\?token=/);
    const token = new URL(inviteUrl).searchParams.get('token')!;

    const info = await request(getApp()).get('/api/v1/auth/invite').query({ token }).expect(200);
    expect(info.body.data).toMatchObject({ name: 'New Coach', email: 'new@example.com' });

    const accepted = await request(getApp())
      .post('/api/v1/auth/accept-invite')
      .send({ token, password: 'MyNewPass1' })
      .expect(200);
    expect(accepted.body.data.user.status).toBe('active');

    // Tokens are single use.
    await request(getApp())
      .post('/api/v1/auth/accept-invite')
      .send({ token, password: 'MyNewPass1' })
      .expect(400);
    await request(getApp()).get('/api/v1/auth/invite').query({ token }).expect(400);
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'new@example.com', password: 'MyNewPass1' })
      .expect(200);
  });

  it('issues reset links to active users and invalidates older links', async () => {
    const admin = await makeUser('admin');
    const coach = await makeUser('coach', { withPassword: true, email: 'reset@example.com' });
    const api = await as(admin);
    const first = await api.post(`/api/v1/users/${coach.id}/access-link`).expect(200);
    expect(first.body.data.type).toBe('password_reset');
    const second = await api.post(`/api/v1/users/${coach.id}/access-link`).expect(200);
    const t1 = new URL(first.body.data.url as string).searchParams.get('token')!;
    const t2 = new URL(second.body.data.url as string).searchParams.get('token')!;

    await request(getApp()).get('/api/v1/auth/password-reset').query({ token: t1 }).expect(400);
    await request(getApp()).get('/api/v1/auth/password-reset').query({ token: t2 }).expect(200);
    await request(getApp())
      .post('/api/v1/auth/reset-password')
      .send({ token: t2, password: 'Brand1New' })
      .expect(200);
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'reset@example.com', password: PASSWORD })
      .expect(401);
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'reset@example.com', password: 'Brand1New' })
      .expect(200);
  });

  it('blocks token flows for disabled users and expired tokens', async () => {
    const admin = await makeUser('admin');
    const coach = await makeUser('coach', { status: 'invited' });
    const link = await (await as(admin)).post(`/api/v1/users/${coach.id}/access-link`).expect(200);
    expect(link.body.data.type).toBe('invite');
    const token = new URL(link.body.data.url as string).searchParams.get('token')!;
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, coach.id));
    await request(getApp())
      .post('/api/v1/auth/accept-invite')
      .send({ token, password: 'Valid1Pass' })
      .expect(403);
  });

  it('changes password, keeps this device signed in and signs out others', async () => {
    const coach = await makeUser('coach', { withPassword: true, email: 'cp@example.com' });
    const other = refreshCookie(
      await request(getApp())
        .post('/api/v1/auth/login')
        .send({ email: 'cp@example.com', password: PASSWORD }),
    );
    const api = await as(coach);

    await api
      .post('/api/v1/auth/change-password', {
        currentPassword: 'wrong',
        newPassword: 'Another1Pass',
      })
      .expect(400);
    await api
      .post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })
      .expect(400);
    const res = await api
      .post('/api/v1/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'Another1Pass',
      })
      .expect(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', other).set(XHR).expect(401);
    // Old access token is invalid because the token version was bumped.
    await api.get('/api/v1/auth/me').expect(401);
  });
});
