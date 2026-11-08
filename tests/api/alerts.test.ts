import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { eq } from 'drizzle-orm';
import { deviceTokens, invoices } from '../../src/db/schema';
import {
  runSessionAlerts,
  sendAdminDigest,
  sendFeedbackReminders,
  sendOverdueNotices,
  sendWeeklyFeesSummary,
} from '../../src/jobs/alerts';
import type { PushMessage, PushSender } from '../../src/modules/push/fcm';
import {
  noticeBatchAssigned,
  noticeBatchChanged,
  noticeMakeupBooked,
  noticeSessionCancelled,
  noticeStudentJoined,
  noticeStudentLeft,
  noticeStudentMovedOut,
} from '../../src/modules/push/coach-notices';
import { setPushSender } from '../../src/modules/push/push.service';
import { istMinutes, tasksFor } from '../../src/modules/tasks/tasks.service';
import {
  as,
  checkIn,
  makeAcademy,
  makeBatch,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';
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
    expect(await sendOverdueNotices(new Date())).toEqual({ coaches: 0 });
    expect(await sendWeeklyFeesSummary(new Date())).toEqual({ sent: false });
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
    expect(sent[0]!.message.body).toBe('Asha K · UPI · received by Admin User');
    expect(s.id).toBeTruthy();
  });
});

