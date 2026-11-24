import { describe, expect, it } from '@jest/globals';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { addDays } from '../../src/lib/dates';
import {
  batches,
  courseRounds,
  enrollments,
  invoices,
  makeupSessions,
  sessionCancellations,
  sessionShortfalls,
  studentAttendance,
  studentCredits,
  students,
} from '../../src/db/schema';
import { runInvoiceJob } from '../../src/jobs/invoice-job';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { expectedRoster } from '../../src/modules/batches/roster';
import { autoLeave, evaluateCourses, remindDecisions } from '../../src/modules/courses/rounds';
import { evaluateDelivery } from '../../src/modules/courses/delivery';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import {
  as,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

/**
 * Mon / Wed / Fri batch → 12 sessions a month. Student joins Mon 2 Mar 2026, so billing months
 * run 2 Mar–1 Apr, 2 Apr–1 May, … Fee ₹2,500 (250 000 paise).
 */
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
const FEE = 250_000;
const ELEVEN_TWELFTHS = 229_167; // round(250 000 × 11 / 12)

async function setup(opts: { courseMonths?: number | null; fee?: number; capacity?: number } = {}) {
  setToday('2026-03-02');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const location = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3, monthlyFee: opts.fee ?? FEE });
  const batch = await makeBatch(coach.id, location.id, {
    weekdays: [1, 3, 5],
    feePlanId: plan.id,
    courseMonths: opts.courseMonths === undefined ? 1 : opts.courseMonths,
    capacity: opts.capacity ?? 50,
  });
  const student = await makeStudent({ batchId: batch.id, joiningDate: '2026-03-02' }, admin.id);
  await generateDueInvoices('2026-03-02');
  return { admin, coach, location, plan, batch, student };
}

const attend = (
  s: { admin: { id: string }; batch: { id: string }; student: { id: string } },
  dates: string[],
  status: 'present' | 'late' | 'absent' = 'present',
  batchId = s.batch.id,
) =>
  db.insert(studentAttendance).values(
    dates.map((date) => ({
      batchId,
      studentId: s.student.id,
      date,
      status,
      isMakeup: batchId !== s.batch.id,
      markedById: s.admin.id,
    })),
  );

const invoicesOf = (studentId: string) =>
  db
    .select()
    .from(invoices)
    .where(eq(invoices.studentId, studentId))
    .orderBy(asc(invoices.periodStart), asc(invoices.createdAt));
const roundsOf = (studentId: string) =>
  db
    .select()
    .from(courseRounds)
    .where(eq(courseRounds.studentId, studentId))
    .orderBy(asc(courseRounds.startedOn), asc(courseRounds.roundNo));
const creditsOf = (studentId: string) =>
  db
    .select()
    .from(studentCredits)
    .where(eq(studentCredits.studentId, studentId))
    .orderBy(asc(studentCredits.createdAt));
const membershipsOf = (studentId: string) =>
  db
    .select()
    .from(enrollments)
    .where(eq(enrollments.studentId, studentId))
    .orderBy(asc(enrollments.effectiveFrom));

async function pay(
  admin: { id: string; role: 'admin' | 'coach' },
  invoiceId: string,
  paidOn: string,
) {
  await (
    await as(admin)
  )
    .post(`/api/v1/invoices/${invoiceId}/payments`, { mode: 'cash', paidOn })
    .expect(200);
}

describe('course rounds: completion within the course', () => {
  it('completes on the 12th session: membership ends, seat held, no next invoice', async () => {
    const s = await setup();
    await attend(s, MARCH.slice(0, 11));
    expect(await evaluateCourses('2026-03-25')).toMatchObject({ completed: 0 });
    await attend(s, MARCH.slice(11));
    expect(await evaluateCourses('2026-03-27')).toMatchObject({ completed: 1 });

    const [round] = await roundsOf(s.student.id);
    expect(round).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-03-27',
      attended: 12,
      target: 12,
      adjustments: [],
    });
    const [m] = await membershipsOf(s.student.id);
    expect(m!.effectiveTo).toBe('2026-03-27');
    // Not expected at the next session; the student stays active (decision pending).
    expect(await expectedRoster(s.batch.id, '2026-03-30')).toEqual([]);
    expect(
      (await db.query.students.findFirst({ where: eq(students.id, s.student.id) }))!.status,
    ).toBe('active');

    // The next month is never billed.
    await generateDueInvoices('2026-04-02');
    expect((await invoicesOf(s.student.id)).map((i) => i.periodStart)).toEqual(['2026-03-02']);

    // Admin sees it to decide; it is listed with the date it would auto-leave.
    setToday('2026-03-28');
    const list = (await (await as(s.admin)).get('/api/v1/courses/decisions').expect(200)).body.data;
    expect(list).toEqual([
      expect.objectContaining({
        id: round!.id,
        attended: 12,
        target: 12,
        credit: 0,
        dues: { amount: FEE, count: 1 },
        autoLeaveOn: '2026-04-26',
      }),
    ]);
    const tasks = await tasksFor({ ...s.admin, role: 'admin' } as never);
    expect(tasks.items.map((t) => t.kind)).toContain('course-decisions');
    // Coaches can't decide.
    await (
      await as(s.coach)
    )
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'leave' })
      .expect(403);
  });

  it('holds the seat while waiting: the batch is full for others, not for re-admission', async () => {
    const s = await setup({ capacity: 1 });
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    const other = (await (
      await as(s.admin)
    ).post('/api/v1/students', {
      fullName: 'New Kid',
      phone: '+919876500000',
      joiningDate: '2026-03-28',
      batches: [{ batchId: s.batch.id }],
    })) as { status: number; body: { error: { message: string } } };
    expect(other.status).toBe(422);
    expect(other.body.error.message).toContain('is full');
    // Joining the batch directly is refused: it goes through the decision.
    const join = await (
      await as(s.admin)
    ).post(`/api/v1/students/${s.student.id}/batches`, {
      batchId: s.batch.id,
      effectiveFrom: '2026-03-30',
    });
    expect(join.status).toBe(409);
    expect(join.body.error.message).toContain('waiting for a decision');

    setToday('2026-03-28');
    const [round] = await roundsOf(s.student.id);
    const api = await as(s.admin);
    // Dues need confirming.
    const dues = await api.post(`/api/v1/courses/rounds/${round!.id}/decide`, {
      action: 'readmit',
    });
    expect(dues.status).toBe(409);
    expect(dues.body.error.details.dues).toEqual({ amount: FEE, count: 1 });
    // Start date: after completion, within 30 days.
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-03-27',
        confirmDues: true,
      })
      .expect(400);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-04-28',
        confirmDues: true,
      })
      .expect(400);
    const done = await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-03-30',
        confirmDues: true,
      })
      .expect(200);
    expect(done.body.data.round).toMatchObject({ status: 'readmitted' });

    // New membership and round 2; billing restarts on its first day (the 30th).
    const ms = await membershipsOf(s.student.id);
    expect(ms.map((m) => [m.effectiveFrom, m.effectiveTo, m.billingStartsOn])).toEqual([
      ['2026-03-02', '2026-03-27', '2026-03-02'],
      ['2026-03-30', null, '2026-03-30'],
    ]);
    const rounds = await roundsOf(s.student.id);
    expect(rounds.map((r) => [r.roundNo, r.status, r.startedOn])).toEqual([
      [1, 'readmitted', '2026-03-02'],
      [2, 'active', '2026-03-30'],
    ]);
    // Not issued before its day…
    expect((await invoicesOf(s.student.id)).length).toBe(1);
    await generateDueInvoices('2026-03-30');
    const inv = await invoicesOf(s.student.id);
    expect(inv.map((i) => [i.periodStart, i.periodEnd, i.totalAmount])).toEqual([
      ['2026-03-02', '2026-04-01', FEE],
      ['2026-03-30', '2026-04-29', FEE],
    ]);
    // A decision is final.
    await api.post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'leave' }).expect(409);
  });
});

