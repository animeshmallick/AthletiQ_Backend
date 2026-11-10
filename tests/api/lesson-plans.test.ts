import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { batches } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import { as, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

// makeAcademy's batch runs Mon–Sat, 06:00–08:00: 120-minute sessions.
const PLAN = [
  {
    name: 'Warm-up',
    color: '#22c55e',
    minutes: 20,
    drills: [
      { name: 'Jogging', minutes: 10, reps: '2 laps' },
      { name: 'Skipping', note: 'Keep the rhythm' },
    ],
  },
  { name: 'Ball drills', color: '#f59e0b', minutes: 80, drills: [{ name: 'Forehand drive' }] },
  { name: 'Cool down', minutes: 20 },
];

describe('batch lesson plans', () => {
  it('saves one plan per batch that must add up to the session length', async () => {
    setToday('2026-03-09');
    const { coach, admin, batch, otherCoach } = await makeAcademy();
    const api = await as(coach);

    const empty = await api.get(`/api/v1/lessons/batch-plan?batchId=${batch.id}`).expect(200);
    expect(empty.body.data).toMatchObject({
      plan: null,
      mismatch: null,
      canEdit: true,
      batch: { sessionMinutes: 120, minutesByDay: { '1': 120, '6': 120 } },
    });

    const short = await api
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN.slice(0, 2) })
      .expect(422);
    expect(short.body.error.message).toContain('add up to 100 min');
    await api
      .put('/api/v1/lessons/batch-plan', {
        batchId: batch.id,
        blocks: [{ name: 'Main', minutes: 120, drills: [{ name: 'Long', minutes: 121 }] }],
      })
      .expect(422);
    await api.put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: [] }).expect(400);

    const saved = await api
      .put('/api/v1/lessons/batch-plan', {
        batchId: batch.id,
        focus: 'Forehand',
        notes: 'Bring cones',
        blocks: PLAN,
      })
      .expect(200);
    expect(saved.body.data.plan).toMatchObject({
      focus: 'Forehand',
      totalMinutes: 120,
      updatedBy: { id: coach.id },
      blocks: [
        {
          name: 'Warm-up',
          drills: [
            { name: 'Jogging', minutes: 10, reps: '2 laps', note: null },
            { name: 'Skipping', minutes: null, note: 'Keep the rhythm' },
          ],
        },
        { name: 'Ball drills', minutes: 80 },
        { name: 'Cool down', color: null, drills: [] },
      ],
    });

    // Saving again replaces it (reordered).
    const again = await api
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: [...PLAN].reverse() })
      .expect(200);
    expect(again.body.data.plan.blocks.map((b: { name: string }) => b.name)).toEqual([
      'Cool down',
      'Ball drills',
      'Warm-up',
    ]);

    // Admins read; other coaches can't see it.
    const view = await (
      await as(admin)
    )
      .get(`/api/v1/lessons/batch-plan?batchId=${batch.id}`)
      .expect(200);
    expect(view.body.data.canEdit).toBe(false);
    await (
      await as(admin)
    )
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN })
      .expect(403);
    await (await as(otherCoach)).get(`/api/v1/lessons/batch-plan?batchId=${batch.id}`).expect(404);

    // A timing change: the plan stays but needs updating.
    await db.update(batches).set({ endTime: '07:30:00' }).where(eq(batches.id, batch.id));
    const stale = await api.get(`/api/v1/lessons/batch-plan?batchId=${batch.id}`).expect(200);
    expect(stale.body.data.mismatch).toContain('each session is 90 min');
    const ov = await api.get('/api/v1/lessons/overview').expect(200);
    expect(ov.body.data.batches.find((b: { id: string }) => b.id === batch.id)).toMatchObject({
      status: 'needs-update',
      totalMinutes: 120,
      sessionMinutes: 90,
      blocks: 3,
      drills: 3,
    });
  });

  it('refuses one plan when the batch days differ in length, naming them', async () => {
    const { coach, location } = await makeAcademy();
    const b = await makeBatch(coach.id, location.id, {
      weekdays: [1, 4],
      startTime: '18:30:00',
      endTime: '19:30:00',
      dayTimes: { '4': { start: '17:30', end: '19:00' } },
    });
    const api = await as(coach);
    const got = await api.get(`/api/v1/lessons/batch-plan?batchId=${b.id}`).expect(200);
    expect(got.body.data.batch).toMatchObject({
      sessionMinutes: null,
      minutesByDay: { '1': 60, '4': 90 },
    });
    const res = await api
      .put('/api/v1/lessons/batch-plan', { batchId: b.id, blocks: [{ name: 'Main', minutes: 60 }] })
      .expect(422);
    expect(res.body.error.message).toContain('Monday 60 min, Thursday 90 min');
  });

  it('copies a plan only to batches with the same session length', async () => {
    const { coach, location, batch, otherBatch } = await makeAcademy();
    const api = await as(coach);
    await api
      .post('/api/v1/lessons/batch-plan/copy', {
        fromBatchId: batch.id,
        toBatchIds: [otherBatch.id],
      })
      .expect(404); // no plan yet
    await api.put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN }).expect(200);
    const same = await makeBatch(coach.id, location.id);
    const shorter = await makeBatch(coach.id, location.id, { endTime: '07:00:00' });
    const taken = await makeBatch(coach.id, location.id);
    await api
      .put('/api/v1/lessons/batch-plan', {
        batchId: taken.id,
        blocks: [{ name: 'Own', minutes: 120 }],
      })
      .expect(200);

    const res = await api
      .post('/api/v1/lessons/batch-plan/copy', {
        fromBatchId: batch.id,
        toBatchIds: [same.id, shorter.id, taken.id, batch.id],
      })
      .expect(200);
    expect(res.body.data.copied).toEqual([same.id]);
    expect(res.body.data.skipped).toEqual([
      { batchId: shorter.id, reason: expect.stringContaining('each session is 60 min') },
      { batchId: taken.id, reason: 'Already has a plan' },
    ]);
    const copy = await api.get(`/api/v1/lessons/batch-plan?batchId=${same.id}`).expect(200);
    expect(copy.body.data.plan.blocks[0].drills).toHaveLength(2);

    const over = await api
      .post('/api/v1/lessons/batch-plan/copy', {
        fromBatchId: batch.id,
        toBatchIds: [taken.id],
        overwrite: true,
      })
      .expect(200);
    expect(over.body.data.copied).toEqual([taken.id]);
    // Another coach's batch is out of reach.
    await api
      .post('/api/v1/lessons/batch-plan/copy', {
        fromBatchId: batch.id,
        toBatchIds: [otherBatch.id],
      })
      .expect(404);
  });
});

