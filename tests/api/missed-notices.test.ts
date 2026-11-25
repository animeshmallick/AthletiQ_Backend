import { describe, expect, it } from '@jest/globals';
import { sendMissedNotices } from '../../src/jobs/missed-notices';
import { runInvoiceJob, safely } from '../../src/jobs/invoice-job';
import { db } from '../../src/db/client';
import { notifications } from '../../src/db/schema';
import {
  as,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

async function setup() {
  setToday('2026-03-01');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const ground = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3 });
  const batch = await makeBatch(coach.id, ground.id, {
    name: 'Main',
    weekdays: [1, 3, 5],
    feePlanId: plan.id,
    courseMonths: 1,
    courseSetOn: '2026-03-01',
  });
  await makeStudent({ batchId: batch.id, joiningDate: '2026-03-02' }, admin.id);
  return { admin, batch };
}
const titles = async () => (await db.select().from(notifications)).map((n) => n.title);

describe('missed-session notices', () => {
  it('tells admins once about unconfirmed sessions, 30 days passed and cycles ending with sessions owed', async () => {
    const { batch, admin } = await setup();
    setToday('2026-03-03');
    expect((await sendMissedNotices()).sent).toBe(1); // Mon 2 Mar: nobody checked in
    expect((await sendMissedNotices()).sent).toBe(0);
    expect(await titles()).toContainEqual(expect.stringContaining('missed or held?'));
    const r = await (
      await as(admin)
    ).post('/api/v1/session-changes/missed/confirm', {
      batchId: batch.id,
      date: '2026-03-02',
    });
    expect(r.status).toBe(200);

    setToday('2026-04-02'); // cycle 2 Mar–1 Apr is over, and 30 days passed
    await runInvoiceJob('schedule');
    const all = await titles();
    expect(all).toContainEqual(
      expect.stringContaining('a cycle ended with sessions to reschedule'),
    );
    expect(all).toHaveLength(new Set(all).size);
    setToday('2026-04-03');
    await sendMissedNotices();
    expect(await titles()).toContainEqual(expect.stringContaining('not made up in 30 days'));
  });

  it('marks a missed bonus session as optional', async () => {
    const { batch, admin } = await setup();
    setToday('2026-03-03');
    const confirm = { batchId: batch.id, date: '2026-03-02' };
    await (await as(admin)).post('/api/v1/session-changes/missed/confirm', confirm);
    const one = await (await as(admin)).get('/api/v1/session-changes/missed');
    // 2 Mar–1 Apr has 14 sessions and the count is 12: one missed leaves 13.
    expect(one.body.data.open[0]).toMatchObject({ date: '2026-03-02', optional: true });
    setToday('2026-03-07');
    for (const date of ['2026-03-04', '2026-03-06'])
      await (
        await as(admin)
      ).post('/api/v1/session-changes/missed/confirm', { batchId: batch.id, date });
    const three = await (await as(admin)).get('/api/v1/session-changes/missed');
    expect(three.body.data.open.map((m: { optional: boolean }) => m.optional)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('nightly job', () => {
  it('carries on when a step around invoicing fails', async () => {
    expect(await safely('x', () => Promise.reject(new Error('boom')))).toEqual({
      error: 'Error: boom',
    });
    expect(await safely('x', () => Promise.resolve(1))).toBe(1);
  });
});

describe('planned leaving', () => {
  it('can be called off in a batch without a course', async () => {
    setToday('2026-03-01');
    const admin = await makeUser('admin');
    const coach = await makeUser('coach');
    const ground = await makeLocation();
    const plan = await makePlan();
    const b = await makeBatch(coach.id, ground.id, { feePlanId: plan.id, courseMonths: null });
    const s = await makeStudent({ batchId: b.id, joiningDate: '2026-03-01' }, admin.id);
    const api = await as(admin);
    await api
      .post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-20', reason: 'Moving' })
      .expect(200);
    const m = (await api.get(`/api/v1/students/${s.id}`)).body.data.memberships[0];
    expect(m.plannedEndOn).toBe('2026-03-20');
    await api.post(`/api/v1/renewals/${m.enrollmentId}/stop`, { reason: 'No cycle' }).expect(404);
    await api.post(`/api/v1/renewals/${m.enrollmentId}/restore`).expect(200);
    const after = (await api.get(`/api/v1/students/${s.id}`)).body.data;
    expect(after.memberships[0].plannedEndOn).toBeNull();
    expect(after.status).toBe('active');
  });
});
