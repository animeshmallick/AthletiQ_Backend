import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import {
  batchCycles,
  enrollments,
  invoices,
  sessionCancellations,
  skillAssessments,
  studentAttendance,
  students,
} from '../../src/db/schema';
import { runInvoiceJob } from '../../src/jobs/invoice-job';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { renderCertificatePdf, certificateData } from '../../src/modules/cycles/certificate';
import { renewCycles } from '../../src/modules/cycles/cycles';
import { applyPlannedEnds } from '../../src/modules/cycles/exits';
import { getAcademySettings } from '../../src/modules/settings/settings';
import { getStudentDetail } from '../../src/modules/students/students.service';
import {
  as,
  getApp,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

const FEE = 250_000;
/** Mon / Wed / Fri batch; the student joins Mon 2 Mar 2026 (billing months from the 2nd). */
async function setup(
  opts: { months?: number | null; fee?: number; joined?: string; capacity?: number } = {},
) {
  const joined = opts.joined ?? '2026-03-02';
  setToday(joined);
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const location = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3, monthlyFee: opts.fee ?? FEE });
  const batch = await makeBatch(coach.id, location.id, {
    weekdays: [1, 3, 5],
    feePlanId: plan.id,
    courseMonths: opts.months === undefined ? 1 : opts.months,
    courseSetOn: joined,
    capacity: opts.capacity ?? 50,
  });
  const student = await makeStudent({ batchId: batch.id, joiningDate: joined }, admin.id);
  await generateDueInvoices(joined);
  const [m] = await db.select().from(enrollments).where(eq(enrollments.studentId, student.id));
  return { admin, coach, location, plan, batch, student, membership: m! };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const cyclesOf = (id: string) =>
  db
    .select()
    .from(batchCycles)
    .where(eq(batchCycles.studentId, id))
    .orderBy(asc(batchCycles.startsOn));
const brief = async (id: string) =>
  (await cyclesOf(id)).map((c) => [c.roundNo, c.status, c.startsOn, c.endsOn]);
const billsOf = (id: string) =>
  db.select().from(invoices).where(eq(invoices.studentId, id)).orderBy(asc(invoices.periodStart));
const periods = async (id: string) => (await billsOf(id)).map((i) => [i.periodStart, i.status]);
const mark = (s: Ctx, date: string, status: 'present' | 'late' | 'absent' = 'present') =>
  db.insert(studentAttendance).values({
    batchId: s.batch.id,
    studentId: s.student.id,
    date,
    status,
    markedById: s.admin.id,
  });
async function night(today: string) {
  setToday(today, '00:00:00');
  const r = await runInvoiceJob('manual');
  expect(r.ran).toBe(true);
}
const pay = async (s: Ctx, id: string, paidOn: string) =>
  (await as(s.admin)).post(`/api/v1/invoices/${id}/payments`, { mode: 'cash', paidOn }).expect(200);

