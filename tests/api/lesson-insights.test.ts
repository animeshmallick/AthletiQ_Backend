import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, setToday } from '../helpers/factories';

describe('lesson planning insights', () => {
  async function setup() {
    setToday('2026-03-11'); // Wednesday
    const academy = await makeAcademy();
    const api = await as(academy.coach);
    const id = async (kind: 'stages' | 'events', name: string) =>
      (await api.post(`/api/v1/lessons/${kind}`, { name }).expect(201)).body.data.id as string;
    const s1 = await id('stages', 'Warm-up');
    const s2 = await id('stages', 'Main');
    const e1 = await id('events', 'Footwork');
    const e2 = await id('events', 'Serve');
    const e3 = await id('events', 'Smash');
    const b = academy.batch.id;
    const save = (date: string, stageIds: string[], eventIds: string[], cells: string[][]) =>
      api
        .put('/api/v1/lessons/plans/day', {
          batchId: b,
          date,
          stageIds,
          eventIds,
          cells: cells.map(([eventId, stageId]) => ({ eventId, stageId, content: 'Drill' })),
        })
        .expect(200);
    // Mon complete · Tue nothing (missed) · Wed today, nothing · Thu partial · Fri cancelled · Sat empty.
    await save(
      '2026-03-09',
      [s1],
      [e1, e2],
      [
        [e1, s1],
        [e2, s1],
      ],
    );
    await save('2026-03-12', [s1, s2], [e1], [[e1, s1]]);
    await save('2026-03-14', [s1], [e1], []);
    await api
      .post(`/api/v1/batches/${b}/cancellations`, { date: '2026-03-13', reason: 'Rain' })
      .expect(201);
    return { ...academy, api, s1, s2, e1, e2, e3 };
  }

  it('summarises coverage, the look-ahead and library usage', async () => {
    const { api, batch, s1, s2, e1, e2, e3 } = await setup();
    const res = await api.get('/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15').expect(200);
    const d = res.body.data;
    expect(d.today).toBe('2026-03-11');
    expect(d.totals).toMatchObject({
      sessions: 5,
      cancelled: 1,
      planned: 3,
      complete: 1,
      missed: 1,
      upcomingUnplanned: 9,
      fillRate: 0.6,
      avgEvents: 1.3,
      streak: 0,
    });
    expect(typeof d.totals.plannedAhead).toBe('number');
    expect(d.batches).toHaveLength(1);
    expect(d.batches[0]).toMatchObject({
      id: batch.id,
      sessions: 5,
      planned: 3,
      complete: 1,
      missed: 1,
      fillRate: 0.6,
      next: { date: '2026-03-11', status: 'unplanned', filled: 0, total: 0 },
    });
    expect(d.needsPlan).toHaveLength(11);
    expect(d.needsPlan.slice(0, 3)).toEqual([
      expect.objectContaining({ date: '2026-03-11', status: 'unplanned', batchId: batch.id }),
      expect.objectContaining({ date: '2026-03-12', status: 'partial' }),
      expect.objectContaining({ date: '2026-03-14', status: 'empty' }),
    ]);
    expect(d.weeks).toEqual([{ start: '2026-03-09', sessions: 5, planned: 3, complete: 1 }]);
    expect(d.events).toEqual([
      { id: e1, name: 'Footwork', plans: 3, cells: 2, lastUsed: '2026-03-14' },
      { id: e2, name: 'Serve', plans: 1, cells: 1, lastUsed: '2026-03-09' },
    ]);
    expect(d.stages).toEqual([
      expect.objectContaining({ id: s1, name: 'Warm-up', plans: 3, cells: 3 }),
      expect.objectContaining({ id: s2, name: 'Main', plans: 1, cells: 0 }),
    ]);
    expect(d.unusedEvents).toEqual([{ id: e3, name: 'Smash', lastUsed: null }]);

    // A later range: nothing used, so every drill shows when it was last run (up to today).
    const later = await api
      .get('/api/v1/lessons/insights?from=2026-03-16&to=2026-03-22')
      .expect(200);
    expect(later.body.data.events).toEqual([]);
    expect(later.body.data.totals).toMatchObject({ planned: 0, fillRate: null, avgEvents: null });
    expect(later.body.data.unusedEvents).toEqual(
      expect.arrayContaining([
        { id: e3, name: 'Smash', lastUsed: null },
        { id: e1, name: 'Footwork', lastUsed: '2026-03-09' },
      ]),
    );
  });

  it('counts the planning streak back from today', async () => {
    const { api, batch, s1, e1 } = await setup();
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-10',
        stageIds: [s1],
        eventIds: [e1],
        cells: [],
      })
      .expect(200);
    const res = await api.get('/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15').expect(200);
    // Today (unplanned) doesn't break it; Tue and Mon were planned, Sat 7th was not.
    expect(res.body.data.batches[0].streak).toBe(2);
    expect(res.body.data.totals.streak).toBe(2);
  });

  it('scopes to the caller and validates the range', async () => {
    const { api, admin, coach, otherCoach, batch, otherBatch } = await setup();
    const other = await as(otherCoach);
    const mine = await other
      .get('/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15')
      .expect(200);
    expect(mine.body.data.batches.map((b: { id: string }) => b.id)).toEqual([otherBatch.id]);
    expect(mine.body.data.events).toEqual([]);
    const denied = await other.get(
      `/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15&batchId=${batch.id}`,
    );
    expect(denied.status).toBeGreaterThanOrEqual(403);
    await api.get('/api/v1/lessons/insights?from=2026-03-09&to=2026-07-15').expect(400);
    await api.get('/api/v1/lessons/insights?from=2026-03-15&to=2026-03-09').expect(400);

    const adminApi = await as(admin);
    const byCoach = await adminApi
      .get(`/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15&coachId=${coach.id}`)
      .expect(200);
    expect(byCoach.body.data.batches.map((b: { id: string }) => b.id)).toEqual([batch.id]);
    expect(byCoach.body.data.unusedEvents).toHaveLength(1);
    const all = await adminApi
      .get('/api/v1/lessons/insights?from=2026-03-09&to=2026-03-15')
      .expect(200);
    expect(all.body.data.batches.length).toBeGreaterThanOrEqual(2);
    expect(all.body.data.unusedEvents).toBeNull();
  });

  it('tells the day view which earlier plan to start from', async () => {
    const { api, batch } = await setup();
    const day = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-12`)
      .expect(200);
    expect(day.body.data.previousPlanDate).toBe('2026-03-09');
    const first = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-09`)
      .expect(200);
    expect(first.body.data.previousPlanDate).toBeNull();
  });
});
