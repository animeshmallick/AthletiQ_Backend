import { describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client';
import {
  batchSubstitutions,
  sessionPlans,
  sessionCancellations,
  skillAssessments,
  studentAttendance,
} from '../../src/db/schema';
import { generateDueInvoices } from '../../src/modules/billing/invoice-generator';
import { as, checkIn, makeAcademy, makeStudent, setToday } from '../helpers/factories';

// Batch runs Mon–Sat 6–8 am. Today: Friday 20 Mar 2026.
const TODAY = '2026-03-20';

async function setup() {
  setToday(TODAY);
  const a = await makeAcademy();
  const asha = await makeStudent(
    {
      fullName: 'Asha',
      batchId: a.batch.id,
      feePlanId: a.plan.id,
      joiningDate: '2026-02-02',
      billingStartsOn: '2026-02-02',
    },
    a.admin.id,
  );
  const bilal = await makeStudent(
    {
      fullName: 'Bilal',
      batchId: a.batch.id,
      feePlanId: a.plan.id,
      joiningDate: '2026-03-16',
      billingStartsOn: '2026-03-16',
    },
    a.admin.id,
  );
  await generateDueInvoices(TODAY);
  const mark = (studentId: string, date: string, status: 'present' | 'absent' | 'late') =>
    db
      .insert(studentAttendance)
      .values({ batchId: a.batch.id, studentId, date, status, markedById: a.coach.id });
  // Mon 16: both present; Tue 17: Asha late, Bilal absent; Wed 18 cancelled; Thu 19 nothing marked.
  await mark(asha.id, '2026-03-16', 'present');
  await mark(bilal.id, '2026-03-16', 'present');
  await mark(asha.id, '2026-03-17', 'late');
  await mark(bilal.id, '2026-03-17', 'absent');
  await db
    .insert(sessionCancellations)
    .values({ batchId: a.batch.id, date: '2026-03-18', reason: 'Rain' });
  await checkIn(a.coach.id, a.batch.id, '2026-03-16', '2026-03-17');
  await db.insert(sessionPlans).values({
    batchId: a.batch.id,
    coachId: a.coach.id,
    date: '2026-03-16',
    blocks: [{ name: 'Warm-up', color: null, minutes: 120, drills: [] }],
  });
  await db.insert(skillAssessments).values({
    studentId: asha.id,
    sportId: a.batch.sportId,
    batchId: a.batch.id,
    coachId: a.coach.id,
    month: '2026-03-01',
    average: 260,
    levelName: 'Lower Intermediate',
    levelCode: 'B1',
    levelPosition: 3,
  });
  return { ...a, asha, bilal };
}

describe('batch insights', () => {
  it('gives admins students, attendance, sessions, skills and fees', async () => {
    const { admin, batch, asha, bilal } = await setup();
    const res = await (await as(admin)).get(`/api/v1/batches/${batch.id}/insights`).expect(200);
    const d = res.body.data;

    expect(d.summary).toMatchObject({
      students: 2,
      attendanceRate: 75, // 3 of 4 marked were present or late
      sessions30: { cancelled: 1, held: 2, withPlan: 1 },
      checkIns30: { total: 2 },
      skills: { assessedThisMonth: 1, levels: [{ code: 'B1', students: 1 }] },
      movement90: { joined: 2, left: 0 },
    });
    // Unpaid invoices: Asha Feb + Mar, Bilal Mar — all due, Feb's is overdue.
    expect(d.summary.fees.money).toMatchObject({ expectedMonthly: 500_000 });
    expect(d.summary.fees.money.outstanding).toBeGreaterThan(0);
    expect(d.summary.fees.studentsOverdue).toBeGreaterThanOrEqual(1);

    const a = d.roster.find((r: { studentId: string }) => r.studentId === asha.id);
    expect(a).toMatchObject({
      fullName: 'Asha',
      joinedBatch: '2026-02-02',
      attendance: { marked: 2, present: 2, rate: 100 },
      lastAttended: '2026-03-17',
      level: { code: 'B1', name: 'Lower Intermediate' },
      assessedThisMonth: true,
      fees: { status: 'overdue', monthly: 250_000 },
    });
    expect(a.fees.unpaidInvoiceId).toBeTruthy();
    const b = d.roster.find((r: { studentId: string }) => r.studentId === bilal.id);
    expect(b).toMatchObject({ attendance: { rate: 50 }, level: null, daysInBatch: 4 });

    // Upcoming: today onwards, only batch days; recent: newest first, cancellations marked.
    expect(d.upcoming[0]).toMatchObject({ date: TODAY, startTime: '06:00:00' });
    expect(d.upcoming.map((s: { date: string }) => s.date)).not.toContain('2026-03-22'); // Sunday
    const wed = d.recent.find((s: { date: string }) => s.date === '2026-03-18');
    expect(wed).toMatchObject({ cancelled: 'Rain' });
    expect(d.recent.find((s: { date: string }) => s.date === '2026-03-16')).toMatchObject({
      marked: 2,
      present: 2,
      checkedIn: true,
      hasPlan: true,
    });
    expect(d.trend.length).toBeGreaterThan(0);
  });

  it('shows coaches fee status but no amounts, and hides the batch from other coaches', async () => {
    const { coach, otherCoach, batch } = await setup();
    const d = (await (await as(coach)).get(`/api/v1/batches/${batch.id}/insights`).expect(200)).body
      .data;
    expect(d.summary.fees.money).toBeNull();
    expect(d.summary.fees.studentsOverdue).toBeGreaterThanOrEqual(1);
    expect(d.roster[0].fees).toMatchObject({ monthly: null, due: null, overdue: null });
    expect(d.roster[0].fees.status).toMatch(/overdue|due|paid/);
    await (await as(otherCoach)).get(`/api/v1/batches/${batch.id}/insights`).expect(404); // other coaches: not even visible
  });
});

describe('batch insights edge cases', () => {
  it('handles an empty batch', async () => {
    setToday(TODAY);
    const a = await makeAcademy();
    const d = (
      await (await as(a.admin)).get(`/api/v1/batches/${a.otherBatch.id}/insights`).expect(200)
    ).body.data;
    expect(d.summary).toMatchObject({
      students: 0,
      attendanceRate: null,
      checkIns30: { total: 0, rate: null },
      skills: { assessedThisMonth: 0, levels: [] },
      fees: { studentsOverdue: 0, money: { expectedMonthly: 0, outstanding: 0 } },
    });
    expect(d.roster).toEqual([]);
    expect(d.trend.every((w: { rate: number | null }) => w.rate === null)).toBe(true);
  });

  it('marks free and paid students, substitutes, late check-ins and unmarked sessions', async () => {
    setToday(TODAY);
    const a = await makeAcademy();
    const admin = await as(a.admin);
    const free = await makeStudent(
      {
        fullName: 'Free',
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-03-02',
        billingStartsOn: '2026-03-02',
        customMonthlyFee: 0,
      },
      a.admin.id,
    );
    const payer = await makeStudent(
      {
        fullName: 'Payer',
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2026-03-02',
        billingStartsOn: '2026-03-02',
      },
      a.admin.id,
    );
    await generateDueInvoices(TODAY);
    const inv = (await admin.get(`/api/v1/invoices?studentId=${payer.id}`)).body.data[0];
    await admin
      .post(`/api/v1/invoices/${inv.id}/payments`, { mode: 'cash', paidOn: '2026-03-03' })
      .expect(200);
    // A late check-in (the factory checks in at 06:00 IST; push the schedule earlier).
    await checkIn(a.coach.id, a.batch.id, '2026-03-16');
    await db.execute(sql`update coach_sessions set scheduled_start = '05:00:00'`);
    // Substitute on Thursday.
    await db.insert(batchSubstitutions).values({
      batchId: a.batch.id,
      substituteCoachId: a.otherCoach.id,
      coachId: a.coach.id,
      fromDate: '2026-03-19',
      toDate: '2026-03-19',
      status: 'approved',
      requestedById: a.admin.id,
    });

    const d = (await admin.get(`/api/v1/batches/${a.batch.id}/insights`).expect(200)).body.data;
    const by = (id: string) => d.roster.find((r: { studentId: string }) => r.studentId === id);
    expect(by(free.id).fees).toMatchObject({ status: 'free', monthly: 0, unpaidInvoiceId: null });
    expect(by(payer.id).fees.status).toBe('paid');
    expect(by(payer.id).fees.lastPaidAt).toBeTruthy();
    expect(d.summary.checkIns30).toMatchObject({ total: 1, onTime: 0, rate: 0 });
    expect(d.summary.sessions30.missed).toBeGreaterThan(0);
    expect(d.summary.sessions30.covered).toBe(1);
    expect(d.recent.find((s: { date: string }) => s.date === '2026-03-19').substitute).toBe(
      a.otherCoach.name,
    );
    expect(d.recent.find((s: { date: string }) => s.date === '2026-03-16').onTime).toBe(false);
    expect(d.summary.fees.money.monthCollected).toBe(250_000);
  });
});
