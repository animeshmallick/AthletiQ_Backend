import { describe, expect, it, jest } from '@jest/globals';
import { db } from '../../src/db/client';
import { clientEvents } from '../../src/db/schema';
import request from 'supertest';
import { fingerprintOf } from '../../src/modules/activity/client-events';
import { as, getApp, makeAcademy, setToday } from '../helpers/factories';

const crash = (over: Record<string, unknown> = {}) => ({
  kind: 'crash',
  message: 'Cannot read properties of undefined (reading map) at row 12',
  stack: 'TypeError: x\n    at Rows (https://www.edupilots.in/assets/index-AbC12345.js:10:20)',
  screen: '/students',
  appVersion: 'abc1234',
  platform: 'android',
  online: true,
  ...over,
});

describe('client events', () => {
  it('groups the same problem however its numbers vary', () => {
    const a = fingerprintOf({ kind: 'crash', message: 'Failed at row 12', stack: crash().stack });
    const b = fingerprintOf({
      kind: 'crash',
      message: 'Failed at row 99',
      stack: 'TypeError: x\n    at Rows (https://www.edupilots.in/assets/index-Zz998877.js:44:1)',
    });
    expect(a).toBe(b);
    expect(
      fingerprintOf({ kind: 'error', message: 'Failed at row 12', stack: crash().stack }),
    ).not.toBe(a);
    expect(
      fingerprintOf({
        kind: 'api',
        message: 'x',
        details: { method: 'GET', route: '/students/:id' },
      }),
    ).not.toBe(
      fingerprintOf({ kind: 'api', message: 'x', details: { method: 'GET', route: '/batches' } }),
    );
  });

  it('takes reports signed in or out and shows admins everything, coaches their own', async () => {
    setToday('2026-03-09');
    const { admin, coach } = await makeAcademy();
    const coach$ = await as(coach);
    // Signed out (e.g. a crash on the login screen).
    await request(getApp())
      .post('/api/v1/client-events')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ events: [crash({ screen: '/login', at: new Date().toISOString() })] })
      .expect(202);
    // Signed in: a crash twice (merged on the device), a freeze, an API failure while offline.
    await coach$
      .post('/api/v1/client-events', {
        events: [
          crash({
            count: 2,
            message: 'Cannot read properties of undefined (reading map) at row 40',
          }),
          {
            kind: 'freeze',
            message: 'App froze for 6.2s',
            screen: '/attendance',
            platform: 'web',
            details: { ms: 6200 },
          },
          { kind: 'console', message: 'Warning: list keys', platform: 'web' },
          {
            kind: 'reload',
            message: 'New version',
            platform: 'web',
            details: { reason: 'update' },
          },
          {
            kind: 'api',
            message: 'Could not reach the server',
            platform: 'pwa',
            online: false,
            details: { method: 'POST', route: '/attendance/session', status: 0, ms: 15000 },
          },
        ],
      })
      .expect(202);
    // Oversized and odd fields are trimmed, not rejected.
    await coach$
      .post('/api/v1/client-events', {
        events: [
          {
            kind: 'error',
            message: 'x'.repeat(5000),
            platform: 'toaster',
            details: { blob: 'y'.repeat(5000) },
          },
        ],
      })
      .expect(202);
    await coach$
      .post('/api/v1/client-events', { events: [{ kind: 'nope', message: 'x' }] })
      .expect(400);

    const range = '?from=2026-03-01&to=2026-03-31';
    const all = (await (await as(admin)).get(`/api/v1/client-events/insights${range}`).expect(200))
      .body.data;
    expect(all.scope).toBe('academy');
    expect(all.totals).toMatchObject({
      events: 8,
      crashes: 3,
      freezes: 1,
      api: 1,
      console: 1,
      reloads: 1,
      offline: 1,
      users: 1,
    });
    // Both crashes group together (only the row number differs), with the signed-out one.
    expect(all.groups[0]).toMatchObject({ kind: 'crash', n: 3, users: 1 });
    expect(all.groups[0].screens.sort()).toEqual(['/login', '/students']);
    expect(all.recent.find((e: { kind: string }) => e.kind === 'error').message).toHaveLength(500);
    expect(all.recent.find((e: { kind: string }) => e.kind === 'error').platform).toBe('web');
    expect(all.byKind.find((k: { kind: string }) => k.kind === 'crash').n).toBe(3);

    const mine = (await coach$.get(`/api/v1/client-events/insights${range}&kind=crash`).expect(200))
      .body.data;
    expect(mine.scope).toBe('self');
    expect(mine.totals.events).toBe(2); // not the signed-out one
    await coach$.get('/api/v1/client-events/insights?from=2026-01-01&to=2026-03-31').expect(400);
    await request(getApp()).get(`/api/v1/client-events/insights${range}`).expect(401);
  });

  it('ignores a bad session, distrusts a wrong device clock and clears old logs', async () => {
    setToday('2026-03-09');
    const { admin } = await makeAcademy();
    const old = new Date(Date.now() - 40 * 864e5);
    await db.insert(clientEvents).values({
      kind: 'error',
      fingerprint: 'old',
      message: 'Old one',
      platform: 'web',
      occurredAt: old,
      createdAt: old,
    });
    const random = jest.spyOn(Math, 'random').mockReturnValue(0); // run the clean-up this time
    await request(getApp())
      .post('/api/v1/client-events')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ events: [crash({ at: '2020-01-01T00:00:00Z' })] })
      .expect(202);
    random.mockRestore();
    const rows = await db.select().from(clientEvents);
    expect(rows.map((r) => r.fingerprint)).not.toContain('old');
    const [row] = rows;
    expect(row!.userId).toBeNull();
    // A clock years off is replaced by the time it arrived.
    expect(Math.abs(row!.occurredAt.getTime() - Date.now())).toBeLessThan(60_000);
    const view = (
      await (
        await as(admin)
      )
        .get('/api/v1/client-events/insights?from=2026-03-01&to=2026-03-31&platform=android')
        .expect(200)
    ).body.data;
    expect(view.byPlatform).toEqual([{ platform: 'android', n: 1 }]);
  });
});
