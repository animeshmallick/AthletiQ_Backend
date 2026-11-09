import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { deviceTokens, invoices } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { sendMoneyReminders } from '../../src/modules/funds/notices';
import type { PushMessage, PushSender } from '../../src/modules/push/fcm';
import { setPushSender } from '../../src/modules/push/push.service';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

type Academy = Awaited<ReturnType<typeof makeAcademy>>;
type Sent = { token: string; message: PushMessage }[];

function capture() {
  const sent: Sent = [];
  const send: PushSender = async (token, message) => {
    sent.push({ token, message });
    return 'ok';
  };
  setPushSender(send);
  return sent;
}

/** Notifications run in the background; give them a moment. */
const settle = () => new Promise((r) => setTimeout(r, 80));

async function devices(a: Academy) {
  const rows: [string, string][] = [
    [a.admin.id, 'admin'],
    [a.coach.id, 'coach'],
    [a.otherCoach.id, 'other'],
  ];
  for (const [userId, t] of rows)
    await db.insert(deviceTokens).values({ userId, token: `${t}-token-xxxxxxxxxxxxxxxxxxxx` });
}

const to = (sent: Sent, who: string) =>
  sent
    .filter((s) => s.token.startsWith(`${who}-`))
    .map((s) => `${s.message.title} | ${s.message.body}`);

async function setup() {
  const a = await makeAcademy();
  await devices(a);
  const admin = await as(a.admin);
  // Head coach (other coach) gets ₹500 flat, the batch coach 50%, the academy the rest.
  await admin.put(`/api/v1/fee-plans/${a.plan.id}/split`, {
    sections: [
      {
        name: 'Head coach',
        kind: 'flat',
        value: 50_000,
        recipient: 'staff',
        userId: a.otherCoach.id,
      },
      { name: 'Coach', kind: 'percent', value: 5000, recipient: 'batch_coach' },
      { name: 'Academy', kind: 'percent', value: 5000, recipient: 'academy' },
    ],
  });
  await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-01-10', fullName: 'Asha K' },
    a.admin.id,
  );
  await generateDueInvoices('2026-01-10');
  const [inv] = await db.select().from(invoices).where(eq(invoices.status, 'due'));
  return { a, admin, inv: inv! };
}

beforeEach(() => setToday('2026-01-15'));
afterEach(() => setPushSender(null));

