import { describe, expect, it } from '@jest/globals';
import { renderParentReportPdf } from '../../src/modules/reports/parent-report-pdf';
import type { StudentReport } from '../../src/modules/reports/report-data';
import type { Framework } from '../../src/modules/skills/framework';
import type { AssessmentView } from '../../src/modules/skills/progress';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

function framework(areas: number): Framework {
  return {
    sport: { id: 's', name: 'Badminton', isActive: true },
    areas: Array.from({ length: areas }, (_, i) => ({
      id: `a${i}`,
      name: `Area ${i + 1}`,
      position: i + 1,
      isActive: true,
      skills: Array.from({ length: 3 }, (_, j) => ({
        id: `a${i}k${j}`,
        name: `Skill ${i + 1}.${j + 1}`,
        description: null,
        position: j + 1,
        isActive: true,
      })),
    })),
    levels: [
      { id: 'l1', code: 'A1', name: 'Novice / Absolute Beginner', minScore: 100, position: 1 },
      { id: 'l2', code: 'A2', name: 'Advanced Beginner', minScore: 175, position: 2 },
      { id: 'l3', code: 'B1', name: 'Lower Intermediate', minScore: 250, position: 3 },
      { id: 'l4', code: 'B2', name: 'Upper Intermediate', minScore: 325, position: 4 },
      { id: 'l5', code: 'C1', name: 'Advanced / Regional Competitor', minScore: 400, position: 5 },
      // A custom rung without a code still renders.
      { id: 'l6', code: null, name: 'Pro', minScore: 480, position: 6 },
    ],
  };
}

function assessment(
  f: Framework,
  month: string,
  base: number,
  extra: Partial<AssessmentView> = {},
) {
  const ids = f.areas.flatMap((a) => a.skills.map((k) => k.id));
  const ratings = Object.fromEntries(ids.map((id, i) => [id, Math.min(5, base + (i % 2))]));
  const vals = Object.values(ratings);
  const average = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
  const level = [...f.levels].filter((l) => average >= l.minScore).at(-1);
  return {
    id: month,
    month,
    average,
    levelName: level?.name ?? null,
    levelCode: level?.code ?? null,
    levelPosition: level?.position ?? null,
    comment: null,
    goals: null,
    batchId: 'b',
    batchName: 'Evening',
    coachName: 'Ravi',
    updatedAt: new Date(),
    ratings,
    ...extra,
  } satisfies AssessmentView;
}

function report(over: Partial<StudentReport> = {}): StudentReport {
  return {
    student: {
      id: 'x',
      code: 'ATQ-0001',
      fullName: 'Aarav Sharma',
      dateOfBirth: null,
      age: null,
      gender: null,
      guardianName: null,
      phone: '+919876543210',
      alternatePhone: null,
      email: null,
      address: null,
      medicalNotes: null,
      joiningDate: '2026-01-10',
      status: 'active',
      leftOn: null,
      leftReason: null,
      tenureDays: 10,
      feePlan: '3 days',
      monthlyFee: 250000,
      monthlyDiscount: 0,
    },
    current: null,
    enrollments: [],
    attendance: {
      present: 0,
      late: 0,
      absent: 0,
      excused: 0,
      counted: 0,
      rate: null,
      rate30: null,
      rate90: null,
      currentStreak: 0,
      longestStreak: 0,
      lastAttended: null,
      makeupsAttended: 0,
      byMonth: [],
      byWeekday: [],
    },
    fees: {
      billed: 0,
      paid: 0,
      outstanding: 0,
      overdue: 0,
      overdueCount: 0,
      invoicesCount: 0,
      onTimeRate: null,
      avgDaysToPay: null,
      invoices: [],
    },
    feedback: { count: 0, skills: [], overall: null, weeks: [] },
    makeups: [],
    skills: [],
    timeline: [],
    insights: [],
    ...over,
  };
}

