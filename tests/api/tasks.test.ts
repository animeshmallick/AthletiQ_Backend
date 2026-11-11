import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import {
  coachSessions,
  invoices,
  makeupSessions,
  registrationRequests,
  sessionCancellations,
} from '../../src/db/schema';
import { billOnAcceptance } from '../../src/modules/billing/invoice-generator';
import { clockLabel, tasksFor, toMinutes, type Task } from '../../src/modules/tasks/tasks.service';
import { checkIn, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

const MON = '2026-03-09';
// IST = UTC+5:30. The factory batch runs 06:00–08:00 IST.
const at = (ist: string) => {
  const [h, m] = ist.split(':').map(Number);
  const utc = h! * 60 + m! - 330;
  return `${String(Math.floor(utc / 60)).padStart(2, '0')}:${String(utc % 60).padStart(2, '0')}:00`;
};
const kinds = (r: { items: Task[] }) => r.items.map((t) => t.kind).sort();
const find = (r: { items: Task[] }, kind: string) => r.items.find((t) => t.kind === kind);

async function academyToday() {
  const a = await makeAcademy();
  // Joins today, so there is no open weekly report from last week.
  await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: MON, trainingDays: [1, 3, 5] },
    a.admin.id,
  );
  const coach = { ...a.coach, role: 'coach' as const };
  const admin = { ...a.admin, role: 'admin' as const };
  return { ...a, coachUser: coach, adminUser: admin };
}

describe('task helpers', () => {
  it('formats clock times', () => {
    expect(clockLabel('17:00:00')).toBe('5:00 pm');
    expect(clockLabel('00:05:00')).toBe('12:05 am');
    expect(clockLabel('12:30:00')).toBe('12:30 pm');
    expect(toMinutes('06:45:00')).toBe(405);
    expect(toMinutes('')).toBe(0);
  });
});

describe('coach session tasks over a day', () => {
  it('moves from planning to check-in and attendance (no check-out)', async () => {
    const a = await academyToday();

    // Every session today has its own check-in to-do: "later today" until 15 min before.
    setToday(MON, at('05:30'));
    expect(kinds(await tasksFor(a.coachUser)).sort()).toEqual(['check-in', 'lesson-plan']);
    expect(find(await tasksFor(a.coachUser), 'check-in')).toMatchObject({ severity: 'info' });

    setToday(MON, at('05:50'));
    expect(find(await tasksFor(a.coachUser), 'check-in')).toMatchObject({
      severity: 'warning',
      detail: expect.stringMatching(/^Starts at 6:00 am · /),
    });

    setToday(MON, at('06:10'));
    expect(find(await tasksFor(a.coachUser), 'check-in')).toMatchObject({
      detail: expect.stringMatching(/^Started at 6:00 am · /),
    });
    // Admins don't get a check-in nudge, only the missed check-in later.
    expect(kinds(await tasksFor(a.adminUser))).toEqual([]);

    await checkIn(a.coach.id, a.batch.id, MON);
    const marking = await tasksFor(a.coachUser);
    expect(kinds(marking)).toEqual(['attendance', 'lesson-plan']);
    expect(find(marking, 'attendance')).toMatchObject({
      severity: 'info',
      title: `Mark attendance for ${a.batch.name}`,
      detail: `${a.batch.name} · 0 of 1 marked`,
    });

    // Session over: attendance is still open, and there is nothing to check out of.
    setToday(MON, at('08:20'));
    const late = await tasksFor(a.coachUser);
    expect(kinds(late)).toEqual(['attendance']);
    expect(find(late, 'attendance')!.severity).toBe('warning');
    expect(kinds(await tasksFor(a.adminUser))).toEqual([]);

    setToday(MON, at('08:40'));
    expect(find(await tasksFor(a.adminUser), 'attendance')).toMatchObject({
      title: 'Attendance not marked',
      detail: `${a.coach.name} · ${a.batch.name} · 0 of 1 marked`,
    });

    expect(kinds(await tasksFor(a.coachUser))).toEqual(['attendance']);
  });

  it('skips cancelled sessions', async () => {
    const a = await academyToday();
    await db
      .insert(sessionCancellations)
      .values({ batchId: a.batch.id, date: MON, reason: 'Rain' });
    setToday(MON, at('06:40'));
    expect(kinds(await tasksFor(a.coachUser))).toEqual([]);
    expect(kinds(await tasksFor(a.adminUser))).toEqual([]);
  });

  it('sends admins to the day calendar for a missed check-in', async () => {
    const a = await academyToday();
    setToday(MON, at('06:45'));
    expect(find(await tasksFor(a.adminUser), 'missed-check-in')).toMatchObject({
      severity: 'critical',
      link: `/calendar?date=${MON}&view=day`,
      screen: '/calendar',
    });
    expect(find(await tasksFor(a.coachUser), 'missed-check-in')).toMatchObject({
      title: "You haven't checked in",
      link: '/',
    });
  });
});

