import { beforeEach, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { fundEntries, fundTxns, invoices } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, makeAcademy, makeStudent, makeUser, setToday } from '../helpers/factories';

type Academy = Awaited<ReturnType<typeof makeAcademy>>;

/** Σ cash must always equal the academy fund + everything owed. */
async function expectBalanced() {
  const [row] = await db
    .select({
      cash: sql<number>`coalesce(sum(case when ${fundEntries.account} = 'cash' then ${fundEntries.amount} end), 0)::int`,
      claims: sql<number>`coalesce(sum(case when ${fundEntries.account} <> 'cash' then ${fundEntries.amount} end), 0)::int`,
    })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .where(isNull(fundTxns.reversedAt));
  expect(row!.cash).toBe(row!.claims);
}

async function overview(user: { id: string; role: 'admin' | 'coach' }) {
  const res = await (await as(user)).get('/api/v1/funds/overview?from=2026-01-01&to=2026-01-31');
  expect(res.status).toBe(200);
  return res.body.data;
}

/** ₹2,500 fee: Academy 50% (Society 35% / Academy 65%), Coach 50% (batch coach). */
async function setSplit(a: Academy) {
  const admin = await as(a.admin);
  const society = (await admin.post('/api/v1/funds/payees', { name: 'Society' })).body.data;
  const res = await admin.put(`/api/v1/fee-plans/${a.plan.id}/split`, {
    sections: [
      {
        name: 'Academy',
        kind: 'percent',
        value: 5000,
        children: [
          {
            name: 'Society',
            kind: 'percent',
            value: 3500,
            recipient: 'payee',
            payeeId: society.id,
          },
          { name: 'Academy', kind: 'percent', value: 6500, recipient: 'academy' },
        ],
      },
      { name: 'Coach', kind: 'percent', value: 5000, recipient: 'batch_coach' },
    ],
  });
  expect(res.status).toBe(200);
  return society as { id: string };
}

async function dueInvoice(a: Academy) {
  await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-01-10' },
    a.admin.id,
  );
  await generateDueInvoices('2026-01-10');
  const [inv] = await db.select().from(invoices).where(eq(invoices.status, 'due'));
  return inv!;
}

