import { describe, expect, it, jest } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client';
import { invoices, jobRuns, students } from '../../src/db/schema';
import * as lock from '../../src/jobs/advisory-lock';
import { runExclusive } from '../../src/jobs/job-runner';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, getApp, makeAcademy, makePlan, makeStudent, setToday } from '../helpers/factories';

async function academyWithStudent(
  overrides: Parameters<typeof makeStudent>[0] extends infer T ? Partial<T> : never = {},
) {
  const a = await makeAcademy();
  const student = await makeStudent(
    {
      batchId: a.batch.id,
      feePlanId: a.plan.id,
      joiningDate: '2026-01-10',
      billingStartsOn: '2026-01-10',
      guardianName: 'Parent',
      ...overrides,
    },
    a.admin.id,
  );
  return { ...a, student };
}

const allInvoices = () => db.select().from(invoices).orderBy(asc(invoices.cycleNumber));

describe('invoice generation', () => {
  it('bills in advance (first month at acceptance), snapshots pricing, and is idempotent', async () => {
    const { student, batch, coach } = await academyWithStudent({ monthlyDiscount: 20_000 });

    const first = await generateDueInvoices('2026-03-09');
    expect(first).toMatchObject({ invoicesCreated: 2, skippedExisting: 0, failures: [] });

    const rows = await allInvoices();
    expect(rows.map((r) => [r.number, r.periodStart, r.periodEnd, r.issueDate, r.dueDate])).toEqual(
      [
        ['ATQ/2025-26/00001', '2026-01-10', '2026-02-09', '2026-01-10', '2026-01-17'],
        ['ATQ/2025-26/00002', '2026-02-10', '2026-03-09', '2026-02-10', '2026-02-17'],
      ],
    );
    expect(rows[0]).toMatchObject({
      studentId: student.id,
      batchId: batch.id,
      coachId: coach.id,
      baseAmount: 250_000,
      discountAmount: 20_000,
      totalAmount: 230_000,
      status: 'due',
    });

    expect((await generateDueInvoices('2026-03-09')).invoicesCreated).toBe(0);

    // New financial year restarts numbering.
    await generateDueInvoices('2026-04-10');
    expect((await allInvoices()).at(-1)!.number).toBe('ATQ/2026-27/00001');
  });

  it('numbers invoices chronologically across students', async () => {
    const a = await academyWithStudent(); // joined 10 Jan
    const early = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-05',
        billingStartsOn: '2026-01-05',
      },
      a.admin.id,
    );
    await generateDueInvoices('2026-03-09');
    const rows = await db.select().from(invoices).orderBy(asc(invoices.number));
    expect(rows.map((r) => [r.issueDate, r.studentId])).toEqual([
      ['2026-01-05', early.id],
      ['2026-01-10', a.student.id],
      ['2026-02-05', early.id],
      ['2026-02-10', a.student.id],
      ['2026-03-05', early.id],
    ]);
  });

  it('keeps old invoices unchanged when the fee changes later', async () => {
    const { admin, student } = await academyWithStudent();
    await generateDueInvoices('2026-01-10');
    const pricier = await makePlan({ monthlyFee: 400_000 });
    await (
      await as(admin)
    )
      .patch(`/api/v1/students/${student.id}`, { feePlanId: pricier.id })
      .expect(200);
    await generateDueInvoices('2026-02-10');
    expect((await allInvoices()).map((r) => r.totalAmount)).toEqual([250_000, 400_000]);
  });

  it('settles zero-amount cycles automatically', async () => {
    await academyWithStudent({ customMonthlyFee: 0 });
    await generateDueInvoices('2026-01-10');
    expect((await allInvoices())[0]).toMatchObject({ totalAmount: 0, status: 'paid' });
  });

  it('stops billing after a student leaves (the month in progress was prepaid)', async () => {
    const { admin, student } = await academyWithStudent();
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${student.id}/leave`, { leftOn: '2026-03-20' })
      .expect(200);
    await generateDueInvoices('2026-06-30');
    expect((await allInvoices()).map((r) => r.cycleNumber)).toEqual([1, 2, 3]);
  });

  it('snapshots the batch the student was in during the cycle', async () => {
    const { admin, student, otherBatch, otherCoach } = await academyWithStudent();
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${student.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-02-20',
      })
      .expect(200);
    await generateDueInvoices('2026-03-10');
    const rows = await allInvoices();
    expect(rows[1]).toMatchObject({ batchId: otherBatch.id, coachId: otherCoach.id });
  });

  it('records per-student failures and continues', async () => {
    await academyWithStudent();
    const spy = jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('boom'));
    const stats = await generateDueInvoices('2026-03-15');
    spy.mockRestore();
    expect(stats.failures).toEqual([expect.objectContaining({ cycleNumber: 1, error: 'boom' })]);
    expect(stats.invoicesCreated).toBe(0); // later cycles wait for the next run to stay in order
    expect((await generateDueInvoices('2026-03-15')).invoicesCreated).toBe(3);
  });

  it('treats a concurrent duplicate as already generated', async () => {
    await academyWithStudent();
    const dup = Object.assign(new Error('dup'), {
      cause: { code: '23505', constraint: 'invoices_student_cycle_uq' },
    });
    const spy = jest.spyOn(db, 'transaction').mockRejectedValueOnce(dup);
    const stats = await generateDueInvoices('2026-01-10');
    spy.mockRestore();
    expect(stats).toMatchObject({ invoicesCreated: 0, skippedExisting: 1 });
  });
});

describe('invoice job runner (admin)', () => {
  it('runs on demand and records the run', async () => {
    setToday('2026-03-15');
    const { admin } = await academyWithStudent();
    const api = await as(admin);
    const res = await api.post('/api/v1/admin/jobs/invoices/run').expect(200);
    expect(res.body.data).toMatchObject({
      ran: true,
      stats: { invoicesCreated: 3, runDate: '2026-03-15' },
    });
    const runs = await api.get('/api/v1/admin/jobs/runs?jobName=invoice-generation').expect(200);
    expect(runs.body.data[0]).toMatchObject({ status: 'succeeded', trigger: 'manual' });
  });

  it('skips when another instance holds the lock', async () => {
    const { admin } = await academyWithStudent();
    jest.mocked(lock.tryAdvisoryLock).mockResolvedValueOnce(null);
    const res = await (await as(admin)).post('/api/v1/admin/jobs/invoices/run').expect(200);
    expect(res.body.data).toEqual({ ran: false, reason: 'Job is already running' });
  });

  it('marks failed runs and releases the lock', async () => {
    const release = jest.fn(async () => undefined);
    jest.mocked(lock.tryAdvisoryLock).mockResolvedValueOnce({ release });
    await expect(
      runExclusive('invoice-generation', 'manual', async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    expect(release).toHaveBeenCalled();
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run!.error).toMatch(/db down/);
  });

  it('is admin-only', async () => {
    const { coach } = await academyWithStudent();
    await (await as(coach)).post('/api/v1/admin/jobs/invoices/run').expect(403);
  });
});

describe('invoices API', () => {
  async function billed() {
    const a = await academyWithStudent();
    const other = await makeStudent(
      {
        batchId: a.otherBatch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-12',
        billingStartsOn: '2026-01-12',
        fullName: 'Zoya Other',
      },
      a.admin.id,
    );
    await generateDueInvoices('2026-02-12');
    const [inv1, inv2] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.studentId, a.student.id))
      .orderBy(asc(invoices.cycleNumber));
    return { ...a, other, inv1: inv1!, inv2: inv2! };
  }

  it('lists with status filters, search and coach scoping', async () => {
    setToday('2026-02-15');
    const { admin, coach, student, other } = await billed();
    const api = await as(admin);

    const all = await api.get('/api/v1/invoices').expect(200);
    expect(all.body.meta).toMatchObject({ total: 4, totalAmount: 1_000_000 });
    expect(all.body.data[0].issueDate).toBe('2026-02-12');

    const overdue = await api.get('/api/v1/invoices?status=overdue&sort=dueDateAsc').expect(200);
    expect(overdue.body.data.map((i: { displayStatus: string }) => i.displayStatus)).toEqual([
      'overdue',
      'overdue',
    ]);
    const due = await api.get('/api/v1/invoices?status=due').expect(200);
    expect(due.body.data.every((i: { displayStatus: string }) => i.displayStatus === 'due')).toBe(
      true,
    );
    expect(
      (await api.get('/api/v1/invoices?status=open&sort=amountDesc').expect(200)).body.meta.total,
    ).toBe(4);
    expect((await api.get('/api/v1/invoices?search=zoya').expect(200)).body.meta.total).toBe(2);
    expect(
      (
        await api
          .get(`/api/v1/invoices?studentId=${other.id}&from=2026-02-01&to=2026-02-28`)
          .expect(200)
      ).body.meta.total,
    ).toBe(1);
    expect(
      (await api.get(`/api/v1/invoices?coachId=${coach.id}`).expect(200)).body.meta.total,
    ).toBe(2);
    expect((await api.get('/api/v1/invoices?status=paid').expect(200)).body.meta.total).toBe(0);

    const coachList = await (await as(coach)).get('/api/v1/invoices').expect(200);
    expect(
      coachList.body.data.every((i: { student: { id: string } }) => i.student.id === student.id),
    ).toBe(true);
  });

  it('marks paid (coach), reverts and refunds (admin only), with full history', async () => {
    setToday('2026-02-15');
    const { admin, coach, otherCoach, inv1 } = await billed();
    const coachApi = await as(coach);
    const adminApi = await as(admin);
    const url = `/api/v1/invoices/${inv1.id}`;

    await (await as(otherCoach)).get(url).expect(404);
    await coachApi.post(`${url}/payments`, { mode: 'upi', paidOn: '2026-02-20' }).expect(400);
    await coachApi.post(`${url}/payments`, { mode: 'upi', paidOn: '2025-12-01' }).expect(400);
    const paid = await coachApi
      .post(`${url}/payments`, { mode: 'upi', reference: 'UTR42', paidOn: '2026-02-14' })
      .expect(200);
    expect(paid.body.data).toMatchObject({
      status: 'paid',
      displayStatus: 'paid',
      payments: [
        expect.objectContaining({
          status: 'completed',
          amount: 250_000,
          recordedBy: { id: coach.id, name: coach.name },
        }),
      ],
    });
    const again = await coachApi
      .post(`${url}/payments`, { mode: 'cash', paidOn: '2026-02-14' })
      .expect(409);
    expect(again.body.error.message).toBe('This invoice is already paid');

    const paymentId = paid.body.data.payments[0].id as string;
    await coachApi.post(`${url}/payments/${paymentId}/revert`, { reason: 'Mistake' }).expect(403);
    await adminApi.post(`${url}/payments/${paymentId}/revert`, { reason: 'x' }).expect(400);
    const reverted = await adminApi
      .post(`${url}/payments/${paymentId}/revert`, { reason: 'Marked by mistake' })
      .expect(200);
    expect(reverted.body.data).toMatchObject({
      status: 'due',
      paidAt: null,
      payments: [
        expect.objectContaining({ status: 'reverted', reversalReason: 'Marked by mistake' }),
      ],
    });
    await adminApi
      .post(`${url}/payments/${paymentId}/refund`, { reason: 'Already reverted' })
      .expect(409);

    const repaid = await coachApi
      .post(`${url}/payments`, { mode: 'cash', paidOn: '2026-02-15' })
      .expect(200);
    const second = repaid.body.data.payments.find(
      (p: { status: string }) => p.status === 'completed',
    ).id as string;
    const refunded = await adminApi
      .post(`${url}/payments/${second}/refund`, { reason: 'Left academy' })
      .expect(200);
    expect(refunded.body.data.status).toBe('refunded');
    expect(refunded.body.data.payments).toHaveLength(2);
    await adminApi
      .post(`${url}/payments/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/refund`, { reason: 'nope' })
      .expect(404);
    const cannotPay = await coachApi
      .post(`${url}/payments`, { mode: 'cash', paidOn: '2026-02-15' })
      .expect(409);
    expect(cannotPay.body.error.message).toBe('This invoice is refunded');
  });

  it('cancels unpaid invoices (admin only)', async () => {
    setToday('2026-02-15');
    const { admin, coach, inv1, inv2 } = await billed();
    await (
      await as(coach)
    )
      .post(`/api/v1/invoices/${inv1.id}/cancel`, { reason: 'Waived' })
      .expect(403);
    const res = await (
      await as(admin)
    )
      .post(`/api/v1/invoices/${inv1.id}/cancel`, { reason: 'Fee waived' })
      .expect(200);
    expect(res.body.data).toMatchObject({ status: 'cancelled', cancelledReason: 'Fee waived' });
    await (
      await as(admin)
    )
      .post(`/api/v1/invoices/${inv1.id}/cancel`, { reason: 'Again please' })
      .expect(409);
    await (
      await as(admin)
    )
      .post('/api/v1/invoices/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/cancel', { reason: 'Nothing' })
      .expect(404);
    await (await as(coach)).post(`/api/v1/invoices/${inv1.id}/share`).expect(422);
    await (await as(coach)).post(`/api/v1/invoices/${inv2.id}/share`).expect(200);
  });

  it('renders PDFs and builds WhatsApp share links that open without login', async () => {
    setToday('2026-02-15');
    const { admin, coach, inv1, inv2 } = await billed();
    await (
      await as(admin)
    )
      .put('/api/v1/settings', { name: 'Smash Academy', upiId: 'smash@okicici' })
      .expect(200);
    const api = await as(coach);

    const pdf = await api
      .get(`/api/v1/invoices/${inv1.id}/pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('inline; filename="ATQ-2025-26-00001.pdf"');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const share = await api.post(`/api/v1/invoices/${inv1.id}/share`).expect(200);
    expect(share.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    expect(share.body.data.message).toMatch(/^Hi Parent,/);
    expect(share.body.data.message).toContain('which was due on 17 Jan 2026');
    expect(share.body.data.message).toContain('Pay via UPI: smash@okicici');
    expect(share.body.data.message).toContain('– Smash Academy');

    const publicUrl = new URL(share.body.data.pdfUrl as string);
    const open = await request(getApp())
      .get(publicUrl.pathname + publicUrl.search)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(open.headers['x-robots-tag']).toBe('noindex, nofollow');
    await request(getApp())
      .get(publicUrl.pathname + publicUrl.search.replace(/s=[^&]+/, 's=forged'))
      .expect(403);

    // Upcoming (not overdue) wording, then receipt wording once paid.
    const upcoming = await api.post(`/api/v1/invoices/${inv2.id}/share`).expect(200);
    expect(upcoming.body.data.message).toContain('due by 17 Feb 2026');
    await api
      .post(`/api/v1/invoices/${inv2.id}/payments`, { mode: 'cash', paidOn: '2026-02-15' })
      .expect(200);
    const receipt = await api.post(`/api/v1/invoices/${inv2.id}/share`).expect(200);
    expect(receipt.body.data.message).toContain('Thank you! We have received ₹2,500.00');
    await api.get(`/api/v1/invoices/${inv2.id}/pdf`).buffer(true).parse(binary).expect(200);

    await (
      await as(admin)
    )
      .post(`/api/v1/invoices/${inv1.id}/cancel`, { reason: 'Waived fee' })
      .expect(200);
    await request(getApp())
      .get(publicUrl.pathname + publicUrl.search)
      .expect(404);
  });
});