describe('coach weekly report task', () => {
  it('counts open reports with the right plural', async () => {
    setToday(MON, at('12:00'));
    const a = await makeAcademy();
    const coach = { ...a.coach, role: 'coach' as const };
    await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id }, a.admin.id);
    expect(find(await tasksFor(coach), 'feedback')).toMatchObject({
      title: '1 weekly report to send',
      count: 1,
    });
    await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id }, a.admin.id);
    const two = await tasksFor(coach);
    expect(find(two, 'feedback')).toMatchObject({ title: '2 weekly reports to send', count: 2 });
    expect(two.counts['/feedback']).toBe(2);
  });
});

describe('admin academy-wide tasks', () => {
  it('counts registrations, flagged check-ins, overdue fees and makeups', async () => {
    setToday(MON, at('12:00'));
    const a = await makeAcademy();
    const admin = { ...a.admin, role: 'admin' as const };
    const s = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-01-10' },
      a.admin.id,
    );
    expect(
      kinds(await tasksFor(admin)).filter((k) => !['missed-check-in', 'attendance'].includes(k)),
    ).toEqual([]);

    const registration = (fullName: string) =>
      db.insert(registrationRequests).values({
        type: 'coach',
        fullName,
        phone: '+919876543210',
        details: {} as never,
      });
    await registration('Neha');
    const flagged = (date: string) =>
      db.insert(coachSessions).values({
        coachId: a.coach.id,
        batchId: a.batch.id,
        locationId: a.location.id,
        date,
        scheduledStart: '06:00:00',
        scheduledEnd: '08:00:00',
        checkInAt: new Date(`${date}T00:30:00Z`),
        checkInLat: 0,
        checkInLng: 0,
        checkInDistanceM: 900,
        checkInWithinFence: false,
      });
    await flagged('2026-03-07');
    await billOnAcceptance(s.id);
    await db.update(invoices).set({ dueDate: '2026-04-01' });
    await db.update(invoices).set({ dueDate: '2026-03-01' }).where(eq(invoices.cycleNumber, 1));
    await db.insert(makeupSessions).values({
      studentId: s.id,
      batchId: a.batch.id,
      date: '2026-03-12',
      status: 'pending',
      createdById: a.coach.id,
    });

    const one = await tasksFor(admin);
    expect(one.items.map((t) => t.title)).toEqual(
      expect.arrayContaining([
        '1 registration to review',
        '1 flagged check-in',
        '1 overdue invoice',
        '1 makeup request to review',
      ]),
    );

    await registration('Arjun');
    await flagged('2026-03-06');
    await db.insert(makeupSessions).values({
      studentId: s.id,
      batchId: a.batch.id,
      date: '2026-03-13',
      status: 'pending',
      createdById: a.coach.id,
    });
    await db.update(invoices).set({ dueDate: '2026-03-01' });
    const two = await tasksFor(admin);
    expect(two.items.map((t) => t.title)).toEqual(
      expect.arrayContaining([
        '2 registrations to review',
        '2 flagged check-ins',
        '2 makeup requests to review',
        '2 overdue invoices',
      ]),
    );
    expect(two.counts).toMatchObject({ '/registrations': 2, '/coach-sessions': 2, '/makeups': 2 });
    // Critical first.
    const severities = two.items.map((t) => t.severity);
    expect(severities).toEqual(
      [...severities].sort((x, y) => (x === 'critical' ? -1 : y === 'critical' ? 1 : 0)),
    );
  });
});

describe('check-ins for every session of the day', () => {
  it('lists a separate check-in for each of the coach’s batches today', async () => {
    const a = await academyToday();
    // Two more batches for the same coach today, later in the day.
    const evening = await makeBatch(a.coach.id, a.location.id, {
      feePlanId: a.plan.id,
      startTime: '17:00:00',
      endTime: '18:00:00',
    });
    await makeBatch(a.coach.id, a.location.id, {
      feePlanId: a.plan.id,
      startTime: '19:00:00',
      endTime: '20:00:00',
    });
    setToday(MON, at('05:50'));
    const checkIns = (await tasksFor(a.coachUser)).items.filter((t) => t.kind === 'check-in');
    expect(checkIns).toHaveLength(3);
    // The one starting now is urgent; the later ones are for later today.
    expect(checkIns.map((t) => t.severity).sort()).toEqual(['info', 'info', 'warning']);
    expect(checkIns.find((t) => t.id.includes(evening.id))!.detail).toMatch(/^Starts at 5:00 pm/);

    // Checking in to one removes only that one.
    await checkIn(a.coach.id, a.batch.id, MON);
    const left = (await tasksFor(a.coachUser)).items.filter((t) => t.kind === 'check-in');
    expect(left).toHaveLength(2);
  });
});
