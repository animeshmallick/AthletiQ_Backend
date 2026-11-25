import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { apiPerf, fundTxns, users } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  cached,
  cacheGeneration,
  cacheGet,
  cacheSet,
  clearCache,
  setCacheEnabled,
} from '../../src/lib/memory-cache';
import { flushPerf, recordPerf } from '../../src/modules/activity/perf-log';
import { percentile } from '../../src/modules/activity/perf.routes';
import { as, makeAcademy, makeUser, setToday } from '../helpers/factories';

afterEach(() => setCacheEnabled(false));

describe('memory cache', () => {
  it('never keeps a value read before a change, and expires', async () => {
    setCacheEnabled(true);
    const before = cacheGeneration();
    clearCache(); // someone changed something while it was being read
    cacheSet('a', 1, 1000, before);
    expect(cacheGet('a')).toBeUndefined();
    let reads = 0;
    const read = () => cached('b', 1000, async () => ++reads);
    expect([await read(), await read()]).toEqual([1, 1]);
    clearCache();
    expect(await read()).toBe(2);
    cacheSet('c', 1, -1, cacheGeneration());
    expect(cacheGet('c')).toBeUndefined();
  });

  it('serves lists from memory, fresh after any edit, and apart per person', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    setCacheEnabled(true);
    const admin = await as(a.admin);
    const names = async () =>
      (await admin.get('/api/v1/locations').expect(200)).body.data.map(
        (l: { name: string }) => l.name,
      );
    const first = await names();
    // Changed elsewhere: memory still answers (for up to a minute)…
    const { locations } = await import('../../src/db/schema');
    await db.update(locations).set({ name: 'Elsewhere' });
    expect(await names()).toEqual(first);
    // …until anyone changes anything through the app.
    await admin.patch(`/api/v1/locations/${a.location.id}`, { name: 'New ground' }).expect(200);
    expect(await names()).toEqual(['New ground']);
    // Coaches get their own list.
    const batches = async (u: typeof a.admin) =>
      (await (await as(u)).get('/api/v1/batches').expect(200)).body.data.length;
    expect(await batches(a.admin)).toBe(2);
    expect(await batches(a.coach)).toBe(1);
    expect(await batches(a.admin)).toBe(2);
    // Money is never kept.
    await admin.get('/api/v1/funds/overview?from=2026-03-01&to=2026-03-31').expect(200);
    const cash = async () =>
      (await admin.get('/api/v1/funds/overview?from=2026-03-01&to=2026-03-31')).body.data.balances
        .academyCash;
    expect(await cash()).toBe(0);
    await admin
      .post('/api/v1/funds/income', { title: 'Gala', amount: 500, occurredOn: '2026-03-16' })
      .expect(201);
    expect(await cash()).toBe(500);
    expect(await db.$count(fundTxns)).toBe(1);
  });

  it('signs a disabled person out at once', async () => {
    setToday('2026-03-16');
    const admin = await makeUser('admin');
    const coach = await makeUser('coach');
    setCacheEnabled(true);
    const coach$ = await as(coach);
    await coach$.get('/api/v1/batches').expect(200); // remembered
    const admin$ = await as(admin);
    await admin$.patch(`/api/v1/users/${coach.id}/status`, { status: 'disabled' });
    if ((await db.select().from(users).where(eq(users.id, coach.id)))[0]!.status !== 'disabled')
      await admin$.post(`/api/v1/users/${coach.id}/status`, { status: 'disabled' }).expect(200);
    await coach$.get('/api/v1/batches').expect(401);
  });
});

describe('app speed', () => {
  it('adds up calls by hour and route for admins', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    await flushPerf();
    await db.delete(apiPerf);
    const s = { queries: 4, dbMs: 80, cacheable: false, cacheHit: false };
    for (const ms of [40, 90, 150, 900])
      recordPerf('GET', '/api/v1/batches', 200, ms, { ...s, cacheable: true, cacheHit: ms === 40 });
    await flushPerf();
    recordPerf('GET', '/api/v1/batches', 500, 100, s); // same hour: added to it
    recordPerf('PUT', '/api/v1/attendance/session', 200, 600, { ...s, queries: 12 });
    await flushPerf();
    const admin = await as(a.admin);
    const r = (
      await admin.get('/api/v1/activity/performance?from=2026-03-16&to=2026-03-16').expect(200)
    ).body.data;
    expect(r.totals).toMatchObject({ n: 6, errors: 1, maxMs: 900, queryMs: 15, cacheRate: 25 });
    expect(r.by).toBe('hour');
    expect(r.series).toEqual([expect.objectContaining({ at: '2026-03-16 12:00', n: 6 })]);
    expect(r.slowest[0]).toMatchObject({ route: '/api/v1/batches', n: 5 });
    expect(r.spread.reduce((n: number, b: { n: number }) => n + b.n, 0)).toBe(6);
    const old = (
      await admin.get('/api/v1/activity/performance?from=2026-03-01&to=2026-03-10').expect(200)
    ).body.data;
    expect(old.totals).toMatchObject({ n: 0, p95Ms: 0, queryMs: null, cacheRate: null });
    await (
      await as(a.coach)
    )
      .get('/api/v1/activity/performance?from=2026-03-16&to=2026-03-16')
      .expect(403);
  });

  it('estimates percentiles from the buckets', () => {
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 0], 0.5, 0)).toBe(0);
    expect(percentile([10, 0, 0, 0, 0, 0, 0, 0], 0.5, 40)).toBe(20);
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 4], 0.95, 9000)).toBeGreaterThan(3200);
  });
});
