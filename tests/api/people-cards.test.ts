import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { skillAssessments, studentAttendance } from '../../src/db/schema';
import { as, checkIn, makeAcademy, makeStudent, setToday } from '../helpers/factories';

const TODAY = '2026-03-20';

describe('people cards', () => {
  it('adds attendance and level to the students list, scoped for coaches', async () => {
    setToday(TODAY);
    const a = await makeAcademy();
    const s = await makeStudent(
      { fullName: 'Asha', batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-02' },
      a.admin.id,
    );
    const mark = (date: string, status: 'present' | 'absent', batchId = a.batch.id) =>
      db
        .insert(studentAttendance)
        .values({ batchId, studentId: s.id, date, status, markedById: a.coach.id });
    await mark('2026-03-16', 'present');
    await mark('2026-03-17', 'present');
    await mark('2026-03-18', 'absent');
    // A makeup in the other coach's batch: admins count it, the coach doesn't see it.
    await mark('2026-03-19', 'absent', a.otherBatch.id);
    await db.insert(skillAssessments).values({
      studentId: s.id,
      sportId: a.batch.sportId,
      batchId: a.batch.id,
      coachId: a.coach.id,
      month: '2026-03-01',
      average: 180,
      levelName: 'Advanced Beginner',
      levelCode: 'A2',
      levelPosition: 2,
    });

    const admin = (await (await as(a.admin)).get('/api/v1/students').expect(200)).body.data[0];
    expect(admin).toMatchObject({
      attendanceRate: 50,
      level: { code: 'A2', name: 'Advanced Beginner' },
    });
    expect(admin).not.toHaveProperty('registrationNo'); // shown only on the profile
    const coach = (await (await as(a.coach)).get('/api/v1/students').expect(200)).body.data[0];
    expect(coach.attendanceRate).toBe(67);
  });

  it('adds students, check-ins, punctuality and money to the team list', async () => {
    setToday(TODAY);
    const a = await makeAcademy();
    await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-02' },
      a.admin.id,
    );
    await checkIn(a.coach.id, a.batch.id, '2026-03-16', '2026-03-17');
    const team = (await (await as(a.admin)).get('/api/v1/users?role=coach').expect(200)).body
      .data as {
      id: string;
      students: number;
      checkIns30: number;
      onTimeRate: number | null;
      cashHeld: number;
      owed: number;
    }[];
    expect(team.find((u) => u.id === a.coach.id)).toMatchObject({
      students: 1,
      checkIns30: 2,
      onTimeRate: 100,
      cashHeld: 0,
      owed: 0,
    });
    expect(team.find((u) => u.id === a.otherCoach.id)).toMatchObject({
      students: 0,
      checkIns30: 0,
      onTimeRate: null,
    });
  });
});
