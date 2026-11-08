import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import type request from 'supertest';
import { db } from '../../src/db/client';
import {
  invoices,
  makeupSessions,
  payments,
  studentAttendance,
  weeklyFeedback,
} from '../../src/db/schema';
import { billOnAcceptance } from '../../src/modules/billing/invoice-generator';
import { insightsFor, loadStudentReports, streaks } from '../../src/modules/reports/report-data';
import { renderGroupReportPdf } from '../../src/modules/reports/report-pdf';
import { getAcademySettings } from '../../src/modules/settings/settings';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

const binary: Parameters<request.Test['parse']>[0] = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** Set REPORT_SAMPLES=<dir> to keep the generated PDFs for a visual check. */
const keep = (name: string, pdf: Buffer) => {
  const dir = process.env.REPORT_SAMPLES;
  if (dir) fs.writeFileSync(`${dir}/${name}`, pdf);
};

const ratings = (v: number) => ({
  technique: v,
  fitness: v,
  game_sense: Math.max(1, v - 1),
  discipline: 5,
  effort: v,
  teamwork: 4,
});

async function richStudent() {
  setToday('2026-03-20', '06:30:00');
  const a = await makeAcademy();
  const s = await makeStudent(
    {
      batchId: a.batch.id,
      feePlanId: a.plan.id,
      joiningDate: '2026-01-05',
      fullName: 'Riya Sharma',
      dateOfBirth: '2014-06-02',
      guardianName: 'Anil Sharma',
    },
    a.admin.id,
  );
  // Six weeks of Mon/Wed/Fri attendance, a few absences and lates.
  const days: string[] = [];
  for (let d = new Date('2026-01-05T00:00:00Z'); d <= new Date('2026-03-18T00:00:00Z');) {
    const wd = d.getUTCDay();
    if (wd === 1 || wd === 3 || wd === 5) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const statusFor = (i: number): 'present' | 'absent' | 'late' | 'excused' =>
    i % 7 === 3 ? 'absent' : i % 9 === 4 ? 'late' : i === 10 ? 'excused' : 'present';
  await db.insert(studentAttendance).values(
    days.map((date, i) => ({
      batchId: a.batch.id,
      studentId: s.id,
      date,
      status: statusFor(i),
      markedById: a.coach.id,
    })),
  );
  for (const [i, weekStart] of ['2026-02-02', '2026-02-09', '2026-02-16', '2026-03-09'].entries()) {
    await db.insert(weeklyFeedback).values({
      studentId: s.id,
      batchId: a.batch.id,
      coachId: a.coach.id,
      weekStart,
      templateKey: 'weekly',
      templateVersion: 1,
      answers: { ...ratings(2 + Math.min(i, 3)), highlights: `Week ${i + 1}: sharper footwork.` },
      status: 'submitted',
      submittedAt: new Date(`${weekStart}T12:00:00Z`),
    });
  }
  await billOnAcceptance(s.id);
  const bills = await db.select().from(invoices).where(eq(invoices.studentId, s.id));
  // Pay the first invoice on time.
  const first = bills.sort((x, y) => x.issueDate.localeCompare(y.issueDate))[0]!;
  await db.insert(payments).values({
    invoiceId: first.id,
    amount: first.totalAmount,
    mode: 'upi',
    paidOn: first.dueDate,
    recordedById: a.admin.id,
  });
  await db.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, first.id));
  return { ...a, s };
}

describe('report insights', () => {
  it('counts streaks, ignoring excused days', () => {
    expect(
      streaks([
        { date: '2026-01-01', status: 'present' },
        { date: '2026-01-02', status: 'present' },
        { date: '2026-01-03', status: 'absent' },
        { date: '2026-01-04', status: 'late' },
        { date: '2026-01-05', status: 'excused' },
        { date: '2026-01-06', status: 'present' },
      ]),
    ).toEqual({ current: 2, longest: 2 });
    expect(streaks([])).toEqual({ current: 0, longest: 0 });
  });

  it('builds attendance, fees, feedback and a timeline', async () => {
    const { s, coach } = await richStudent();
    const [r] = await loadStudentReports([s.id], null, '2026-03-20');
    expect(r!.student).toMatchObject({ fullName: 'Riya Sharma', age: 11, tenureDays: 74 });
    expect(r!.current).toMatchObject({ coachName: coach.name });
    expect(r!.attendance.counted).toBeGreaterThan(25);
    expect(r!.attendance.byMonth.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r!.attendance.byWeekday.map((w) => w.weekday)).toEqual([1, 3, 5]);
    expect(r!.feedback.count).toBe(4);
    expect(r!.feedback.skills.find((k) => k.label === 'Technique')).toMatchObject({
      first: 2,
      latest: 5,
    });
    expect(r!.feedback.weeks[0]!.notes[0]!.value).toMatch(/sharper footwork/);
    expect(r!.fees.paid).toBeGreaterThan(0);
    expect(r!.fees.onTimeRate).toBe(100);
    expect(r!.timeline[0]).toMatchObject({ kind: 'joined', date: '2026-01-05' });
    expect(r!.timeline.some((e) => e.kind === 'payment')).toBe(true);
    expect(r!.timeline.some((e) => e.kind === 'feedback')).toBe(true);
    expect(r!.insights.join(' ')).toMatch(/Attended \d+ of \d+ sessions/);
    expect(r!.insights.join(' ')).toMatch(/Strongest area: Discipline/);
    expect(r!.insights.join(' ')).toMatch(/Improved since the first report/);
  });

  it('describes a student with no history yet', async () => {
    setToday('2026-03-20');
    const a = await makeAcademy();
    const s = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-19' },
      a.admin.id,
    );
    const [r] = await loadStudentReports([s.id], null, '2026-03-20');
    expect(insightsFor(r!)).toEqual(['No attendance recorded yet.']);
    expect(await loadStudentReports([], null, '2026-03-20')).toEqual([]);
  });
});