const academy = {
  id: 1,
  name: 'Smash Academy',
  legalName: null,
  address: '12 Lake Road',
  phone: '+91 98765 43210',
  email: 'hi@smash.in',
  website: null,
  gstin: null,
  upiId: null,
  invoiceFooter: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const render = (r: StudentReport, photo: Buffer | null = null) =>
  renderParentReportPdf(r, academy, {
    scope: 'All batches',
    generated: '9 Nov 2026',
    photo: photo ? { data: photo } : null,
  });
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('parent report PDF', () => {
  it('renders a full report: photo, skills over months, coach remarks, attendance and fees', async () => {
    const f = framework(6);
    const months = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'];
    const assessments = months.map((m, i) =>
      assessment(
        f,
        m,
        Math.min(5, 2 + i),
        i === months.length - 1 ? { comment: 'Great net play.', goals: 'Footwork.' } : {},
      ),
    );
    const pdf = await render(
      report({
        student: { ...report().student, age: 12, tenureDays: 240 },
        current: {
          batchName: 'Evening',
          coachName: 'Ravi',
          trainingDays: [1, 3],
          since: '2026-01-10',
        },
        attendance: {
          ...report().attendance,
          present: 40,
          late: 2,
          absent: 6,
          counted: 48,
          rate: 88,
          rate30: 60,
          rate90: 85,
          currentStreak: 7,
          longestStreak: 12,
          lastAttended: '2026-09-20',
          byMonth: [
            { month: '2026-08', present: 10, late: 0, absent: 5, excused: 0, rate: 67 },
            { month: '2026-09', present: 12, late: 1, absent: 0, excused: 0, rate: 100 },
            { month: '2026-10', present: 2, late: 0, absent: 8, excused: 0, rate: 20 },
          ],
          byWeekday: [
            { weekday: 1, rate: 90, counted: 20 },
            { weekday: 3, rate: 50, counted: 20 },
          ],
        },
        fees: {
          ...report().fees,
          invoicesCount: 2,
          outstanding: 250000,
          overdue: 250000,
          overdueCount: 1,
          invoices: [
            {
              number: 'I-1',
              period: '2026-09-10 to 2026-10-09',
              issueDate: '2026-09-03',
              dueDate: '2026-09-17',
              amount: 250000,
              status: 'overdue',
              paidOn: null,
              mode: null,
            },
          ],
        },
        feedback: {
          count: 1,
          skills: [],
          overall: null,
          weeks: [
            {
              weekStart: '2026-09-14',
              coachName: 'Ravi',
              ratings: [],
              notes: [{ label: 'Highlights', value: 'Won a match' }],
            },
          ],
        },
        skills: [{ framework: f, batchId: 'b', batchName: 'Evening', assessments }],
      }),
      PNG,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBeGreaterThanOrEqual(3);
  });

  it('renders a first assessment (no comparison), a dropped level and few areas', async () => {
    const f = framework(2); // too few areas for a skill wheel: bars only
    const first = await render(
      report({
        skills: [
          {
            framework: f,
            batchId: 'b',
            batchName: 'Evening',
            assessments: [assessment(f, '2026-09-01', 3)],
          },
        ],
      }),
    );
    expect(first.subarray(0, 5).toString()).toBe('%PDF-');
    const down = await render(
      report({
        skills: [
          {
            framework: f,
            batchId: 'b',
            batchName: 'Evening',
            assessments: [assessment(f, '2026-08-01', 4), assessment(f, '2026-09-01', 2)],
          },
        ],
        fees: { ...report().fees, invoicesCount: 1, outstanding: 0 },
      }),
    );
    expect(pages(down)).toBeGreaterThanOrEqual(2);
    // Same score both months, top level reached.
    const top = framework(4);
    await render(
      report({
        skills: [
          {
            framework: top,
            batchId: 'b',
            batchName: 'Evening',
            assessments: [assessment(top, '2026-08-01', 5), assessment(top, '2026-09-01', 5)],
          },
        ],
      }),
    );
  });

  it('explains that assessments are coming when there are none, and tolerates a bad photo', async () => {
    const pdf = await render(
      report({ fees: { ...report().fees, invoicesCount: 1, outstanding: 100000, invoices: [] } }),
      Buffer.from('not an image'),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