describe('course rounds: extension month', () => {
  /** 11 of 12 in March, April billed in full on 2 Apr, the 12th session on Fri 3 Apr. */
  async function extended(payApril: boolean) {
    const s = await setup();
    // March is settled, so nothing is outstanding at the decision.
    await pay(s.admin, (await invoicesOf(s.student.id))[0]!.id, '2026-03-02');
    await attend(s, MARCH.slice(0, 11));
    await evaluateCourses('2026-04-01');
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april).toMatchObject({ periodStart: '2026-04-02', totalAmount: FEE, status: 'due' });
    if (payApril) await pay(s.admin, april.id, '2026-04-02');
    await attend(s, ['2026-04-03']);
    setToday('2026-04-03');
    expect(await evaluateCourses('2026-04-03')).toMatchObject({ completed: 1 });
    return { ...s, april };
  }

  it('unpaid: the extension invoice is cut to the one session used', async () => {
    const s = await extended(false);
    const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, s.april.id) });
    expect(inv).toMatchObject({
      status: 'due',
      baseAmount: FEE,
      discountAmount: ELEVEN_TWELFTHS,
      totalAmount: FEE - ELEVEN_TWELFTHS,
    });
    expect(inv!.notes).toContain('11 of 12 sessions');
    const [round] = await roundsOf(s.student.id);
    expect(round).toMatchObject({ status: 'awaiting', completedOn: '2026-04-03', attended: 12 });
    expect(round!.adjustments).toEqual([
      expect.objectContaining({ action: 'reduced', amount: ELEVEN_TWELFTHS, createdCreditIds: [] }),
    ]);
    expect(await creditsOf(s.student.id)).toEqual([]);
    // No May invoice.
    await generateDueInvoices('2026-05-02');
    expect((await invoicesOf(s.student.id)).length).toBe(2);
  });

  it('paid: the unused part becomes credit on the next round’s first invoice', async () => {
    const s = await extended(true);
    const [credit] = await creditsOf(s.student.id);
    expect(credit).toMatchObject({
      status: 'held',
      amount: ELEVEN_TWELFTHS,
      kind: 'course_unused',
      sourceInvoiceId: s.april.id,
    });
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-06');
    const decisions = (await (await as(s.admin)).get('/api/v1/courses/decisions').expect(200)).body
      .data;
    expect(decisions[0]).toMatchObject({ credit: ELEVEN_TWELFTHS, dues: { amount: 0, count: 0 } });
    await (
      await as(s.admin)
    )
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-04-06',
      })
      .expect(200);
    const inv = await invoicesOf(s.student.id);
    expect(inv.map((i) => [i.periodStart, i.creditAmount, i.totalAmount, i.status])).toEqual([
      ['2026-03-02', 0, FEE, 'paid'],
      ['2026-04-02', 0, FEE, 'paid'],
      ['2026-04-06', ELEVEN_TWELFTHS, FEE - ELEVEN_TWELFTHS, 'due'],
    ]);
    const [applied] = await creditsOf(s.student.id);
    expect(applied).toMatchObject({ status: 'applied', appliedInvoiceId: inv[2]!.id });
    // The invoice view shows the credit.
    const view = (await (await as(s.admin)).get(`/api/v1/invoices/${inv[2]!.id}`).expect(200)).body
      .data;
    expect(view.creditAmount).toBe(ELEVEN_TWELFTHS);
    // Cancelling that invoice gives the credit back to the membership…
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${inv[2]!.id}/cancel`, { reason: 'Issued in error' })
      .expect(200);
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'assigned',
      appliedInvoiceId: null,
    });
    // …and the next invoice takes it again.
    await generateDueInvoices('2026-05-06');
    const may = (await invoicesOf(s.student.id)).at(-1)!;
    expect(may).toMatchObject({ periodStart: '2026-05-06', creditAmount: ELEVEN_TWELFTHS });
  });

  it('paid, moving to a cheaper batch: credit covers it and the rest carries to the next month', async () => {
    const s = await extended(true);
    // A full unused month is worth more than the cheaper batch's fee.
    const cheap = await makePlan({ daysPerWeek: 2, monthlyFee: 150_000 });
    const other = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: cheap.id,
      courseMonths: 2,
    });
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-06');
    const api = await as(s.admin);
    // Same batch isn't a move.
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'move', batchId: s.batch.id })
      .expect(400);
    await api.post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'move' }).expect(400);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'move',
        batchId: other.id,
        startsOn: '2026-04-07',
        monthlyDiscount: 10_000,
      })
      .expect(200);
    const rounds = await roundsOf(s.student.id);
    expect(rounds.map((r) => [r.batchId, r.roundNo, r.status])).toEqual([
      [s.batch.id, 1, 'moved'],
      [other.id, 1, 'active'],
    ]);
    // Billing in the new batch starts on its first day (not before).
    expect((await invoicesOf(s.student.id)).length).toBe(2);
    await generateDueInvoices('2026-04-07');
    // Invoice for the new batch: ₹1,500 − ₹100 discount = ₹1,400, all of it from credit.
    const first = (await invoicesOf(s.student.id)).at(-1)!;
    expect(first).toMatchObject({
      periodStart: '2026-04-07',
      baseAmount: 150_000,
      discountAmount: 10_000,
      creditAmount: 140_000,
      totalAmount: 0,
      status: 'paid',
    });
    const credits = await creditsOf(s.student.id);
    expect(credits.map((c) => [c.status, c.amount])).toEqual([
      ['applied', 140_000],
      ['assigned', ELEVEN_TWELFTHS - 140_000],
    ]);
    await generateDueInvoices('2026-05-07');
    expect((await invoicesOf(s.student.id)).at(-1)).toMatchObject({
      periodStart: '2026-05-07',
      creditAmount: ELEVEN_TWELFTHS - 140_000,
      totalAmount: 140_000 - (ELEVEN_TWELFTHS - 140_000),
      status: 'due',
    });
  });

  it('leaving: the admin chooses refund (then settles it) or forfeit', async () => {
    const s = await extended(true);
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-06');
    const api = await as(s.admin);
    // Credit waiting → a choice is required.
    await api.post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'leave' }).expect(400);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'leave',
        credit: 'refund',
        note: 'Moving city',
      })
      .expect(200);
    const st = await db.query.students.findFirst({ where: eq(students.id, s.student.id) });
    expect(st).toMatchObject({ status: 'left', leftOn: '2026-04-03' });
    const [credit] = await creditsOf(s.student.id);
    expect(credit).toMatchObject({ status: 'refund_due', amount: ELEVEN_TWELFTHS });
    const tasks = await tasksFor({ ...s.admin, role: 'admin' } as never);
    expect(tasks.items.find((t) => t.kind === 'refunds-due')).toMatchObject({ count: 1 });
    const owed = (await api.get('/api/v1/courses/credits?status=refund_due').expect(200)).body.data;
    expect(owed).toEqual([
      expect.objectContaining({
        id: credit!.id,
        sourceInvoice: expect.objectContaining({ id: s.april.id }),
      }),
    ]);
    await api
      .post(`/api/v1/courses/credits/${credit!.id}/settle`, {
        action: 'refunded',
        note: 'UPI ref 123',
      })
      .expect(200);
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'refunded',
      settledById: s.admin.id,
    });
    await api
      .post(`/api/v1/courses/credits/${credit!.id}/settle`, { action: 'forfeited' })
      .expect(409);
  });

  it('leaving with the credit forfeited', async () => {
    const s = await extended(true);
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-06');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'leave', credit: 'forfeit' })
      .expect(200);
    expect((await creditsOf(s.student.id))[0]).toMatchObject({ status: 'forfeited' });
  });
});

describe('course rounds: late completion and corrections', () => {
  it('marks entered after the next month was billed: unpaid month cancelled, paid month credited', async () => {
    // Unpaid.
    const s = await setup();
    await attend(s, MARCH);
    // The night run was missed; April is billed before anyone looks at March.
    await generateDueInvoices('2026-04-02');
    setToday('2026-04-03');
    await evaluateCourses('2026-04-03');
    const inv = await invoicesOf(s.student.id);
    expect(inv.map((i) => [i.periodStart, i.status, i.cancelledReason])).toEqual([
      ['2026-03-02', 'due', null],
      ['2026-04-02', 'cancelled', 'Course completed on 27 Mar 2026'],
    ]);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ completedOn: '2026-03-27' });
  });

  it('late completion with the next month already paid → full month credited', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await generateDueInvoices('2026-04-02');
    setToday('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    await pay(s.admin, april.id, '2026-04-02');
    await evaluateCourses('2026-04-03');
    expect((await creditsOf(s.student.id)).map((c) => [c.status, c.amount])).toEqual([
      ['held', FEE],
    ]);
  });

  it('undoes a completion when attendance is corrected, and redoes it on the right day', async () => {
    const s = await extended();
    async function extended() {
      const x = await setup();
      await attend(x, MARCH.slice(0, 11));
      setToday('2026-04-02');
      await generateDueInvoices('2026-04-02');
      await attend(x, ['2026-04-03']);
      await evaluateCourses('2026-04-03');
      return x;
    }
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april.totalAmount).toBe(FEE - ELEVEN_TWELFTHS);

    // The 3 Apr mark was a mistake (absent): undone exactly.
    setToday('2026-04-04');
    const api = await as(s.admin);
    await api
      .put('/api/v1/attendance/session', {
        batchId: s.batch.id,
        date: '2026-04-03',
        records: [{ studentId: s.student.id, status: 'absent' }],
      })
      .expect(200);
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      status: 'due',
      discountAmount: 0,
      totalAmount: FEE,
    });
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'active',
      completedOn: null,
      adjustments: [],
    });
    expect((await membershipsOf(s.student.id))[0]!.effectiveTo).toBeNull();

    // Attending on Mon 6 Apr completes it then (3 Apr is absent, so 1 April session used).
    setToday('2026-04-06');
    await attend(s, ['2026-04-06']);
    await evaluateCourses('2026-04-06');
    const back = Math.round((FEE * 11) / 12); // 3 Apr is absent: only 6 Apr counts in April
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      discountAmount: back,
      totalAmount: FEE - back,
    });
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-04-06',
    });
  });

  it('does not undo what can’t be undone exactly (reduced invoice paid since): admins are told', async () => {
    const s = await setup();
    await attend(s, MARCH.slice(0, 11));
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    await attend(s, ['2026-04-03']);
    await evaluateCourses('2026-04-03');
    const april = (await invoicesOf(s.student.id))[1]!;
    setToday('2026-04-04');
    await pay(s.admin, april.id, '2026-04-04');
    await db
      .update(studentAttendance)
      .set({ status: 'absent' })
      .where(
        and(
          eq(studentAttendance.studentId, s.student.id),
          eq(studentAttendance.date, '2026-04-03'),
        ),
      );
    expect(await evaluateCourses('2026-04-04')).toMatchObject({ stuck: 1, undone: 0 });
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ status: 'awaiting' });
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      status: 'paid',
      totalAmount: FEE - ELEVEN_TWELFTHS,
    });
  });
});

describe('course rounds: guards, leaving and rejoining', () => {
  it('blocks moving mid-course; leaving mid-course ends the round; rejoining starts round 1', async () => {
    const s = await setup();
    const other = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
    });
    await attend(s, MARCH.slice(0, 5));
    const [m] = await membershipsOf(s.student.id);
    setToday('2026-03-14');
    const api = await as(s.admin);
    const move = await api.post(`/api/v1/students/${s.student.id}/batches/${m!.id}/move`, {
      batchId: other.id,
      effectiveFrom: '2026-03-16',
    });
    expect(move.status).toBe(422);
    expect(move.body.error.message).toContain('middle of the course');

    await api
      .post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-03-14', reason: 'Exams' })
      .expect(200);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'left',
      completedOn: '2026-03-14',
    });

    setToday('2026-05-04');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/rejoin`, {
        rejoinDate: '2026-05-04',
        batches: [{ batchId: s.batch.id }],
      })
      .expect(200);
    const rounds = await roundsOf(s.student.id);
    expect(rounds.map((r) => [r.roundNo, r.status, r.startedOn])).toEqual([
      [1, 'left', '2026-03-02'],
      [1, 'active', '2026-05-04'],
    ]);
    // Earlier attendance doesn't count for the new round.
    const prog = (
      await (await as(s.admin)).get(`/api/v1/courses/batches/${s.batch.id}`).expect(200)
    ).body.data;
    expect(prog.students[0]).toMatchObject({ attended: 0, target: 12, remaining: 12, month: 1 });
  });

  it('leaving the academy while a decision waits: the round ends, credit owed back', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await generateDueInvoices('2026-04-02');
    setToday('2026-04-02');
    await pay(s.admin, (await invoicesOf(s.student.id))[1]!.id, '2026-04-02');
    await evaluateCourses('2026-04-03');
    setToday('2026-04-03');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-04-03' })
      .expect(200);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ status: 'left' });
    expect((await creditsOf(s.student.id))[0]).toMatchObject({ status: 'refund_due', amount: FEE });
  });

  it('undecided for 30 days: the student leaves automatically, credit owed back', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    setToday('2026-04-25');
    expect(await autoLeave('2026-04-25')).toEqual({ autoLeft: 0 });
    setToday('2026-04-26');
    expect(await autoLeave('2026-04-26')).toEqual({ autoLeft: 1 });
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ status: 'left', autoLeft: true });
    expect(
      await db.query.students.findFirst({ where: eq(students.id, s.student.id) }),
    ).toMatchObject({
      status: 'left',
      leftOn: '2026-03-27',
      leftReason: 'Course completed (no decision in 30 days)',
    });
  });

  it('the nightly job completes the course before billing the next month', async () => {
    const s = await setup();
    await attend(s, MARCH);
    // Billing month 2 starts 2 Apr; the night run that day sees the completion first.
    setToday('2026-04-02', '00:00:00');
    await runInvoiceJob('manual');
    expect((await invoicesOf(s.student.id)).length).toBe(1);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-03-27',
    });
  });

  it('counts makeups attended elsewhere for the home batch', async () => {
    const s = await setup();
    const other = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
    });
    setToday('2026-03-09');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/makeups`, {
        batchId: other.id,
        date: '2026-03-10',
        missedDate: '2026-03-09',
      })
      .expect(201);
    const [mk] = await db
      .select()
      .from(makeupSessions)
      .where(eq(makeupSessions.studentId, s.student.id));
    expect(mk!.homeBatchId).toBe(s.batch.id);
    await attend(
      s,
      MARCH.filter((d) => d !== '2026-03-09'),
    );
    await attend(s, ['2026-03-10'], 'present', other.id);
    await evaluateCourses('2026-03-27');
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-03-27',
      attended: 12,
    });
  });

  it('free batches complete the same way, with nothing billed', async () => {
    const s = await setup({ fee: 0 });
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ status: 'awaiting' });
    expect(await invoicesOf(s.student.id)).toEqual([]);
  });
});

describe('course set-up', () => {
  it('replays history when first set up, without touching billing', async () => {
    const s = await setup({ courseMonths: null });
    expect(await roundsOf(s.student.id)).toEqual([]);
    // 30 sessions from March to mid-May.
    const days: string[] = [];
    for (
      let d = new Date('2026-03-02T00:00:00Z');
      days.length < 30;
      d.setUTCDate(d.getUTCDate() + 1)
    )
      if ([1, 3, 5].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
    await attend(s, days);
    setToday('2026-05-20');
    await generateDueInvoices('2026-05-20');
    const before = await invoicesOf(s.student.id);

    const tasks = await tasksFor({ ...s.admin, role: 'admin' } as never);
    expect(tasks.items.find((t) => t.kind === 'course-setup')).toMatchObject({ count: 1 });
    await (
      await as(s.admin)
    )
      .patch(`/api/v1/batches/${s.batch.id}`, { courseMonths: 1 })
      .expect(200);
    const rounds = await roundsOf(s.student.id);
    expect(
      rounds.map((r) => [r.roundNo, r.status, r.historical, r.startedOn, r.completedOn]),
    ).toEqual([
      [1, 'readmitted', true, '2026-03-02', days[11]],
      // The next round starts the day after the previous one completed.
      [2, 'readmitted', true, addDays(days[11]!, 1), days[23]],
      [3, 'active', false, expect.any(String), null],
    ]);
    expect(rounds[2]!.startedOn > days[23]!).toBe(true);
    expect(await invoicesOf(s.student.id)).toEqual(before);
    expect(
      (await db.query.batches.findFirst({ where: eq(batches.id, s.batch.id) }))!.courseSetOn,
    ).toBe('2026-05-20');
    // It can't be removed again.
    await (
      await as(s.admin)
    )
      .patch(`/api/v1/batches/${s.batch.id}`, { courseMonths: null })
      .expect(400);
  });

  it('shortening the course completes those already past it, as of today', async () => {
    const s = await setup({ courseMonths: 2 });
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    expect((await roundsOf(s.student.id))[0]).toMatchObject({ status: 'active' });
    setToday('2026-03-30');
    await (
      await as(s.admin)
    )
      .patch(`/api/v1/batches/${s.batch.id}`, { courseMonths: 1 })
      .expect(200);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-03-30',
    });
  });

  it('shows course progress to the batch coach and on the student', async () => {
    const s = await setup();
    await attend(s, MARCH.slice(0, 4));
    setToday('2026-03-10');
    const coach = await as(s.coach);
    const prog = (await coach.get(`/api/v1/courses/batches/${s.batch.id}`).expect(200)).body.data;
    expect(prog).toMatchObject({ sessionsPerMonth: 12, target: 12, awaiting: [] });
    expect(prog.students[0]).toMatchObject({
      attended: 4,
      remaining: 8,
      month: 1,
      extension: false,
    });
    const mine = (await coach.get(`/api/v1/courses/students/${s.student.id}`).expect(200)).body
      .data;
    expect(mine.credits).toBeNull(); // money is for admins
    expect(mine.rounds[0]).toMatchObject({ roundNo: 1, status: 'active', attended: 4 });
    const admin = (
      await (await as(s.admin)).get(`/api/v1/courses/students/${s.student.id}`).expect(200)
    ).body.data;
    expect(admin.credits).toEqual([]);
  });
});

describe('credits and invoices', () => {
  /** Course completed with April paid → full month (₹2,500) held → re-admitted from 6 Apr. */
  async function withCreditInvoice() {
    const s = await setup();
    await attend(s, MARCH);
    await generateDueInvoices('2026-04-02');
    setToday('2026-04-02');
    await pay(s.admin, (await invoicesOf(s.student.id))[0]!.id, '2026-04-02');
    await pay(s.admin, (await invoicesOf(s.student.id))[1]!.id, '2026-04-02');
    await evaluateCourses('2026-04-03');
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-06');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-04-06',
      })
      .expect(200);
    const inv = (await invoicesOf(s.student.id)).at(-1)!;
    return { ...s, inv };
  }

  it('a credit covering a whole invoice settles it', async () => {
    const s = await withCreditInvoice();
    expect(s.inv).toMatchObject({ creditAmount: FEE, totalAmount: 0, status: 'paid' });
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'applied',
      appliedInvoiceId: s.inv.id,
    });
    // Already settled: nothing to adjust.
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${s.inv.id}/adjust`, { discountAmount: 1, reason: 'Goodwill' })
      .expect(409);
  });

  it('adjusting a part-credited invoice keeps the credit; refunding it frees the credit', async () => {
    const s = await setup();
    // A credit of ₹1,000 assigned to the membership comes off the next invoice.
    const [m] = await membershipsOf(s.student.id);
    await db.insert(studentCredits).values({
      studentId: s.student.id,
      kind: 'shortfall',
      amount: 100_000,
      status: 'assigned',
      enrollmentId: m!.id,
      reason: 'Test credit',
    });
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april).toMatchObject({
      creditAmount: 100_000,
      totalAmount: FEE - 100_000,
      status: 'due',
    });
    setToday('2026-04-02');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/invoices/${april.id}/adjust`, {
        discountAmount: FEE - 100_000 + 1,
        reason: 'Too much',
      })
      .expect(400);
    const adj = await api
      .post(`/api/v1/invoices/${april.id}/adjust`, { discountAmount: 50_000, reason: 'Hardship' })
      .expect(200);
    expect(adj.body.data).toMatchObject({
      discountAmount: 50_000,
      creditAmount: 100_000,
      totalAmount: 100_000,
    });
    await pay(s.admin, april.id, '2026-04-02');
    const paidInv = (await api.get(`/api/v1/invoices/${april.id}`).expect(200)).body.data;
    const payment = paidInv.payments.find((p: { status: string }) => p.status === 'completed');
    await api
      .post(`/api/v1/invoices/${april.id}/payments/${payment.id}/refund`, {
        reason: 'Family moved',
      })
      .expect(200);
    expect((await creditsOf(s.student.id)).map((c) => c.status)).toEqual(['assigned']);
  });

  it('undoing a late completion restores a cancelled month (and its credit)', async () => {
    const s = await setup();
    const [m] = await membershipsOf(s.student.id);
    await db.insert(studentCredits).values({
      studentId: s.student.id,
      kind: 'shortfall',
      amount: 30_000,
      status: 'assigned',
      enrollmentId: m!.id,
      reason: 'Test credit',
    });
    await attend(s, MARCH);
    await generateDueInvoices('2026-04-02'); // April, with the ₹300 credit taken off
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april.creditAmount).toBe(30_000);
    await evaluateCourses('2026-04-03');
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      status: 'cancelled',
    });
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'held',
      appliedInvoiceId: null,
    });

    // The 27 Mar mark is corrected to absent: April is due again, credit back on it.
    await db
      .update(studentAttendance)
      .set({ status: 'absent' })
      .where(
        and(
          eq(studentAttendance.studentId, s.student.id),
          eq(studentAttendance.date, '2026-03-27'),
        ),
      );
    expect(await evaluateCourses('2026-04-04')).toMatchObject({ undone: 1 });
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      status: 'due',
      cancelledReason: null,
      creditAmount: 30_000,
    });
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'applied',
      appliedInvoiceId: april.id,
    });
  });

  it('credit owed back can go towards a batch the student is still in', async () => {
    const s = await setup();
    const second = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
    });
    setToday('2026-03-02');
    await (
      await as(s.admin)
    )
      .post(`/api/v1/students/${s.student.id}/batches`, {
        batchId: second.id,
        effectiveFrom: '2026-03-03',
      })
      .expect(201);
    await attend(s, MARCH);
    await generateDueInvoices('2026-04-02');
    setToday('2026-04-02');
    const aprilMain = (await invoicesOf(s.student.id)).find(
      (i) => i.batchId === s.batch.id && i.periodStart === '2026-04-02',
    )!;
    await pay(s.admin, aprilMain.id, '2026-04-02');
    await evaluateCourses('2026-04-03');
    const [round] = await roundsOf(s.student.id);
    setToday('2026-04-04');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'leave',
        credit: 'refund',
        confirmDues: true,
      })
      .expect(200);
    // Still in the other batch, so not left the academy.
    expect(
      (await db.query.students.findFirst({ where: eq(students.id, s.student.id) }))!.status,
    ).toBe('active');
    const [credit] = await creditsOf(s.student.id);
    const open = (await membershipsOf(s.student.id)).find((x) => x.batchId === second.id)!;
    await api
      .post(`/api/v1/courses/credits/${credit!.id}/settle`, {
        action: 'assign',
        enrollmentId: aprilMain.enrollmentId,
      })
      .expect(400); // that membership has ended
    await api
      .post(`/api/v1/courses/credits/${credit!.id}/settle`, {
        action: 'assign',
        enrollmentId: open.id,
      })
      .expect(200);
    expect((await creditsOf(s.student.id))[0]).toMatchObject({
      status: 'assigned',
      enrollmentId: open.id,
    });
  });

  it('leaving one batch mid-course ends that round only', async () => {
    const s = await setup();
    const second = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
      courseMonths: 3,
    });
    setToday('2026-03-02');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/students/${s.student.id}/batches`, {
        batchId: second.id,
        effectiveFrom: '2026-03-03',
      })
      .expect(201);
    const main = (await membershipsOf(s.student.id)).find((x) => x.batchId === s.batch.id)!;
    await api
      .post(`/api/v1/students/${s.student.id}/batches/${main.id}/leave`, { leftOn: '2026-03-10' })
      .expect(200);
    const rounds = await roundsOf(s.student.id);
    expect(rounds.map((r) => [r.batchId, r.status])).toEqual([
      [s.batch.id, 'left'],
      [second.id, 'active'],
    ]);
  });

  it('fewer training days lowers the target from today on', async () => {
    const s = await setup({ courseMonths: 1 });
    const two = await makePlan({ daysPerWeek: 2, monthlyFee: FEE });
    await attend(s, MARCH.slice(0, 9));
    setToday('2026-03-21');
    // Mon/Wed only → 8 a month: already past it, completes today.
    await (
      await as(s.admin)
    )
      .patch(`/api/v1/batches/${s.batch.id}`, { weekdays: [1, 3], feePlanId: two.id })
      .expect(200);
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      status: 'awaiting',
      completedOn: '2026-03-21',
      target: 8,
    });
  });
});

