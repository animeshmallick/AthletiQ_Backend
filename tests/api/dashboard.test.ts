import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { studentAttendance } from '../../src/db/schema';
import { nextBirthday } from '../../src/modules/dashboard/dashboard.routes';
import { as, checkIn, makeAcademy, makeStudent, setToday } from '../helpers/factories';

const MON = '2026-03-09';

describe('nextBirthday', () => {
  it('counts days to the next birthday and the age turned', () => {
    expect(nextBirthday('2014-03-09', MON)).toEqual({ inDays: 0, turning: 12 });
    expect(nextBirthday('2014-03-12', MON)).toEqual({ inDays: 3, turning: 12 });
    expect(nextBirthday('2014-03-01', MON)).toEqual({ inDays: 357, turning: 13 });
    expect(nextBirthday('2012-02-29', '2026-02-20')).toEqual({ inDays: 9, turning: 14 });
  });
});

describe('dashboard', () => {
  it('summarises people, attendance, batches, coaches and who needs attention', async () => {
    setToday(MON, '06:30:00'); // 12:00 IST
    const { admin, coach, otherCoach, batch, otherBatch, plan } = await makeAcademy();
    const regular = await makeStudent(
      {
        batchId: batch.id,
        feePlanId: plan.id,
        joiningDate: '2026-01-10',
        fullName: 'Regular Riya',
        dateOfBirth: '2014-03-11',
      },
      admin.id,
    );
    const absentee = await makeStudent(
      {
        batchId: batch.id,
        feePlanId: plan.id,
        joiningDate: '2026-03-02',
        fullName: 'Absent Arjun',
      },
      admin.id,
    );
    await makeStudent(
      { batchId: otherBatch.id, feePlanId: plan.id, joiningDate: '2026-01-10' },
      admin.id,
    );

    // Last week: Riya came 3/3, Arjun 0/3.
    for (const date of ['2026-03-02', '2026-03-04', '2026-03-06']) {
      await db.insert(studentAttendance).values([
        { batchId: batch.id, studentId: regular.id, date, status: 'present', markedById: coach.id },
        { batchId: batch.id, studentId: absentee.id, date, status: 'absent', markedById: coach.id },
      ]);
    }
    await checkIn(coach.id, batch.id, '2026-03-02', '2026-03-04');

    const adminDash = (await (await as(admin)).get('/api/v1/dashboard').expect(200)).body.data;
    expect(adminDash.people).toMatchObject({
      activeStudents: 3,
      newThisMonth: 1,
      activeCoaches: 2,
      activeBatches: 2,
    });
    expect(adminDash.attendance.rate30d).toBe(50);
    expect(adminDash.attendance.trend).toHaveLength(14);
    expect(
      adminDash.attendance.trend.find((d: { date: string }) => d.date === '2026-03-02').rate,
    ).toBe(50);
    expect(adminDash.needsAttention).toEqual([
      expect.objectContaining({ fullName: 'Absent Arjun', rate: 0, attended: 0, counted: 3 }),
    ]);
    expect(adminDash.birthdays).toEqual([
      expect.objectContaining({ fullName: 'Regular Riya', inDays: 2, turning: 12 }),
    ]);
    expect(adminDash.batchHealth[0]).toMatchObject({
      id: batch.id,
      enrolled: 2,
      attendanceRate: 50,
    });
    const coachRow = adminDash.coaches.find((c: { id: string }) => c.id === coach.id);
    expect(coachRow).toMatchObject({ batches: 1, students: 2, sessions: 2, flagged: 0 });
    expect(adminDash.myMonth).toBeNull();

    // A coach only sees their own batch.
    const coachDash = (await (await as(coach)).get('/api/v1/dashboard').expect(200)).body.data;
    expect(coachDash.people).toMatchObject({ activeStudents: 2, activeBatches: 1 });
    expect(coachDash.coaches).toEqual([]);
    expect(coachDash.myMonth).toMatchObject({ sessions: 2, flagged: 0 });
    expect(coachDash.feedback).toMatchObject({ total: 2 });

    const empty = (await (await as(otherCoach)).get('/api/v1/dashboard').expect(200)).body.data;
    expect(empty.attendance.rate30d).toBeNull();
    expect(empty.needsAttention).toEqual([]);
  });
});
