import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { invoices } from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import {
  as,
  makeAcademy,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

describe('users (admin)', () => {
  it('lists, filters and searches users with active batch counts', async () => {
    const { admin, coach } = await makeAcademy();
    const api = await as(admin);
    const all = await api.get('/api/v1/users?role=coach').expect(200);
    expect(all.body.meta).toMatchObject({ page: 1, total: 2 });
    expect(all.body.data.find((u: { id: string }) => u.id === coach.id).activeBatches).toBe(1);

    const search = await api
      .get(`/api/v1/users?search=${encodeURIComponent(coach.email)}&status=active`)
      .expect(200);
    expect(search.body.data.map((u: { id: string }) => u.id)).toEqual([coach.id]);
  });

  it('is forbidden for coaches', async () => {
    const coach = await makeUser('coach');
    const res = await (await as(coach)).get('/api/v1/users').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('invites users and rejects duplicate emails case-insensitively', async () => {
    const admin = await makeUser('admin');
    const api = await as(admin);
    const res = await api
      .post('/api/v1/users', { name: 'Riya', email: 'Riya@Example.com', role: 'coach' })
      .expect(201);
    expect(res.body.data.user).toMatchObject({ status: 'invited', email: 'riya@example.com' });
    const dup = await api
      .post('/api/v1/users', { name: 'Riya 2', email: 'RIYA@example.com' })
      .expect(409);
    expect(dup.body.error.message).toBe('A user with this email already exists');
  });

  it('updates users and profiles', async () => {
    const admin = await makeUser('admin');
    const coach = await makeUser('coach');
    const api = await as(admin);
    await api
      .patch(`/api/v1/users/${coach.id}`, { name: 'Renamed', phone: '9876543210' })
      .expect(200);
    const fetched = await api.get(`/api/v1/users/${coach.id}`).expect(200);
    expect(fetched.body.data).toMatchObject({ name: 'Renamed', phone: '+919876543210' });
    await api.get('/api/v1/users/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c').expect(404);
    await api
      .patch('/api/v1/users/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c', { name: 'x' })
      .expect(404);
    await api.get('/api/v1/users/not-a-uuid').expect(400);

    const me = await (
      await as(coach)
    )
      .patch('/api/v1/users/me', { name: 'Coach Self' })
      .expect(200);
    expect(me.body.data.name).toBe('Coach Self');
  });

  it('disables and re-enables accounts with safety checks', async () => {
    const { admin, coach } = await makeAcademy();
    const api = await as(admin);
    await api.post(`/api/v1/users/${admin.id}/status`, { status: 'disabled' }).expect(422);
    const blocked = await api
      .post(`/api/v1/users/${coach.id}/status`, { status: 'disabled' })
      .expect(422);
    expect(blocked.body.error.message).toMatch(/still has active batches/);

    const idle = await makeUser('coach', { withPassword: true });
    await api.post(`/api/v1/users/${idle.id}/status`, { status: 'disabled' }).expect(200);
    await (await as(idle)).get('/api/v1/auth/me').expect(401);
    await api.post(`/api/v1/users/${idle.id}/access-link`).expect(422);
    const enabled = await api
      .post(`/api/v1/users/${idle.id}/status`, { status: 'active' })
      .expect(200);
    expect(enabled.body.data.status).toBe('active');

    const neverSetPassword = await makeUser('coach', { status: 'disabled' });
    const back = await api
      .post(`/api/v1/users/${neverSetPassword.id}/status`, { status: 'active' })
      .expect(200);
    expect(back.body.data.status).toBe('invited');
    await api
      .post('/api/v1/users/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/status', { status: 'active' })
      .expect(404);
    await api.post('/api/v1/users/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/access-link').expect(404);
  });
});

describe('locations', () => {
  it('lets admins manage locations and anyone read them', async () => {
    const { admin, coach, location } = await makeAcademy();
    const api = await as(admin);
    const created = await api
      .post('/api/v1/locations', { name: 'North Ground', latitude: 13.0, longitude: 77.6 })
      .expect(201);
    expect(created.body.data.radiusMeters).toBe(200);
    await api
      .post('/api/v1/locations', { name: 'north ground', latitude: 1, longitude: 1 })
      .expect(409);
    await api.post('/api/v1/locations', { name: 'Bad', latitude: 120, longitude: 1 }).expect(400);

    const list = await (await as(coach)).get('/api/v1/locations?active=true').expect(200);
    expect(list.body.data.find((l: { id: string }) => l.id === location.id).activeBatches).toBe(2);
    await (await as(coach)).get(`/api/v1/locations/${location.id}`).expect(200);
    await (
      await as(coach)
    )
      .post('/api/v1/locations', { name: 'X', latitude: 1, longitude: 1 })
      .expect(403);
    await api.get('/api/v1/locations/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c').expect(404);
  });

  it('prevents deactivating a location with active batches', async () => {
    const { admin, location } = await makeAcademy();
    const api = await as(admin);
    await api.patch(`/api/v1/locations/${location.id}`, { isActive: false }).expect(422);
    const spare = await makeLocation();
    const res = await api
      .patch(`/api/v1/locations/${spare.id}`, { isActive: false, radiusMeters: 300 })
      .expect(200);
    expect(res.body.data).toMatchObject({ isActive: false, radiusMeters: 300 });
    await api
      .patch('/api/v1/locations/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c', { name: 'x' })
      .expect(404);
  });
});

describe('fee plans', () => {
  it('keeps the order the admin drags plans into; new plans go last', async () => {
    const { admin, coach, plan } = await makeAcademy();
    const api = await as(admin);
    const b = await api
      .post('/api/v1/fee-plans', { name: 'Two days', daysPerWeek: 2, monthlyFee: 150_000 })
      .expect(201);
    const c = await api
      .post('/api/v1/fee-plans', { name: 'Weekend', daysPerWeek: 2, monthlyFee: 120_000 })
      .expect(201);
    const names = async () =>
      (await api.get('/api/v1/fee-plans').expect(200)).body.data.map(
        (p: { name: string }) => p.name,
      );
    // Created last, listed last (not by days or price).
    expect((await names()).slice(-2)).toEqual(['Two days', 'Weekend']);

    const ids = [c.body.data.id, plan.id, b.body.data.id];
    await api.put('/api/v1/fee-plans/order', { ids }).expect(200);
    expect(await names()).toEqual(['Weekend', plan.name, 'Two days']);

    await api.put('/api/v1/fee-plans/order', { ids: ids.slice(1) }).expect(400);
    await api.put('/api/v1/fee-plans/order', { ids: [...ids, ids[0]] }).expect(400);
    await (await as(coach)).put('/api/v1/fee-plans/order', { ids }).expect(403);
  });

  it('manages plans with usage counts and history-safe price changes', async () => {
    const { admin, batch, plan } = await makeAcademy();
    await makeStudent({ batchId: batch.id, feePlanId: plan.id }, admin.id);
    const api = await as(admin);

    const created = await api
      .post('/api/v1/fee-plans', { name: '5 days', daysPerWeek: 5, monthlyFee: 350_000 })
      .expect(201);
    const list = await api.get('/api/v1/fee-plans').expect(200);
    expect(list.body.data.find((p: { id: string }) => p.id === plan.id).activeStudents).toBe(1);

    await api.patch(`/api/v1/fee-plans/${plan.id}`, { isActive: false }).expect(422);
    const updated = await api
      .patch(`/api/v1/fee-plans/${created.body.data.id}`, { monthlyFee: 360_000 })
      .expect(200);
    expect(updated.body.data.monthlyFee).toBe(360_000);
    await api.patch(`/api/v1/fee-plans/${created.body.data.id}`, { isActive: false }).expect(200);
    const active = await api.get('/api/v1/fee-plans?active=true').expect(200);
    expect(active.body.data).toHaveLength(1);
    await api
      .patch('/api/v1/fee-plans/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c', { name: 'x' })
      .expect(404);
    await api
      .post('/api/v1/fee-plans', { name: 'Neg', daysPerWeek: 3, monthlyFee: -1 })
      .expect(400);
  });
});

describe('batches', () => {
  it('scopes batch lists to the coach and filters for admins', async () => {
    const { admin, coach, otherCoach, batch, otherBatch, location } = await makeAcademy();
    const mine = await (await as(coach)).get('/api/v1/batches').expect(200);
    expect(mine.body.data.map((b: { id: string }) => b.id)).toEqual([batch.id]);
    expect(mine.body.data[0]).toMatchObject({
      coach: { id: coach.id },
      location: { id: location.id },
      memberCount: 0,
    });

    const api = await as(admin);
    const byCoach = await api
      .get(`/api/v1/batches?coachId=${otherCoach.id}&active=true&locationId=${location.id}`)
      .expect(200);
    expect(byCoach.body.data.map((b: { id: string }) => b.id)).toEqual([otherBatch.id]);

    await (await as(coach)).get(`/api/v1/batches/${otherBatch.id}`).expect(404);
    const detail = await (await as(coach)).get(`/api/v1/batches/${batch.id}`).expect(200);
    expect(detail.body.data.members).toEqual([]);
  });

  it('creates batches with validation', async () => {
    const { admin, coach, location, batch, plan } = await makeAcademy();
    const api = await as(admin);
    const body = {
      name: 'Evening',
      coachId: coach.id,
      locationId: location.id,
      weekdays: [6, 1, 3],
      startTime: '17:00',
      endTime: '18:30',
      capacity: 12,
      sportId: batch.sportId,
      feePlanId: plan.id, // 3 days a week, like the batch
    };
    // A fee plan is required, active, and for as many days as the batch runs.
    const { feePlanId: _p, ...noPlan } = body;
    await api.post('/api/v1/batches', { ...noPlan, name: 'E0' }).expect(400);
    const twoDay = await makePlan({ daysPerWeek: 2 });
    const mismatch = await api
      .post('/api/v1/batches', { ...body, name: 'E0', feePlanId: twoDay.id })
      .expect(400);
    expect(mismatch.body.error.details.fields[0]).toMatchObject({ path: 'feePlanId' });
    const retired = await makePlan({ isActive: false });
    await api.post('/api/v1/batches', { ...body, name: 'E0', feePlanId: retired.id }).expect(422);
    // A sport is required, and must exist and be active.
    const { sportId: _s, ...noSport } = body;
    await api.post('/api/v1/batches', { ...noSport, name: 'E0' }).expect(400);
    await api
      .post('/api/v1/batches', {
        ...body,
        name: 'E0',
        sportId: '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c',
      })
      .expect(422);
    const res = await api.post('/api/v1/batches', body).expect(201);
    expect(res.body.data).toMatchObject({
      weekdays: [1, 3, 6],
      startTime: '17:00:00',
      capacity: 12,
      feePlanId: plan.id,
    });

    // Capacity is required and must be a positive number.
    const { capacity: _omit, ...noCapacity } = body;
    await api.post('/api/v1/batches', { ...noCapacity, name: 'E0' }).expect(400);
    await api.post('/api/v1/batches', { ...body, name: 'E0', capacity: null }).expect(400);
    await api.post('/api/v1/batches', { ...body, name: 'E0', capacity: 0 }).expect(400);

    await api.post('/api/v1/batches', { ...body, name: 'E2', endTime: '16:00' }).expect(400);
    await api.post('/api/v1/batches', { ...body, name: 'E3', coachId: admin.id }).expect(422);
    const offCoach = await makeUser('coach', { status: 'disabled' });
    await api.post('/api/v1/batches', { ...body, name: 'E4', coachId: offCoach.id }).expect(422);
    const closed = await makeLocation({ isActive: false });
    await api.post('/api/v1/batches', { ...body, name: 'E5', locationId: closed.id }).expect(422);
    await api
      .post('/api/v1/batches', {
        ...body,
        name: 'E6',
        locationId: '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c',
      })
      .expect(422);
    await api.post('/api/v1/batches', { ...body, name: 'evening' }).expect(409);
  });

  it('guards weekday changes, deactivation and reassignment', async () => {
    const { admin, batch, plan, otherCoach } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, trainingDays: [1, 3, 5] },
      admin.id,
    );
    const api = await as(admin);

    // The 3-day plan doesn't fit 2 days; 3 days fit, and students follow the batch's days.
    await api.patch(`/api/v1/batches/${batch.id}`, { weekdays: [1, 2] }).expect(400);
    await api.patch(`/api/v1/batches/${batch.id}`, { weekdays: [2, 4, 6] }).expect(200);
    const detail = await api.get(`/api/v1/students/${s.id}`).expect(200);
    expect(detail.body.data.enrollmentHistory[0].trainingDays).toEqual([2, 4, 6]);
    await api.patch(`/api/v1/batches/${batch.id}`, { isActive: false }).expect(422);
    await api.patch(`/api/v1/batches/${batch.id}`, { endTime: '05:00' }).expect(400);
    // Capacity can't drop below the students already in the batch, or be cleared.
    const tight = await api.patch(`/api/v1/batches/${batch.id}`, { capacity: 0 }).expect(400);
    expect(tight.body.error.code).toBe('VALIDATION_ERROR');
    await api.patch(`/api/v1/batches/${batch.id}`, { capacity: null }).expect(400);
    const s2 = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, trainingDays: [1, 3, 5] },
      admin.id,
    );
    expect(s2.id).toBeTruthy();
    const below = await api.patch(`/api/v1/batches/${batch.id}`, { capacity: 1 }).expect(422);
    expect(below.body.error.message).toMatch(/has 2 students/);
    await api.patch(`/api/v1/batches/${batch.id}`, { capacity: 2 }).expect(200);

    const moved = await api
      .patch(`/api/v1/batches/${batch.id}`, { coachId: otherCoach.id, weekdays: [1, 3, 5] })
      .expect(200);
    expect(moved.body.data.coachId).toBe(otherCoach.id);
    const loc = await makeLocation();
    await api.patch(`/api/v1/batches/${batch.id}`, { locationId: loc.id }).expect(200);
  });

  it('prices the next invoices with a new batch plan', async () => {
    setToday('2026-03-09');
    const { admin, batch, plan } = await makeAcademy();
    const s = await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-03-09' },
      admin.id,
    );
    await generateDueInvoices('2026-03-09');
    const api = await as(admin);
    const dearer = await makePlan({ monthlyFee: 300_000, daysPerWeek: 6 });
    // The batch runs 6 days, so a 6-day plan fits.
    await api.patch(`/api/v1/batches/${batch.id}`, { feePlanId: dearer.id }).expect(200);
    const detail = await api.get(`/api/v1/students/${s.id}`).expect(200);
    expect(detail.body.data.memberships[0].fee.total).toBe(300_000);
    await generateDueInvoices('2026-04-09');
    const rows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.studentId, s.id))
      .orderBy(invoices.periodStart);
    expect(rows.map((i) => [i.totalAmount, i.feePlanId])).toEqual([
      [250_000, plan.id], // already issued: unchanged
      [300_000, dearer.id],
    ]);
    const log = await api
      .get(`/api/v1/admin/audit-logs?entityType=batch&entityId=${batch.id}`)
      .expect(200);
    expect(log.body.data[0].metadata).toMatchObject({
      previousFeePlanId: plan.id,
      studentsAffected: 1,
    });
  });

  it('returns the expected roster including makeups', async () => {
    const { admin, coach, location, otherBatch } = await makeAcademy();
    const batch = await makeBatch(coach.id, location.id, { weekdays: [1, 2, 3, 5] });
    const regular = await makeStudent({ batchId: batch.id }, admin.id);
    const visitor = await makeStudent({ batchId: otherBatch.id }, admin.id);
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${visitor.id}/makeups`, {
        batchId: batch.id,
        date: '2026-03-10',
        reason: 'Exam',
      })
      .expect(201);

    const api = await as(coach);
    const tue = await api.get(`/api/v1/batches/${batch.id}/roster?date=2026-03-10`).expect(200); // Tuesday
    // The regular student trains every day the batch runs; the visitor is a makeup.
    expect(tue.body.data.students).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ studentId: regular.id, isMakeup: false }),
        expect.objectContaining({ studentId: visitor.id, isMakeup: true, makeupReason: 'Exam' }),
      ]),
    );
    expect(tue.body.data.students).toHaveLength(2);
    const mon = await api.get(`/api/v1/batches/${batch.id}/roster?date=2026-03-09`).expect(200);
    expect(mon.body.data.students.map((r: { studentId: string }) => r.studentId)).toEqual([
      regular.id,
    ]);
    const today = await api.get(`/api/v1/batches/${batch.id}/roster`).expect(200);
    expect(today.body.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('academy settings', () => {
  it('lets everyone read and admins update settings', async () => {
    const admin = await makeUser('admin');
    const coach = await makeUser('coach');
    const read = await (await as(coach)).get('/api/v1/settings').expect(200);
    expect(read.body.data.name).toBe('AthletiQ Academy');

    const api = await as(admin);
    const res = await api
      .put('/api/v1/settings', {
        name: 'Smash Academy',
        upiId: 'smash@okicici',
        gstin: '29abcde1234f1z5',
        phone: '9876543210',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Smash Academy',
      gstin: '29ABCDE1234F1Z5',
      phone: '+919876543210',
    });
    await api.put('/api/v1/settings', { upiId: 'not a upi' }).expect(400);
    await (await as(coach)).put('/api/v1/settings', { name: 'Hack' }).expect(403);
  });
});

describe('audit log and jobs (admin)', () => {
  it('records sensitive actions and exposes them to admins', async () => {
    const { admin } = await makeAcademy();
    const api = await as(admin);
    const plan = await api
      .post('/api/v1/fee-plans', { name: 'Audit Plan', daysPerWeek: 4, monthlyFee: 300_000 })
      .expect(201);
    const logs = await api
      .get(
        `/api/v1/admin/audit-logs?entityType=fee_plan&entityId=${plan.body.data.id}&actorId=${admin.id}`,
      )
      .expect(200);
    expect(logs.body.data).toEqual([
      expect.objectContaining({
        action: 'fee_plan.created',
        actor: { id: admin.id, name: admin.name },
      }),
    ]);
    const coach = await makeUser('coach');
    await (await as(coach)).get('/api/v1/admin/audit-logs').expect(403);
  });

  it('builds plans from the factory with defaults', async () => {
    expect((await makePlan()).monthlyFee).toBe(250_000);
    const c = await makeUser('coach');
    expect((await makeBatch(c.id, (await makeLocation()).id)).weekdays).toHaveLength(6);
  });
});
