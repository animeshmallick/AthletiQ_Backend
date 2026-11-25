import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batches, deviceTokens, enrollments, invoices, students, users } from '../../src/db/schema';
import { checkRegistrationNo } from '../../src/modules/billing/share-gate';
import { buildStudentPdf } from '../../src/modules/reports/reports.routes';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import {
  as,
  getApp,
  makeAcademy,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';
import request from 'supertest';

/** One student in two batches run by different coaches. */
async function shared() {
  setToday('2026-03-16');
  const a = await makeAcademy();
  const plan = await makePlan({ daysPerWeek: 3, monthlyFee: 700_000 });
  const second = await makeBatch(a.otherCoach.id, (await makeLocation()).id, {
    weekdays: [1, 3, 5],
    startTime: '17:00:00',
    endTime: '18:00:00',
    feePlanId: plan.id,
  });
  const student = await makeStudent(
    {
      batchId: a.batch.id,
      feePlanId: a.plan.id,
      joiningDate: '2026-02-20',
      billingStartsOn: '2026-02-20',
    },
    a.admin.id,
  );
  const api = await as(a.admin);
  await api
    .post(`/api/v1/students/${student.id}/batches`, {
      batchId: second.id,
      effectiveFrom: '2026-03-02',
    })
    .expect(201);
  return { ...a, second, student, api };
}

describe('a student shared by two coaches', () => {
  it('each coach sees only their own batch’s fees and dues', async () => {
    const s = await shared();
    const all = (await s.api.get(`/api/v1/students/${s.student.id}`).expect(200)).body.data;
    expect(all.memberships).toHaveLength(2);
    const theirs = (
      await (await as(s.otherCoach)).get(`/api/v1/students/${s.student.id}`).expect(200)
    ).body.data;
    expect(theirs.memberships.map((m: { batchId: string }) => m.batchId)).toEqual([s.second.id]);
    expect(theirs.enrollmentHistory).toHaveLength(1);
    expect(theirs.effectiveFee.total).toBe(700_000);
    expect(theirs.billing.outstanding).toBe(700_000);
    expect(all.billing.outstanding).toBeGreaterThan(700_000);
    const list = (await (await as(s.otherCoach)).get('/api/v1/students').expect(200)).body.data;
    expect(list[0].outstanding).toBe(700_000);
    // Once theirs is paid, the other batch's dues don't show up in their "outstanding" list.
    const [bill] = await db.select().from(invoices).where(eq(invoices.batchId, s.second.id));
    await s.api
      .post(`/api/v1/invoices/${bill!.id}/payments`, { mode: 'cash', paidOn: '2026-03-16' })
      .expect(200);
    const due = await (await as(s.otherCoach)).get('/api/v1/students?dues=outstanding').expect(200);
    expect(due.body.data).toEqual([]);
    // The coach's own report copy builds from their batches.
    const coach = { id: s.otherCoach.id, role: 'coach' as const, name: 'c', email: '' };
    expect((await buildStudentPdf(s.student.id, 'all', coach)).pdf.length).toBeGreaterThan(1000);
  });

  it('each coach writes their own weekly report; neither overwrites the other', async () => {
    const s = await shared();
    const url = `/api/v1/feedback/students/${s.student.id}/weeks/2026-03-09`;
    await (await as(s.coach)).put(url, { answers: { technique: 2 } }).expect(200);
    await (await as(s.otherCoach)).put(url, { answers: { technique: 5 } }).expect(200);
    const mine = (await (await as(s.coach)).get(url).expect(200)).body.data.feedback;
    expect(mine).toMatchObject({ batchId: s.batch.id, answers: { technique: 2 } });
    const board = (await s.api.get('/api/v1/feedback/week?weekStart=2026-03-09').expect(200)).body
      .data;
    expect(board.summary).toMatchObject({ total: 2, draft: 2 });
    const forAdmin = (await s.api.get(`${url}?batchId=${s.second.id}`).expect(200)).body.data;
    expect(forAdmin.feedback.answers.technique).toBe(5);
    expect((await s.api.get(url).expect(200)).body.data.feedback).not.toBeNull();
  });

  it('the week’s report can still be written after the student leaves', async () => {
    const s = await shared();
    const day = { leftOn: '2026-03-14', reason: 'Moved city' };
    await s.api.post(`/api/v1/students/${s.student.id}/leave`, day).expect(200);
    const url = `/api/v1/feedback/students/${s.student.id}/weeks/2026-03-09`;
    const c = await as(s.coach);
    await c.get(url).expect(200);
    await c.put(url, { answers: { technique: 3 } }).expect(200);
    await c.get(`/api/v1/feedback/students/${s.student.id}/weeks/2026-03-02`).expect(200);
    await c.get(`/api/v1/feedback/students/${s.student.id}/weeks/2026-01-05`).expect(404);
  });
});

describe('a substitute', () => {
  it('sees the batch’s sessions but not its students’ fees', async () => {
    const s = await shared();
    const sub = await makeUser('coach');
    await s.api
      .post('/api/v1/substitutions', {
        batchId: s.batch.id,
        substituteCoachId: sub.id,
        fromDate: '2026-03-16',
        toDate: '2026-03-18',
      })
      .expect(201);
    const url = `/api/v1/batches/${s.batch.id}/insights`;
    const d = (await (await as(sub)).get(url).expect(200)).body.data;
    expect(d.roster[0].fees).toMatchObject({ status: 'hidden', unpaidInvoiceId: null });
    expect(d.summary.fees).toMatchObject({ hidden: true, studentsOverdue: 0, studentsDue: 0 });
    expect(d.upcoming.length).toBeGreaterThan(0);
    const own = (await (await as(s.coach)).get(url).expect(200)).body.data;
    expect(own.roster[0].fees.status).not.toBe('hidden');
    await s.api.get('/api/v1/invoices?pageSize=500').expect(200);
    await s.api.get('/api/v1/invoices?pageSize=501').expect(400);
  });
});

describe('people', () => {
  it('a coach with batches or cover due can’t lose the role or be disabled', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const drop = (id: string) => api.patch(`/api/v1/users/${id}`, { roles: ['admin'] });
    expect((await drop(a.coach.id)).body.error.message).toContain('active batches');
    const free = await makeUser('coach');
    await api
      .post('/api/v1/substitutions', {
        batchId: a.batch.id,
        substituteCoachId: free.id,
        fromDate: '2026-03-17',
        toDate: '2026-03-17',
      })
      .expect(201);
    expect((await drop(free.id)).body.error.message).toContain('cover as a substitute');
    await api.post(`/api/v1/users/${free.id}/status`, { status: 'disabled' }).expect(422);
    const idle = await makeUser('coach');
    await db
      .insert(deviceTokens)
      .values({ userId: idle.id, token: `t-${idle.id}-xxxxxxxxxxxx`, platform: 'android' });
    await api.post(`/api/v1/users/${idle.id}/status`, { status: 'disabled' }).expect(200);
    expect(await db.$count(deviceTokens, eq(deviceTokens.userId, idle.id))).toBe(0);
  });

  it('someone holding academy cash can’t be disabled until it’s handed over', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const s = await makeStudent({ batchId: a.batch.id, joiningDate: '2026-03-10' }, a.admin.id);
    const { generateDueInvoices } = await import('../../src/modules/billing/invoice-generator');
    await generateDueInvoices('2026-03-16');
    const [bill] = await db.select().from(invoices).where(eq(invoices.studentId, s.id));
    await (
      await as(a.coach)
    )
      .post(`/api/v1/invoices/${bill!.id}/payments`, { mode: 'cash', paidOn: '2026-03-16' })
      .expect(200);
    await db.update(batches).set({ coachId: a.otherCoach.id });
    const off = () => api.post(`/api/v1/users/${a.coach.id}/status`, { status: 'disabled' });
    expect((await off().expect(422)).body.error.message).toContain('still holds');
    await api
      .post('/api/v1/funds/handovers', {
        amount: bill!.totalAmount,
        occurredOn: '2026-03-16',
        userId: a.coach.id,
      })
      .expect(201);
    await off().expect(200);
  });

  it('name and phone together are unique, for new, approved, renamed and left students', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const body = (fullName: string, phone = '9812345678') => ({
      fullName,
      phone,
      joiningDate: '2026-03-16',
      batches: [{ batchId: a.batch.id }],
    });
    const first = (await api.post('/api/v1/students', body('Anya Rao')).expect(201)).body.data;
    const again = await api.post('/api/v1/students', body(' anya   RAO ', '+91 98123 45678'));
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain(first.code);
    // A sibling shares the phone; a namesake has another phone.
    const sibling = (await api.post('/api/v1/students', body('Vir Rao')).expect(201)).body.data;
    await api.post('/api/v1/students', body('Anya Rao', '9812345679')).expect(201);
    await api.patch(`/api/v1/students/${sibling.id}`, { fullName: 'Anya Rao' }).expect(409);
    await api
      .patch(`/api/v1/students/${first.id}`, { fullName: 'Anya Rao', address: 'X' })
      .expect(200);
    const reg = await request(getApp())
      .post('/api/v1/public/register/student')
      .send({ fullName: 'Anya Rao', phone: '9812345678', consent: true });
    await api
      .post(`/api/v1/registrations/${reg.body.data.id}/approve`, {
        joiningDate: '2026-03-16',
        batches: [{ batchId: a.batch.id }],
      })
      .expect(409);
    await api.post(`/api/v1/students/${first.id}/leave`, { leftOn: '2026-03-16' }).expect(200);
    const back = await api.post('/api/v1/students', body('Anya Rao'));
    expect(back.body.error.message).toContain('rejoin');
    const both = await Promise.all([
      api.post('/api/v1/students', body('Twin')),
      api.post('/api/v1/students', body('Twin')),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('a covered coach has no to-dos for that session; the admin sees who runs it', async () => {
    setToday('2026-03-16', '02:00:00'); // 07:30 IST, the 06:00 session is running
    const a = await makeAcademy();
    const sub = await makeUser('coach');
    await (
      await as(a.admin)
    )
      .post('/api/v1/substitutions', {
        batchId: a.batch.id,
        substituteCoachId: sub.id,
        fromDate: '2026-03-16',
        toDate: '2026-03-16',
      })
      .expect(201);
    const of = async (u: { id: string; name: string; email: string }, role: 'admin' | 'coach') =>
      (await tasksFor({ id: u.id, name: u.name, email: u.email, role })).items.filter((t) =>
        t.id.includes(a.batch.id),
      );
    expect(await of(a.coach, 'coach')).toEqual([]);
    expect((await of(sub, 'coach')).map((t) => t.kind)).toContain('missed-check-in');
    expect((await of(a.admin, 'admin'))[0]!.title).toContain(sub.name);
  });

  it('counts wrong passwords sent together, then locks', async () => {
    const u = await makeUser('coach', { withPassword: true });
    const attempt = () =>
      request(getApp())
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ email: u.email, password: 'wrong-pass-1' });
    await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.lockedUntil).not.toBeNull();
  });
});