describe('corrections after a decision, and manual checks', () => {
  it('a correction after the decision is flagged to admins, never changed automatically', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    const [round] = await roundsOf(s.student.id);
    setToday('2026-03-30');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-03-30',
        confirmDues: true,
      })
      .expect(200);
    // An admin corrects 27 Mar to absent: round 1 no longer reached 12, but it was decided.
    await api
      .put('/api/v1/attendance/session', {
        batchId: s.batch.id,
        date: '2026-03-27',
        records: [{ studentId: s.student.id, status: 'absent' }],
      })
      .expect(200);
    const rounds = await roundsOf(s.student.id);
    expect(rounds.map((r) => r.status)).toEqual(['readmitted', 'active']);
    const inbox = (await api.get('/api/v1/me/notifications').expect(200)).body.data;
    const items = (inbox.items ?? inbox) as { title: string }[];
    expect(items.map((n) => n.title)).toContain(
      `⚠️ Check ${s.student.fullName}'s course completion`,
    );
  });

  it('an invoice changed after completion keeps the completion (flagged instead)', async () => {
    const s = await setup();
    await attend(s, MARCH.slice(0, 11));
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    await attend(s, ['2026-04-03']);
    await evaluateCourses('2026-04-03');
    const april = (await invoicesOf(s.student.id))[1]!;
    setToday('2026-04-04');
    // The admin gives a further concession on the reduced invoice.
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${april.id}/adjust`, {
        discountAmount: FEE - 1000,
        reason: 'Goodwill',
      })
      .expect(200);
    await db
      .update(studentAttendance)
      .set({ status: 'absent' })
      .where(
        and(
          eq(studentAttendance.studentId, s.student.id),
          eq(studentAttendance.date, '2026-04-03'),
        ),
      );
    expect(await evaluateCourses('2026-04-04')).toMatchObject({ stuck: 1 });
  });

  it('admins can re-check a student or batch on demand', async () => {
    const s = await setup();
    await attend(s, MARCH);
    setToday('2026-03-27');
    const api = await as(s.admin);
    expect(
      (await api.post('/api/v1/courses/evaluate', { batchId: s.batch.id }).expect(200)).body.data,
    ).toMatchObject({ evaluated: 1, completed: 1 });
    expect(
      (await api.post('/api/v1/courses/evaluate', { studentId: s.student.id }).expect(200)).body
        .data,
    ).toMatchObject({ evaluated: 1, completed: 0 });
    expect((await api.post('/api/v1/courses/evaluate').expect(200)).body.data).toMatchObject({
      evaluated: 1,
    });
    await (await as(s.coach)).post('/api/v1/courses/evaluate', {}).expect(403);
    await (await as(s.coach)).get('/api/v1/courses/decisions').expect(403);
    await (await as(s.coach)).get('/api/v1/courses/credits').expect(403);
    // Credit list filters.
    expect(
      (await api.get(`/api/v1/courses/credits?studentId=${s.student.id}`).expect(200)).body.data,
    ).toEqual([]);
  });
});

describe('credit edge cases', () => {
  it('uses the oldest credits first and leaves the rest for later months', async () => {
    const s = await setup();
    const [m] = await membershipsOf(s.student.id);
    for (const [amount, reason] of [
      [FEE, 'First'],
      [10_000, 'Second'],
    ] as const) {
      await db.insert(studentCredits).values({
        studentId: s.student.id,
        kind: 'shortfall',
        amount,
        status: 'assigned',
        enrollmentId: m!.id,
        reason,
        createdAt: new Date(reason === 'First' ? '2026-03-01T00:00:00Z' : '2026-03-02T00:00:00Z'),
      });
    }
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april).toMatchObject({ creditAmount: FEE, totalAmount: 0, status: 'paid' });
    expect((await creditsOf(s.student.id)).map((c) => [c.reason, c.status])).toEqual([
      ['First', 'applied'],
      ['Second', 'assigned'],
    ]);
  });

  it('refunding a credited month after the membership ended: the credit is owed back', async () => {
    const s = await setup();
    const [m] = await membershipsOf(s.student.id);
    await db.insert(studentCredits).values({
      studentId: s.student.id,
      kind: 'shortfall',
      amount: 50_000,
      status: 'assigned',
      enrollmentId: m!.id,
      reason: 'Test credit',
    });
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    setToday('2026-04-02');
    await pay(s.admin, april.id, '2026-04-02');
    const api = await as(s.admin);
    await api.post(`/api/v1/students/${s.student.id}/leave`, { leftOn: '2026-04-05' }).expect(200);
    const paid = (await api.get(`/api/v1/invoices/${april.id}`).expect(200)).body.data;
    const payment = paid.payments.find((p: { status: string }) => p.status === 'completed');
    await api
      .post(`/api/v1/invoices/${april.id}/payments/${payment.id}/refund`, { reason: 'Left early' })
      .expect(200);
    expect((await creditsOf(s.student.id))[0]).toMatchObject({ status: 'refund_due' });
  });
});

describe('API edges', () => {
  it('decisions: unknown round, move into a full batch, leave without credit', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    const [round] = await roundsOf(s.student.id);
    setToday('2026-03-28');
    const api = await as(s.admin);
    await api
      .post('/api/v1/courses/rounds/00000000-0000-0000-0000-000000000000/decide', {
        action: 'leave',
      })
      .expect(404);
    const full = await makeBatch(s.coach.id, s.location.id, {
      weekdays: [2, 4, 6],
      startTime: '17:00:00',
      endTime: '18:00:00',
      feePlanId: s.plan.id,
      capacity: 1,
    });
    const other = await makeStudent({ batchId: full.id, joiningDate: '2026-03-02' }, s.admin.id);
    void other;
    const res = await api.post(`/api/v1/courses/rounds/${round!.id}/decide`, {
      action: 'move',
      batchId: full.id,
      confirmDues: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('is full');
    // No credit waiting: leaving needs no choice.
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'leave', confirmDues: true })
      .expect(200);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, { action: 'readmit', confirmDues: true })
      .expect(409);
  });

  it('credits: filters, unknown credit, settling something not owed', async () => {
    const s = await setup();
    const [m] = await membershipsOf(s.student.id);
    const [c] = await db
      .insert(studentCredits)
      .values({
        studentId: s.student.id,
        kind: 'shortfall',
        amount: 5_000,
        status: 'assigned',
        enrollmentId: m!.id,
        reason: 'Test',
      })
      .returning();
    const api = await as(s.admin);
    expect(
      (await api.get('/api/v1/courses/credits?status=assigned').expect(200)).body.data,
    ).toHaveLength(1);
    expect(
      (await api.get('/api/v1/courses/credits?status=refund_due').expect(200)).body.data,
    ).toEqual([]);
    expect((await api.get('/api/v1/courses/credits').expect(200)).body.data[0]).toMatchObject({
      sourceInvoice: null,
    });
    await api
      .post('/api/v1/courses/credits/00000000-0000-0000-0000-000000000000/settle', {
        action: 'refunded',
      })
      .expect(404);
    await api.post(`/api/v1/courses/credits/${c!.id}/settle`, { action: 'refunded' }).expect(409);
  });

  it('a credit larger than the unpaid invoice it goes on is split', async () => {
    const s = await setup();
    // The month ends short by a lot: 7 rain-outs → 7 of 14 held → 5 missing.
    await db
      .insert(sessionCancellations)
      .values(
        [
          '2026-03-02',
          '2026-03-04',
          '2026-03-06',
          '2026-03-09',
          '2026-03-11',
          '2026-03-13',
          '2026-03-16',
        ].map((date) => ({ batchId: s.batch.id, date, reason: 'Rain', cancelledById: s.admin.id })),
      );
    setToday('2026-03-02');
    const march = (await invoicesOf(s.student.id))[0]!;
    // March almost settled by an admin concession, so its unpaid amount is small.
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${march.id}/adjust`, {
        discountAmount: FEE - 10_000,
        reason: 'Concession',
      })
      .expect(200);
    await evaluateDelivery('2026-04-02');
    const [sf] = await db.select().from(sessionShortfalls);
    setToday('2026-04-02');
    const res = await (
      await as(s.admin)
    )
      .post(`/api/v1/delivery/shortfalls/${sf!.id}/discount`)
      .expect(200);
    const missing = 12 - 7;
    const amount = Math.round((10_000 * missing) / 12); // the month's value was ₹100
    expect(res.body.data).toMatchObject({ amount });
  });

  it('pace and shortfall lists for one batch', async () => {
    const s = await setup();
    setToday('2026-03-10');
    const coach = await as(s.coach);
    // Nothing attended yet: 2 short of finishing within the month.
    expect(
      (await coach.get(`/api/v1/delivery/pace?batchId=${s.batch.id}`).expect(200)).body.data,
    ).toEqual([expect.objectContaining({ attended: 0, short: 2 })]);
    expect(
      (await coach.get(`/api/v1/delivery/shortfalls?batchId=${s.batch.id}`).expect(200)).body.data,
    ).toEqual([]);
  });
});

