import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { enrollments, invoices } from '../../src/db/schema';
import { as, makeAcademy, makeBatch, makePlan, makeStudent, setToday } from '../helpers/factories';

const UNKNOWN = '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c';

describe('student registration (admin)', () => {
  it('registers a student with an enrollment and sequential code', async () => {
    setToday('2026-03-05');
    const { admin, batch, plan } = await makeAcademy();
    const api = await as(admin);
    const body = {
      fullName: 'Aarav Sharma',
      phone: '98765 43210',
      guardianName: 'Rohit',
      email: 'aarav@example.com',
      joiningDate: '2026-03-10',
      batchId: batch.id,
      trainingDays: [5, 1, 3],
      feePlanId: plan.id,
      monthlyDiscount: 25_000,
    };
    const res = await api.post('/api/v1/students', body).expect(201);
    expect(res.body.data).toMatchObject({
      code: 'ATQ-0001',
      phone: '+919876543210',
      status: 'active',
      billingStartsOn: '2026-03-05',
      effectiveFee: { base: 250_000, discount: 25_000, total: 225_000 },
      currentEnrollment: {
        batchId: batch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-03-10',
        effectiveTo: null,
      },
      billing: { outstanding: 0, invoiceCount: 0 },
    });
    const second = await api.post('/api/v1/students', { ...body, fullName: 'Second' }).expect(201);
    expect(second.body.data.code).toBe('ATQ-0002');
  });

  it('validates training days, plan, batch and capacity', async () => {
    const { admin, batch, plan, coach, location } = await makeAcademy();
    const api = await as(admin);
    const base = {
      fullName: 'X',
      phone: '9876543210',
      joiningDate: '2026-03-10',
      batchId: batch.id,
      trainingDays: [1, 3, 5],
      feePlanId: plan.id,
    };

    await api.post('/api/v1/students', { ...base, trainingDays: [] }).expect(400);
    await api
      .post('/api/v1/students', { ...base, trainingDays: [1, 2, 3, 4, 5, 6, 7] })
      .expect(400);
    const sunday = await api
      .post('/api/v1/students', { ...base, trainingDays: [1, 3, 7] })
      .expect(400);
    expect(sunday.body.error.details.fields[0].path).toBe('trainingDays');

    const inactivePlan = await makePlan({ isActive: false });
    await api.post('/api/v1/students', { ...base, feePlanId: inactivePlan.id }).expect(422);
    await api.post('/api/v1/students', { ...base, feePlanId: UNKNOWN }).expect(422);
    await api.post('/api/v1/students', { ...base, batchId: UNKNOWN }).expect(422);
    const closed = await makeBatch(coach.id, location.id, { isActive: false });
    await api.post('/api/v1/students', { ...base, batchId: closed.id }).expect(422);

    const tiny = await makeBatch(coach.id, location.id, { capacity: 1 });
    await api.post('/api/v1/students', { ...base, batchId: tiny.id }).expect(201);
    const full = await api.post('/api/v1/students', { ...base, batchId: tiny.id }).expect(422);
    expect(full.body.error.message).toMatch(/is full \(capacity 1\)/);
  });

  it('is admin-only', async () => {
    const { coach, batch, plan } = await makeAcademy();
    await (
      await as(coach)
    )
      .post('/api/v1/students', {
        fullName: 'X',
        phone: '9876543210',
        joiningDate: '2026-03-10',
        batchId: batch.id,
        trainingDays: [1, 3, 5],
        feePlanId: plan.id,
      })
      .expect(403);
  });
});

