import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import {
  courseRounds,
  invoices,
  sessionCancellations,
  skillAssessments,
  sessionShortfalls,
  studentAttendance,
  studentCredits,
  students,
} from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { evaluateDelivery, sendPaceDigest } from '../../src/modules/courses/delivery';
import { evaluateCourses } from '../../src/modules/courses/rounds';
import { certificateData, renderCertificatePdf } from '../../src/modules/courses/certificate';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
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

/**
 * Mon / Wed / Fri batch (12 a month), student joins Mon 2 Mar 2026: billing month 2 Mar – 1 Apr
 * holds 14 sessions (Mar 2 … 30, Apr 1). Fee ₹2,500.
 */
const FEE = 250_000;
const MARCH = [
  '2026-03-02',
  '2026-03-04',
  '2026-03-06',
  '2026-03-09',
  '2026-03-11',
  '2026-03-13',
  '2026-03-16',
  '2026-03-18',
  '2026-03-20',
  '2026-03-23',
  '2026-03-25',
  '2026-03-27',
];

async function setup(opts: { fee?: number; courseMonths?: number | null } = {}) {
  setToday('2026-03-02');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const location = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3, monthlyFee: opts.fee ?? FEE });
  const batch = await makeBatch(coach.id, location.id, {
    weekdays: [1, 3, 5],
    feePlanId: plan.id,
    courseMonths: opts.courseMonths === undefined ? 2 : opts.courseMonths,
  });
  const student = await makeStudent({ batchId: batch.id, joiningDate: '2026-03-02' }, admin.id);
  await generateDueInvoices('2026-03-02');
  return { admin, coach, location, plan, batch, student };
}

const cancel = (s: { batch: { id: string }; admin: { id: string } }, ...dates: string[]) =>
  db.insert(sessionCancellations).values(
    dates.map((date) => ({
      batchId: s.batch.id,
      date,
      reason: 'Rain',
      cancelledById: s.admin.id,
    })),
  );
const shortfalls = () =>
  db.select().from(sessionShortfalls).orderBy(asc(sessionShortfalls.periodStart));
const invoicesOf = (id: string) =>
  db.select().from(invoices).where(eq(invoices.studentId, id)).orderBy(asc(invoices.periodStart));