describe('more money paths', () => {
  /** 11 in March; April issued with a ₹2,400 concession (₹100 left to pay); 12th on 3 Apr. */
  async function nearlyWaived() {
    const s = await setup();
    await attend(s, MARCH.slice(0, 11));
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    await (
      await as(s.admin)
    )
      .post(`/api/v1/invoices/${april.id}/adjust`, {
        discountAmount: FEE - 10_000,
        reason: 'Concession',
      })
      .expect(200);
    await attend(s, ['2026-04-03']);
    await evaluateCourses('2026-04-03');
    return { ...s, april };
  }

  it('an extension month with a concession: the unused share of what was charged comes off', async () => {
    const s = await nearlyWaived();
    // The month was worth ₹100 after the concession: 11/12 of it (₹91.67) comes off.
    const back = Math.round((10_000 * 11) / 12);
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, s.april.id) })).toMatchObject(
      {
        totalAmount: 10_000 - back,
        status: 'due',
      },
    );
  });

  it('a credit bigger than the unpaid extension invoice: invoice settled, remainder held, undo restores both', async () => {
    const s = await setup();
    await attend(s, MARCH.slice(0, 11));
    // A ₹2,400 credit was used on April, so only ₹100 is left to pay; the month is worth ₹2,500.
    const [m] = await membershipsOf(s.student.id);
    await db.insert(studentCredits).values({
      studentId: s.student.id,
      kind: 'shortfall',
      amount: FEE - 10_000,
      status: 'assigned',
      enrollmentId: m!.id,
      reason: 'Earlier credit',
    });
    setToday('2026-04-02');
    await generateDueInvoices('2026-04-02');
    const april = (await invoicesOf(s.student.id))[1]!;
    expect(april).toMatchObject({ totalAmount: 10_000, creditAmount: FEE - 10_000 });
    await attend(s, ['2026-04-03']);
    await evaluateCourses('2026-04-03');
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      totalAmount: 0,
      discountAmount: 10_000,
      status: 'paid',
    });
    const held = (await creditsOf(s.student.id)).filter((c) => c.status === 'held');
    expect(held.map((c) => c.amount)).toEqual([ELEVEN_TWELFTHS - 10_000]);

    // Correction: undone exactly (back to due, ₹100), the held remainder voided.
    await db
      .update(studentAttendance)
      .set({ status: 'absent' })
      .where(
        and(
          eq(studentAttendance.studentId, s.student.id),
          eq(studentAttendance.date, '2026-04-03'),
        ),
      );
    expect(await evaluateCourses('2026-04-04')).toMatchObject({ undone: 1 });
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, april.id) })).toMatchObject({
      totalAmount: 10_000,
      discountAmount: 0,
      status: 'due',
      paidAt: null,
    });
    expect((await creditsOf(s.student.id)).map((c) => c.status).sort()).toEqual([
      'applied',
      'void',
    ]);
  });

  it('re-admits with a new fee; a reopened course can’t be decided', async () => {
    const s = await setup();
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    const [round] = await roundsOf(s.student.id);
    setToday('2026-03-28');
    const api = await as(s.admin);
    await api
      .post(`/api/v1/courses/rounds/${round!.id}/decide`, {
        action: 'readmit',
        startsOn: '2026-03-30',
        customMonthlyFee: 200_000,
        monthlyDiscount: 0,
        confirmDues: true,
        note: 'New season price',
      })
      .expect(200);
    const ms = await membershipsOf(s.student.id);
    expect(ms[1]).toMatchObject({ customMonthlyFee: 200_000, monthlyDiscount: 0 });
    expect((await roundsOf(s.student.id))[0]).toMatchObject({
      note: 'New season price',
      decidedById: s.admin.id,
    });

    // A second student whose completion is undone before anyone decides.
    const t = await makeStudent({ batchId: s.batch.id, joiningDate: '2026-03-02' }, s.admin.id);
    await db.insert(studentAttendance).values(
      MARCH.map((date) => ({
        batchId: s.batch.id,
        studentId: t.id,
        date,
        status: 'present' as const,
        markedById: s.admin.id,
      })),
    );
    await evaluateCourses('2026-03-28');
    const [tr] = await roundsOf(t.id);
    await db
      .update(studentAttendance)
      .set({ status: 'absent' })
      .where(and(eq(studentAttendance.studentId, t.id), eq(studentAttendance.date, '2026-03-27')));
    await evaluateCourses('2026-03-28');
    const reopened = await api.post(`/api/v1/courses/rounds/${tr!.id}/decide`, { action: 'leave' });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.message).toContain('reopened');
  });

  it('reminds admins of waiting decisions once a day', async () => {
    const s = await setup();
    expect(await remindDecisions('2026-03-27')).toEqual({ waiting: 0 });
    await attend(s, MARCH);
    await evaluateCourses('2026-03-27');
    expect(await remindDecisions('2026-03-28')).toEqual({ waiting: 1 });
    setToday('2026-03-28');
    const inbox = (await (await as(s.admin)).get('/api/v1/me/notifications').expect(200)).body.data;
    const titles = ((inbox.items ?? inbox) as { title: string }[]).map((n) => n.title);
    expect(titles.some((x) => x.includes('1 course decision waiting'))).toBe(true);
  });
});
