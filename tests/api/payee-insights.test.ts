import { describe, expect, it } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { invoices, students } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

/**
 * ₹2,500 fee: Society gets 50% × 35% = ₹437.50 of each fee (Academy 50% → Society 35%), the
 * batch coach the other 50%.
 */
async function setup() {
  setToday('2026-03-20');
  const a = await makeAcademy();
  const admin = await as(a.admin);
  const society = (await admin.post('/api/v1/funds/payees', { name: 'Society' })).body.data as {
    id: string;
  };
  await admin
    .put(`/api/v1/fee-plans/${a.plan.id}/split`, {
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
    })
    .expect(200);
  for (const fullName of ['Asha', 'Bilal'])
    await makeStudent(
      {
        fullName,
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-10',
        billingStartsOn: '2026-01-10',
      },
      a.admin.id,
    );
  await generateDueInvoices('2026-03-20');
  const inv = await db
    .select({ id: invoices.id, name: students.fullName, start: invoices.periodStart })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .orderBy(asc(invoices.periodStart), asc(students.fullName));
  const pay = async (i: (typeof inv)[number], paidOn: string) =>
    (await admin.post(`/api/v1/invoices/${i.id}/payments`, { mode: 'upi', paidOn }).expect(200))
      .body.data.payments[0].id as string;
  return { ...a, admin, society, inv, pay };
}

describe('payee insights', () => {
  it('totals shares, payouts, what is owed and since when, by month and source', async () => {
    const { admin, society, inv, pay, plan } = await setup();
    // Jan: Asha + Bilal paid. Feb: Asha paid, then reverted. Mar: Bilal paid.
    await pay(inv[0]!, '2026-01-12');
    await pay(inv[1]!, '2026-01-13');
    const febAsha = inv.find((i) => i.start === '2026-02-10' && i.name === 'Asha')!;
    const reverted = await pay(febAsha, '2026-02-11');
    await admin
      .post(`/api/v1/invoices/${febAsha.id}/payments/${reverted}/revert`, { reason: 'Bounced' })
      .expect(200);
    await pay(
      inv.find((i) => i.start === '2026-03-10' && i.name === 'Bilal')!,
      '2026-03-11',
    );
    // Society paid for January.
    await admin
      .post('/api/v1/funds/payouts', {
        amount: 87_500,
        occurredOn: '2026-02-01',
        payeeId: society.id,
        reference: 'NEFT-1',
      })
      .expect(201);

    const data = (await admin.get(`/api/v1/funds/payees/${society.id}/insights`).expect(200)).body
      .data;
    expect(data.summary).toMatchObject({
      owedNow: 43_750, // March share
      unpaidSince: '2026-03-11',
      unpaidDays: 9,
      earned: 131_250, // 3 live shares
      paid: 87_500,
      lifetimeEarned: 131_250,
      lifetimePaid: 87_500,
      payouts: 1,
      shares: 3,
      students: 2,
      lastPayout: { date: '2026-02-01', amount: 87_500 },
      // Two current students at ₹437.50 each.
      expectedMonthly: 87_500,
      payoutRate: 67,
    });
    expect(data.monthly).toEqual([
      { month: '2026-01', earned: 87_500, paid: 0 },
      { month: '2026-02', earned: 0, paid: 87_500 },
      { month: '2026-03', earned: 43_750, paid: 0 },
    ]);
    expect(
      data.sources.byStudent.map((s: { name: string; amount: number }) => [s.name, s.amount]),
    ).toEqual([
      ['Bilal', 87_500],
      ['Asha', 43_750],
    ]);
    expect(data.sources.byPlan[0]).toMatchObject({ id: plan.id, amount: 131_250, count: 3 });
    expect(data.plans).toEqual([
      expect.objectContaining({
        id: plan.id,
        perStudent: 43_750,
        students: 2,
        expectedMonthly: 87_500,
      }),
    ]);
    // Newest first, with the running balance; the reverted share is shown but not counted.
    const h = data.history as {
      kind: string;
      amount: number;
      balance: number;
      reversed: boolean;
      date: string;
    }[];
    expect(h.map((x) => [x.date, x.kind, x.amount, x.reversed, x.balance])).toEqual([
      ['2026-03-11', 'share', 43_750, false, 43_750],
      ['2026-02-11', 'share', 43_750, true, 0],
      ['2026-02-01', 'payout', -87_500, false, 0],
      ['2026-01-13', 'share', 43_750, false, 87_500],
      ['2026-01-12', 'share', 43_750, false, 43_750],
    ]);
    expect(data.history[0].title).toBe('Share of Bilal’s fee');
    expect(data.history[2].title).toBe('Paid from academy cash');
    expect(data.history[2].detail).toContain('Ref NEFT-1');
  });

  it('limits to a period, with opening and closing balances', async () => {
    const { admin, society, inv, pay } = await setup();
    await pay(inv[0]!, '2026-01-12');
    await pay(
      inv.find((i) => i.start === '2026-02-10')!,
      '2026-02-11',
    );
    const feb = (
      await admin.get(`/api/v1/funds/payees/${society.id}/insights?from=2026-02-01&to=2026-02-28`)
    ).body.data;
    expect(feb.summary).toMatchObject({
      opening: 43_750,
      earned: 43_750,
      paid: 0,
      closing: 87_500,
    });
    expect(feb.history).toHaveLength(1);
    expect(feb.monthly).toEqual([{ month: '2026-02', earned: 43_750, paid: 0 }]);
    await admin
      .get(`/api/v1/funds/payees/${society.id}/insights?from=2026-03-01&to=2026-02-01`)
      .expect(400);
  });

  it('lists payees with their totals and downloads a statement', async () => {
    const { admin, society, inv, pay } = await setup();
    await pay(inv[0]!, '2026-01-12');
    await admin.post('/api/v1/funds/payees', { name: 'Ground owner' }).expect(201);
    const list = (await admin.get('/api/v1/funds/payees/summary?from=2026-01-01').expect(200)).body
      .data;
    expect(
      list.map((p: { name: string; owedNow: number; plans: number }) => [
        p.name,
        p.owedNow,
        p.plans,
      ]),
    ).toEqual([
      ['Society', 43_750, 1],
      ['Ground owner', 0, 0],
    ]);
    const pdf = await admin
      .get(`/api/v1/funds/payees/${society.id}/statement?from=2026-01-01&to=2026-03-31`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('Statement-Society.pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('is for admins only and 404s for unknown payees', async () => {
    const { coach, admin, society } = await setup();
    await (await as(coach)).get(`/api/v1/funds/payees/${society.id}/insights`).expect(403);
    await admin
      .get('/api/v1/funds/payees/00000000-0000-4000-8000-000000000000/insights')
      .expect(404);
  });
});

describe('payee insights across a year end', () => {
  it('lists every month from December into the new year', async () => {
    setToday('2026-02-20');
    const a = await makeAcademy();
    const admin = await as(a.admin);
    const p = (await admin.post('/api/v1/funds/payees', { name: 'Ground' })).body.data as {
      id: string;
    };
    const data = (
      await admin
        .get(`/api/v1/funds/payees/${p.id}/insights?from=2025-12-01&to=2026-02-20`)
        .expect(200)
    ).body.data;
    expect(data.monthly.map((m: { month: string }) => m.month)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(data.summary).toMatchObject({
      owedNow: 0,
      unpaidSince: null,
      payoutRate: null,
      lastPayout: null,
    });
    expect(data.plans).toEqual([]);
  });
});