describe('cycles and auto-renewal', () => {
  it('ends with the billing month and renews, however little the student attended', async () => {
    const s = await setup();
    expect(await brief(s.student.id)).toEqual([[1, 'active', '2026-03-02', '2026-04-01']]);
    for (const d of ['2026-03-04', '2026-03-06']) await mark(s, d, 'absent');
    await night('2026-04-01');
    expect(await brief(s.student.id)).toHaveLength(1);
    await night('2026-04-02');
    expect(await brief(s.student.id)).toEqual([
      [1, 'completed', '2026-03-02', '2026-04-01'],
      [2, 'active', '2026-04-02', '2026-05-01'],
    ]);
    // One membership, one invoice a month, same day; the unpaid March doesn't stop it.
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'due'],
    ]);
    expect((await getStudentDetail(s.student.id)).memberships).toHaveLength(1);
    const inbox = (await (await as(s.admin)).get('/api/v1/me/notifications')).body.data.items;
    expect(inbox.map((n: { title: string }) => n.title)).toEqual(
      expect.arrayContaining([expect.stringContaining('1 student renewed with unpaid fees')]),
    );
    // Running it again changes nothing.
    await night('2026-04-02');
    expect(await brief(s.student.id)).toHaveLength(2);
    expect(await billsOf(s.student.id)).toHaveLength(2);
  });

  it('keeps the billing day over short months, and catches up after downtime', async () => {
    const s = await setup({ joined: '2026-01-31', months: 2 });
    await night('2026-08-05');
    expect(await brief(s.student.id)).toEqual([
      [1, 'completed', '2026-01-31', '2026-03-30'],
      [2, 'completed', '2026-03-31', '2026-05-30'],
      [3, 'completed', '2026-05-31', '2026-07-30'],
      [4, 'active', '2026-07-31', '2026-09-29'],
    ]);
    expect((await billsOf(s.student.id)).map((i) => i.periodStart)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
    ]);
  });

  it('carries custom fee and discount; free batches renew without invoices', async () => {
    const s = await setup();
    await db
      .update(enrollments)
      .set({ customMonthlyFee: 200_000, monthlyDiscount: 10_000 })
      .where(eq(enrollments.id, s.membership.id));
    await night('2026-04-02');
    expect((await billsOf(s.student.id))[1]).toMatchObject({ totalAmount: 190_000 });
    const free = await setup({ fee: 0 });
    await night('2026-04-02');
    expect(await brief(free.student.id)).toHaveLength(2);
    expect(await billsOf(free.student.id)).toEqual([]);
  });

  it('first set-up starts everyone at their current month and touches no invoice', async () => {
    const s = await setup({ months: null });
    await night('2026-06-20');
    const before = await billsOf(s.student.id);
    expect(await cyclesOf(s.student.id)).toEqual([]);
    setToday('2026-06-20');
    const api = await as(s.admin);
    await api.patch(`/api/v1/batches/${s.batch.id}`, { courseMonths: 3 }).expect(200);
    expect(await brief(s.student.id)).toEqual([[1, 'active', '2026-06-02', '2026-09-01']]);
    expect(await billsOf(s.student.id)).toEqual(before);
    // Length and days are fixed while there are students; times and the rest aren't.
    await api.patch(`/api/v1/batches/${s.batch.id}`, { courseMonths: 2 }).expect(422);
    await api.patch(`/api/v1/batches/${s.batch.id}`, { weekdays: [2, 4, 6] }).expect(422);
    await api.patch(`/api/v1/batches/${s.batch.id}`, { startTime: '05:30' }).expect(200);
    const hist = (await api.get(`/api/v1/cycles/students/${s.student.id}`).expect(200)).body.data;
    expect(hist[0].cycles[0].invoices).toHaveLength(1);
    expect(hist[0].earlier).toHaveLength(3);
  });

  it('an imported student starts with the first billed month; a corrected joining date restarts', async () => {
    const s = await setup();
    const t = await makeStudent(
      { batchId: s.batch.id, joiningDate: '2025-10-05', billingStartsOn: '2026-03-02' },
      s.admin.id,
    );
    expect(await brief(t.id)).toEqual([[1, 'active', '2026-03-05', '2026-04-04']]);
    await (
      await as(s.admin)
    )
      .patch(`/api/v1/students/${s.student.id}`, { joiningDate: '2026-03-01' })
      .expect(200);
    expect(await brief(s.student.id)).toEqual([[1, 'active', '2026-03-01', '2026-03-31']]);
  });

  it('a renewal shows as neither a new nor a leaving student', async () => {
    const s = await setup();
    await night('2026-04-02');
    const ins = (
      await (await as(s.admin)).get(`/api/v1/batches/${s.batch.id}/insights`).expect(200)
    ).body.data;
    expect(ins.summary).toMatchObject({ students: 1 });
    expect(JSON.stringify(ins)).toContain('"left":0');
  });
});

