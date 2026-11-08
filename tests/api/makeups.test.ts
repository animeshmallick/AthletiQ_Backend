import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batches, deviceTokens, makeupSessions, sessionCancellations } from '../../src/db/schema';
import type { PushMessage, PushSender } from '../../src/modules/push/fcm';
import { setPushSender } from '../../src/modules/push/push.service';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

const ZERO_ID = '00000000-0000-4000-8000-000000000000';

function capture() {
  const sent: { token: string; message: PushMessage }[] = [];
  const send: PushSender = async (token, message) => {
    sent.push({ token, message });
    return 'ok';
  };
  setPushSender(send);
  return sent;
}

/** Waits for background notifications to flush. */
const settle = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => setPushSender(null));

async function setup() {
  setToday('2026-03-01');
  const a = await makeAcademy();
  const student = await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-01-10' },
    a.admin.id,
  );
  const pending = async (date: string, extra: Partial<typeof makeupSessions.$inferInsert> = {}) => {
    const [m] = await db
      .insert(makeupSessions)
      .values({
        studentId: student.id,
        batchId: a.batch.id,
        date,
        status: 'pending',
        createdById: a.coach.id,
        ...extra,
      })
      .returning();
    return m!;
  };
  return { ...a, student, pending, adminApi: await as(a.admin) };
}

describe('makeup review', () => {
  it('lists every status with ?status=all, newest request first', async () => {
    const s = await setup();
    const p = await s.pending('2026-03-10');
    const done = await s.pending('2026-03-12', { status: 'approved' });
    const all = await s.adminApi.get('/api/v1/makeups?status=all').expect(200);
    expect(all.body.data.map((m: { id: string }) => m.id).sort()).toEqual([p.id, done.id].sort());
    const pendingOnly = await s.adminApi.get('/api/v1/makeups').expect(200);
    expect(pendingOnly.body.data.map((m: { id: string }) => m.id)).toEqual([p.id]);
    await s.adminApi.get('/api/v1/makeups?status=bogus').expect(400);
  });

  it('reports unknown and already-reviewed requests', async () => {
    const s = await setup();
    await s.adminApi.post(`/api/v1/makeups/${ZERO_ID}/approve`).expect(404);
    await s.adminApi
      .post(`/api/v1/makeups/${ZERO_ID}/reject`, { reason: 'Not possible' })
      .expect(404);
    await s.adminApi.post('/api/v1/makeups/not-a-uuid/approve').expect(400);
    const r = await s.pending('2026-03-10', { status: 'rejected' });
    const res = await s.adminApi.post(`/api/v1/makeups/${r.id}/approve`).expect(409);
    expect(res.body.error.message).toBe('This request was already rejected');
  });

  it('refuses to approve past, inactive or cancelled sessions', async () => {
    const s = await setup();
    const past = await s.pending('2026-02-20');
    expect(
      (await s.adminApi.post(`/api/v1/makeups/${past.id}/approve`).expect(422)).body.error.message,
    ).toBe('This session date has already passed');

    const cancelledDay = await s.pending('2026-03-11');
    await db
      .insert(sessionCancellations)
      .values({ batchId: s.batch.id, date: '2026-03-11', reason: 'Rain' });
    expect(
      (await s.adminApi.post(`/api/v1/makeups/${cancelledDay.id}/approve`).expect(422)).body.error
        .message,
    ).toBe('That session was cancelled (Rain)');

    const inactive = await s.pending('2026-03-12');
    await db.update(batches).set({ isActive: false }).where(eq(batches.id, s.batch.id));
    expect(
      (await s.adminApi.post(`/api/v1/makeups/${inactive.id}/approve`).expect(422)).body.error
        .message,
    ).toBe('That batch is no longer active');
  });

  it('notifies the requesting coach on approval and rejection', async () => {
    const s = await setup();
    const sent = capture();
    await db
      .insert(deviceTokens)
      .values({ userId: s.coach.id, token: 'coach-token-xxxxxxxxxxxxxxxx' });
    const a = await s.pending('2026-03-02'); // tomorrow
    const r = await s.pending('2026-03-03');
    await s.adminApi.post(`/api/v1/makeups/${a.id}/approve`).expect(200);
    await s.adminApi
      .post(`/api/v1/makeups/${r.id}/reject`, { reason: 'Batch is full' })
      .expect(200);
    await settle();
    const titles = sent.map((x) => x.message.title);
    expect(titles).toEqual(expect.arrayContaining(['Makeup approved', 'Makeup not approved']));
    const approved = sent.find((x) => x.message.title === 'Makeup approved')!;
    expect(approved.message.body).toContain('tomorrow');
    const rejected = sent.find((x) => x.message.title === 'Makeup not approved')!;
    expect(rejected.message.body).toMatch(/ on Tuesday: Batch is full$/);
  });

  it('rejects requests whose requester no longer exists without notifying anyone', async () => {
    const s = await setup();
    const sent = capture();
    const m = await s.pending('2026-03-10', { createdById: null });
    const res = await s.adminApi
      .post(`/api/v1/makeups/${m.id}/reject`, { reason: 'Coach left' })
      .expect(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', reviewNote: 'Coach left' });
    await settle();
    expect(sent).toEqual([]);
  });

  it('approves requests whose requester no longer exists, telling the batch coach', async () => {
    const s = await setup();
    const sent = capture();
    await db
      .insert(deviceTokens)
      .values({ userId: s.coach.id, token: 'coach-token-yyyyyyyyyyyyyyyy' });
    const m = await s.pending('2026-03-10', { createdById: null });
    await s.adminApi.post(`/api/v1/makeups/${m.id}/approve`).expect(200);
    await settle();
    expect(sent.map((x) => x.message.title)).toEqual(['Makeup approved']);
  });
});