describe('session plans', () => {
  it('follows the batch plan; a day can be adjusted to its exact length and reset', async () => {
    setToday('2026-03-09');
    const { coach, batch, admin } = await makeAcademy();
    const api = await as(coach);
    const day = `/api/v1/lessons/session?batchId=${batch.id}&date=2026-03-10`;

    expect((await api.get(day).expect(200)).body.data).toMatchObject({
      source: 'none',
      minutes: 120,
      blocks: [],
      canAdjust: true,
      lockedReason: null,
    });
    await api
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, focus: 'Serve', blocks: PLAN })
      .expect(200);
    const follows = (await api.get(day).expect(200)).body.data;
    expect(follows).toMatchObject({ source: 'batch', focus: 'Serve', totalMinutes: 120 });
    // Not filled in: blocks without drills, the batch plan's drills offered per block.
    expect(follows.blocks.every((b: { drills: unknown[] }) => b.drills.length === 0)).toBe(true);
    expect(follows.drillOptions['Warm-up'].map((d: { name: string }) => d.name)).toEqual([
      'Jogging',
      'Skipping',
    ]);

    const tweak = {
      batchId: batch.id,
      date: '2026-03-10',
      note: 'Match prep',
      blocks: [
        { name: 'Warm-up', minutes: 30 },
        { name: 'Matches', minutes: 90, drills: [{ name: 'Singles', reps: '3 games' }] },
      ],
    };
    await api
      .put('/api/v1/lessons/session', { ...tweak, blocks: tweak.blocks.slice(1) })
      .expect(422);
    await api.put('/api/v1/lessons/session', tweak).expect(204);
    await api.put('/api/v1/lessons/session', tweak).expect(204); // upsert
    expect((await api.get(day).expect(200)).body.data).toMatchObject({
      source: 'session',
      note: 'Match prep',
      blocks: [{ name: 'Warm-up' }, { name: 'Matches', drills: [{ reps: '3 games' }] }],
    });
    const ov = await api.get('/api/v1/lessons/overview').expect(200);
    expect(ov.body.data.batches[0]).toMatchObject({ status: 'ready', adjustedDays: 1 });

    // Not on a day off, nor a cancelled day.
    await api.put('/api/v1/lessons/session', { ...tweak, date: '2026-03-15' }).expect(422);
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-11', reason: 'Rain' })
      .expect(201);
    await api.put('/api/v1/lessons/session', { ...tweak, date: '2026-03-11' }).expect(422);

    // Admins look but don't adjust.
    const a$ = await as(admin);
    expect((await a$.get(day).expect(200)).body.data.canAdjust).toBe(false);
    await a$.put('/api/v1/lessons/session', tweak).expect(403);

    await api.delete(day).expect(204);
    expect((await api.get(day).expect(200)).body.data.source).toBe('batch');
  });

  it('lets a substitute adjust only the days they cover', async () => {
    setToday('2026-03-09', '00:30:00');
    const { batch, otherCoach, admin, coach } = await makeAcademy();
    await (
      await as(coach)
    )
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN })
      .expect(200);
    await (
      await as(admin)
    )
      .post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-10',
        toDate: '2026-03-10',
      })
      .expect(201);
    const sub$ = await as(otherCoach);
    const covered = await sub$
      .get(`/api/v1/lessons/session?batchId=${batch.id}&date=2026-03-10`)
      .expect(200);
    expect(covered.body.data).toMatchObject({ source: 'batch', canAdjust: true });
    await sub$
      .put('/api/v1/lessons/session', {
        batchId: batch.id,
        date: '2026-03-10',
        blocks: [{ name: 'Games', minutes: 120 }],
      })
      .expect(204);
    await sub$
      .put('/api/v1/lessons/session', {
        batchId: batch.id,
        date: '2026-03-12',
        blocks: [{ name: 'Games', minutes: 120 }],
      })
      .expect(404);
    // The batch plan stays the coach's.
    await sub$.put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN }).expect(404);
  });
});