describe('monthly delivery', () => {
  it('warns as soon as a month can’t reach 12, and clears when an extra session is added', async () => {
    const s = await setup();
    setToday('2026-03-10');
    await evaluateDelivery('2026-03-10');
    expect(await shortfalls()).toEqual([]);

    // Three rain-outs: 14 − 3 = 11 possible.
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    expect(await evaluateDelivery('2026-03-10')).toMatchObject({ atRisk: 1 });
    const [sf] = await shortfalls();
    expect(sf).toMatchObject({
      status: 'at_risk',
      cycleNumber: 1,
      periodStart: '2026-03-02',
      periodEnd: '2026-04-01',
      target: 12,
      held: 1, // 2 Mar (4, 6 and 9 Mar were cancelled)
      remaining: 10, // 11 Mar … 1 Apr
    });
    // Coach gets a to-do and sees it (without money).
    const coachTasks = await tasksFor({ ...s.coach, role: 'coach' } as never);
    expect(coachTasks.items.find((t) => t.kind === 'delivery-risk')).toMatchObject({ count: 1 });
    const seen = (await (await as(s.coach)).get('/api/v1/delivery/shortfalls').expect(200)).body
      .data;
    expect(seen).toEqual([expect.objectContaining({ id: sf!.id, missing: 1 })]);
    expect(seen[0].discountValue).toBeUndefined();

    // The coach adds an extra session on Sunday 15 Mar: recovered.
    const extra = await (
      await as(s.coach)
    )
      .post(`/api/v1/batches/${s.batch.id}/session-changes`, {
        date: '2026-03-15',
        startTime: '08:00',
        endTime: '10:00',
        reason: 'Make up the rain-outs',
      })
      .expect(201);
    expect(extra.body.data.status).toBe('approved');
    expect(await evaluateDelivery('2026-03-10')).toMatchObject({ recovered: 1 });
    expect((await shortfalls())[0]).toMatchObject({ status: 'recovered', remaining: 11 });
  });

  it('a month that ends short waits for an admin: discount off the next unpaid invoice', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    expect(await evaluateDelivery('2026-04-02')).toMatchObject({ short: 1 });
    const [sf] = await shortfalls();
    expect(sf).toMatchObject({ status: 'short', held: 11, remaining: 0 });
    const adminTasks = await tasksFor({ ...s.admin, role: 'admin' } as never);
    expect(adminTasks.items.find((t) => t.kind === 'session-shortfalls')).toMatchObject({
      count: 1,
    });

    const api = await as(s.admin);
    const list = (await api.get('/api/v1/delivery/shortfalls').expect(200)).body.data;
    expect(list[0]).toMatchObject({ missing: 1, discountValue: 20_833 }); // ₹2,500 ÷ 12 × 1
    // Coaches can't discount or dismiss.
    await (await as(s.coach)).post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`).expect(403);
    await (
      await as(s.coach)
    )
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/dismiss`, { reason: 'x'.repeat(5) })
      .expect(403);

    const res = await api
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`, { note: 'Rain' })
      .expect(200);
    const [march, april] = await invoicesOf(s.student.id);
    // The oldest unpaid invoice takes it (March, still unpaid here).
    expect(res.body.data).toMatchObject({
      amount: 20_833,
      invoiceId: march!.id,
      creditStatus: 'assigned',
    });
    expect(march).toMatchObject({ creditAmount: 20_833, totalAmount: FEE - 20_833 });
    expect(april).toMatchObject({ creditAmount: 0, totalAmount: FEE });
    expect((await shortfalls())[0]).toMatchObject({ status: 'discounted', amount: 20_833 });
    await api.post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`).expect(409);
  });

  it('with nothing unpaid, the discount waits for the next invoice', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    setToday('2026-03-02');
    const march = (await invoicesOf(s.student.id))[0]!;
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${march.id}/payments`, { mode: 'cash', paidOn: '2026-03-02' })
      .expect(200);
    // Month ended; the night's run hasn't issued April yet.
    await evaluateDelivery('2026-04-02');
    const [sf] = await shortfalls();
    setToday('2026-04-02');
    await (await as(s.admin)).post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`).expect(200);
    expect(await db.select().from(studentCredits)).toEqual([
      expect.objectContaining({ status: 'assigned', amount: 20_833, kind: 'shortfall' }),
    ]);
    await generateDueInvoices('2026-04-02');
    expect((await invoicesOf(s.student.id))[1]).toMatchObject({
      creditAmount: 20_833,
      totalAmount: FEE - 20_833,
    });
  });

  it('dismissing needs a reason; extra sessions must belong to the batch and month', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    await evaluateDelivery('2026-04-02');
    const [sf] = await shortfalls();
    setToday('2026-04-02');
    const api = await as(s.admin);
    await api.post(`/api/v1/delivery/shortfalls/${sf!.id}/dismiss`, { reason: '' }).expect(400);
    // An extra session of the batch on 5 Apr (Sunday) makes it up.
    const extra = (
      await api
        .post(`/api/v1/batches/${s.batch.id}/session-changes`, {
          date: '2026-04-05',
          startTime: '08:00',
          endTime: '10:00',
        })
        .expect(201)
    ).body.data;
    await api
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/extra`, {
        sessionChangeId: '00000000-0000-0000-0000-000000000000',
      })
      .expect(422);
    const linked = await api
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/extra`, {
        sessionChangeId: extra.id,
        note: 'Sunday catch-up',
      })
      .expect(200);
    expect(linked.body.data).toMatchObject({ status: 'extra_added', sessionChangeId: extra.id });
    await api
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/dismiss`, { reason: 'Already handled' })
      .expect(409);
  });

  it('free months have nothing to discount', async () => {
    const free = await setup({ fee: 0 });
    await cancel(free, '2026-03-04', '2026-03-06', '2026-03-09');
    await evaluateDelivery('2026-04-02');
    const [sf] = await shortfalls();
    setToday('2026-04-02');
    const api = await as(free.admin);
    await api.post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`).expect(422);
    await api
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/dismiss`, { reason: 'Free batch' })
      .expect(200);
  });

  it('skips batches without a course (rollout is opt-in)', async () => {
    const s = await setup({ courseMonths: null });
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    expect(await evaluateDelivery('2026-04-02')).toMatchObject({ checked: 0 });
  });

  it('an admin can run the check on demand; month-in-progress can’t be discounted', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    setToday('2026-03-10');
    const api = await as(s.admin);
    expect((await api.post('/api/v1/delivery/evaluate').expect(200)).body.data).toMatchObject({
      atRisk: 1,
    });
    const [sf] = await shortfalls();
    await api.post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`).expect(422);
    expect(
      (await api.get('/api/v1/delivery/shortfalls?status=at_risk').expect(200)).body.data,
    ).toHaveLength(1);
  });
});