async function pay(
  user: { id: string; role: 'admin' | 'coach' },
  invoiceId: string,
  extra: object = {},
) {
  const res = await (
    await as(user)
  ).post(`/api/v1/invoices/${invoiceId}/payments`, {
    mode: 'cash',
    paidOn: '2026-01-12',
    ...extra,
  });
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeEach(() => setToday('2026-01-15'));

describe('fee plan splits', () => {
  it('validates and saves a two-level split; only admins see and change it', async () => {
    const a = await makeAcademy();
    const admin = await as(a.admin);
    const url = `/api/v1/fee-plans/${a.plan.id}/split`;

    const bad = await admin.put(url, {
      sections: [{ name: 'A', kind: 'percent', value: 6000, recipient: 'academy' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Percentages add up to 60%, not 100%');

    const over = await admin.put(url, {
      sections: [
        { name: 'A', kind: 'percent', value: 12000, recipient: 'academy' },
        { name: 'B', kind: 'flat', value: 200_000_000, recipient: 'academy' },
      ],
    });
    expect(over.status).toBe(400);

    const disabled = await makeUser('coach', { status: 'disabled' });
    const inactiveStaff = await admin.put(url, {
      sections: [
        { name: 'A', kind: 'percent', value: 10000, recipient: 'staff', userId: disabled.id },
      ],
    });
    expect(inactiveStaff.body.error.message).toBe('A chosen staff member is not active');

    const old = (await admin.post('/api/v1/funds/payees', { name: 'Old club', isActive: false }))
      .body.data;
    const inactivePayee = await admin.put(url, {
      sections: [{ name: 'A', kind: 'percent', value: 10000, recipient: 'payee', payeeId: old.id }],
    });
    expect(inactivePayee.body.error.message).toBe('A chosen payee is not active');

    expect(
      (
        await admin.put('/api/v1/fee-plans/00000000-0000-4000-8000-000000000000/split', {
          sections: [],
        })
      ).status,
    ).toBe(404);

    await setSplit(a);
    const plans = (await admin.get('/api/v1/fee-plans')).body.data;
    const plan = plans.find((p: { id: string }) => p.id === a.plan.id);
    expect(plan.split).toMatchObject([
      {
        name: '', // Divided sections have no name of their own.
        recipient: null,
        children: [{ name: 'Society', recipient: 'payee' }, { name: 'Academy' }],
      },
      { name: 'Coach', recipient: 'batch_coach', userId: null, children: [] },
    ]);

    const coach = await as(a.coach);
    expect((await coach.get('/api/v1/fee-plans')).body.data[0].split).toBeUndefined();
    expect((await coach.put(url, { sections: [] })).status).toBe(403);

    // An empty split means everything goes to the academy.
    expect((await admin.put(url, { sections: [] })).body.data).toEqual([]);
  });
});

describe('fee distribution on payment', () => {
  it('coach collects: keeps their share, holds the academy and society shares', async () => {
    const a = await makeAcademy();
    const society = await setSplit(a);
    const inv = await dueInvoice(a);
    const paid = await pay(a.coach, inv.id);
    expect(paid.split).toEqual([{ label: 'Coach', name: a.coach.name, amount: 125_000 }]);

    const detail = (await (await as(a.admin)).get(`/api/v1/invoices/${inv.id}`)).body.data;
    expect(detail.split).toEqual(
      expect.arrayContaining([
        { label: 'Society', name: 'Society', amount: 43_750 },
        { label: 'Academy', name: 'Academy', amount: 81_250 },
        { label: 'Coach', name: a.coach.name, amount: 125_000 },
      ]),
    );

    const o = await overview(a.admin);
    expect(o.balances).toMatchObject({
      academyCash: 0,
      withStaff: 125_000,
      academyFund: 81_250,
      owedToStaff: 0,
      owedToPayees: 43_750,
      holders: [{ userId: a.coach.id, amount: 125_000 }],
      payeeDue: [{ payeeId: society.id, name: 'Society', amount: 43_750 }],
    });
    expect(o.period).toMatchObject({
      collected: 250_000,
      payments: 1,
      keptByStaff: 125_000,
      keptBy: [{ userId: a.coach.id, amount: 125_000 }],
    });
    expect(
      o.period.byRecipient.map((r: { name: string; amount: number }) => [r.name, r.amount]),
    ).toEqual([
      [a.coach.name, 125_000],
      ['Academy', 81_250],
      ['Society', 43_750],
    ]);

    const mine = await overview(a.coach);
    expect(mine).toMatchObject({
      scope: 'self',
      cash: 125_000,
      due: 0,
      period: { collected: 250_000, earned: 125_000, kept: 125_000, handedOver: 0 },
    });
    await expectBalanced();
  });

  it('admin collects: the academy holds the cash and owes the coach', async () => {
    const a = await makeAcademy();
    await setSplit(a);
    const inv = await dueInvoice(a);
    await pay(a.admin, inv.id, { heldBy: 'collector' });
    const o = await overview(a.admin);
    expect(o.balances).toMatchObject({
      academyCash: 250_000,
      withStaff: 0,
      owedToStaff: 125_000,
      staffDue: [{ userId: a.coach.id, amount: 125_000 }],
    });
    expect((await overview(a.coach)).due).toBe(125_000);
    await expectBalanced();
  });

  it('coach collects into the academy account: the academy owes the coach their share', async () => {
    const a = await makeAcademy();
    await setSplit(a);
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id, { mode: 'upi', heldBy: 'academy' });
    const mine = await overview(a.coach);
    expect(mine).toMatchObject({ cash: 0, due: 125_000, period: { kept: 0 } });
    await expectBalanced();
  });

  it('without a split everything goes to the academy; revert undoes the split', async () => {
    const a = await makeAcademy();
    const inv = await dueInvoice(a);
    const paid = await pay(a.coach, inv.id);
    expect(paid.split).toEqual([]); // the coach has no share
    expect((await overview(a.admin)).balances).toMatchObject({
      academyFund: 250_000,
      withStaff: 250_000,
    });

    const admin = await as(a.admin);
    const paymentId = paid.payments[0].id;
    const r = await admin.post(`/api/v1/invoices/${inv.id}/payments/${paymentId}/revert`, {
      reason: 'Wrong student',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.split).toEqual([]);
    expect((await overview(a.admin)).balances).toMatchObject({ academyFund: 0, withStaff: 0 });

    // Paying again creates a fresh split; refunding removes it too.
    const again = await pay(a.admin, inv.id);
    await admin.post(`/api/v1/invoices/${inv.id}/payments/${again.payments[0].id}/refund`, {
      reason: 'Left the academy',
    });
    expect((await overview(a.admin)).balances.academyCash).toBe(0);
    const txns = (await admin.get('/api/v1/funds/txns?includeReversed=true')).body.data;
    expect(txns).toHaveLength(2);
    expect(txns.every((t: { reversedAt: string | null }) => t.reversedAt)).toBe(true);
    await expectBalanced();
  });

  it('pays a fixed staff member their share even when someone else collects', async () => {
    const a = await makeAcademy();
    const admin = await as(a.admin);
    await admin.put(`/api/v1/fee-plans/${a.plan.id}/split`, {
      sections: [
        {
          name: 'Head coach',
          kind: 'flat',
          value: 50_000,
          recipient: 'staff',
          userId: a.otherCoach.id,
        },
        { name: 'Academy', kind: 'percent', value: 10000, recipient: 'academy' },
      ],
    });
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id);
    const o = await overview(a.admin);
    expect(o.balances).toMatchObject({
      withStaff: 250_000,
      academyFund: 200_000,
      staffDue: [{ userId: a.otherCoach.id, amount: 50_000 }],
    });
    await expectBalanced();
  });
});

describe('cash handovers, purchases, payouts and income', () => {
  async function coachHolding(a: Academy) {
    await setSplit(a);
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id); // coach now holds ₹1,250
  }

  it('coach hands cash to the academy, within what they hold', async () => {
    const a = await makeAcademy();
    await coachHolding(a);
    const coach = await as(a.coach);
    const tooMuch = await coach.post('/api/v1/funds/handovers', {
      amount: 200_000,
      occurredOn: '2026-01-14',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.message).toBe('Only ₹1,250.00 in hand with this person.');
    const future = await coach.post('/api/v1/funds/handovers', {
      amount: 100,
      occurredOn: '2026-02-01',
    });
    expect(future.status).toBe(400);

    const ok = await coach.post('/api/v1/funds/handovers', {
      amount: 100_000,
      occurredOn: '2026-01-14',
      note: 'Weekly cash',
      userId: a.otherCoach.id, // ignored for coaches
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      type: 'handover',
      userId: a.coach.id,
      title: `Cash handed over by ${a.coach.name}`,
    });
    expect((await overview(a.admin)).balances).toMatchObject({
      academyCash: 100_000,
      withStaff: 25_000,
    });

    // Admins record a handover for a named staff member.
    const admin = await as(a.admin);
    expect(
      (await admin.post('/api/v1/funds/handovers', { amount: 100, occurredOn: '2026-01-14' }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.post('/api/v1/funds/handovers', {
          amount: 25_000,
          occurredOn: '2026-01-15',
          userId: a.coach.id,
        })
      ).status,
    ).toBe(201);
    expect((await overview(a.coach)).period.handedOver).toBe(125_000);
    await expectBalanced();
  });

  it('records purchases from held cash, the academy, or a staff member’s own pocket', async () => {
    const a = await makeAcademy();
    await coachHolding(a);
    const coach = await as(a.coach);
    const admin = await as(a.admin);

    const fromCash = await coach.post('/api/v1/funds/expenses', {
      amount: 30_000,
      occurredOn: '2026-01-14',
      title: 'Cones and bibs',
      paidFrom: 'cash',
    });
    expect(fromCash.status).toBe(201);
    expect(fromCash.body.data).toMatchObject({ category: 'equipment', userId: a.coach.id });

    const own = await coach.post('/api/v1/funds/expenses', {
      amount: 50_000,
      occurredOn: '2026-01-14',
      title: 'Football',
      category: 'equipment',
      paidFrom: 'own',
    });
    expect(own.status).toBe(201);
    expect(
      (
        await coach.post('/api/v1/funds/expenses', {
          amount: 1,
          occurredOn: '2026-01-14',
          title: 'Net',
          paidFrom: 'academy',
        })
      ).status,
    ).toBe(403);

    expect(await overview(a.coach)).toMatchObject({
      cash: 95_000,
      due: 50_000,
      period: { spent: 80_000 },
    });

    // The academy has no cash of its own yet.
    const broke = await admin.post('/api/v1/funds/expenses', {
      amount: 10_000,
      occurredOn: '2026-01-14',
      title: 'Ground booking',
      category: 'venue',
      paidFrom: 'academy',
    });
    expect(broke.status).toBe(422);
    expect(broke.body.error.message).toBe('The academy has only ₹0.00 in hand.');

    const income = await admin.post('/api/v1/funds/income', {
      amount: 500_000,
      occurredOn: '2026-01-01',
      title: 'Opening balance',
    });
    expect(income.status).toBe(201);
    expect(
      (
        await admin.post('/api/v1/funds/expenses', {
          amount: 10_000,
          occurredOn: '2026-01-14',
          title: 'Ground booking',
          category: 'venue',
          paidFrom: 'academy',
        })
      ).status,
    ).toBe(201);
    // Admin paying from their own pocket is owed it back.
    await admin.post('/api/v1/funds/expenses', {
      amount: 2_000,
      occurredOn: '2026-01-14',
      title: 'Water',
      category: 'refreshments',
      paidFrom: 'own',
    });

    const o = await overview(a.admin);
    expect(o.balances).toMatchObject({
      academyCash: 490_000,
      withStaff: 95_000,
      academyFund: 81_250 + 500_000 - 30_000 - 50_000 - 10_000 - 2_000,
    });
    expect(
      o.balances.staffDue.map((s: { userId: string; amount: number }) => [s.userId, s.amount]),
    ).toEqual([
      [a.coach.id, 50_000],
      [a.admin.id, 2_000],
    ]);
    expect(o.period).toMatchObject({ spent: 92_000, income: 500_000 });
    expect(o.period.expensesByCategory).toEqual([
      { category: 'equipment', amount: 80_000, count: 2 },
      { category: 'venue', amount: 10_000, count: 1 },
      { category: 'refreshments', amount: 2_000, count: 1 },
    ]);
    await expectBalanced();
  });

  it('pays staff and payees what they are owed, from the academy or a holder’s cash', async () => {
    const a = await makeAcademy();
    const society = await coachHolding(a)
      .then(async () => (await as(a.admin)).get('/api/v1/funds/payees'))
      .then((r) => r.body.data[0]);
    const admin = await as(a.admin);
    const coach = await as(a.coach);
    await coach.post('/api/v1/funds/expenses', {
      amount: 20_000,
      occurredOn: '2026-01-14',
      title: 'Ball',
      paidFrom: 'own',
    });

    expect(
      (
        await coach.post('/api/v1/funds/payouts', {
          amount: 1,
          occurredOn: '2026-01-14',
          userId: a.coach.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.post('/api/v1/funds/payouts', { amount: 1, occurredOn: '2026-01-14' })).status,
    ).toBe(400);
    const over = await admin.post('/api/v1/funds/payouts', {
      amount: 50_000,
      occurredOn: '2026-01-14',
      payeeId: society.id,
    });
    expect(over.body.error.message).toBe('Only ₹437.50 is owed to Society.');

    // Society paid out of the coach's cash; coach reimbursed by keeping some of the cash.
    const toSociety = await admin.post('/api/v1/funds/payouts', {
      amount: 43_750,
      occurredOn: '2026-01-14',
      payeeId: society.id,
      fromUserId: a.coach.id,
      reference: 'RCPT-9',
    });
    expect(toSociety.status).toBe(201);
    expect(toSociety.body.data.title).toBe(`Paid to Society from ${a.coach.name}’s cash`);
    const reimburse = await admin.post('/api/v1/funds/payouts', {
      amount: 20_000,
      occurredOn: '2026-01-14',
      userId: a.coach.id,
      fromUserId: a.coach.id,
    });
    expect(reimburse.status).toBe(201);
    const noCash = await admin.post('/api/v1/funds/payouts', {
      amount: 1,
      occurredOn: '2026-01-14',
      payeeId: society.id,
    });
    expect(noCash.status).toBe(422);
    expect(
      (
        await admin.post('/api/v1/funds/payouts', {
          amount: 1,
          occurredOn: '2026-01-14',
          payeeId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);

    expect(await overview(a.coach)).toMatchObject({
      cash: 125_000 - 43_750 - 20_000,
      due: 0,
      period: { paidToMe: 20_000 },
    });
    expect((await overview(a.admin)).balances).toMatchObject({
      owedToPayees: 0,
      owedToStaff: 0,
      payeeDue: [],
    });
    await expectBalanced();
  });

  it('coaches pay their batches’ payees from the cash they hold, never more', async () => {
    const a = await makeAcademy();
    await coachHolding(a); // coach holds ₹1,250; Society is owed ₹437.50
    const coach = await as(a.coach);
    const other = await as(a.otherCoach);

    const mine = (await coach.get('/api/v1/funds/payable').expect(200)).body.data;
    expect(mine.cash).toBe(125_000);
    expect(mine.payees).toEqual([expect.objectContaining({ name: 'Society', owed: 43_750 })]);
    const society = mine.payees[0].id as string;
    // A coach with no students on that plan can't see or pay it.
    expect((await other.get('/api/v1/funds/payable').expect(200)).body.data.payees).toEqual([]);
    await other
      .post('/api/v1/funds/payouts', { amount: 100, occurredOn: '2026-01-14', payeeId: society })
      .expect(403);

    // Only payees, only from their own cash, never more than owed.
    await coach
      .post('/api/v1/funds/payouts', { amount: 100, occurredOn: '2026-01-14', userId: a.coach.id })
      .expect(403);
    await coach
      .post('/api/v1/funds/payouts', {
        amount: 100,
        occurredOn: '2026-01-14',
        payeeId: society,
        fromUserId: a.otherCoach.id,
      })
      .expect(403);
    const over = await coach
      .post('/api/v1/funds/payouts', { amount: 50_000, occurredOn: '2026-01-14', payeeId: society })
      .expect(422);
    expect(over.body.error.message).toBe('Only ₹437.50 is owed to Society.');

    const paid = await coach
      .post('/api/v1/funds/payouts', { amount: 43_750, occurredOn: '2026-01-14', payeeId: society })
      .expect(201);
    expect(paid.body.data.title).toBe(`Paid to Society from ${a.coach.name}’s cash`);
    expect((await overview(a.coach)).cash).toBe(125_000 - 43_750);
    expect((await overview(a.admin)).balances.owedToPayees).toBe(0);
    await expectBalanced();
  });

  it('a coach cannot pay more than the cash they hold', async () => {
    const a = await makeAcademy();
    await coachHolding(a);
    const admin = await as(a.admin);
    const coach = await as(a.coach);
    const society = (await coach.get('/api/v1/funds/payable')).body.data.payees[0].id;
    // The coach hands most of the cash over, leaving ₹50.
    await admin
      .post('/api/v1/funds/handovers', {
        amount: 120_000,
        occurredOn: '2026-01-14',
        userId: a.coach.id,
      })
      .expect(201);
    const short = await coach
      .post('/api/v1/funds/payouts', { amount: 43_750, occurredOn: '2026-01-14', payeeId: society })
      .expect(422);
    expect(short.body.error.message).toBe('Only ₹50.00 in hand with this person.');
  });

  it('admins reverse wrong entries; fee splits are undone from the invoice', async () => {
    const a = await makeAcademy();
    await coachHolding(a);
    const coach = await as(a.coach);
    const admin = await as(a.admin);
    const h = (
      await coach.post('/api/v1/funds/handovers', { amount: 100_000, occurredOn: '2026-01-14' })
    ).body.data;

    expect(
      (await coach.post(`/api/v1/funds/txns/${h.id}/reverse`, { reason: 'Oops' })).status,
    ).toBe(403);
    expect((await admin.post(`/api/v1/funds/txns/${h.id}/reverse`, { reason: 'x' })).status).toBe(
      400,
    );
    const r = await admin.post(`/api/v1/funds/txns/${h.id}/reverse`, { reason: 'Never received' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      reversedById: a.admin.id,
      reversalReason: 'Never received',
    });
    expect(
      (await admin.post(`/api/v1/funds/txns/${h.id}/reverse`, { reason: 'Again' })).status,
    ).toBe(409);
    expect((await overview(a.coach)).cash).toBe(125_000);

    const split = (await admin.get('/api/v1/funds/txns?type=fee_split')).body.data[0];
    const blocked = await admin.post(`/api/v1/funds/txns/${split.id}/reverse`, { reason: 'Nope' });
    expect(blocked.status).toBe(422);
    expect(
      (
        await admin.post('/api/v1/funds/txns/00000000-0000-4000-8000-000000000000/reverse', {
          reason: 'Nope',
        })
      ).status,
    ).toBe(404);
    await expectBalanced();
  });
});

describe('ledger list and recalculation', () => {
  it('lists entries with names; coaches see only what involves them', async () => {
    const a = await makeAcademy();
    await setSplit(a);
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id);
    const admin = await as(a.admin);
    await admin.post('/api/v1/funds/income', {
      amount: 1_000,
      occurredOn: '2026-01-02',
      title: 'Donation',
    });
    await (
      await as(a.otherCoach)
    ).post('/api/v1/funds/expenses', {
      amount: 500,
      occurredOn: '2026-01-14',
      title: 'Tape',
      paidFrom: 'own',
    });

    const all = await admin.get('/api/v1/funds/txns?from=2026-01-01&to=2026-01-31&pageSize=10');
    expect(all.body.meta.total).toBe(3);
    const fee = all.body.data.find((t: { type: string }) => t.type === 'fee_split');
    expect(fee).toMatchObject({
      title: expect.stringMatching(/^Fee · ATQ\//),
      invoice: { id: inv.id, number: inv.number },
      user: { id: a.coach.id, name: a.coach.name },
      createdBy: { id: a.coach.id },
    });
    expect(
      fee.entries.map((e: { account: string; name: string; amount: number }) => [
        e.account,
        e.name,
        e.amount,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['cash', a.coach.name, 250_000],
        ['payee_due', 'Society', 43_750],
        ['academy_fund', 'Academy', 81_250],
        ['staff_due', a.coach.name, -125_000],
      ]),
    );
    expect((await admin.get(`/api/v1/funds/txns?type=income`)).body.data[0].entries[0].name).toBe(
      'Academy',
    );
    expect((await admin.get(`/api/v1/funds/txns?userId=${a.otherCoach.id}`)).body.meta.total).toBe(
      1,
    );
    const society = (await admin.get('/api/v1/funds/payees')).body.data[0];
    expect((await admin.get(`/api/v1/funds/txns?payeeId=${society.id}`)).body.meta.total).toBe(1);

    const mine = (await (await as(a.coach)).get('/api/v1/funds/txns')).body;
    expect(mine.meta.total).toBe(1);
    expect(mine.data[0].entries.every((e: { userId: string }) => e.userId === a.coach.id)).toBe(
      true,
    );
    expect(
      (await (await as(a.coach)).get('/api/v1/funds/txns?userId=' + a.otherCoach.id)).body.meta
        .total,
    ).toBe(1);
  });

  it('recalculates past payments with the current split, keeping who holds the cash', async () => {
    const a = await makeAcademy();
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id); // no split yet → all to the academy, coach holds ₹2,500
    await setSplit(a);
    const admin = await as(a.admin);
    expect(
      (await admin.post('/api/v1/funds/resplit', { from: '2026-01-31', to: '2026-01-01' })).status,
    ).toBe(400);
    const r = await admin.post('/api/v1/funds/resplit', {
      feePlanId: a.plan.id,
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(r.body.data).toEqual({ updated: 1 });
    expect((await overview(a.admin)).balances).toMatchObject({
      withStaff: 125_000,
      academyFund: 81_250,
      owedToPayees: 43_750,
    });
    const live = await db
      .select()
      .from(fundTxns)
      .where(and(eq(fundTxns.type, 'fee_split'), isNull(fundTxns.reversedAt)));
    expect(live).toHaveLength(1);

    // An academy-held payment stays with the academy.
    const inv2 = await (async () => {
      await generateDueInvoices('2026-02-10');
      const [i] = await db.select().from(invoices).where(eq(invoices.status, 'due'));
      return i!;
    })();
    setToday('2026-02-15');
    await (
      await as(a.admin)
    ).post(`/api/v1/invoices/${inv2.id}/payments`, { mode: 'upi', paidOn: '2026-02-12' });
    await admin.post('/api/v1/funds/resplit', { from: '2026-02-01', to: '2026-02-28' });
    const feb = (
      await (await as(a.admin)).get('/api/v1/funds/overview?from=2026-02-01&to=2026-02-28')
    ).body.data;
    expect(feb.balances.academyCash).toBe(250_000);
    await expectBalanced();
  });
});

describe('payments recorded without a split', () => {
  it('recalculation adds the missing split, with the cash where it was received', async () => {
    const a = await makeAcademy();
    await setSplit(a);
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id);
    await db.delete(fundTxns); // as if recorded before the ledger existed
    const admin = await as(a.admin);
    const r = await admin.post('/api/v1/funds/resplit', { from: '2026-01-01', to: '2026-01-31' });
    expect(r.body.data).toEqual({ updated: 1 });
    expect((await overview(a.admin)).balances).toMatchObject({
      withStaff: 125_000,
      academyFund: 81_250,
      owedToPayees: 43_750,
    });
    // Running it again only recalculates; nothing is duplicated.
    await admin.post('/api/v1/funds/resplit', { from: '2026-01-01', to: '2026-01-31' });
    expect((await overview(a.admin)).period.payments).toBe(1);
    await expectBalanced();
  });
});

describe('payees and overview validation', () => {
  it('creates, renames and protects payees', async () => {
    const a = await makeAcademy();
    const admin = await as(a.admin);
    const p = (
      await admin.post('/api/v1/funds/payees', { name: 'Ground owner', note: 'Monthly rent' })
    ).body.data;
    expect((await admin.post('/api/v1/funds/payees', { name: 'ground OWNER' })).status).toBe(409);
    const upd = await admin.patch(`/api/v1/funds/payees/${p.id}`, {
      name: 'Landlord',
      isActive: false,
    });
    expect(upd.body.data).toMatchObject({ name: 'Landlord', isActive: false });
    expect(
      (
        await admin.patch('/api/v1/funds/payees/00000000-0000-4000-8000-000000000000', {
          name: 'X',
        })
      ).status,
    ).toBe(404);
    expect((await (await as(a.coach)).get('/api/v1/funds/payees')).status).toBe(403);
  });

  it('rejects bad ranges and defaults to this month', async () => {
    const a = await makeAcademy();
    const admin = await as(a.admin);
    expect((await admin.get('/api/v1/funds/overview?from=2026-02-01&to=2026-01-01')).status).toBe(
      400,
    );
    expect((await admin.get('/api/v1/funds/overview?from=2020-01-01&to=2026-01-01')).status).toBe(
      400,
    );
    const d = (await admin.get('/api/v1/funds/overview')).body.data;
    expect(d).toMatchObject({ scope: 'academy', from: '2026-01-01', to: '2026-01-15' });
    expect(d.balances).toMatchObject({ academyCash: 0, holders: [], staffDue: [], payeeDue: [] });
  });

  it('rejects inactive or unknown staff', async () => {
    const a = await makeAcademy();
    const admin = await as(a.admin);
    const r = await admin.post('/api/v1/funds/handovers', {
      amount: 100,
      occurredOn: '2026-01-14',
      userId: '00000000-0000-4000-8000-000000000000',
    });
    expect(r.status).toBe(404);
  });
});

describe('migration backfill', () => {
  it('turns existing payments into academy fee splits held by the collector', async () => {
    const a = await makeAcademy();
    const inv = await dueInvoice(a);
    await pay(a.coach, inv.id);
    await generateDueInvoices('2026-02-10');
    const [inv2] = await db.select().from(invoices).where(eq(invoices.status, 'due'));
    setToday('2026-02-15');
    await pay(a.admin, inv2!.id, { paidOn: '2026-02-12' });

    // Start from an empty ledger, as before the migration, then replay its backfill.
    await db.delete(fundTxns);
    const file = readFileSync(path.join(__dirname, '../../drizzle/0006_funds.sql'), 'utf8');
    const backfill = file.slice(file.indexOf('-- Backfill')).split('--> statement-breakpoint');
    for (const stmt of backfill) await db.execute(sql.raw(stmt));

    const o = (
      await (await as(a.admin)).get('/api/v1/funds/overview?from=2026-01-01&to=2026-02-28')
    ).body.data;
    expect(o.balances).toMatchObject({
      academyCash: 250_000,
      withStaff: 250_000,
      academyFund: 500_000,
      holders: [{ userId: a.coach.id, amount: 250_000 }],
    });
    expect(o.period).toMatchObject({ collected: 500_000, payments: 2 });
    await expectBalanced();
  });
});