describe('finance insights', () => {
  it('summarises billing, collections and dues for admins and coaches', async () => {
    setToday('2026-03-15');
    const a = await academyWithStudent();
    await makeStudent(
      {
        batchId: a.otherBatch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-12',
        billingStartsOn: '2026-01-12',
      },
      a.admin.id,
    );
    await generateDueInvoices('2026-03-15');
    const [first] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.studentId, a.student.id))
      .orderBy(asc(invoices.cycleNumber));
    await (
      await as(a.coach)
    )
      .post(`/api/v1/invoices/${first!.id}/payments`, { mode: 'upi', paidOn: '2026-03-02' })
      .expect(200);

    const api = await as(a.admin);
    const summary = await api
      .get('/api/v1/finance/summary?from=2026-01-01&to=2026-03-31')
      .expect(200);
    expect(summary.body.data.totals).toMatchObject({
      billed: 1_500_000,
      invoicesIssued: 6,
      collected: 250_000,
      paymentsReceived: 1,
      outstanding: 1_250_000,
      overdue: 750_000,
      overdueCount: 3,
      due: 500_000,
      dueCount: 2,
      collectionRate: 16.7,
    });
    expect(summary.body.data.trend).toHaveLength(12);
    expect(summary.body.data.trend.at(-1)).toEqual({
      month: '2026-03',
      billed: 500_000,
      collected: 250_000,
    });
    expect(summary.body.data.byPaymentMode).toEqual([{ mode: 'upi', amount: 250_000, count: 1 }]);
    expect(summary.body.data.topOverdue).toEqual([
      expect.objectContaining({ overdue: 500_000, invoices: 2 }),
      expect.objectContaining({ studentId: a.student.id, overdue: 250_000, invoices: 1 }),
    ]);
    expect(summary.body.data.byBatch).toHaveLength(2);
    expect(summary.body.data.byReceiver).toEqual([
      { userId: a.coach.id, name: a.coach.name, role: 'coach', amount: 250_000, count: 1 },
    ]);

    const coachView = await (
      await as(a.coach)
    )
      .get('/api/v1/finance/summary?from=2026-01-01&to=2026-03-31')
      .expect(200);
    expect(coachView.body.data.totals).toMatchObject({
      billed: 750_000,
      collected: 250_000,
      outstanding: 500_000,
    });
    expect(coachView.body.data.byReceiver).toHaveLength(1);
    const otherView = await (
      await as(a.otherCoach)
    )
      .get('/api/v1/finance/summary?from=2026-01-01&to=2026-03-31')
      .expect(200);
    expect(otherView.body.data.byReceiver).toEqual([]);
    const filtered = await api
      .get(
        `/api/v1/finance/summary?from=2026-01-01&to=2026-03-31&coachId=${a.otherCoach.id}&batchId=${a.otherBatch.id}`,
      )
      .expect(200);
    expect(filtered.body.data.totals.billed).toBe(750_000);
    const empty = await api.get('/api/v1/finance/summary').expect(200);
    expect(empty.body.data.range).toEqual({ from: '2026-03-01', to: '2026-03-15' });

    await api.get('/api/v1/finance/summary?from=2026-03-31&to=2026-01-01').expect(400);
    await api.get('/api/v1/finance/summary?from=2020-01-01&to=2026-01-01').expect(400);
  });

  it('projects upcoming invoices', async () => {
    setToday('2026-03-15');
    const a = await academyWithStudent();
    await generateDueInvoices('2026-03-15');
    const left = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-01-25',
        billingStartsOn: '2026-01-25',
      },
      a.admin.id,
    );
    await db
      .update(students)
      .set({ status: 'left', leftOn: '2026-03-01' })
      .where(eq(students.id, left.id));

    const res = await (await as(a.coach)).get('/api/v1/finance/projection?days=30').expect(200);
    expect(res.body.data).toMatchObject({
      from: '2026-03-16',
      to: '2026-04-14',
      totalAmount: 250_000,
    });
    expect(res.body.data.invoices).toEqual([
      expect.objectContaining({
        studentId: a.student.id,
        issueDate: '2026-04-10',
        amount: 250_000,
      }),
    ]);
    const shortWindow = await (
      await as(a.admin)
    )
      .get('/api/v1/finance/projection?days=5')
      .expect(200);
    expect(shortWindow.body.data.invoices).toEqual([]);
  });
});

/** supertest parser that collects a binary body into a Buffer. */
const binary: Parameters<request.Test['parse']>[0] = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