describe('course pace', () => {
  it('lists students who can’t finish within the course months, and sends the Monday digest', async () => {
    const s = await setup({ courseMonths: 1 });
    // Missed the first two weeks: by 13 Mar, 1 attended; 8 sessions left until 1 Apr → 3 short.
    await db.insert(studentAttendance).values({
      batchId: s.batch.id,
      studentId: s.student.id,
      date: '2026-03-02',
      status: 'present',
      markedById: s.admin.id,
    });
    for (const d of MARCH.slice(1, 6))
      await db.insert(studentAttendance).values({
        batchId: s.batch.id,
        studentId: s.student.id,
        date: d,
        status: 'absent',
        markedById: s.admin.id,
      });
    setToday('2026-03-13');
    const pace = (await (await as(s.coach)).get('/api/v1/delivery/pace').expect(200)).body.data;
    expect(pace).toEqual([
      expect.objectContaining({
        attended: 1,
        target: 12,
        remaining: 8, // 16, 18, 20, 23, 25, 27, 30 Mar, 1 Apr
        short: 3,
        courseEndsOn: '2026-04-01',
        inExtension: false,
      }),
    ]);
    // Other coaches see nothing; a batch filter needs access.
    const other = await makeUser('coach');
    expect((await (await as(other)).get('/api/v1/delivery/pace').expect(200)).body.data).toEqual(
      [],
    );
    await (await as(other)).get(`/api/v1/delivery/pace?batchId=${s.batch.id}`).expect(404);

    setToday('2026-03-16');
    expect(await sendPaceDigest('2026-03-16')).toEqual({ students: 1, coaches: 1 });
    const inbox = (await (await as(s.coach)).get('/api/v1/me/notifications').expect(200)).body.data;
    const titles = ((inbox.items ?? inbox) as { title: string }[]).map((n) => n.title);
    expect(titles.some((t) => t.includes('1 student is behind course pace'))).toBe(true);
    // Once a day only.
    expect(await sendPaceDigest('2026-03-16')).toEqual({ students: 1, coaches: 1 });
  });

  it('flags a student already in an extension month', async () => {
    const s = await setup({ courseMonths: 1 });
    setToday('2026-04-03');
    const pace = (await (await as(s.admin)).get('/api/v1/delivery/pace').expect(200)).body.data;
    expect(pace[0]).toMatchObject({ inExtension: true, attended: 0 });
    expect(await sendPaceDigest('2026-04-03')).toMatchObject({ students: 1 });
  });
});

