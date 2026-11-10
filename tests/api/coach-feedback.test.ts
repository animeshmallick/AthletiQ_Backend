import { describe, expect, it } from '@jest/globals';
import { lastCompletedWeek, weekBoard } from '../../src/modules/feedback/feedback.routes';
import { pendingAssessments } from '../../src/modules/skills/reminders';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

const MON = '2026-03-16';

describe('free batches without coach feedback', () => {
  it('keeps attendance only: no reports, assessments or plan reminders for that batch', async () => {
    setToday(MON, '00:00:00'); // 5:30 am IST, before the sessions
    const { admin, coach, location, batch, plan } = await makeAcademy();
    const api = await as(admin);
    const free = (await api.get('/api/v1/fee-plans?forBatch=true').expect(200)).body.data[0];
    const body = {
      name: 'Free volleyball',
      coachId: coach.id,
      locationId: location.id,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startTime: '06:00',
      endTime: '07:00',
      capacity: 30,
      sportId: batch.sportId,
      feePlanId: free.id,
    };
    // Feedback is on unless turned off.
    const on = (await api.post('/api/v1/batches', { ...body, name: 'Free A' }).expect(201)).body
      .data;
    expect(on.coachFeedback).toBe(true);
    const off = (await api.post('/api/v1/batches', { ...body, coachFeedback: false }).expect(201))
      .body.data;
    expect(off.coachFeedback).toBe(false);
    // The batch list says so too (for the form and the Attendance only tag).
    const listed = (await api.get(`/api/v1/batches/${off.id}`).expect(200)).body.data;
    expect(listed.coachFeedback).toBe(false);
    // A paid batch can't opt out: paying students always get feedback.
    const paid = (
      await api
        .post('/api/v1/batches', {
          ...body,
          name: 'Paid',
          weekdays: [1, 3, 5],
          feePlanId: plan.id,
          coachFeedback: false,
        })
        .expect(201)
    ).body.data;
    expect(paid.coachFeedback).toBe(true);
    // A free batch can be switched to attendance-only later…
    const moved = (
      await api.patch(`/api/v1/batches/${on.id}`, { coachFeedback: false }).expect(200)
    ).body.data;
    expect(moved.coachFeedback).toBe(false);
    // …and moving it onto a paid plan turns feedback back on.
    const repriced = (
      await api
        .patch(`/api/v1/batches/${on.id}`, { feePlanId: plan.id, weekdays: [1, 3, 5] })
        .expect(200)
    ).body.data;
    expect(repriced.coachFeedback).toBe(true);

    const onlyFree = await makeStudent(
      { fullName: 'Only Free', batchId: off.id, joiningDate: '2026-03-01' },
      admin.id,
    );
    // In both: still gets a report through the paid batch.
    const both = await makeStudent(
      { fullName: 'Both', batchId: batch.id, feePlanId: plan.id, joiningDate: '2026-03-01' },
      admin.id,
    );
    const coachUser = { ...coach, role: 'coach' as const };
    const week = await weekBoard(coachUser, lastCompletedWeek());
    expect(week.students.map((s: { studentId: string }) => s.studentId)).not.toContain(onlyFree.id);
    expect(week.students.map((s: { studentId: string }) => s.studentId)).toContain(both.id);
    // Only the paid batch's student is due an assessment.
    expect(await pendingAssessments(coach.id, '2026-03-20')).toBe(1);
    const plans = (await tasksFor(coachUser)).items.filter((t) => t.kind === 'lesson-plan');
    expect(plans.some((t) => t.id.includes(off.id))).toBe(false);
    expect(plans.some((t) => t.id.includes(batch.id))).toBe(true);
  });
});