describe('money notifications', () => {
  it('tells staff about their fee shares and when they are undone', async () => {
    const { a, admin, inv } = await setup();
    const sent = capture();
    const paid = await (
      await as(a.coach)
    ).post(`/api/v1/invoices/${inv.id}/payments`, {
      mode: 'cash',
      paidOn: '2026-01-12',
    });
    await settle();
    expect(to(sent, 'other')).toEqual([
      `Your share · ₹500.00 | Asha K's fee was received by ${a.coach.name}. ${a.coach.name} holds it for you.`,
    ]);
    // The collector keeps their own share; no notice to themselves.
    expect(to(sent, 'coach')).toEqual([]);

    sent.length = 0;
    const paymentId = paid.body.data.payments[0].id;
    await admin.post(`/api/v1/invoices/${inv.id}/payments/${paymentId}/revert`, {
      reason: 'Wrong student',
    });
    await settle();
    expect(to(sent, 'other')).toEqual([
      'Share removed · ₹500.00 | The payment was reverted by Admin User.',
    ]);
    expect(to(sent, 'coach')).toEqual([
      'Share removed · ₹1,000.00 | The payment was reverted by Admin User.',
    ]);

    sent.length = 0;
    await admin.post(`/api/v1/invoices/${inv.id}/payments`, { mode: 'upi', paidOn: '2026-01-13' });
    await settle();
    expect(to(sent, 'coach')).toEqual([
      "Your share · ₹1,000.00 | Asha K's fee was received by Admin User. The academy holds it for you.",
    ]);
  });

  it('notifies admins and the staff member involved in every movement', async () => {
    const { a, admin, inv } = await setup();
    const coach = await as(a.coach);
    await coach.post(`/api/v1/invoices/${inv.id}/payments`, { mode: 'cash', paidOn: '2026-01-12' });
    await settle();
    const sent = capture();

    const h = (
      await coach.post('/api/v1/funds/handovers', { amount: 10_000, occurredOn: '2026-01-14' })
    ).body.data;
    await settle();
    await coach.post('/api/v1/funds/expenses', {
      amount: 5_000,
      occurredOn: '2026-01-14',
      title: 'Cones',
      paidFrom: 'cash',
    });
    await settle();
    await coach.post('/api/v1/funds/expenses', {
      amount: 2_000,
      occurredOn: '2026-01-14',
      title: 'Tape',
      paidFrom: 'own',
    });
    await settle();
    expect(to(sent, 'admin')).toEqual([
      `Cash handed over · ₹100.00 | ${a.coach.name} → academy`,
      `Purchase · ₹50.00 | Cones · from ${a.coach.name}'s cash · by ${a.coach.name}`,
      `Purchase · ₹20.00 | Tape · paid by ${a.coach.name}, to reimburse · by ${a.coach.name}`,
    ]);
    expect(to(sent, 'coach')).toEqual([]);

    sent.length = 0;
    const steps: [string, object][] = [
      ['handovers', { amount: 10_000, userId: a.coach.id }],
      ['expenses', { amount: 1_000, title: 'Ball', paidFrom: 'cash', userId: a.coach.id }],
      ['payouts', { amount: 50_000, userId: a.otherCoach.id, fromUserId: a.coach.id }],
      ['payouts', { amount: 2_000, userId: a.coach.id }],
      ['income', { amount: 9_900, title: 'Sponsor' }],
    ];
    for (const [path, body] of steps) {
      const r = await admin.post(`/api/v1/funds/${path}`, { occurredOn: '2026-01-14', ...body });
      expect(r.status).toBe(201);
      await settle();
    }
    await admin.post(`/api/v1/funds/txns/${h.id}/reverse`, { reason: 'Counted twice' });
    await settle();
    expect(to(sent, 'coach')).toEqual([
      'Cash handed over · ₹100.00 | Admin User recorded ₹100.00 received from you.',
      `Purchase · ₹10.00 | Admin User recorded “Ball” from ${a.coach.name}'s cash.`,
      `Paid · ₹500.00 | Admin User recorded ₹500.00 paid from your cash to ${a.otherCoach.name}.`,
      'Payment to you · ₹20.00 | Recorded by Admin User.',
      `Entry reversed · ₹100.00 | “Cash handed over by ${a.coach.name}” was reversed by Admin User: Counted twice`,
    ]);
    expect(to(sent, 'other')).toEqual([
      `Payment to you · ₹500.00 | Recorded by Admin User from ${a.coach.name}'s cash.`,
    ]);
    // The only admin did all of it.
    expect(to(sent, 'admin')).toEqual([]);
  });

  it('reminds cash holders weekly and sends admins the money position once', async () => {
    const { a, admin, inv } = await setup();
    expect(await sendMoneyReminders(new Date())).toEqual({ holders: 0, admins: false });
    await (
      await as(a.coach)
    ).post(`/api/v1/invoices/${inv.id}/payments`, {
      mode: 'cash',
      paidOn: '2026-01-12',
    });
    await (
      await as(a.otherCoach)
    ).post('/api/v1/funds/expenses', {
      amount: 3_000,
      occurredOn: '2026-01-14',
      title: 'Tape',
      paidFrom: 'own',
    });
    await admin.post('/api/v1/funds/income', {
      amount: 100_000,
      occurredOn: '2026-01-14',
      title: 'Opening',
    });
    await settle();

    const sent = capture();
    expect(await sendMoneyReminders(new Date())).toEqual({ holders: 1, admins: true });
    expect(to(sent, 'coach')).toEqual([
      'You hold ₹1,500.00 for the academy | Please hand it over to the academy and record it in Money.',
    ]);
    expect(to(sent, 'admin')).toEqual([
      'Money position · ₹2,500.00 in hand | Academy ₹1,000.00 · with staff ₹1,500.00 · owed to others ₹530.00',
    ]);
    expect(await sendMoneyReminders(new Date())).toEqual({ holders: 0, admins: false });

    // Next week: a holder who is also owed money is told both.
    sent.length = 0;
    await admin.post('/api/v1/funds/expenses', {
      amount: 1_000,
      occurredOn: '2026-01-14',
      title: 'Kit',
      paidFrom: 'own',
      userId: a.coach.id,
    });
    await settle();
    sent.length = 0;
    setToday('2026-01-20');
    await sendMoneyReminders(new Date());
    expect(to(sent, 'coach')[0]).toBe(
      'You hold ₹1,500.00 for the academy | The academy also owes you ₹10.00. Please hand over the cash or settle with an admin.',
    );
  });
});
