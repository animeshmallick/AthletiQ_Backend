import { describe, expect, it } from '@jest/globals';
import { auditLogs, apiRequests } from '../../src/db/schema/index';
import { clearSummaryCache } from '../../src/modules/activity/activity.routes';
import { flushRequestLog } from '../../src/modules/activity/request-log';
import { as, makeAcademy, setToday } from '../helpers/factories';
import { db } from '../helpers/test-db';

/** An audit row at a given IST date and hour. */
const at = (date: string, hour: number) =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:30`);

async function seed() {
  setToday('2026-03-14', '06:00:00');
  clearSummaryCache();
  const a = await makeAcademy();
  await db.delete(auditLogs);
  await flushRequestLog(); // Earlier tests' queued entries, then start clean.
  await db.delete(apiRequests);
  await db.insert(auditLogs).values([
    // Previous week (for the comparison): 1 event.
    {
      actorId: a.admin.id,
      action: 'student.created',
      entityType: 'student',
      createdAt: at('2026-03-04', 10),
    },
    // This week: admin 3, coach 2.
    {
      actorId: a.admin.id,
      action: 'student.created',
      entityType: 'student',
      createdAt: at('2026-03-09', 10),
      metadata: { name: 'Asha' },
    },
    {
      actorId: a.admin.id,
      action: 'invoice.payment_reverted',
      entityType: 'invoice',
      createdAt: at('2026-03-09', 18),
      metadata: { reason: 'Duplicate' },
    },
    {
      actorId: a.admin.id,
      action: 'fee_plan.split_updated',
      entityType: 'fee_plan',
      createdAt: at('2026-03-10', 18),
    },
    {
      actorId: a.coach.id,
      action: 'attendance.saved',
      entityType: 'batch',
      createdAt: at('2026-03-10', 7),
    },
    {
      actorId: a.coach.id,
      action: 'invoice.payment_recorded',
      entityType: 'invoice',
      createdAt: at('2026-03-12', 7),
      metadata: { amount: 200000 },
    },
  ]);
  return { ...a, admin$: await as(a.admin), coach$: await as(a.coach) };
}

describe('activity log', () => {
  it('lists activity with filters; coaches only see their own', async () => {
    const { admin$, coach$, coach } = await seed();
    const all = (
      await admin$.get('/api/v1/activity/logs?from=2026-03-09&to=2026-03-15').expect(200)
    ).body;
    expect(all.meta.total).toBe(5);
    expect(all.data[0]).toMatchObject({
      action: 'invoice.payment_recorded',
      actor: { id: coach.id },
    });

    const mine = (await coach$.get('/api/v1/activity/logs').expect(200)).body;
    expect(mine.data.map((l: { actorId: string }) => l.actorId)).toEqual([coach.id, coach.id]);
    // A coach can't widen the scope by asking for someone else.
    const sneaky = (
      await coach$.get(`/api/v1/activity/logs?actorId=${coach.id.replace(/./, '0')}`).expect(200)
    ).body;
    expect(sneaky.meta.total).toBe(2);

    const search = (await admin$.get('/api/v1/activity/logs?search=Duplicate').expect(200)).body;
    expect(search.data.map((l: { action: string }) => l.action)).toEqual([
      'invoice.payment_reverted',
    ]);
    const sensitive = (await admin$.get('/api/v1/activity/logs?sensitive=true').expect(200)).body;
    expect(sensitive.data.map((l: { action: string }) => l.action).sort()).toEqual([
      'fee_plan.split_updated',
      'invoice.payment_reverted',
    ]);
  });

  it('summarises a period: volume, when, where, who and what to review', async () => {
    const { admin$, coach$, admin } = await seed();
    const d = (
      await admin$.get('/api/v1/activity/insights?from=2026-03-09&to=2026-03-15').expect(200)
    ).body.data;
    expect(d.totals).toMatchObject({
      events: 5,
      people: 2,
      sensitive: 2,
      activeDays: 3,
      previous: 1,
      change: 400,
    });
    expect(d.byDay).toHaveLength(7);
    expect(d.byDay[0]).toEqual({ date: '2026-03-09', n: 2 });
    expect(d.busiestDay).toEqual({ date: '2026-03-09', n: 2 });
    expect(d.byHour[18]).toBe(2);
    expect(d.byHour[7]).toBe(2);
    expect(d.byEntity[0]).toEqual({ entityType: 'invoice', n: 2 });
    expect(d.byActor[0]).toMatchObject({ id: admin.id, n: 3 });
    expect(d.notable).toHaveLength(2);

    const mine = (
      await coach$.get('/api/v1/activity/insights?from=2026-03-09&to=2026-03-15').expect(200)
    ).body.data;
    expect(mine.totals).toMatchObject({ events: 2, people: 1, sensitive: 0 });
    expect(mine.byActor).toEqual([]);
    await admin$.get('/api/v1/activity/insights?from=2026-03-15&to=2026-03-09').expect(400);
  });

  it('summarises the whole log on demand, scoped to the caller', async () => {
    const { admin$, coach$ } = await seed();
    const s = (await admin$.post('/api/v1/activity/summary', {}).expect(200)).body.data;
    expect(s.scope).toBe('academy');
    expect(s.totals).toMatchObject({ events: 6, people: 2, activeDays: 4, sensitive: 2 });
    expect(s.byMonth).toEqual([{ month: '2026-03', n: 6 }]);
    expect(s.topActions[0]).toEqual({ action: 'student.created', n: 2 });
    expect(s.highlights.join(' ')).toMatch(/6 actions by 2 people/);
    expect(s.errors).toEqual({ total: 0, server: 0, routes: 0 });

    const mine = (await coach$.post('/api/v1/activity/summary', {}).expect(200)).body.data;
    expect(mine).toMatchObject({ scope: 'self', errors: null, topActors: [] });
    expect(mine.totals.events).toBe(2);
  });

  it('records failed requests and summarises them for admins', async () => {
    const { admin$, coach$ } = await seed();
    await coach$.get('/api/v1/no-such-route').expect(404);
    await coach$.get('/api/v1/students/not-a-uuid').expect(400);
    await coach$.get('/api/v1/activity/errors?from=2026-03-01&to=2026-03-31').expect(403);
    // Recording happens off the request path; save what's queued.
    await flushRequestLog();

    const list = (
      await admin$.get('/api/v1/activity/errors?from=2026-03-01&to=2026-03-31').expect(200)
    ).body;
    expect(list.meta.total).toBe(3); // the two above plus the coach's 403
    expect(list.data.map((e: { status: number }) => e.status).sort()).toEqual([400, 403, 404]);
    expect(list.data.find((e: { status: number }) => e.status === 404)).toMatchObject({
      method: 'GET',
      route: '/api/v1/no-such-route',
      code: 'NOT_FOUND',
    });
    const client = (
      await admin$
        .get('/api/v1/activity/errors?from=2026-03-01&to=2026-03-31&kind=server')
        .expect(200)
    ).body;
    expect(client.meta.total).toBe(0);

    const ins = (
      await admin$.get('/api/v1/activity/errors/insights?from=2026-03-01&to=2026-03-31').expect(200)
    ).body.data;
    expect(ins.totals).toMatchObject({ total: 3, client: 3, server: 0, users: 1 });
    expect(ins.byStatus.map((s: { status: number }) => s.status).sort()).toEqual([400, 403, 404]);
    expect(ins.byRoute.length).toBeGreaterThanOrEqual(2);
    expect(ins.byDay).toHaveLength(31);
    // Hour of day for a one-day chart: 24 slots that add up to the total.
    expect(ins.byHour).toHaveLength(24);
    expect(ins.byHour.reduce((n: number, h: { n: number }) => n + h.n, 0)).toBe(3);
  });

  it('tracks every write and failure per person, off the request path', async () => {
    const { admin$, coach$, coach, batch } = await seed();
    await flushRequestLog();
    await db.delete(apiRequests);
    await coach$
      .put('/api/v1/lessons/batch-plan', {
        batchId: batch.id,
        blocks: [{ name: 'Main', minutes: 120 }],
      })
      .expect(200);
    await coach$
      .put('/api/v1/lessons/batch-plan', {
        batchId: batch.id,
        blocks: [{ name: 'Main', minutes: 30 }],
      })
      .expect(422);
    await coach$.get('/api/v1/batches').expect(200); // successful reads aren't stored
    await flushRequestLog();

    const mine = (
      await coach$
        .get('/api/v1/activity/requests/insights?from=2026-03-01&to=2026-03-31')
        .expect(200)
    ).body.data;
    expect(mine.totals).toMatchObject({ total: 2, writes: 2, failed: 1, people: 1 });
    expect(mine.byRoute[0]).toMatchObject({
      method: 'PUT',
      route: '/api/v1/lessons/batch-plan',
      n: 2,
      failed: 1,
    });
    expect(mine.byPerson).toEqual([]);

    const all = (
      await admin$
        .get('/api/v1/activity/requests/insights?from=2026-03-01&to=2026-03-31')
        .expect(200)
    ).body.data;
    expect(all.byPerson[0]).toMatchObject({ id: coach.id, n: 2, failed: 1 });
    const stream = (
      await admin$.get('/api/v1/activity/requests?from=2026-03-01&to=2026-03-31').expect(200)
    ).body;
    expect(stream.data.map((r: { status: number }) => r.status).sort()).toEqual([200, 422]);
    expect(stream.data.find((r: { status: number }) => r.status === 422)).toMatchObject({
      code: 'UNPROCESSABLE',
      user: { id: coach.id },
    });
    expect(typeof stream.data[0].durationMs).toBe('number');
  });
});

describe('activity within the last few hours', () => {
  it('filters to an exact start time and compares with the same length before', async () => {
    const a = await makeAcademy();
    const admin$ = await as(a.admin);
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    const log = (action: string, at: Date) =>
      db.insert(auditLogs).values({
        actorId: a.admin.id,
        action,
        entityType: 'invoice',
        entityId: a.batch.id,
        createdAt: at,
      });
    await log('invoice.shared', ago(1));
    await log('invoice.payment_recorded', ago(2));
    await log('invoice.cancelled', ago(5)); // the 3 hours before
    await log('student.updated', ago(30)); // outside both

    const since = ago(3).toISOString();
    // Dates as the API reads them (IST), so this holds around midnight too.
    const day = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
    const q = `from=${day(ago(3))}&to=${day(new Date())}&since=${encodeURIComponent(since)}`;
    const logs = (await admin$.get(`/api/v1/activity/logs?${q}`).expect(200)).body.data;
    expect(logs.map((l: { action: string }) => l.action).sort()).toEqual([
      'invoice.payment_recorded',
      'invoice.shared',
    ]);
    const ins = (await admin$.get(`/api/v1/activity/insights?${q}`).expect(200)).body.data;
    expect(ins.totals).toMatchObject({ events: 2, previous: 1 });
    // In 10-minute slices: 18 for 3 hours (plus the current, partial one), oldest first.
    const sliced = (await admin$.get(`/api/v1/activity/insights?${q}&bucket=10`).expect(200)).body
      .data;
    expect(sliced.byBucket.length).toBeGreaterThanOrEqual(18);
    expect(sliced.byBucket.length).toBeLessThanOrEqual(19);
    expect(sliced.byBucket.reduce((n: number, b: { n: number }) => n + b.n, 0)).toBe(2);
    expect(Date.parse(sliced.byBucket[1].at) - Date.parse(sliced.byBucket[0].at)).toBe(600_000);
    expect(ins.byBucket).toBeNull(); // no bucket asked for
    await admin$.get(`/api/v1/activity/insights?${q}&bucket=7`).expect(400);
    const errs = (await admin$.get(`/api/v1/activity/errors/insights?${q}&bucket=10`).expect(200))
      .body.data;
    expect(errs.byBucket.length).toBeGreaterThanOrEqual(18);
    await admin$.get('/api/v1/activity/logs?since=yesterday').expect(400);
  });
});

describe('request log noise', () => {
  it('skips expired access tokens (the app renews them) but keeps other failures', async () => {
    const a = await makeAcademy();
    await flushRequestLog();
    await db.delete(apiRequests);
    const app = (await import('../helpers/factories')).getApp();
    const request = (await import('supertest')).default;
    // An expired / garbled access token: routine, the client refreshes and retries.
    await request(app).get('/api/v1/batches').set('Authorization', 'Bearer expired').expect(401);
    // A real failure is still recorded.
    await (await as(a.coach)).get('/api/v1/users').expect(403);
    await flushRequestLog();
    const rows = await db.select().from(apiRequests);
    expect(rows.map((r) => r.status)).toEqual([403]);
  });
});