describe('certificates', () => {
  async function completed() {
    const s = await setup({ courseMonths: 1 });
    await db.insert(studentAttendance).values(
      MARCH.map((date) => ({
        batchId: s.batch.id,
        studentId: s.student.id,
        date,
        status: 'present' as const,
        markedById: s.admin.id,
      })),
    );
    await evaluateCourses('2026-03-27');
    const [round] = (
      await (await as(s.admin)).get(`/api/v1/courses/students/${s.student.id}`).expect(200)
    ).body.data.rounds;
    return { ...s, round };
  }

  it('downloads for completed rounds only (admin and the coach)', async () => {
    const s = await completed();
    setToday('2026-03-28');
    const pdf = await (
      await as(s.coach)
    )
      .get(`/api/v1/courses/rounds/${s.round.id}/certificate`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const stranger = await makeUser('coach');
    await (await as(stranger)).get(`/api/v1/courses/rounds/${s.round.id}/certificate`).expect(404);
    await (
      await as(s.admin)
    )
      .get(`/api/v1/courses/rounds/00000000-0000-0000-0000-000000000000/certificate`)
      .expect(404);
  });

  it('is not available mid-course', async () => {
    const s = await setup({ courseMonths: 1 });
    const [round] = (
      await (await as(s.admin)).get(`/api/v1/courses/students/${s.student.id}`).expect(200)
    ).body.data.rounds;
    await (await as(s.admin)).get(`/api/v1/courses/rounds/${round.id}/certificate`).expect(422);
    await (
      await as(s.admin)
    )
      .post(`/api/v1/courses/rounds/${round.id}/certificate/share`)
      .expect(422);
  });

  it('shares a link that opens with the registration number', async () => {
    const s = await completed();
    setToday('2026-03-28');
    const share = (
      await (
        await as(s.admin)
      )
        .post(`/api/v1/courses/rounds/${s.round.id}/certificate/share`)
        .expect(200)
    ).body.data;
    expect(share.whatsapp).toContain('wa.me/');
    const url = new URL(share.url);
    const e = url.searchParams.get('e')!;
    const sig = url.searchParams.get('s')!;
    const base = `/api/v1/public/certificates/${s.round.id}`;
    const info = await request(getApp()).get(`${base}?e=${e}&s=${sig}`).expect(200);
    expect(info.body.data).toMatchObject({ kind: 'certificate', title: 'Course certificate' });
    await request(getApp()).get(`${base}?e=${e}&s=forged`).expect(403);

    const st = await db.query.students.findFirst({ where: eq(students.id, s.student.id) });
    const regNo = String(st!.registrationNo);
    await request(getApp())
      .post(`${base}/pdf`)
      .send({ e, s: sig, registrationNo: regNo === '9999' ? '9998' : '9999' })
      .expect(403);
    const ok = await request(getApp())
      .post(`${base}/pdf`)
      .send({ e, s: sig, registrationNo: regNo })
      .expect(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
  });
});

describe('delivery over time and certificate details', () => {
  it('an at-risk month becomes short when it ends; decided months only get their numbers updated', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    expect(await evaluateDelivery('2026-03-10')).toMatchObject({ atRisk: 1 });
    expect(await evaluateDelivery('2026-03-11')).toMatchObject({ atRisk: 0 }); // no repeat notice
    expect(await evaluateDelivery('2026-04-02')).toMatchObject({ short: 1 });
    const [sf] = await shortfalls();
    expect(sf).toMatchObject({ status: 'short', held: 11, remaining: 0 });
    setToday('2026-04-02');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/dismiss`, { reason: 'Agreed with parent' })
      .expect(200);
    // A cancellation restored afterwards: the numbers follow, the decision stands.
    await db.delete(sessionCancellations).where(eq(sessionCancellations.date, '2026-03-09'));
    await evaluateDelivery('2026-04-03');
    expect((await shortfalls())[0]).toMatchObject({ status: 'dismissed', held: 12 });
    // Filtered list.
    const dismissed = (
      await (await as(s.admin)).get('/api/v1/delivery/shortfalls?status=dismissed').expect(200)
    ).body.data;
    expect(dismissed).toHaveLength(1);
  });

  it('a short month restored before anyone decides keeps its numbers current', async () => {
    const s = await setup();
    await cancel(s, '2026-03-04', '2026-03-06', '2026-03-09');
    await evaluateDelivery('2026-04-02');
    await db.delete(sessionCancellations).where(eq(sessionCancellations.date, '2026-03-09'));
    await evaluateDelivery('2026-04-03');
    expect((await shortfalls())[0]).toMatchObject({ status: 'short', held: 12 });
  });

  it('a certificate shows the level reached and the round', async () => {
    const s = await setup({ courseMonths: 1 });
    await db.insert(studentAttendance).values(
      MARCH.map((date) => ({
        batchId: s.batch.id,
        studentId: s.student.id,
        date,
        status: 'present' as const,
        markedById: s.admin.id,
      })),
    );
    await db.insert(skillAssessments).values({
      studentId: s.student.id,
      sportId: s.batch.sportId,
      batchId: s.batch.id,
      coachId: s.coach.id,
      month: '2026-03-01',
      average: 250,
      levelName: 'Bronze',
      levelCode: 'A2',
    });
    await evaluateCourses('2026-03-27');
    const data = await certificateData(
      (await db.select().from(courseRounds).where(eq(courseRounds.studentId, s.student.id)))[0]!.id,
    );
    expect(data).toMatchObject({
      level: { code: 'A2', name: 'Bronze' },
      attended: 12,
      target: 12,
      roundNo: 1,
      completedOn: '2026-03-27',
      courseMonths: 1,
    });
    // Round 2 wording renders too.
    const pdf = await renderCertificatePdf(
      { ...data, roundNo: 2, level: null, courseMonths: null },
      {
        name: 'Test Academy',
        legalName: null,
      } as never,
    );
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
