import { describe, expect, it } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client';
import { users } from '../../src/db/schema';
import { as, getApp, makeBatch, makeLocation, makeUser, PASSWORD } from '../helpers/factories';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

function refreshCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('atq_rt='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0]!;
}

/** Signs in through the real login and returns the cookie and access token. */
async function signIn(email: string) {
  const res = await request(getApp())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    cookie: refreshCookie(res),
    token: res.body.data.accessToken as string,
    user: res.body.data.user as { role: string; roles: string[] },
  };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('one account, coach and/or admin', () => {
  it('lets an admin who also coaches switch roles, and remembers the last one', async () => {
    const owner = await makeUser('admin');
    await makeUser('admin', {
      withPassword: true,
      email: 'both@example.com',
      roles: ['admin', 'coach'],
    });
    const app = getApp();

    // Signs in as the role they used last (admin).
    const first = await signIn('both@example.com');
    expect(first.user).toMatchObject({ role: 'admin', roles: ['admin', 'coach'] });
    await request(app).get('/api/v1/users').set(bearer(first.token)).expect(200);

    // Switch to coach: a new access token for the same sign-in; admin pages are now off limits.
    const switched = await request(app)
      .post('/api/v1/auth/switch-role')
      .set('Cookie', first.cookie)
      .set(XHR)
      .send({ role: 'coach' })
      .expect(200);
    const coachToken = switched.body.data.accessToken as string;
    expect(switched.body.data.user).toMatchObject({ role: 'coach', roles: ['admin', 'coach'] });
    await request(app).get('/api/v1/users').set(bearer(coachToken)).expect(403);
    const me = await request(app).get('/api/v1/auth/me').set(bearer(coachToken)).expect(200);
    expect(me.body.data.role).toBe('coach');

    // Refreshing keeps the coach role; signing in again opens in coach too.
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', first.cookie)
      .set(XHR)
      .expect(200);
    expect(refreshed.body.data.user.role).toBe('coach');
    expect((await signIn('both@example.com')).user.role).toBe('coach');

    // A role they don't hold can't be picked.
    const coachOnly = await makeUser('coach', { withPassword: true, email: 'c@example.com' });
    const c = await signIn('c@example.com');
    await request(app)
      .post('/api/v1/auth/switch-role')
      .set('Cookie', c.cookie)
      .set(XHR)
      .send({ role: 'admin' })
      .expect(403);
    await request(app)
      .post('/api/v1/auth/switch-role')
      .set('Cookie', c.cookie)
      .send({ role: 'coach' })
      .expect(403); // cookie calls need the CSRF header
    await request(app)
      .post('/api/v1/auth/switch-role')
      .set(XHR)
      .send({ role: 'coach' })
      .expect(401);
    expect(coachOnly.roles).toEqual(['coach']);
    expect(owner.roles).toEqual(['admin']);
  });

  it('lists and assigns a two-role person as a coach whichever role they used last', async () => {
    const admin = await makeUser('admin');
    const both = await makeUser('admin', { roles: ['admin', 'coach'] });
    const api = await as(admin);
    const coaches = await api.get('/api/v1/users?role=coach').expect(200);
    expect(coaches.body.data.map((u: { id: string }) => u.id)).toContain(both.id);
    // A batch can be given to them as its coach.
    const loc = await makeLocation();
    const batch = await makeBatch(both.id, loc.id);
    expect(batch.coachId).toBe(both.id);
  });

  it('manages roles: coach, admin or both — never none, never twice', async () => {
    const admin = await makeUser('admin');
    const api = await as(admin);
    const invited = await api
      .post('/api/v1/users', {
        name: 'Shubham',
        email: 'shubham@example.com',
        roles: ['coach', 'admin'],
      })
      .expect(201);
    // Stored in a fixed order.
    expect(invited.body.data.user.roles).toEqual(['admin', 'coach']);
    const id = invited.body.data.user.id as string;

    await api.patch(`/api/v1/users/${id}`, { roles: [] }).expect(400);
    await api.patch(`/api/v1/users/${id}`, { roles: ['coach', 'coach'] }).expect(400);
    await api.patch(`/api/v1/users/${id}`, { roles: ['owner'] }).expect(400);
    const coachOnly = await api.patch(`/api/v1/users/${id}`, { roles: ['coach'] }).expect(200);
    expect(coachOnly.body.data).toMatchObject({ roles: ['coach'], role: 'coach' });

    // No admin can take away their own admin role.
    await api.patch(`/api/v1/users/${admin.id}`, { roles: ['coach'] }).expect(422);

    // The database refuses anything else too.
    await expect(
      db.execute(sql`update users set roles = '{coach,coach}' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update users set roles = '{}', role = 'coach' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update users set role = 'admin' where id = ${id}`), // not a role they hold
    ).rejects.toThrow();
  });

  it('allows one account per phone number', async () => {
    const admin = await makeUser('admin');
    const api = await as(admin);
    await api
      .post('/api/v1/users', { name: 'A', email: 'a@example.com', phone: '9876543210' })
      .expect(201);
    const dup = await api
      .post('/api/v1/users', { name: 'B', email: 'b@example.com', phone: '+91 98765 43210' })
      .expect(409);
    expect(dup.body.error.message).toBe('Another account already uses this phone number');
  });

  it('keeps sign-ins from before roles existed working, now with both roles', async () => {
    await makeUser('coach', { withPassword: true, email: 'old@example.com' });
    const s = await signIn('old@example.com');
    // As if signed in before this change: no role on the session, and given admin later.
    await db.execute(sql`update sessions set role = null`);
    await db.execute(sql`update users set roles = '{admin,coach}' where email = 'old@example.com'`);
    const next = await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('Cookie', s.cookie)
      .set(XHR)
      .expect(200);
    // Opens in the role they used last (coach), and the app learns they also hold admin.
    expect(next.body.data.user).toMatchObject({ role: 'coach', roles: ['admin', 'coach'] });
    const switched = await request(getApp())
      .post('/api/v1/auth/switch-role')
      .set('Cookie', refreshCookie(next))
      .set(XHR)
      .send({ role: 'admin' })
      .expect(200);
    expect(switched.body.data.user.role).toBe('admin');
  });

  it('moves a signed-in session off a role that was taken away', async () => {
    const admin = await makeUser('admin');
    await makeUser('admin', {
      withPassword: true,
      email: 'two@example.com',
      roles: ['admin', 'coach'],
      role: 'coach',
    });
    const s = await signIn('two@example.com');
    expect(s.user.role).toBe('coach');
    const [row] = await db.select().from(users).where(eq(users.email, 'two@example.com'));
    await (await as(admin)).patch(`/api/v1/users/${row!.id}`, { roles: ['admin'] }).expect(200);
    // The coach token no longer works…
    await request(getApp()).get('/api/v1/auth/me').set(bearer(s.token)).expect(401);
    // …and the next refresh carries on as the role they still have.
    const next = await request(getApp())
      .post('/api/v1/auth/refresh')
      .set('Cookie', s.cookie)
      .set(XHR)
      .expect(200);
    expect(next.body.data.user).toMatchObject({ role: 'admin', roles: ['admin'] });
  });
});
