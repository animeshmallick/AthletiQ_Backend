import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batches } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import {
  as,
  makeAcademy,
  makeLocation,
  makePlan,
  makeSport,
  makeStudent,
  setToday,
} from '../helpers/factories';

type Row = {
  number: string;
  totalAmount: number;
  student: { fullName: string };
  batchName: string;
};

async function setup() {
  setToday('2026-03-20');
  const a = await makeAcademy();
  const chess = await makeSport('Chess');
  const club = await makeLocation({ name: 'Club' });
  const cheap = await makePlan({ daysPerWeek: 6, monthlyFee: 100_000 });
  // Other batch: Chess at the Club on a cheaper plan.
  await db
    .update(batches)
    .set({ sportId: chess.id, locationId: club.id, feePlanId: cheap.id })
    .where(eq(batches.id, a.otherBatch.id));
  // Bea: Jan–Mar in the main batch (₹2,500). Cal: Mar only, in the chess batch (₹1,000).
  await makeStudent(
    {
      fullName: 'Bea',
      batchId: a.batch.id,
      joiningDate: '2026-01-05',
      billingStartsOn: '2026-01-05',
    },
    a.admin.id,
  );
  await makeStudent(
    {
      fullName: 'Cal',
      batchId: a.otherBatch.id,
      joiningDate: '2026-03-10',
      billingStartsOn: '2026-03-10',
    },
    a.admin.id,
  );
  await generateDueInvoices('2026-03-20');
  const api = await as(a.admin);
  const list = async (query: string) =>
    (await api.get(`/api/v1/invoices?${query}`).expect(200)).body as {
      data: Row[];
      meta: { total: number; totalAmount: number };
    };
  return { ...a, chess, club, cheap, api, list };
}

describe('invoice filters and sorting', () => {
  it('filters by sport, location, fee plan and billing month', async () => {
    const { list, chess, club, cheap, plan, api } = await setup();
    expect((await list('')).meta.total).toBe(4);
    const bySport = await list(`sportId=${chess.id}`);
    expect(bySport.data.map((r) => r.student.fullName)).toEqual(['Cal']);
    expect((await list(`locationId=${club.id}`)).meta.total).toBe(1);
    expect((await list(`feePlanId=${cheap.id}`)).meta.total).toBe(1);
    expect((await list(`feePlanId=${plan.id}`)).meta).toMatchObject({
      total: 3,
      totalAmount: 750_000,
    });
    const march = await list('month=2026-03');
    expect(march.data.map((r) => r.student.fullName).sort()).toEqual(['Bea', 'Cal']);
    await api.get('/api/v1/invoices?month=2026-13').expect(400);
  });

  it('filters by how long an invoice is overdue and by amount', async () => {
    const { list } = await setup();
    // Due 7 days after the month starts: Jan 12 (67 days late), Feb 12 (36), Mar 12 (8), Mar 17 (3).
    expect((await list('overdueBy=60%2B')).meta.total).toBe(1);
    expect((await list('overdueBy=31-60')).meta.total).toBe(1);
    expect((await list('overdueBy=1-30')).meta.total).toBe(2);
    expect((await list('amountMin=200000')).meta.total).toBe(3);
    expect((await list('amountMax=100000')).meta.total).toBe(1);
  });

  it('sorts by amount, student and number', async () => {
    const { list } = await setup();
    expect((await list('sort=amountAsc')).data[0]!.totalAmount).toBe(100_000);
    expect((await list('sort=amountDesc')).data[0]!.totalAmount).toBe(250_000);
    expect((await list('sort=studentAsc')).data.map((r) => r.student.fullName)).toEqual([
      'Bea',
      'Bea',
      'Bea',
      'Cal',
    ]);
    const asc = (await list('sort=numberAsc')).data.map((r) => r.number);
    expect([...asc].sort()).toEqual(asc);
    expect((await list('sort=numberDesc')).data.map((r) => r.number)).toEqual([...asc].reverse());
    expect((await list('sort=issueDateAsc')).data[0]!.number).toBe(asc[0]);
  });
});