describe('leaving and moving', () => {
  it('backdated: later unpaid months are cancelled, paid ones kept, the cycle is cut short', async () => {
    const s = await setup();
    await night('2026-05-03');
    const bills = await billsOf(s.student.id);
    setToday('2026-05-03');
    await pay(s, bills[1]!.id, '2026-05-03');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-03-20' })
      .expect(200);
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'paid'],
      ['2026-05-02', 'cancelled'],
    ]);
    expect((await cyclesOf(s.student.id)).map((c) => [c.roundNo, c.status, c.endedOn])).toEqual([
      [1, 'exited', '2026-03-20'],
    ]);
    // Rejoining starts again at round 1.
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/rejoin`, {
        rejoinDate: '2026-05-04',
        batches: [{ batchId: s.batch.id }],
      })
      .expect(200);
    expect((await brief(s.student.id))[1]).toEqual([1, 'active', '2026-05-04', '2026-06-03']);
  });

  it('a future date: active until then, never billed past it, even if the job is late', async () => {
    const s = await setup();
    const api = await as(s.admin);
    await api
      .post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-04-20', reason: 'Exams' })
      .expect(200);
    expect((await getStudentDetail(s.student.id)).status).toBe('active');
    // The closing job never ran: the generator alone must not bill May.
    await generateDueInvoices('2026-05-10');
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'due'],
    ]);
    await night('2026-05-10');
    expect(
      await db.query.students.findFirst({ where: eq(students.id, s.student.id) }),
    ).toMatchObject({ status: 'left', leftOn: '2026-04-20', leftReason: 'Exams' });
    expect((await cyclesOf(s.student.id)).map((c) => [c.roundNo, c.status, c.endedOn])).toEqual([
      [1, 'completed', '2026-04-01'],
      [2, 'exited', '2026-04-20'],
    ]);
  });

  it('leaving exactly on the last day finishes the cycle', async () => {
    const s = await setup();
    setToday('2026-04-01');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-04-01' })
      .expect(200);
    await night('2026-04-02');
    expect((await cyclesOf(s.student.id)).map((c) => c.status)).toEqual(['completed']);
    expect(await billsOf(s.student.id)).toHaveLength(1);
  });
});

describe('renewals', () => {
  it('coach stops and restores their own; admins only for moves, exits and write-offs', async () => {
    const s = await setup();
    const coach = await as(s.coach);
    const other = await as(await makeUser('coach'));
    const id = s.membership.id;
    const list = (await coach.get('/api/v1/renewals').expect(200)).body.data;
    expect(list[0]).toMatchObject({ enrollmentId: id, dues: null, stopped: null, roundNo: 1 });
    expect((await other.get('/api/v1/renewals').expect(200)).body.data).toEqual([]);
    await other.post(`/api/v1/renewals/${id}/stop`, { reason: 'Not mine' }).expect(404);
    await coach.post(`/api/v1/renewals/${id}/stop`, {}).expect(400);
    await coach
      .post(`/api/v1/renewals/${id}/stop`, { reason: 'Move', moveToBatchId: s.batch.id })
      .expect(403);
    await coach.get(`/api/v1/renewals/${id}/exit`).expect(403);
    await coach.post(`/api/v1/renewals/${id}/exit`, { reason: 'Leaving now' }).expect(403);
    await coach.post(`/api/v1/renewals/${id}/restore`).expect(409);
    await coach.post(`/api/v1/renewals/${id}/stop`, { reason: 'Parent asked' }).expect(200);
    await coach.post(`/api/v1/renewals/${id}/stop`, { reason: 'Again please' }).expect(409);
    const admin = await as(s.admin);
    expect((await admin.get('/api/v1/renewals').expect(200)).body.data[0]).toMatchObject({
      dues: { amount: FEE, count: 1 },
      stopped: { on: '2026-04-01', reason: 'Parent asked', moveTo: null },
    });
    await coach.post(`/api/v1/renewals/${id}/restore`).expect(200);
    await admin.post(`/api/v1/renewals/${id}/stop`, { reason: 'Admin decided' }).expect(200);
    await coach.post(`/api/v1/renewals/${id}/restore`).expect(403);
    await admin.post(`/api/v1/renewals/${id}/restore`).expect(200);
    await night('2026-04-02');
    expect(await brief(s.student.id)).toHaveLength(2);
  });

  it('stopped: the cycle is finished and billed in full, then they leave', async () => {
    const s = await setup({ months: 2 });
    await (
      await as(s.admin)
    )
      .post(`/api/v1/renewals/${s.membership.id}/stop`, { reason: 'Moving city' })
      .expect(200);
    await night('2026-05-02');
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'due'],
    ]);
    expect((await cyclesOf(s.student.id)).map((c) => c.status)).toEqual(['completed']);
    expect((await getStudentDetail(s.student.id)).status).toBe('left');
    await (await as(s.admin)).post(`/api/v1/renewals/${s.membership.id}/restore`).expect(409);
  });

  it('stopped with a move: the seat is held, billing continues on the same day', async () => {
    const s = await setup();
    const next = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
      courseMonths: 3,
      capacity: 1,
    });
    const admin = await as(s.admin);
    await admin
      .post(`/api/v1/renewals/${s.membership.id}/stop`, {
        reason: 'Level up',
        moveToBatchId: next.id,
      })
      .expect(200);
    const full = await admin.post('/api/v1/students', {
      fullName: 'Late Kid',
      phone: '+919876500000',
      joiningDate: '2026-03-03',
      batches: [{ batchId: next.id }],
    });
    expect(full.status).toBe(422);
    await admin.patch(`/api/v1/batches/${next.id}`, { isActive: false }).expect(422);
    await night('2026-04-02');
    expect(await brief(s.student.id)).toEqual([
      [1, 'completed', '2026-03-02', '2026-04-01'],
      [1, 'active', '2026-04-02', '2026-07-01'],
    ]);
    const bills = await billsOf(s.student.id);
    expect(bills.map((b) => [b.batchId, b.periodStart])).toEqual([
      [s.batch.id, '2026-03-02'],
      [next.id, '2026-04-02'],
    ]);
  });

  it('a destination that closed meanwhile: nothing billed, admins told, student kept active', async () => {
    const s = await setup();
    const next = await makeBatch(s.coach.id, s.location.id, { feePlanId: s.plan.id });
    await (
      await as(s.admin)
    )
      .post(`/api/v1/renewals/${s.membership.id}/stop`, {
        reason: 'Move up',
        moveToBatchId: next.id,
      })
      .expect(200);
    await db.execute(`update batches set is_active = false where id = '${next.id}'`);
    await night('2026-04-02');
    const d = await getStudentDetail(s.student.id);
    expect([d.status, d.memberships.length]).toEqual(['active', 0]);
    expect(await billsOf(s.student.id)).toHaveLength(1);
    expect(await applyPlannedEnds('2026-04-03')).toEqual({ ended: 0, moved: 0, failed: 0 });
  });
});

describe('exit now and lost invoices', () => {
  async function april(attended: boolean) {
    const s = await setup({ months: 3 });
    await night('2026-04-02');
    if (attended) await mark(s, '2026-04-03', 'late');
    setToday('2026-04-14');
    const bills = await billsOf(s.student.id);
    return { ...s, march: bills[0]!, april: bills[1]!, api: await as(s.admin) };
  }
  const exit = (s: Awaited<ReturnType<typeof april>>, body: object) =>
    s.api.post(`/api/v1/renewals/${s.membership.id}/exit`, { reason: 'Moving city', ...body });

  it('attended: the running month is suggested lost, older months stay due', async () => {
    const s = await april(true);
    const view = (await s.api.get(`/api/v1/renewals/${s.membership.id}/exit`).expect(200)).body
      .data;
    expect(
      view.invoices.map((i: { suggestion: string; attended: number }) => [
        i.suggestion,
        i.attended,
      ]),
    ).toEqual([
      ['due', 0],
      ['lost', 1],
    ]);
    const r = (await exit(s, { lostInvoiceIds: [s.april.id] }).expect(200)).body.data;
    expect(r).toMatchObject({ lost: 1, lostTotal: FEE, cancelled: 0, leftAcademy: true });
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'lost'],
    ]);
    const st = await getStudentDetail(s.student.id);
    expect([st.status, st.leftOn]).toEqual(['left', '2026-04-14']);
    expect(st.notes).toContain('₹2,500.00 written off as lost');
    expect((await cyclesOf(s.student.id)).at(-1)).toMatchObject({
      status: 'exited',
      endedOn: '2026-04-14',
    });
    // Closed for the family, out of dues and income, shown on its own.
    await s.api
      .post(`/api/v1/invoices/${s.april.id}/payments`, { mode: 'cash', paidOn: '2026-04-14' })
      .expect(409);
    await s.api.post(`/api/v1/invoices/${s.april.id}/share`).expect(422);
    await s.api.get(`/api/v1/invoices/${s.april.id}/pdf`).expect(200);
    const fin = (
      await s.api.get('/api/v1/finance/summary?from=2026-04-01&to=2026-04-30').expect(200)
    ).body.data.totals;
    expect(fin).toMatchObject({ billed: 0, outstanding: FEE, lost: FEE, lostCount: 1 });
    expect((await s.api.get('/api/v1/invoices?status=lost').expect(200)).body.data).toHaveLength(1);
    await night('2026-06-10');
    expect(await billsOf(s.student.id)).toHaveLength(2);

    // Collected after all.
    setToday('2026-06-10');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/invoices/${s.april.id}/restore-lost`, { reason: 'Parent paid' })
      .expect(200);
    await api
      .post(`/api/v1/invoices/${s.april.id}/restore-lost`, { reason: 'Parent paid' })
      .expect(409);
    await pay(s, s.april.id, '2026-06-10');
    expect((await periods(s.student.id))[1]).toEqual(['2026-04-02', 'paid']);
  });

  it('nothing attended: the running month is cancelled, not lost; the admin can leave dues', async () => {
    const s = await april(false);
    await exit(s, { lostInvoiceIds: [s.april.id] }).expect(400);
    await exit(s, { lostInvoiceIds: [s.march.id] }).expect(200);
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'lost'],
      ['2026-04-02', 'cancelled'],
    ]);
    await exit(s, {}).expect(409);
  });

  it('paid months are kept; unticked ones stay due; a payment in between refuses the write-off', async () => {
    const s = await april(true);
    await pay(s, s.april.id, '2026-04-14');
    await exit(s, { lostInvoiceIds: [s.april.id] }).expect(409);
    expect((await getStudentDetail(s.student.id)).status).toBe('active');
    await exit(s, {}).expect(200);
    expect(await periods(s.student.id)).toEqual([
      ['2026-03-02', 'due'],
      ['2026-04-02', 'paid'],
    ]);
  });

  it('moving now: the new batch bills from the next billing date', async () => {
    const s = await april(true);
    const next = await makeBatch(s.coach.id, s.location.id, {
      feePlanId: s.plan.id,
      courseMonths: 1,
    });
    await exit(s, { lostInvoiceIds: [s.april.id], moveToBatchId: next.id }).expect(200);
    expect((await brief(s.student.id)).at(-1)).toEqual([1, 'active', '2026-05-02', '2026-06-01']);
    await night('2026-05-02');
    expect((await billsOf(s.student.id)).at(-1)).toMatchObject({
      batchId: next.id,
      periodStart: '2026-05-02',
    });
  });

  it('a student who has not started yet can be exited (but not moved)', async () => {
    const s = await setup();
    const t = await makeStudent(
      { batchId: s.batch.id, joiningDate: '2026-03-09', billingStartsOn: '2026-03-02' },
      s.admin.id,
    );
    await generateDueInvoices('2026-03-02');
    const [bill] = await billsOf(t.id);
    // Paying before the period starts is fine.
    const [m] = await db.select().from(enrollments).where(eq(enrollments.studentId, t.id));
    const api = await as(s.admin);
    await api
      .post(`/api/v1/renewals/${m!.id}/exit`, { reason: 'Changed mind', moveToBatchId: s.batch.id })
      .expect(422);
    await pay(s, bill!.id, '2026-03-02');
    await api.post(`/api/v1/renewals/${m!.id}/exit`, { reason: 'Changed mind' }).expect(200);
    expect((await billsOf(t.id)).map((i) => i.status)).toEqual(['paid']);
  });
});

