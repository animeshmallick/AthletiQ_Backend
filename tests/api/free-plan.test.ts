import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { invoices } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, makeAcademy, makeStudent } from '../helpers/factories';

describe('the built-in free plan', () => {
  it('is offered for batches on any days, hidden from the Fee plans page and not editable', async () => {
    const { admin, coach, location, batch, plan } = await makeAcademy();
    const api = await as(admin);

    const forBatch = (await api.get('/api/v1/fee-plans?active=true&forBatch=true').expect(200)).body
      .data;
    const free = forBatch[0];
    expect(free).toMatchObject({ name: 'Free', monthlyFee: 0, isSystem: true });
    // Asking again doesn't create a second one.
    const again = (await api.get('/api/v1/fee-plans?forBatch=true').expect(200)).body.data;
    expect(again.filter((p: { isSystem: boolean }) => p.isSystem)).toHaveLength(1);
    // The Fee plans page doesn't list it.
    const page = (await api.get('/api/v1/fee-plans').expect(200)).body.data;
    expect(page.map((p: { id: string }) => p.id)).toEqual([plan.id]);
    // Built in: can't be edited or split.
    await api.patch(`/api/v1/fee-plans/${free.id}`, { monthlyFee: 100 }).expect(422);
    await api.put(`/api/v1/fee-plans/${free.id}/split`, { sections: [] }).expect(422);

    // Fits a batch on any number of days.
    const created = await api
      .post('/api/v1/batches', {
        name: 'Free Saturdays',
        coachId: coach.id,
        locationId: location.id,
        weekdays: [6],
        startTime: '07:00',
        endTime: '08:00',
        capacity: 30,
        sportId: batch.sportId,
        feePlanId: free.id,
      })
      .expect(201);

    // Students in it never get invoices.
    const s = await makeStudent(
      {
        batchId: created.body.data.id,
        joiningDate: '2026-01-10',
        billingStartsOn: '2026-01-10',
      },
      admin.id,
    );
    expect((await generateDueInvoices('2026-04-10')).freeCycles).toBe(4);
    expect(await db.select().from(invoices)).toEqual([]);
    const detail = (await api.get(`/api/v1/students/${s.id}`).expect(200)).body.data;
    expect(detail.memberships[0]).toMatchObject({ fee: { total: 0 }, nextInvoice: null });
  });

  it('takes another name if the academy already has a plan called Free', async () => {
    const { admin } = await makeAcademy();
    const api = await as(admin);
    await api
      .post('/api/v1/fee-plans', { name: 'free', daysPerWeek: 3, monthlyFee: 100 })
      .expect(201);
    const list = (await api.get('/api/v1/fee-plans?forBatch=true').expect(200)).body.data;
    expect(list.find((p: { isSystem: boolean }) => p.isSystem).name).toBe('Free (no fee)');
  });
});