describe('coach notices', () => {
  async function settle(sent: unknown[], n: number) {
    for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  }

  it('tells coaches about new, changed and reassigned batches', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, coach, otherCoach, location } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(otherCoach.id, 'other-coach-token-xxxxxxxxxxxx');
    const api = await as(admin);

    const created = await api
      .post('/api/v1/batches', {
        name: 'Evening Juniors',
        coachId: coach.id,
        locationId: location.id,
        weekdays: [5, 1, 3],
        startTime: '17:00',
        endTime: '18:30',
      })
      .expect(201);
    await settle(sent, 1);
    expect(sent[0]!.message).toMatchObject({
      title: 'New batch assigned: Evening Juniors',
      body: expect.stringContaining('Mon · Wed · Fri · 5:00 pm–6:30 pm'),
    });

    const id = created.body.data.id as string;
    await api.patch(`/api/v1/batches/${id}`, { startTime: '17:30', endTime: '19:00' }).expect(200);
    await settle(sent, 2);
    expect(sent[1]!.message).toMatchObject({
      title: 'Evening Juniors was updated',
      body: 'now 5:30 pm–7:00 pm',
    });

    // No real change → no push.
    await api.patch(`/api/v1/batches/${id}`, { startTime: '17:30' }).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(2);

    await api.patch(`/api/v1/batches/${id}`, { coachId: otherCoach.id }).expect(200);
    await settle(sent, 4);
    const byToken = Object.fromEntries(sent.slice(2).map((s) => [s.userToken, s.message.title]));
    expect(byToken).toEqual({
      'other-coach-token-xxxxxxxxxxxx': 'New batch assigned: Evening Juniors',
      'coach-device-token-xxxxxxxxxxxx': 'Evening Juniors moved to another coach',
    });
  });

  it('tells the coach when a student joins or moves into their batch', async () => {
    const sent = capture();
    setToday('2026-03-05', at('12:00'));
    const { admin, coach, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(otherCoach.id, 'other-coach-token-xxxxxxxxxxxx');
    const api = await as(admin);
    const res = await api
      .post('/api/v1/students', {
        fullName: 'Diya Kapoor',
        phone: '98765 43210',
        joiningDate: '2026-03-10',
        batchId: batch.id,
        trainingDays: [1, 3, 5],
        feePlanId: plan.id,
      })
      .expect(201);
    await settle(sent, 1);
    expect(sent[0]).toMatchObject({
      userToken: 'coach-device-token-xxxxxxxxxxxx',
      message: {
        title: `New student in ${batch.name}`,
        body: 'Diya Kapoor · Mon · Wed · Fri from Tuesday',
      },
    });

    // Changing only the days in the same batch is not a "new student".
    await api
      .post(`/api/v1/students/${res.body.data.id}/transfer`, {
        batchId: batch.id,
        trainingDays: [1, 3],
        effectiveFrom: '2026-03-10',
      })
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);

    await api
      .post(`/api/v1/students/${res.body.data.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [2, 4],
        effectiveFrom: '2026-03-12',
      })
      .expect(200);
    await settle(sent, 3);
    const byToken = Object.fromEntries(sent.slice(1).map((m) => [m.userToken, m.message]));
    expect(byToken['other-coach-token-xxxxxxxxxxxx']).toMatchObject({
      title: `New student in ${otherBatch.name}`,
    });
    // The coach they left hears about it too.
    expect(byToken['coach-device-token-xxxxxxxxxxxx']).toMatchObject({
      title: `Diya Kapoor moved out of ${batch.name}`,
      body: `Now in ${otherBatch.name} from 12 Mar`,
    });
  });

  it('tells the coach when a student leaves the academy', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, coach, batch, plan } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, fullName: 'Kabir Das' },
      admin.id,
    );
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-14', reason: 'Moving city' })
      .expect(200);
    await settle(sent, 1);
    expect(sent[0]!.message).toMatchObject({
      title: 'Kabir Das left the academy',
      body: `${batch.name} · last day Saturday`,
    });
  });

  it('tells the coach when someone else cancels or restores their session', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, coach, batch } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    const api = await as(admin);
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, {
        date: '2026-03-11',
        reason: 'Ground under repair',
      })
      .expect(201);
    await settle(sent, 1);
    expect(sent[0]!.message).toMatchObject({
      title: `${batch.name} is cancelled on Wednesday`,
      body: 'Reason: Ground under repair',
      link: '/calendar?date=2026-03-11&view=day',
    });
    await api.delete(`/api/v1/batches/${batch.id}/cancellations/2026-03-11`).expect(204);
    await settle(sent, 2);
    expect(sent[1]!.message.title).toBe(`${batch.name} is on again on Wednesday`);

    // The coach's own cancellation needs no push to themselves.
    await (
      await as(coach)
    )
      .post(`/api/v1/batches/${batch.id}/cancellations`, {
        date: '2026-03-12',
        reason: 'Unwell today',
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(2);
  });

  it('tells the coach when an admin books a makeup into their batch', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    await device(otherCoach.id, 'other-coach-token-xxxxxxxxxxxx');
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, fullName: 'Meera N' },
      admin.id,
    );
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-03-12' })
      .expect(201);
    await settle(sent, 1);
    expect(sent[0]!.message).toMatchObject({
      title: `Makeup student in ${otherBatch.name}`,
      body: 'Meera N joins on Thursday',
    });
  });

  it('tells admins about coach makeup requests and the coach about the decision', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, coach, batch, plan } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(admin.id, 'admin-device-token-xxxxxxxxxxxx');
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, fullName: 'Ojas P' },
      admin.id,
    );
    const coachApi = await as(coach);
    const r1 = await coachApi
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: batch.id, date: '2026-03-10' })
      .expect(201);
    const r2 = await coachApi
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: batch.id, date: '2026-03-17' })
      .expect(201);
    await settle(sent, 2);
    expect(sent[0]!.message.title).toBe('Makeup request');
    const adminApi = await as(admin);
    await adminApi.post(`/api/v1/makeups/${r1.body.data.id}/approve`).expect(200);
    await settle(sent, 3);
    expect(sent[2]!.message).toMatchObject({
      title: 'Makeup approved',
      body: expect.stringContaining('Ojas P'),
    });
    await adminApi
      .post(`/api/v1/makeups/${r2.body.data.id}/reject`, { reason: 'Batch is full that day' })
      .expect(200);
    await settle(sent, 4);
    expect(sent[3]!.message.title).toBe('Makeup not approved');
  });

  it('stays quiet when there is nobody (or nothing new) to tell', async () => {
    const sent = capture();
    setToday(MON, at('12:00'));
    const { admin, coach, batch, plan, location } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    const gone = '00000000-0000-4000-8000-000000000000';
    await noticeBatchAssigned(gone);
    await noticeBatchChanged(batch, gone);
    await noticeStudentJoined(gone);
    await noticeStudentLeft(gone, gone, MON);
    await noticeStudentMovedOut(gone, gone, batch.id, MON);
    await noticeSessionCancelled(gone, MON, admin.id, null);
    await noticeMakeupBooked(gone, gone, MON, admin.id);
    // Same coach on both batches: the "joined" notice is enough.
    const second = await makeBatch(coach.id, location.id);
    const s = await makeStudent({ batchId: batch.id, feePlanId: plan.id }, admin.id);
    await noticeStudentMovedOut(s.id, batch.id, second.id, MON);
    // Coach's own makeup / cancellation.
    await noticeMakeupBooked(s.id, batch.id, MON, coach.id);
    await noticeSessionCancelled(batch.id, MON, coach.id, null);
    // A student with no name on record still reads well, and no reason is spelled out.
    await noticeSessionCancelled(batch.id, '2026-03-11', admin.id, null);
    await noticeStudentLeft(gone, batch.id, MON);
    expect(sent.map((m) => m.message.body)).toEqual([
      'Reason: not given',
      `${batch.name} · last day today`,
    ]);
    expect(sent[1]!.message.title).toBe('A student left the academy');
  });

  it('tells coaches once about fees over a week overdue, and admins about last week', async () => {
    const sent = capture();
    setToday(MON, at('10:00'));
    const { admin, coach, batch, plan } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    await device(admin.id, 'admin-device-token-xxxxxxxxxxxx');
    const a = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01', fullName: 'Late Lata' },
      admin.id,
    );
    const b = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01', fullName: 'Recent Ravi' },
      admin.id,
    );
    await billOnAcceptance(a.id);
    await billOnAcceptance(b.id);
    await db.update(invoices).set({ dueDate: '2026-03-01' }).where(eq(invoices.studentId, a.id));
    await db.update(invoices).set({ dueDate: '2026-03-06' }).where(eq(invoices.studentId, b.id));

    expect(await sendOverdueNotices(new Date())).toEqual({ coaches: 1 });
    expect(sent[0]!.message).toMatchObject({
      title: "Late Lata's fees are over a week overdue",
      link: `/students/${a.id}`,
    });
    expect(await sendOverdueNotices(new Date())).toEqual({ coaches: 0 });

    // Three days later Ravi crosses a week too, and only Ravi is reported.
    setToday('2026-03-13', at('10:00'));
    await db.update(invoices).set({ dueDate: '2026-03-01' }).where(eq(invoices.studentId, b.id));
    expect(await sendOverdueNotices(new Date())).toEqual({ coaches: 1 });
    expect(sent.at(-1)!.message.title).toBe("Recent Ravi's fees are over a week overdue");

    setToday('2026-03-16', at('09:00'));
    expect(await sendWeeklyFeesSummary(new Date())).toEqual({ sent: true });
    expect(await sendWeeklyFeesSummary(new Date())).toEqual({ sent: false });
    const summary = sent.find((m) => m.message.tag === 'fees-week')!;
    expect(summary.userToken).toBe('admin-device-token-xxxxxxxxxxxx');
    expect(summary.message.title).toMatch(/^Last week: ₹0(\.00)? collected$/);
    expect(summary.message.body).toMatch(
      /^0 payments · .* billed \(0 invoices\) · .* overdue across \d+ invoices$/,
    );
  });

  it('groups several overdue students into one push per coach', async () => {
    const sent = capture();
    setToday(MON, at('10:00'));
    const { admin, coach, batch, plan } = await makeAcademy();
    await device(coach.id, 'coach-device-token-xxxxxxxxxxxx');
    for (const name of ['Anu', 'Bela', 'Chirag', 'Dev', 'Esha']) {
      const s = await makeStudent(
        { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01', fullName: name },
        admin.id,
      );
      await billOnAcceptance(s.id);
    }
    await db.update(invoices).set({ dueDate: '2026-02-20' });
    expect(await sendOverdueNotices(new Date())).toEqual({ coaches: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({
      title: "5 students' fees are over a week overdue",
      link: '/invoices?status=overdue',
    });
    expect(sent[0]!.message.body).toMatch(/and 1 more$/);
  });
});