describe('history and certificates', () => {
  async function finished() {
    const s = await setup();
    for (const d of ['2026-03-02', '2026-03-04', '2026-03-06']) await mark(s, d);
    await mark(s, '2026-03-09', 'absent');
    await mark(s, '2026-03-11', 'late');
    await db.insert(sessionCancellations).values({
      batchId: s.batch.id,
      date: '2026-03-13',
      reason: 'Rain',
      cancelledById: s.coach.id,
    });
    for (const [month, average] of [
      ['2026-03-01', 200],
      ['2026-04-01', 300],
    ] as const)
      await db.insert(skillAssessments).values({
        studentId: s.student.id,
        sportId: s.batch.sportId,
        batchId: s.batch.id,
        coachId: s.coach.id,
        month,
        average,
        levelName: 'Bronze',
        levelCode: 'A2',
      });
    await night('2026-04-02');
    setToday('2026-04-02');
    const [c] = await cyclesOf(s.student.id);
    return { ...s, cycle: c! };
  }

  it('shows every batch, cycle and session to admins and the batch coach', async () => {
    const s = await finished();
    const hist = (
      await (await as(s.coach)).get(`/api/v1/cycles/students/${s.student.id}`).expect(200)
    ).body.data;
    expect(hist[0].cycles).toHaveLength(2);
    expect(hist[0].cycles[1]).toMatchObject({
      conducted: 5,
      attended: 4,
      late: 1,
      absent: 1,
      missed: 1,
      unconfirmed: 8,
      rate: 80,
    });
    const running = (
      await (await as(s.coach)).get(`/api/v1/cycles/batches/${s.batch.id}`).expect(200)
    ).body.data;
    expect(running.cycles[0]).toMatchObject({ roundNo: 2, target: 12 });
    expect(running.cycles[0].sessions).toBeUndefined();
    const stranger = await as(await makeUser('coach'));
    await stranger.get(`/api/v1/cycles/students/${s.student.id}`).expect(404);
    await stranger.get(`/api/v1/cycles/${s.cycle.id}/certificate`).expect(404);
  });

  it('gives a certificate for finished cycles only, shareable with the registration number', async () => {
    const s = await finished();
    const coach = await as(s.coach);
    const running = (await cyclesOf(s.student.id))[1]!;
    await coach.get(`/api/v1/cycles/${running.id}/certificate`).expect(422);
    const pdf = await coach.get(`/api/v1/cycles/${s.cycle.id}/certificate`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const data = await certificateData(s.cycle.id);
    expect(data).toMatchObject({
      conducted: 5,
      attended: 4,
      rate: 80,
      trend: [{ month: '2026-03', attended: 4, conducted: 5 }],
      level: { start: { average: 2 }, end: { average: 3 } },
    });
    const blank = await renderCertificatePdf(
      {
        ...data,
        studentName: 'A very long name '.repeat(8),
        rate: null,
        trend: [],
        level: { start: null, end: null },
      },
      await getAcademySettings(),
    );
    expect(blank.subarray(0, 4).toString()).toBe('%PDF');

    const share = (await coach.post(`/api/v1/cycles/${s.cycle.id}/certificate/share`).expect(200))
      .body.data;
    expect(share.whatsappUrl).toContain('wa.me');
    const u = new URL(share.url);
    const q = { e: u.searchParams.get('e')!, s: u.searchParams.get('s')! };
    const base = `/api/v1/public/certificates/${s.cycle.id}`;
    await request(getApp()).get(base).query(q).expect(200);
    await request(getApp())
      .get(base)
      .query({ ...q, s: 'forged' })
      .expect(403);
    const st = await db.query.students.findFirst({ where: eq(students.id, s.student.id) });
    await request(getApp())
      .post(`${base}/pdf`)
      .send({ ...q, registrationNo: '000000' })
      .expect(403);
    await request(getApp())
      .post(`${base}/pdf`)
      .send({ ...q, registrationNo: String(st!.registrationNo) })
      .expect(200);
  });

  it('handles unknown memberships, full or same destinations, and later planned days', async () => {
    const s = await setup();
    const api = await as(s.admin);
    const none = '00000000-0000-4000-8000-000000000000';
    await api.post(`/api/v1/renewals/${none}/stop`, { reason: 'Nobody here' }).expect(404);
    await api.get(`/api/v1/renewals/${none}/exit`).expect(404);
    await api.post(`/api/v1/renewals/${none}/exit`, { reason: 'Nobody here' }).expect(404);
    await api.get(`/api/v1/cycles/${none}/certificate`).expect(404);
    await api
      .post(`/api/v1/renewals/${s.membership.id}/stop`, {
        reason: 'Same batch',
        moveToBatchId: s.batch.id,
      })
      .expect(400);
    expect(
      (await api.get(`/api/v1/renewals?batchId=${s.batch.id}`).expect(200)).body.data,
    ).toHaveLength(1);
    expect((await api.get(`/api/v1/renewals?batchId=${none}`).expect(200)).body.data).toEqual([]);
    await api.post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-03-02' }).expect(200);
    await api.post(`/api/v1/renewals/${s.membership.id}/stop`, { reason: 'Too late' }).expect(409);
    // Without a course there is nothing to renew.
    const free = await setup({ months: null });
    expect((await (await as(free.admin)).get('/api/v1/renewals').expect(200)).body.data).toEqual(
      [],
    );
    await (
      await as(free.admin)
    )
      .post(`/api/v1/renewals/${free.membership.id}/stop`, { reason: 'No course' })
      .expect(404);
  });

  it('names up to six students renewed with dues; deactivated batches do not renew', async () => {
    const s = await setup();
    for (let i = 0; i < 7; i++)
      await makeStudent({ batchId: s.batch.id, joiningDate: '2026-03-02' }, s.admin.id);
    await generateDueInvoices('2026-03-02');
    await night('2026-04-02');
    const inbox = (await (await as(s.admin)).get('/api/v1/me/notifications')).body.data.items;
    const note = inbox.find((n: { title: string }) => n.title.includes('renewed with unpaid'));
    expect(note.title).toContain('8 students');
    expect(note.body).toContain('and 2 more');
    await db.execute(`update batches set is_active = false where id = '${s.batch.id}'`);
    expect(await renewCycles('2026-05-02')).toMatchObject({ checked: 8, renewed: 0, failed: 0 });
  });

  it('a certificate without sessions, levels or course months reads sensibly', async () => {
    const s = await setup();
    await night('2026-04-02');
    const [c] = await cyclesOf(s.student.id);
    const d = await certificateData(c!.id);
    expect(d).toMatchObject({
      conducted: 0,
      rate: null,
      trend: [],
      level: { start: null, end: null },
    });
  });
});
