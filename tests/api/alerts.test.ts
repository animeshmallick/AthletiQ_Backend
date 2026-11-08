import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { deviceTokens, invoices } from '../../src/db/schema';
import { runSessionAlerts, sendAdminDigest, sendFeedbackReminders } from '../../src/jobs/alerts';
import type { PushMessage, PushSender } from '../../src/modules/push/fcm';
import { setPushSender } from '../../src/modules/push/push.service';
import { istMinutes, tasksFor } from '../../src/modules/tasks/tasks.service';
import { as, checkIn, makeAcademy, makeStudent, makeUser, setToday } from '../helpers/factories';
import { billOnAcceptance } from '../../src/modules/billing/invoice-generator';

const MON = '2026-03-09';
// IST = UTC+5:30. The factory batch runs 06:00–08:00 IST.
const at = (ist: string) => {
  const [h, m] = ist.split(':').map(Number);
  const utc = h! * 60 + m! - 330;
  return `${String(Math.floor(utc / 60)).padStart(2, '0')}:${String(utc % 60).padStart(2, '0')}:00`;
};

function capture() {
  const sent: { userToken: string; message: PushMessage }[] = [];
  const send: PushSender = async (token, message) => {
    sent.push({ userToken: token, message });
    return 'ok';
  };
  setPushSender(send);
  return sent;
}

async function device(userId: string, token: string) {
  await db.insert(deviceTokens).values({ userId, token });
}

afterEach(() => setPushSender(null));

describe('tasks', () => {
  it('converts IST clock time to minutes', () => {
    expect(istMinutes(new Date('2026-03-09T00:20:00Z'))).toBe(5 * 60 + 50);
  });

  it('tells a coach to check in and plan before the session, then flags a missed check-in', async () => {
    const { coach, admin, batch, plan } = await makeAcademy();
    await makeStudent({ batchId: batch.id, feePlanId: plan.id, trainingDays: [1, 3, 5] }, admin.id);

    setToday(MON, at('05:50'));
    const before = await tasksFor({ ...coach, role: 'coach' }, new Date());
    // Student joined in January, so last week's report is also open.
    expect(before.items.map((t) => t.kind).sort()).toEqual(['check-in', 'feedback', 'lesson-plan']);
    expect(before.counts).toMatchObject({ '/': 1, '/lesson-plans': 1 });

    setToday(MON, at('06:40'));
    const late = await tasksFor({ ...coach, role: 'coach' }, new Date());
    expect(late.items[0]).toMatchObject({ kind: 'missed-check-in', severity: 'critical' });
    const adminView = await tasksFor({ ...admin, role: 'admin' }, new Date());
    expect(adminView.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missed-check-in',
          title: `${coach.name} hasn't checked in`,
        }),
      ]),
    );

    // Checked in: attendance becomes the task.
    await checkIn(coach.id, batch.id, MON);
    const marking = await tasksFor({ ...coach, role: 'coach' }, new Date());
    expect(marking.items.map((t) => t.kind)).toContain('attendance');
    expect(marking.counts['/attendance']).toBe(1);
  });

  it('gives admins academy-wide counts through GET /me/tasks', async () => {
    setToday(MON, at('12:00'));
    const { admin, batch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    await billOnAcceptance(s.id);
    await db.update(invoices).set({ dueDate: '2026-03-01' }); // make its invoice overdue
    const res = await (await as(admin)).get('/api/v1/me/tasks').expect(200);
    expect(res.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'overdue-fees' })]),
    );
    expect(res.body.data.counts['/invoices']).toBeGreaterThanOrEqual(1);
    expect(s.id).toBeTruthy();
  });
});

describe('session alerts', () => {
  it('reminds, escalates a missed check-in and wraps up — each only once', async () => {
    const sent = capture();
    const { coach, admin, batch, plan } = await makeAcademy();
    await makeStudent({ batchId: batch.id, feePlanId: plan.id, trainingDays: [1, 3, 5] }, admin.id);
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(admin.id, 'admin-device-token-xxxxxxxxxxxx');

    setToday(MON, at('05:50'));
    await runSessionAlerts(new Date());
    await runSessionAlerts(new Date()); // same minute again: no duplicate
    expect(sent.map((s) => s.message.title)).toEqual([`${batch.name} starts at 6:00 am`]);

    setToday(MON, at('06:35'));
    await runSessionAlerts(new Date());
    expect(
      sent
        .slice(1)
        .map((s) => s.message.title)
        .sort(),
    ).toEqual(
      [`${coach.name} hasn't checked in`, `You haven't checked in to ${batch.name}`].sort(),
    );

    setToday(MON, at('08:35'));
    await runSessionAlerts(new Date());
    const wrap = sent.slice(3);
    expect(wrap).toHaveLength(2);
    expect(wrap[0]!.message.body).toContain('no check-in');
    expect(wrap[0]!.message.body).toContain('attendance 0/1');

    // Outside every window: nothing more (e.g. after a restart late at night).
    setToday(MON, at('22:00'));
    await runSessionAlerts(new Date());
    expect(sent).toHaveLength(5);
  });

  it('sends nothing when push is not configured', async () => {
    await makeAcademy();
    setToday(MON, at('05:50'));
    expect(await runSessionAlerts(new Date())).toEqual({ sent: 0 });
    expect(await sendAdminDigest(new Date())).toEqual({ sent: false });
    expect(await sendFeedbackReminders()).toEqual({ coaches: 0 });
  });

  it('sends admins one evening digest and coaches one weekly feedback nudge', async () => {
    const sent = capture();
    const { coach, admin, batch, plan } = await makeAcademy();
    await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01' },
      admin.id,
    );
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(admin.id, 'admin-device-token-xxxxxxxxxxxx');

    setToday(MON, at('20:00'));
    expect(await sendAdminDigest(new Date())).toEqual({ sent: true });
    expect(await sendAdminDigest(new Date())).toEqual({ sent: false });
    expect(sent[0]!.message.title).toBe('Today at the academy');
    expect(sent[0]!.message.body).toMatch(/2 sessions · 2 missed check-ins/);

    setToday(MON, at('10:00'));
    expect(await sendFeedbackReminders()).toEqual({ coaches: 1 });
    expect(await sendFeedbackReminders()).toEqual({ coaches: 0 });
    expect(sent.at(-1)!.message.title).toBe('1 weekly report to send');
  });
});

describe('fee paid', () => {
  it('tells the other admins when an invoice is marked paid', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, batch, plan } = await makeAcademy();
    const otherAdmin = await makeUser('admin');
    await device(admin.id, 'admin-device-token-xxxxxxxxxxxx');
    await device(otherAdmin.id, 'other-admin-token-xxxxxxxxxxxx');
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-03-01', fullName: 'Asha K' },
      admin.id,
    );
    await billOnAcceptance(s.id);
    const [inv] = await db.select().from(invoices);
    await (
      await as(admin)
    )
      .post(`/api/v1/invoices/${inv!.id}/payments`, { mode: 'upi', paidOn: MON })
      .expect(200);
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1); // not the admin who recorded it
    expect(sent[0]!.userToken).toBe('other-admin-token-xxxxxxxxxxxx');
    expect(sent[0]!.message.title).toMatch(/^Fee received · ₹/);
    expect(sent[0]!.message.body).toBe('Asha K · UPI');
    expect(s.id).toBeTruthy();
  });
});
