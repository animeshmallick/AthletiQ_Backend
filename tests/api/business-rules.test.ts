import { describe, expect, it } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { invoices } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, makeAcademy, makeStudent, setToday, checkIn } from '../helpers/factories';

const MON = '2026-03-09';

describe('session cancellations (rain, holidays)', () => {
  async function setup() {
    const a = await makeAcademy();
    const s = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-02-01',
        billingStartsOn: '2026-02-01',
      },
      a.admin.id,
    );
    return { ...a, s };
  }

  it('lets the coach cancel a session and blocks marking and check-in', async () => {
    setToday(MON);
    const { coach, batch, s } = await setup();
    const api = await as(coach);

    const created = await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: MON, reason: 'Heavy rain' })
      .expect(201);
    expect(created.body.data).toMatchObject({ date: MON, reason: 'Heavy rain' });
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: MON, reason: 'Again' })
      .expect(409);

    const sheet = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${MON}`)
      .expect(200);
    expect(sheet.body.data).toMatchObject({ cancelled: { reason: 'Heavy rain' }, editable: false });
    const put = await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s.id, status: 'present' }],
      })
      .expect(422);
    expect(put.body.error.message).toMatch(/cancelled \(Heavy rain\)/);

    const overview = await api.get(`/api/v1/attendance/overview?date=${MON}`).expect(200);
    expect(overview.body.data.sessions[0].cancelled).toBe('Heavy rain');
    const today = await api.get('/api/v1/coach-sessions/today').expect(200);
    expect(today.body.data.sessions[0].cancelled).toBe('Heavy rain');
    await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(422);

    const list = await api
      .get(`/api/v1/batches/${batch.id}/cancellations?from=2026-03-01&to=2026-03-31`)
      .expect(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({ date: MON, cancelledBy: { id: coach.id, name: coach.name } }),
    ]);

    await api.delete(`/api/v1/batches/${batch.id}/cancellations/${MON}`).expect(204);
    await api.delete(`/api/v1/batches/${batch.id}/cancellations/${MON}`).expect(404);
    await checkIn(coach.id, batch.id, MON); // the session is back on: check in, then mark
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s.id, status: 'present' }],
      })
      .expect(200);
  });

  it('refuses to cancel a session that already happened, or invalid dates', async () => {
    setToday(MON);
    const { coach, admin, otherCoach, batch, s } = await setup();
    const api = await as(coach);
    await checkIn(coach.id, batch.id, MON);
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s.id, status: 'present' }],
      })
      .expect(200);
    const happened = await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: MON, reason: 'Rain' })
      .expect(422);
    expect(happened.body.error.message).toMatch(/already recorded/);

    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-15', reason: 'Sunday' })
      .expect(422); // not a session day
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-02-23', reason: 'Old' })
      .expect(422); // coach > 7 days back
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-08-03', reason: 'Far' })
      .expect(422); // > 90 days ahead
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-10', reason: 'x' })
      .expect(400); // reason too short
    await (
      await as(otherCoach)
    )
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-10', reason: 'Rain' })
      .expect(404);
    await (
      await as(admin)
    )
      .post(`/api/v1/batches/${batch.id}/cancellations`, {
        date: '2026-02-23',
        reason: 'Back-dated holiday',
      })
      .expect(201);
  });

  it('excludes cancelled sessions from weekly feedback, the register and the plan calendar', async () => {
    setToday('2026-03-16');
    const { coach, admin, batch, s } = await setup();
    await (
      await as(admin)
    )
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-11', reason: 'Holi' })
      .expect(201);
    const api = await as(coach);

    const report = await api.get(`/api/v1/feedback/students/${s.id}/weeks/2026-03-09`).expect(200);
    expect(report.body.data.attendance.scheduled).toBe(5); // Mon–Sat (the batch's days) minus Wednesday
    const register = await api
      .get(`/api/v1/attendance/register?batchId=${batch.id}&from=2026-03-09&to=2026-03-15`)
      .expect(200);
    expect(register.body.data.cancelled).toEqual({ '2026-03-11': 'Holi' });
    const session = await api
      .get(`/api/v1/lessons/session?batchId=${batch.id}&date=2026-03-11`)
      .expect(200);
    expect(session.body.data.lockedReason).toContain('Holi');
  });
});

describe('rejoining after leaving', () => {
  it('restarts billing from the rejoin date as a new batch membership', async () => {
    setToday('2026-04-01');
    const a = await makeAcademy();
    const s = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-10',
        billingStartsOn: '2026-01-10',
      },
      a.admin.id,
    );
    const api = await as(a.admin);
    await api.post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-20' }).expect(200);
    await generateDueInvoices('2026-04-01');

    await api
      .post(`/api/v1/students/${s.id}/rejoin`, {
        rejoinDate: '2026-03-20',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(400);
    await api
      .post(`/api/v1/students/${s.id}/rejoin`, { rejoinDate: '2026-05-05', batches: [] })
      .expect(400);
    const res = await api
      .post(`/api/v1/students/${s.id}/rejoin`, {
        rejoinDate: '2026-05-05',
        batches: [{ batchId: a.otherBatch.id, monthlyDiscount: 50_000 }],
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      status: 'active',
      leftOn: null,
      memberships: [
        {
          batchId: a.otherBatch.id,
          since: '2026-05-05',
          billingDay: 5,
          fee: { total: 200_000, discount: 50_000 },
        },
      ],
    });
    expect(res.body.data.enrollmentHistory[0]).toMatchObject({
      batchId: a.otherBatch.id,
      effectiveFrom: '2026-05-05',
      reason: 'Rejoined',
    });
    await api
      .post(`/api/v1/students/${s.id}/rejoin`, {
        rejoinDate: '2026-06-01',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(422);

    await generateDueInvoices('2026-07-10');
    const rows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.studentId, s.id))
      .orderBy(asc(invoices.issueDate));
    // Prepaid: the month in progress at leaving (10 Mar) was billed; the new membership's first
    // month was billed at rejoin (1 Apr), ahead of training restarting on 5 May.
    expect(rows.map((r) => [r.cycleNumber, r.periodStart, r.issueDate, r.totalAmount])).toEqual([
      [1, '2026-01-10', '2026-01-10', 250_000],
      [2, '2026-02-10', '2026-02-10', 250_000],
      [3, '2026-03-10', '2026-03-10', 250_000],
      [1, '2026-05-05', '2026-04-01', 200_000],
      [2, '2026-06-05', '2026-06-05', 200_000],
      [3, '2026-07-05', '2026-07-05', 200_000],
    ]);

    setToday('2026-07-10');
    const projection = await (
      await as(a.admin)
    )
      .get('/api/v1/finance/projection?days=30')
      .expect(200);
    expect(projection.body.data.invoices[0]).toMatchObject({
      studentId: s.id,
      issueDate: '2026-08-05',
    });
  });

  it('validates rejoin requests', async () => {
    const a = await makeAcademy();
    const s = await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id }, a.admin.id);
    const api = await as(a.admin);
    await api
      .post(`/api/v1/students/${s.id}/rejoin`, {
        rejoinDate: '2026-05-01',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(422);
    await api
      .post('/api/v1/students/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/rejoin', {
        rejoinDate: '2026-05-01',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(404);
    await (
      await as(a.coach)
    )
      .post(`/api/v1/students/${s.id}/rejoin`, {
        rejoinDate: '2026-05-01',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(403);
  });
});

describe('deleting a student created by mistake', () => {
  it('deletes a clean record but protects one with history', async () => {
    setToday(MON);
    const a = await makeAcademy();
    const dup = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, fullName: 'Duplicate' },
      a.admin.id,
    );
    const real = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-02-01',
        billingStartsOn: '2026-02-01',
      },
      a.admin.id,
    );
    const api = await as(a.admin);
    await api
      .put('/api/v1/attendance/session', {
        batchId: a.batch.id,
        date: MON,
        records: [{ studentId: real.id, status: 'present' }],
      })
      .expect(200);

    await (await as(a.coach)).delete(`/api/v1/students/${dup.id}`).expect(403);
    await api.delete(`/api/v1/students/${dup.id}`).expect(204);
    await api.get(`/api/v1/students/${dup.id}`).expect(404);
    const blocked = await api.delete(`/api/v1/students/${real.id}`).expect(422);
    expect(blocked.body.error.details).toEqual({ invoices: 0, attendance: 1, feedback: 0 });
    await api.delete(`/api/v1/students/${dup.id}`).expect(404);
  });
});

describe('collections follow-up', () => {
  it('filters and sorts students by dues', async () => {
    setToday('2026-03-15');
    const a = await makeAcademy();
    const late = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-10',
        billingStartsOn: '2026-01-10',
        fullName: 'Late Payer',
      },
      a.admin.id,
    );
    const recent = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-03-12',
        billingStartsOn: '2026-03-12',
        fullName: 'Recent Joiner',
      },
      a.admin.id,
    );
    await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-03-20',
        billingStartsOn: '2026-03-20',
        fullName: 'No Invoice',
      },
      a.admin.id,
    );
    await generateDueInvoices('2026-03-15');
    const api = await as(a.coach);

    const overdue = await api.get('/api/v1/students?dues=overdue').expect(200);
    expect(overdue.body.data.map((s: { id: string }) => s.id)).toEqual([late.id]);
    const outstanding = await api.get('/api/v1/students?dues=outstanding&sort=dues').expect(200);
    expect(outstanding.body.data.map((s: { id: string }) => s.id)).toEqual([late.id, recent.id]);
    expect(outstanding.body.meta.total).toBe(2);
  });
});

describe('invoice adjustments (admin)', () => {
  it('applies a one-off concession, and a full waiver settles the invoice', async () => {
    const a = await makeAcademy();
    await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-10',
        billingStartsOn: '2026-01-10',
      },
      a.admin.id,
    );
    await generateDueInvoices('2026-03-15');
    const [inv1, inv2] = await db.select().from(invoices).orderBy(asc(invoices.cycleNumber));
    const api = await as(a.admin);

    await (
      await as(a.coach)
    )
      .post(`/api/v1/invoices/${inv1!.id}/adjust`, {
        discountAmount: 50_000,
        reason: 'Missed week',
      })
      .expect(403);
    await api
      .post(`/api/v1/invoices/${inv1!.id}/adjust`, { discountAmount: 50_000, reason: 'x' })
      .expect(400);
    await api
      .post(`/api/v1/invoices/${inv1!.id}/adjust`, { discountAmount: 999_999, reason: 'Too much' })
      .expect(400);
    const adjusted = await api
      .post(`/api/v1/invoices/${inv1!.id}/adjust`, {
        discountAmount: 50_000,
        reason: 'Missed a week (injury)',
      })
      .expect(200);
    expect(adjusted.body.data).toMatchObject({
      discountAmount: 50_000,
      totalAmount: 200_000,
      status: 'due',
    });

    const waived = await api
      .post(`/api/v1/invoices/${inv2!.id}/adjust`, {
        discountAmount: 250_000,
        reason: 'Scholarship month',
      })
      .expect(200);
    expect(waived.body.data).toMatchObject({ totalAmount: 0, status: 'paid' });
    await api
      .post(`/api/v1/invoices/${inv2!.id}/adjust`, { discountAmount: 0, reason: 'Undo please' })
      .expect(409);
    await api
      .post('/api/v1/invoices/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/adjust', {
        discountAmount: 0,
        reason: 'Nothing',
      })
      .expect(404);

    const logs = await api
      .get(`/api/v1/admin/audit-logs?entityType=invoice&entityId=${inv1!.id}`)
      .expect(200);
    expect(logs.body.data[0]).toMatchObject({
      action: 'invoice.adjusted',
      metadata: { before: { totalAmount: 250_000 }, reason: 'Missed a week (injury)' },
    });
  });
});
