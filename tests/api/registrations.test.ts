import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { as, getApp, makeAcademy, makeUser } from '../helpers/factories';

const studentForm = {
  fullName: 'Diya Kapoor',
  phone: '9876501234',
  guardianName: 'Neha Kapoor',
  email: 'neha@example.com',
  dateOfBirth: '2014-06-01',
  gender: 'female',
  medicalNotes: 'Mild asthma',
  preferredDays: [1, 3, 5],
  message: 'Beginner',
  consent: true,
};

const coachForm = {
  fullName: 'Vikram Rao',
  email: 'vikram@example.com',
  phone: '9876512345',
  password: 'Coach1Pass',
  experience: '5 years, state level',
  specialization: 'Footwork',
};

describe('public registration', () => {
  it('lists the academy and bookable batches without login', async () => {
    const { batch } = await makeAcademy();
    const res = await request(getApp()).get('/api/v1/public/register/options').expect(200);
    expect(res.body.data.academy.name).toBe('AthletiQ Academy');
    expect(res.body.data.batches.map((b: { id: string }) => b.id)).toContain(batch.id);
    expect(res.body.data.batches[0]).not.toHaveProperty('coachId');
  });

  it('accepts a student sign-up as a pending request', async () => {
    const { batch } = await makeAcademy();
    const res = await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ ...studentForm, preferredBatchId: batch.id })
      .expect(201);
    expect(res.body.data.message).toMatch(/registration has been received/);
  });

  it('rejects bots, missing consent and unavailable batches', async () => {
    await makeAcademy();
    await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ ...studentForm, website: 'http://spam' })
      .expect(400);
    await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ ...studentForm, consent: false })
      .expect(400);
    await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ ...studentForm, preferredBatchId: '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c' })
      .expect(422);
  });

  it('accepts a coach sign-up and blocks duplicates', async () => {
    await makeUser('coach', { email: 'taken@example.com' });
    await request(getApp())
      .post('/api/v1/public/register/coach')
      .send({ ...coachForm, email: 'taken@example.com' })
      .expect(409);
    await request(getApp())
      .post('/api/v1/public/register/coach')
      .send({ ...coachForm, password: 'weak' })
      .expect(400);
    await request(getApp()).post('/api/v1/public/register/coach').send(coachForm).expect(201);
    const dup = await request(getApp())
      .post('/api/v1/public/register/coach')
      .send({ ...coachForm, email: 'VIKRAM@example.com' })
      .expect(409);
    expect(dup.body.error.message).toMatch(/awaiting approval/);
    // Cannot sign in before approval.
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: coachForm.email, password: coachForm.password })
      .expect(401);
  });
});

describe('admin review of registrations', () => {
  it('approves a student: creates the student, enrollment and billing anchor', async () => {
    const { admin, batch, plan } = await makeAcademy();
    const submitted = await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ ...studentForm, preferredBatchId: batch.id });
    const id = submitted.body.data.id as string;
    const api = await as(admin);

    const list = await api.get('/api/v1/registrations?type=student').expect(200);
    expect(list.body.meta.pending).toEqual({ pendingStudents: 1, pendingCoaches: 0 });
    expect(list.body.data[0]).toMatchObject({
      id,
      preferredBatch: { id: batch.id },
      preferredDays: [1, 3, 5],
      details: { guardianName: 'Neha Kapoor' },
    });
    await api.get(`/api/v1/registrations/${id}`).expect(200);

    await api
      .post(`/api/v1/registrations/${id}/approve`, { batchId: batch.id, trainingDays: [1, 3, 5] })
      .expect(400);
    const approved = await api
      .post(`/api/v1/registrations/${id}/approve`, {
        joiningDate: '2026-03-10',
        batchId: batch.id,
        trainingDays: [1, 3, 5],
        feePlanId: plan.id,
        monthlyDiscount: 10_000,
        note: 'Welcome!',
      })
      .expect(200);
    expect(approved.body.data.student).toMatchObject({
      fullName: 'Diya Kapoor',
      guardianName: 'Neha Kapoor',
      medicalNotes: 'Mild asthma',
      joiningDate: '2026-03-10',
      currentEnrollment: { batchId: batch.id },
      effectiveFee: { total: 240_000 },
    });

    await api.post(`/api/v1/registrations/${id}/approve`, {}).expect(409);
    const done = await api.get('/api/v1/registrations?status=approved').expect(200);
    expect(done.body.data[0]).toMatchObject({
      status: 'approved',
      studentId: approved.body.data.student.id,
      reviewNote: 'Welcome!',
    });
  });

  it('approves a coach who can then sign in with their chosen password', async () => {
    const admin = await makeUser('admin');
    const submitted = await request(getApp()).post('/api/v1/public/register/coach').send(coachForm);
    const res = await (
      await as(admin)
    )
      .post(`/api/v1/registrations/${submitted.body.data.id}/approve`)
      .expect(200);
    expect(res.body.data.user).toMatchObject({
      role: 'coach',
      status: 'active',
      email: coachForm.email,
    });
    await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: coachForm.email, password: coachForm.password })
      .expect(200);
  });

  it('refuses to approve a coach whose email was taken in the meantime', async () => {
    const admin = await makeUser('admin');
    const submitted = await request(getApp()).post('/api/v1/public/register/coach').send(coachForm);
    await makeUser('coach', { email: coachForm.email, withPassword: true });
    await (
      await as(admin)
    )
      .post(`/api/v1/registrations/${submitted.body.data.id}/approve`)
      .expect(409);
  });

  it('rejects requests and is admin-only', async () => {
    const { admin, coach } = await makeAcademy();
    const submitted = await request(getApp())
      .post('/api/v1/public/register/student')
      .send(studentForm);
    const id = submitted.body.data.id as string;
    await (await as(coach)).get('/api/v1/registrations').expect(403);
    const api = await as(admin);
    await api
      .post(`/api/v1/registrations/${id}/reject`, { reason: 'Batch full' })
      .expect(200, { data: { id, status: 'rejected' } });
    await api.post(`/api/v1/registrations/${id}/reject`).expect(409);
    await api.post('/api/v1/registrations/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/reject').expect(404);
    await api.get('/api/v1/registrations/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c').expect(404);
    const rejected = await api.get('/api/v1/registrations?status=rejected').expect(200);
    expect(rejected.body.data[0].reviewNote).toBe('Batch full');
  });
});