describe('student listing and access', () => {
  it('scopes coaches to their own students and supports filters', async () => {
    const { admin, coach, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    const mine = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, fullName: 'Meera Iyer' },
      admin.id,
    );
    const theirs = await makeStudent(
      { batchId: otherBatch.id, feePlanId: plan.id, fullName: 'Kabir Rao' },
      admin.id,
    );

    const coachList = await (await as(coach)).get('/api/v1/students').expect(200);
    expect(coachList.body.data.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    expect(coachList.body.data[0]).toMatchObject({
      batch: { id: batch.id },
      coach: { id: coach.id },
      effectiveFee: 250_000,
      outstanding: 0,
    });
    await (await as(coach)).get(`/api/v1/students/${theirs.id}`).expect(404);
    await (await as(coach)).get(`/api/v1/students/${mine.id}`).expect(200);

    const api = await as(admin);
    const search = await api.get('/api/v1/students?search=kabir').expect(200);
    expect(search.body.data.map((s: { id: string }) => s.id)).toEqual([theirs.id]);
    const byCoach = await api
      .get(`/api/v1/students?coachId=${otherCoach.id}&sort=recent&status=active`)
      .expect(200);
    expect(byCoach.body.meta.total).toBe(1);
    const byBatch = await api
      .get(`/api/v1/students?batchId=${batch.id}&feePlanId=${plan.id}&sort=joiningDate`)
      .expect(200);
    expect(byBatch.body.data.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    await api.get(`/api/v1/students/${UNKNOWN}`).expect(404);
  });
});

describe('updating students', () => {
  it('updates profile and fee with an audit trail', async () => {
    const { admin, batch, plan } = await makeAcademy();
    const s = await makeStudent({ batchId: batch.id, feePlanId: plan.id }, admin.id);
    const newPlan = await makePlan({ monthlyFee: 400_000, daysPerWeek: 5 });
    const api = await as(admin);
    const res = await api
      .patch(`/api/v1/students/${s.id}`, {
        feePlanId: newPlan.id,
        customMonthlyFee: 380_000,
        notes: 'Scholarship',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({ notes: 'Scholarship', effectiveFee: { total: 380_000 } });

    const logs = await api
      .get(`/api/v1/admin/audit-logs?entityType=student&entityId=${s.id}`)
      .expect(200);
    expect(logs.body.data[0]).toMatchObject({
      action: 'student.fee_changed',
      metadata: { before: { feePlanId: plan.id } },
    });
    await api
      .patch(`/api/v1/students/${s.id}`, { feePlanId: (await makePlan({ isActive: false })).id })
      .expect(422);
    await api.patch(`/api/v1/students/${UNKNOWN}`, { notes: 'x' }).expect(404);
    await api.patch(`/api/v1/students/${s.id}`, { address: '2 Park Street' }).expect(200);
  });

  it('allows correcting the joining date only before billing starts', async () => {
    const { admin, batch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);
    const res = await api
      .patch(`/api/v1/students/${s.id}`, { joiningDate: '2026-01-12' })
      .expect(200);
    expect(res.body.data.currentEnrollment.effectiveFrom).toBe('2026-01-12');

    await db.insert(invoices).values({
      number: 'ATQ/2025-26/00001',
      studentId: s.id,
      cycleNumber: 1,
      periodStart: '2026-01-12',
      periodEnd: '2026-02-11',
      issueDate: '2026-02-12',
      dueDate: '2026-02-19',
      feePlanName: 'P',
      baseAmount: 1,
      totalAmount: 1,
    });
    const blocked = await api
      .patch(`/api/v1/students/${s.id}`, { joiningDate: '2026-01-15' })
      .expect(422);
    expect(blocked.body.error.message).toMatch(/anchors the billing cycle/);
  });

  it('rejects joining-date changes that conflict with enrollment history', async () => {
    const { admin, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);
    await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-02-01',
      })
      .expect(200);
    await api.patch(`/api/v1/students/${s.id}`, { joiningDate: '2026-03-01' }).expect(422);
  });
});

describe('transfers and training-day changes', () => {
  it('moves a student permanently and keeps history', async () => {
    const { admin, coach, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);

    const res = await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [2, 4, 6],
        effectiveFrom: '2026-03-01',
        reason: 'Timing',
      })
      .expect(200);
    expect(res.body.data.currentEnrollment).toMatchObject({
      batchId: otherBatch.id,
      trainingDays: [2, 4, 6],
      effectiveFrom: '2026-03-01',
    });
    expect(res.body.data.enrollmentHistory).toHaveLength(2);
    expect(res.body.data.enrollmentHistory[1]).toMatchObject({
      batchId: batch.id,
      effectiveTo: '2026-02-28',
    });

    // Ownership follows the move.
    await (await as(coach)).get(`/api/v1/students/${s.id}`).expect(404);
    await (await as(otherCoach)).get(`/api/v1/students/${s.id}`).expect(200);
  });

  it('replaces a same-day enrollment and allows day changes in a full batch', async () => {
    const { admin, coach, location, plan } = await makeAcademy();
    const full = await makeBatch(coach.id, location.id, { capacity: 1 });
    const s = await makeStudent(
      { batchId: full.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);
    const res = await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: full.id,
        trainingDays: [2, 4, 6],
        effectiveFrom: '2026-01-10',
      })
      .expect(200);
    expect(res.body.data.enrollmentHistory).toHaveLength(1);
    expect(res.body.data.currentEnrollment.trainingDays).toEqual([2, 4, 6]);
  });

  it('rejects invalid transfers', async () => {
    const { admin, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01' },
      admin.id,
    );
    const api = await as(admin);
    await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-01-01',
      })
      .expect(422);
    await api
      .post(`/api/v1/students/${UNKNOWN}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-03-01',
      })
      .expect(404);
    await db.delete(enrollments).where(eq(enrollments.studentId, s.id));
    await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-03-01',
      })
      .expect(422);
  });
});

describe('leaving the academy', () => {
  it('closes enrollment, cancels future makeups and blocks further changes', async () => {
    const { admin, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-04-07' })
      .expect(201);

    await api.post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-01-01' }).expect(400);
    const res = await api
      .post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-31', reason: 'Relocated' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      status: 'left',
      leftOn: '2026-03-31',
      leftReason: 'Relocated',
      currentEnrollment: null,
      upcomingMakeups: [],
    });

    await api.post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-04-01' }).expect(422);
    await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-04-01',
      })
      .expect(422);
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-04-08' })
      .expect(422);
    await api.post(`/api/v1/students/${UNKNOWN}/leave`, { leftOn: '2026-04-01' }).expect(404);
    const left = await api.get('/api/v1/students?status=left').expect(200);
    expect(left.body.data).toHaveLength(1);
  });

  it('rejects a leaving date before the current enrollment started', async () => {
    const { admin, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(admin);
    await api
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-03-01',
      })
      .expect(200);
    await api.post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-02-15' }).expect(400);
  });
});

describe('makeup sessions', () => {
  it("lets the student's coach book and cancel one-off sessions", async () => {
    setToday('2026-03-01');
    const { admin, coach, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );
    const api = await as(coach);

    const booked = await api
      .post(`/api/v1/students/${s.id}/makeups`, {
        batchId: otherBatch.id,
        date: '2026-03-10',
        missedDate: '2026-03-09',
        reason: 'School trip',
      })
      .expect(201);
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-03-10' })
      .expect(409);
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-03-15' })
      .expect(422); // Sunday
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: otherBatch.id, date: '2026-01-05' })
      .expect(422); // before joining
    await api
      .post(`/api/v1/students/${s.id}/makeups`, { batchId: UNKNOWN, date: '2026-03-11' })
      .expect(422);

    const detail = await api.get(`/api/v1/students/${s.id}`).expect(200);
    expect(detail.body.data.upcomingMakeups).toEqual([
      expect.objectContaining({ date: '2026-03-10', batchId: otherBatch.id }),
    ]);

    await (
      await as(otherCoach)
    )
      .delete(`/api/v1/students/${s.id}/makeups/${booked.body.data.id}`)
      .expect(404);
    await api.delete(`/api/v1/students/${s.id}/makeups/${booked.body.data.id}`).expect(204);
    await api.delete(`/api/v1/students/${s.id}/makeups/${booked.body.data.id}`).expect(404);
  });
});
