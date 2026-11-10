import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client';
import { deviceTokens, sessionCancellations } from '../../src/db/schema';
import { clock, sendSessionReminders } from '../../src/jobs/session-reminders';
import type { PushMessage, PushSender } from '../../src/modules/push/fcm';
import {
  notifyAdmins,
  notifyInBackground,
  notifyUsers,
  setPushSender,
} from '../../src/modules/push/push.service';
import { as, getApp, makeAcademy, makeBatch, makeUser, setToday } from '../helpers/factories';

const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb';
const MON = '2026-03-09';

/** Records every push; tokens listed in `dead` report as uninstalled. */
function fakeSender(dead: string[] = []) {
  const sent: { token: string; message: PushMessage }[] = [];
  const send: PushSender = async (token, message) => {
    if (token === 'boom-token-xxxxxxxxxxxxxxxxxxxx') throw new Error('network');
    if (dead.includes(token)) return 'invalid-token';
    sent.push({ token, message });
    return 'ok';
  };
  setPushSender(send);
  return sent;
}

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for push');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => setPushSender(null));

describe('device registration', () => {
  it('registers, re-assigns on a new sign-in and unregisters devices', async () => {
    const coach = await makeUser('coach');
    const other = await makeUser('coach');
    const res = await (
      await as(coach)
    )
      .post('/api/v1/me/devices', { token: TOKEN_A, platform: 'android' })
      .expect(200);
    expect(res.body.data).toEqual({ registered: true, pushEnabled: false });

    // Same phone, different person signs in: the token follows the new user.
    await (await as(other)).post('/api/v1/me/devices', { token: TOKEN_A }).expect(200);
    const rows = await db.select().from(deviceTokens);
    expect(rows).toEqual([expect.objectContaining({ userId: other.id, token: TOKEN_A })]);

    // Only the owner can remove it.
    await (await as(coach)).delete('/api/v1/me/devices').send({ token: TOKEN_A }).expect(204);
    expect(await db.select().from(deviceTokens)).toHaveLength(1);
    await (await as(other)).delete('/api/v1/me/devices').send({ token: TOKEN_A }).expect(204);
    expect(await db.select().from(deviceTokens)).toHaveLength(0);
  });

  it('validates the token and requires sign-in', async () => {
    const coach = await makeUser('coach');
    await (await as(coach)).post('/api/v1/me/devices', { token: 'short' }).expect(400);
    await request(getApp()).post('/api/v1/me/devices').send({ token: TOKEN_A }).expect(401);
  });
});

describe('sending', () => {
  it('delivers to every device and prunes uninstalled ones', async () => {
    const sent = fakeSender([TOKEN_B]);
    const coach = await makeUser('coach');
    const api = await as(coach);
    await api.post('/api/v1/me/devices', { token: TOKEN_A }).expect(200);
    await api.post('/api/v1/me/devices', { token: TOKEN_B }).expect(200);
    await api.post('/api/v1/me/devices', { token: 'boom-token-xxxxxxxxxxxxxxxxxxxx' }).expect(200);

    const result = await notifyUsers([coach.id, coach.id], {
      category: 'students',
      title: 'Hi',
      body: 'There',
    });
    expect(result).toEqual({ sent: 1, removed: 1 });
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]);
    const left = await db.select({ token: deviceTokens.token }).from(deviceTokens);
    expect(left.map((r) => r.token).sort()).toEqual(['boom-token-xxxxxxxxxxxxxxxxxxxx', TOKEN_A]);
  });

  it('still fills the in-app inbox when push is not configured', async () => {
    const coach = await makeUser('coach');
    expect(
      await notifyUsers([coach.id], { category: 'students', icon: '🎉', title: 'x', body: 'y' }),
    ).toEqual({ sent: 0, removed: 0 });
    expect(await notifyAdmins({ category: 'students', title: 'x', body: 'y' })).toEqual({
      sent: 0,
      removed: 0,
    });
    const task = jest.fn(async () => undefined);
    notifyInBackground(task);
    expect(task).toHaveBeenCalled();
    const inbox = (await (await as(coach)).get('/api/v1/me/notifications').expect(200)).body.data;
    expect(inbox).toMatchObject({ unread: 1, items: [{ title: '🎉 x', category: 'students' }] });
  });

  it('keeps an inbox: unread count on the app badge, a newer one replaces the same kind, mark read', async () => {
    const sent = fakeSender();
    const coach = await makeUser('coach');
    const coach$ = await as(coach);
    await coach$.post('/api/v1/me/devices', { token: TOKEN_A, platform: 'android' }).expect(200);
    await notifyUsers([coach.id], { category: 'sessions', title: 'A', body: '1', tag: 't1' });
    await notifyUsers([coach.id], { category: 'money', title: 'B', body: '2' });
    // Same tag, still unread: replaces the first rather than stacking.
    await notifyUsers([coach.id], { category: 'sessions', title: 'A2', body: '3', tag: 't1' });
    expect(sent.map((s) => s.message.badge)).toEqual([1, 2, 2]);
    expect(sent[2]!.message.notificationId).toEqual(expect.any(String));

    let inbox = (await coach$.get('/api/v1/me/notifications').expect(200)).body.data;
    expect(inbox.unread).toBe(2);
    expect(inbox.items.map((n: { title: string }) => n.title)).toEqual(['A2', 'B']);

    await coach$.post('/api/v1/me/notifications/read', { ids: [inbox.items[0].id] }).expect(200);
    inbox = (await coach$.get('/api/v1/me/notifications').expect(200)).body.data;
    expect(inbox.unread).toBe(1);
    const all = (await coach$.post('/api/v1/me/notifications/read', {}).expect(200)).body.data;
    expect(all.unread).toBe(0);
    // Someone else's inbox is separate.
    const other = await makeUser('coach');
    expect(
      (await (await as(other)).get('/api/v1/me/notifications').expect(200)).body.data.unread,
    ).toBe(0);
  });

  it('only reaches active admins', async () => {
    const sent = fakeSender();
    const admin = await makeUser('admin');
    const disabled = await makeUser('admin', { status: 'disabled' });
    const coach = await makeUser('coach');
    for (const [u, t] of [
      [admin, TOKEN_A],
      [coach, TOKEN_B],
    ] as const) {
      await (await as(u)).post('/api/v1/me/devices', { token: t }).expect(200);
    }
    await db
      .insert(deviceTokens)
      .values({ userId: disabled.id, token: 'disabled-admin-token-xxxxxx' });
    await notifyAdmins({ category: 'approvals', title: 'Admins', body: 'only' });
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]);
  });
});