describe('report PDFs', () => {
  it('lets the coach and admins download a student report, all batches or one', async () => {
    const { s, coach, otherCoach, admin, batch, otherBatch } = await richStudent();
    const coachApi = await as(coach);
    const all = await coachApi
      .get(`/api/v1/reports/students/${s.id}/pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(all.headers['content-type']).toBe('application/pdf');
    expect(all.headers['content-disposition']).toMatch(
      /attachment; filename="riya-sharma-.*\.pdf"/,
    );
    expect((all.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    keep('student-all.pdf', all.body as Buffer);

    const one = await coachApi
      .get(`/api/v1/reports/students/${s.id}/pdf?batchId=${batch.id}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((one.body as Buffer).length).toBeGreaterThan(2000);

    // Never in that batch / not their student / not their batch.
    await coachApi.get(`/api/v1/reports/students/${s.id}/pdf?batchId=${otherBatch.id}`).expect(422);
    await (await as(otherCoach)).get(`/api/v1/reports/students/${s.id}/pdf`).expect(404);
    await (await as(admin)).get(`/api/v1/reports/students/${s.id}/pdf?batchId=nope`).expect(400);
  });

  it('lets only admins download batch and academy reports', async () => {
    const { coach, admin, batch, otherBatch, plan } = await richStudent();
    await makeStudent(
      { batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-02-01', fullName: 'Aarav Mehta' },
      admin.id,
    );
    await makeStudent(
      {
        batchId: otherBatch.id,
        feePlanId: plan.id,
        joiningDate: '2026-02-01',
        fullName: 'Zoya Khan',
      },
      admin.id,
    );
    await (await as(coach)).get(`/api/v1/reports/batches/pdf?batchId=${batch.id}`).expect(403);

    const api = await as(admin);
    const one = await api
      .get(`/api/v1/reports/batches/pdf?batchId=${batch.id}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(one.headers['content-disposition']).toMatch(
      /attachment; filename=".*-report-2026-03-20\.pdf"/,
    );
    keep('batch.pdf', one.body as Buffer);

    const everyone = await api
      .get('/api/v1/reports/batches/pdf')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((everyone.body as Buffer).length).toBeGreaterThan((one.body as Buffer).length);
    keep('academy.pdf', everyone.body as Buffer);

    await api
      .get('/api/v1/reports/batches/pdf?batchId=00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('refuses a batch report when nobody is enrolled', async () => {
    setToday('2026-03-20');
    const { admin, batch } = await makeAcademy();
    await (await as(admin)).get(`/api/v1/reports/batches/pdf?batchId=${batch.id}`).expect(422);
  });
});

describe('report variants', () => {
  it('covers moves, makeups, every feedback field, late fees and a student who left', async () => {
    setToday('2026-03-20', '06:30:00');
    const a = await makeAcademy();
    const s = await makeStudent(
      {
        batchId: a.batch.id,
        feePlanId: a.plan.id,
        joiningDate: '2025-12-01',
        fullName: 'Kabir Das',
        gender: 'male',
        email: 'kabir.parent@example.com',
        address: '12 MG Road, Bengaluru',
        medicalNotes: 'Mild asthma; carries an inhaler.',
        alternatePhone: '+919812345678',
        monthlyDiscount: 20_000,
      },
      a.admin.id,
    );
    const admin = await as(a.admin);
    await admin
      .post(`/api/v1/students/${s.id}/transfer`, {
        batchId: a.otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: '2026-02-02',
        reason: 'Evening slot suits school',
      })
      .expect(200);

    // December: never on Mondays, always on Wednesdays; March: mostly absent.
    const rows: (typeof studentAttendance.$inferInsert)[] = [];
    const mark = (
      batchId: string,
      date: string,
      status: 'present' | 'absent',
      by: string,
      isMakeup = false,
    ) => rows.push({ batchId, studentId: s.id, date, status, markedById: by, isMakeup });
    for (const d of ['2025-12-01', '2025-12-08', '2025-12-15', '2025-12-22'])
      mark(a.batch.id, d, 'absent', a.coach.id);
    for (const d of ['2025-12-03', '2025-12-10', '2025-12-17', '2025-12-24', '2025-12-31'])
      mark(a.batch.id, d, 'present', a.coach.id);
    for (const d of [
      '2026-02-04',
      '2026-02-06',
      '2026-02-11',
      '2026-02-13',
      '2026-02-18',
      '2026-02-20',
    ])
      mark(a.otherBatch.id, d, 'present', a.otherCoach.id);
    for (const d of ['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09'])
      mark(a.otherBatch.id, d, 'absent', a.otherCoach.id);
    mark(a.batch.id, '2026-02-10', 'present', a.coach.id, true);
    await db.insert(studentAttendance).values(rows);
    await db.insert(makeupSessions).values({
      studentId: s.id,
      batchId: a.batch.id,
      date: '2026-02-10',
      missedDate: '2026-02-09',
      reason: 'School exam',
      createdById: a.admin.id,
      status: 'approved',
    });
    await db.insert(weeklyFeedback).values([
      {
        studentId: s.id,
        batchId: a.otherBatch.id,
        coachId: a.otherCoach.id,
        weekStart: '2026-02-09',
        templateKey: 'weekly',
        templateVersion: 1,
        answers: {
          ...ratings(4),
          overall: 'on_track',
          injury_concern: true,
          home_practice: 'Skipping, 10 minutes a day',
          improvements: 42, // not text: ignored
        },
        status: 'submitted',
        submittedAt: new Date('2026-02-15T12:00:00Z'),
      },
      {
        studentId: s.id,
        batchId: a.otherBatch.id,
        coachId: a.otherCoach.id,
        weekStart: '2026-02-16',
        templateKey: 'weekly',
        templateVersion: 1,
        answers: { ...ratings(3), overall: ['unknown_choice'], injury_concern: false },
        status: 'submitted',
        submittedAt: null,
      },
    ]);
    await billOnAcceptance(s.id);
    const bills = (await db.select().from(invoices).where(eq(invoices.studentId, s.id))).sort(
      (x, y) => x.issueDate.localeCompare(y.issueDate),
    );
    expect(bills.length).toBeGreaterThanOrEqual(3);
    // First paid late by cheque, second cancelled, the rest stay due.
    await db.insert(payments).values({
      invoiceId: bills[0]!.id,
      amount: bills[0]!.totalAmount,
      mode: 'cheque',
      paidOn: '2026-01-30',
      recordedById: a.admin.id,
    });
    await db.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, bills[0]!.id));
    await db.update(invoices).set({ status: 'cancelled' }).where(eq(invoices.id, bills[1]!.id));
    await admin
      .post(`/api/v1/students/${s.id}/leave`, { leftOn: '2026-03-18', reason: 'Moving city' })
      .expect(200);

    const [r] = await loadStudentReports([s.id], null, '2026-03-20');
    expect(r!.student).toMatchObject({ status: 'left', leftReason: 'Moving city' });
    expect(r!.current).toBeNull();
    expect(r!.enrollments).toHaveLength(2);
    expect(r!.makeups).toEqual([expect.objectContaining({ missedDate: '2026-02-09' })]);
    expect(r!.attendance.makeupsAttended).toBe(1);
    expect(r!.fees.onTimeRate).toBe(0);
    expect(r!.fees.invoices.some((i) => i.status === 'cancelled')).toBe(false);
    const notes = r!.feedback.weeks.flatMap((w) => w.notes.map((n) => `${n.label}=${n.value}`));
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/=Yes$/),
        expect.stringMatching(/=No$/),
        expect.stringMatching(/=unknown_choice$/),
        expect.stringMatching(/Skipping/),
      ]),
    );
    const titles = r!.timeline.map((e) => e.title);
    expect(titles).toEqual(
      expect.arrayContaining([`Moved to ${a.otherBatch.name}`, 'Left the academy']),
    );
    const text = r!.insights.join(' ');
    expect(text).toMatch(/last 30 days is \d+%, down/);
    expect(text).toMatch(/Most regular on Wednesdays/);
    expect(text).toMatch(/1 makeup session taken/);
    expect(text).toMatch(/Pays on time 0%/);

    // Only that batch: just the evening sessions and that coach's reports.
    const [evening] = await loadStudentReports([s.id], [a.otherBatch.id], '2026-03-20');
    expect(evening!.attendance.counted).toBe(10);
    expect(evening!.feedback.count).toBe(2);

    // PDFs render every variant (left student, makeups, notes, no current batch).
    const pdf = await admin
      .get(`/api/v1/reports/students/${s.id}/pdf?batchId=${a.otherBatch.id}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    keep('student-left.pdf', pdf.body as Buffer);
    const group = await renderGroupReportPdf([r!, evening!], await getAcademySettings(), {
      title: 'Everyone',
      scope: 'test',
      generated: '20 Mar 2026',
    });
    expect(group.subarray(0, 5).toString()).toBe('%PDF-');
    keep('group-left.pdf', group);
  });
});