describe('money and plans', () => {
  it('asks before recording the same money twice in a row', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const when = { occurredOn: '2026-03-16', amount: 50_000 };
    const post = (path: string, body: object, who = api) =>
      who.post(`/api/v1/funds/${path}`, { ...when, ...body });
    await post('income', { title: 'Opening balance' }).expect(201);
    const again = await post('income', { title: ' opening BALANCE ' }).expect(409);
    expect(again.body.error.details.warnings).toEqual([{ code: 'repeated' }]);
    await post('income', { title: 'Opening balance', confirm: true }).expect(201);
    await post('income', { title: 'Opening balance', amount: 50_001 }).expect(201);
    const bought = { title: 'Balls', paidFrom: 'own' };
    const coach = await as(a.coach);
    await post('expenses', bought, coach).expect(201);
    await post('expenses', bought, coach).expect(409);
    await post('expenses', bought, await as(a.otherCoach)).expect(201); // someone else
    await post('payouts', { userId: a.coach.id, amount: 20_000 }).expect(201);
    await post('payouts', { userId: a.coach.id, amount: 20_000 }).expect(409);
    await post('payouts', { userId: a.coach.id, amount: 20_000, confirm: true }).expect(201);
    // Two at the same moment: only one goes in.
    const both = await Promise.all([
      post('income', { title: 'Gala' }),
      post('income', { title: 'Gala' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    // A reversed one doesn't count.
    const gala = both.find((r) => r.status === 201)!.body.data.id as string;
    await api.post(`/api/v1/funds/txns/${gala}/reverse`, { reason: 'Wrong' }).expect(200);
    await post('income', { title: 'Gala' }).expect(201);
  });

  it('a cancelled invoice isn’t restored over days billed again', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const s = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-10' },
      a.admin.id,
    );
    const { generateDueInvoices } = await import('../../src/modules/billing/invoice-generator');
    await generateDueInvoices('2026-03-16');
    await api.patch(`/api/v1/students/${s.id}`, { joiningDate: '2026-03-12' }).expect(200);
    const bills = await db.select().from(invoices).where(eq(invoices.studentId, s.id));
    const cancelled = bills.find((b) => b.status === 'cancelled')!;
    const r = await api.post(`/api/v1/invoices/${cancelled.id}/restore-cancelled`, {
      reason: 'By mistake',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('already billed');
  });

  it('joining date can’t pass a planned last day', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const api = await as(a.admin);
    const s = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-16' },
      a.admin.id,
    );
    await api.post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-20' }).expect(200);
    await api.patch(`/api/v1/students/${s.id}`, { joiningDate: '2026-03-25' }).expect(422);
    const [e] = await db.select().from(enrollments).where(eq(enrollments.studentId, s.id));
    expect(e!.effectiveFrom).toBe('2026-03-16');
  });

  it('a plan in use keeps its days; a free plan made paid brings feedback back', async () => {
    const a = await makeAcademy();
    const api = await as(a.admin);
    const free = await makePlan({ daysPerWeek: 2, monthlyFee: 0 });
    const b = await makeBatch(a.coach.id, a.location.id, {
      weekdays: [6, 7],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: free.id,
      coachFeedback: false,
    });
    await api.patch(`/api/v1/fee-plans/${free.id}`, { daysPerWeek: 3 }).expect(422);
    await api.patch(`/api/v1/fee-plans/${free.id}`, { monthlyFee: 100_000 }).expect(200);
    const [after] = await db.select().from(batches).where(eq(batches.id, b.id));
    expect(after!.coachFeedback).toBe(true);
  });

  it('an edit with nothing in it is a plain 400', async () => {
    const a = await makeAcademy();
    const r = await (await as(a.admin)).patch(`/api/v1/fee-plans/${a.plan.id}`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('Nothing to change');
  });

  it('guesses sent together can’t slip past a share link’s lock', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const s = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-10' },
      a.admin.id,
    );
    const [row] = await db.select().from(students).where(eq(students.id, s.id));
    const guess = (n: string) =>
      checkRegistrationNo('invoice:x', s.id, n).then(
        () => 'ok',
        (e: { code: string }) => e.code,
      );
    const out = await Promise.all(Array.from({ length: 8 }, () => guess('0000')));
    expect(out.filter((x) => x === 'FORBIDDEN')).toHaveLength(4);
    expect(out.filter((x) => x === 'RATE_LIMITED')).toHaveLength(4);
    expect(await guess(String(row!.registrationNo))).toBe('RATE_LIMITED');
  });
});