describe('triggers', () => {
  it('tells admins about new public registrations', async () => {
    const sent = fakeSender();
    const { admin } = await makeAcademy();
    await (await as(admin)).post('/api/v1/me/devices', { token: TOKEN_A }).expect(200);
    await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ fullName: 'Diya Kapoor', phone: '9876501234', consent: true })
      .expect(201);
    await until(() => sent.length === 1);
    expect(sent[0]!.message).toMatchObject({
      category: 'approvals',
      title: 'New student sign-up',
      body: 'Diya Kapoor wants to join. Review and pick a batch.',
      link: '/registrations',
    });
  });

  it('tells admins when a check-in is outside the geofence', async () => {
    setToday(MON);
    const sent = fakeSender();
    const { admin, coach, batch } = await makeAcademy();
    await (await as(admin)).post('/api/v1/me/devices', { token: TOKEN_A }).expect(200);
    await (
      await as(coach)
    )
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.99,
        longitude: 77.5946,
      })
      .expect(200);
    await until(() => sent.length === 1);
    expect(sent[0]!.message.title).toMatch(/checked in away from the venue$/);
    expect(sent[0]!.message.category).toBe('sessions');
    expect(sent[0]!.message.body).toContain(batch.name);
  });

  it('sends coaches a morning summary of today’s sessions, skipping cancelled ones', async () => {
    const sent = fakeSender();
    const { coach, batch, location } = await makeAcademy();
    const evening = await makeBatch(coach.id, location.id, {
      name: 'Evening',
      startTime: '17:30:00',
      endTime: '18:30:00',
    });
    const rained = await makeBatch(coach.id, location.id, { name: 'Rained off' });
    await db.insert(sessionCancellations).values({
      batchId: rained.id,
      date: MON,
      reason: 'Rain',
      cancelledById: coach.id,
    });
    await (await as(coach)).post('/api/v1/me/devices', { token: TOKEN_A }).expect(200);

    // Every coach with a session counts; only this coach has the app installed.
    expect((await sendSessionReminders(MON)).coaches).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe(TOKEN_A);
    expect(sent[0]!.message.title).toBe('You have 2 sessions today');
    expect(sent[0]!.message.body).toBe(`${batch.name} at 6:00 am · ${evening.name} at 5:30 pm`);

    // Sunday: the factory batches don't run.
    expect(await sendSessionReminders('2026-03-15')).toEqual({ coaches: 0 });
    await db.delete(deviceTokens).where(eq(deviceTokens.userId, coach.id));
    setPushSender(null);
    expect(await sendSessionReminders(MON)).toEqual({ coaches: 0 });
  });

  it('formats clock times', () => {
    expect(clock('00:05:00')).toBe('12:05 am');
    expect(clock('12:00:00')).toBe('12:00 pm');
    expect(clock('23:45:00')).toBe('11:45 pm');
  });
});

describe('push status', () => {
  it('reports a broken service-account key instead of failing /ready', async () => {
    const { pushStatus } = await import('../../src/modules/push/push.service');
    setPushSender(undefined); // re-read config
    const { env } = await import('../../src/config/env');
    const original = env.FCM_SERVICE_ACCOUNT;
    (env as { FCM_SERVICE_ACCOUNT?: string }).FCM_SERVICE_ACCOUNT = 'not-json';
    expect(pushStatus()).toBe('misconfigured');
    // Notifying must not throw (e.g. inside the public registration handler).
    expect(() => notifyInBackground(async () => undefined)).not.toThrow();
    await expect(notifyAdmins({ category: 'students', title: 'x', body: 'y' })).resolves.toEqual({
      sent: 0,
      removed: 0,
    });
    (env as { FCM_SERVICE_ACCOUNT?: string }).FCM_SERVICE_ACCOUNT = original;
    setPushSender(undefined);
    expect(pushStatus()).toBe('disabled');
  });
});