describe('lesson plan to-dos', () => {
  it('asks to set up a plan, then to update it after a timing change', async () => {
    setToday('2026-03-09', '00:20:00'); // 05:50 IST
    const { coach, batch, admin, plan } = await makeAcademy();
    await makeStudent({ batchId: batch.id, feePlanId: plan.id }, admin.id);
    const me = { ...coach, role: 'coach' as const };
    const planTask = async () =>
      (await tasksFor(me, new Date())).items.find((t) => t.kind === 'lesson-plan');

    expect(await planTask()).toMatchObject({
      title: `Set up the lesson plan for ${batch.name}`,
      link: `/lesson-plans?batch=${batch.id}&plan=1`,
    });
    await (
      await as(coach)
    )
      .put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN })
      .expect(200);
    expect(await planTask()).toBeUndefined();

    await db.update(batches).set({ endTime: '07:00:00' }).where(eq(batches.id, batch.id));
    expect(await planTask()).toMatchObject({
      title: `Update the lesson plan for ${batch.name}`,
    });
  });
});

describe('lesson plan insights', () => {
  it('counts held sessions filled in per batch, the drills used and what is still open', async () => {
    setToday('2026-03-11'); // Wednesday
    const { coach, admin, batch, otherCoach } = await makeAcademy();
    const api = await as(coach);
    await api.put('/api/v1/lessons/batch-plan', { batchId: batch.id, blocks: PLAN }).expect(200);
    // Monday filled in; Tuesday cancelled; Wednesday not filled yet.
    await api
      .put('/api/v1/lessons/session', {
        batchId: batch.id,
        date: '2026-03-09',
        blocks: [
          { name: 'Warm-up', minutes: 20, drills: [{ name: 'Skipping' }, { name: 'Jogging' }] },
          { name: 'Ball drills', minutes: 100, drills: [{ name: 'skipping ' }] },
        ],
      })
      .expect(204);
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-10', reason: 'Rain' })
      .expect(201);

    const q = '?from=2026-03-09&to=2026-03-15';
    const ins = (await api.get(`/api/v1/lessons/insights${q}`).expect(200)).body.data;
    // Only up to today, and not the cancelled day.
    expect(ins.to).toBe('2026-03-11');
    expect(ins.totals).toMatchObject({ sessions: 2, filled: 1, rate: 0.5, drills: 2 });
    expect(ins.batches).toEqual([
      { id: batch.id, name: batch.name, sessions: 2, filled: 1, rate: 0.5 },
    ]);
    // "Skipping" twice (case and spaces don't matter).
    expect(ins.drills[0]).toMatchObject({ name: 'Skipping', sessions: 2, batches: 1 });
    expect(ins.blocks.map((b: { name: string }) => b.name)).toEqual(['Ball drills', 'Warm-up']);
    expect(ins.unfilled).toEqual([
      { batchId: batch.id, batchName: batch.name, date: '2026-03-11' },
    ]);
    expect(ins.weeks).toEqual([{ start: '2026-03-09', sessions: 2, filled: 1 }]);

    // Admins see every batch; another coach sees none of these.
    const all = (await (await as(admin)).get(`/api/v1/lessons/insights${q}`).expect(200)).body.data;
    expect(all.batches.map((b: { id: string }) => b.id)).toContain(batch.id);
    const other = (await (await as(otherCoach)).get(`/api/v1/lessons/insights${q}`).expect(200))
      .body.data;
    expect(other.batches.map((b: { id: string }) => b.id)).not.toContain(batch.id);
    await api.get('/api/v1/lessons/insights?from=2026-01-01&to=2026-12-31').expect(400);
  });
});
