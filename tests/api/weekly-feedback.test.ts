import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, makeStudent, setToday } from '../helpers/factories';

describe('weekly feedback', () => {
  const WEEK = '2026-03-09'; // Monday
  const complete = {
    technique: 4,
    fitness: 3,
    game_sense: 5,
    discipline: 4,
    effort: 5,
    teamwork: 4,
    overall: 'improving',
    highlights: 'Great footwork',
    improvements: 'Follow-through',
  };

  async function setup() {
    const a = await makeAcademy();
    const student = await makeStudent(
      { batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-02-01', fullName: 'Isha' },
      a.admin.id,
    );
    return { ...a, student };
  }

  it('exposes the template from code', async () => {
    const { coach } = await setup();
    const res = await (await as(coach)).get('/api/v1/feedback/template').expect(200);
    expect(res.body.data).toMatchObject({ key: 'weekly', version: 1 });
  });

  it('tracks pending/draft/submitted reports for the week', async () => {
    setToday('2026-03-16');
    const { coach, admin, student, batch } = await setup();
    const api = await as(coach);

    const board = await api.get('/api/v1/feedback/week').expect(200); // defaults to last completed week
    expect(board.body.data).toMatchObject({
      weekStart: WEEK,
      weekEnd: '2026-03-15',
      summary: { total: 1, pending: 1 },
    });

    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, { answers: { technique: 3 } })
      .expect(200);
    const drafted = await api
      .get(`/api/v1/feedback/week?weekStart=${WEEK}&batchId=${batch.id}`)
      .expect(200);
    expect(drafted.body.data.summary).toMatchObject({ draft: 1, pending: 0 });

    // Submitting enforces required fields.
    const invalid = await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, {
        answers: { technique: 3 },
        submit: true,
      })
      .expect(400);
    expect(invalid.body.error.details.fields.length).toBeGreaterThan(3);
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, {
        answers: complete,
        submit: true,
      })
      .expect(200);

    const adminBoard = await (
      await as(admin)
    )
      .get(`/api/v1/feedback/week?weekStart=${WEEK}&coachId=${coach.id}`)
      .expect(200);
    expect(adminBoard.body.data.students[0]).toMatchObject({
      status: 'submitted',
      writtenBy: coach.name,
    });

    await api.get('/api/v1/feedback/week?weekStart=2026-03-10').expect(400); // not a Monday
    await api.get('/api/v1/feedback/week?weekStart=2026-03-23').expect(400); // future
  });

  it('snapshots attendance, stays editable for a grace period, then locks', async () => {
    setToday('2026-03-16');
    const { coach, admin, student, batch } = await setup();
    const adminApi = await as(admin);
    await adminApi.put('/api/v1/attendance/session', {
      batchId: batch.id,
      date: '2026-03-09',
      records: [{ studentId: student.id, status: 'present' }],
    });
    await adminApi.put('/api/v1/attendance/session', {
      batchId: batch.id,
      date: '2026-03-11',
      records: [{ studentId: student.id, status: 'absent' }],
    });

    const api = await as(coach);
    const blank = await api
      .get(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`)
      .expect(200);
    expect(blank.body.data).toMatchObject({
      feedback: null,
      editable: true,
      // Students train every day their batch runs (Mon–Sat).
      attendance: { scheduled: 6, present: 1, absent: 1, unmarked: 4 },
      template: { key: 'weekly' },
    });

    const saved = await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, {
        answers: complete,
        submit: true,
      })
      .expect(200);
    expect(saved.body.data).toMatchObject({
      status: 'submitted',
      batchId: batch.id,
      attendanceSummary: { scheduled: 6 },
    });

    // Edit within grace: stays submitted, keeps original submittedAt.
    const edited = await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, {
        answers: { ...complete, technique: 5 },
      })
      .expect(200);
    expect(edited.body.data).toMatchObject({
      status: 'submitted',
      submittedAt: saved.body.data.submittedAt,
    });

    setToday('2026-03-23'); // past weekStart + 13 days
    const later = await as(coach);
    const locked = await later
      .get(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`)
      .expect(200);
    expect(locked.body.data.editable).toBe(false);
    await later
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, { answers: complete })
      .expect(422);
  });

  it('enforces access and enrollment rules', async () => {
    setToday('2026-03-16');
    const { otherCoach, admin, student, coach } = await setup();
    await (
      await as(otherCoach)
    )
      .get(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`)
      .expect(404);
    await (
      await as(admin)
    )
      .put(`/api/v1/feedback/students/${student.id}/weeks/${WEEK}`, { answers: {} })
      .expect(403);
    const api = await as(coach);
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-03-23`, { answers: {} })
      .expect(422); // future week
    // The current week (today is Mon 16 Mar) isn't over yet: read-only until it ends.
    const current = await api
      .get(`/api/v1/feedback/students/${student.id}/weeks/2026-03-16`)
      .expect(200);
    expect(current.body.data).toMatchObject({
      weekCompleted: false,
      opensOn: '2026-03-23',
      editable: false,
    });
    const early = await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-03-16`, { answers: {} })
      .expect(422);
    expect(early.body.error.message).toBe(
      'Feedback for this week opens on 2026-03-23, once the week is over.',
    );
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-01-05`, { answers: {} })
      .expect(422); // before joining
  });

  it('returns history and rating trends', async () => {
    setToday('2026-03-23');
    const { coach, student } = await setup();
    const api = await as(coach);
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-03-09`, {
        answers: complete,
        submit: true,
      })
      .expect(200);
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-03-16`, {
        answers: { ...complete, technique: 5 },
        submit: true,
      })
      .expect(200);
    await api
      .put(`/api/v1/feedback/students/${student.id}/weeks/2026-03-02`, {
        answers: { technique: 2 },
      })
      .expect(200);

    const history = await api.get(`/api/v1/feedback/students/${student.id}`).expect(200);
    expect(history.body.data.map((h: { weekStart: string }) => h.weekStart)).toEqual([
      '2026-03-16',
      '2026-03-09',
      '2026-03-02',
    ]);
    const trends = await api.get(`/api/v1/feedback/students/${student.id}/trends`).expect(200);
    expect(trends.body.data.find((t: { id: string }) => t.id === 'technique').points).toEqual([
      { weekStart: '2026-03-09', value: 4 },
      { weekStart: '2026-03-16', value: 5 },
    ]);
    const submittedView = await api
      .get(`/api/v1/feedback/students/${student.id}/weeks/2026-03-09`)
      .expect(200);
    expect(submittedView.body.data.feedback.status).toBe('submitted');
  });
});
