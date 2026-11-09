import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

describe('batch plan templates', () => {
  it('lets the batch coach build the batch template', async () => {
    const { coach, otherCoach, admin, batch, otherBatch, location } = await makeAcademy();
    const api = await as(coach);
    const B = batch.id;
    const stages = (q = '') => api.get(`/api/v1/lessons/stages?batchId=${B}${q}`).expect(200);

    const warm = await api
      .post('/api/v1/lessons/stages', { batchId: B, name: 'Warm-up', color: '#22c55e' })
      .expect(201);
    const main = await api.post('/api/v1/lessons/stages', { batchId: B, name: 'Main' }).expect(201);
    expect([warm.body.data.sortOrder, main.body.data.sortOrder]).toEqual([0, 1]);
    expect(warm.body.data).toMatchObject({ batchId: B, coachId: coach.id });
    await api.post('/api/v1/lessons/stages', { batchId: B, name: 'warm-up' }).expect(409);
    await api
      .post('/api/v1/lessons/stages', { batchId: B, name: 'Bad', color: 'green' })
      .expect(400);
    await api.post('/api/v1/lessons/stages', { name: 'No batch' }).expect(400);
    const drill = await api
      .post('/api/v1/lessons/events', { batchId: B, name: 'Footwork', description: 'Ladder' })
      .expect(201);
    expect(drill.body.data.description).toBe('Ladder');

    // Templates are per batch: another of my batches can reuse names; others' batches are off limits.
    const second = await makeBatch(coach.id, location.id, {
      startTime: '09:00:00',
      endTime: '10:00:00',
    });
    await api.post('/api/v1/lessons/stages', { batchId: second.id, name: 'Warm-up' }).expect(201);
    await api.post('/api/v1/lessons/stages', { batchId: otherBatch.id, name: 'X' }).expect(404);
    await api.get(`/api/v1/lessons/stages?batchId=${otherBatch.id}`).expect(404);

    await api
      .put('/api/v1/lessons/stages/order', {
        batchId: B,
        ids: [main.body.data.id, warm.body.data.id],
      })
      .expect(204);
    await api
      .put('/api/v1/lessons/stages/order', {
        batchId: B,
        ids: ['6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c'],
      })
      .expect(400);
    expect((await stages()).body.data.map((s: { name: string }) => s.name)).toEqual([
      'Main',
      'Warm-up',
    ]);

    await api
      .patch(`/api/v1/lessons/stages/${warm.body.data.id}`, { isArchived: true })
      .expect(200);
    expect((await stages()).body.data).toHaveLength(1);
    expect((await stages('&includeArchived=true')).body.data).toHaveLength(2);
    await api
      .patch(`/api/v1/lessons/events/${drill.body.data.id}`, { name: 'Footwork II' })
      .expect(200);
    await (
      await as(otherCoach)
    )
      .patch(`/api/v1/lessons/events/${drill.body.data.id}`, { name: 'Hijack' })
      .expect(404);
    await api
      .patch('/api/v1/lessons/events/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c', { name: 'X' })
      .expect(404);

    // Admins can read (not edit) any batch's template.
    const adminApi = await as(admin);
    const viaAdmin = await adminApi.get(`/api/v1/lessons/events?batchId=${B}`).expect(200);
    expect(viaAdmin.body.data[0].name).toBe('Footwork II');
    await adminApi.get('/api/v1/lessons/events').expect(400);
    await adminApi.post('/api/v1/lessons/events', { batchId: B, name: 'Nope' }).expect(403);

    // A batch can start from another batch's template; names it already has are skipped.
    const copied = await api
      .post('/api/v1/lessons/template/copy', { fromBatchId: B, toBatchId: second.id })
      .expect(200);
    expect(copied.body.data).toEqual({ stages: 1, events: 1 }); // Main + Footwork II
    const secondStages = await api.get(`/api/v1/lessons/stages?batchId=${second.id}`).expect(200);
    expect(secondStages.body.data.map((s: { name: string }) => s.name)).toEqual([
      'Warm-up',
      'Main',
    ]);
    await api.post('/api/v1/lessons/template/copy', { fromBatchId: B, toBatchId: B }).expect(400);
    await api
      .post('/api/v1/lessons/template/copy', { fromBatchId: otherBatch.id, toBatchId: B })
      .expect(404);
  });

  it('copies a plan to another batch by matching names in its template', async () => {
    const { coach, batch, location } = await makeAcademy();
    const api = await as(coach);
    const second = await makeBatch(coach.id, location.id, {
      startTime: '09:00:00',
      endTime: '10:00:00',
    });
    const add = async (kind: string, batchId: string, name: string) =>
      (await api.post(`/api/v1/lessons/${kind}`, { batchId, name }).expect(201)).body.data
        .id as string;
    const s1 = await add('stages', batch.id, 'Warm-up');
    const e1 = await add('events', batch.id, 'Serve');
    const existing = await add('stages', second.id, 'warm-up');
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [s1],
        eventIds: [e1],
        cells: [{ eventId: e1, stageId: s1, content: 'Shadow serves' }],
      })
      .expect(200);
    const res = await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        toBatchId: second.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10'],
      })
      .expect(200);
    expect(res.body.data.copied).toEqual(['2026-03-10']);
    const day = await api
      .get(`/api/v1/lessons/plans/day?batchId=${second.id}&date=2026-03-10`)
      .expect(200);
    const plan = day.body.data.plan;
    expect(plan.stages.map((s: { id: string }) => s.id)).toEqual([existing]);
    expect(plan.events[0].name).toBe('Serve');
    expect(plan.events[0].id).not.toBe(e1);
    expect(plan.cells).toEqual([
      { eventId: plan.events[0].id, stageId: existing, content: 'Shadow serves' },
    ]);
  });
});

describe('daily lesson plans', () => {
  async function library(coach: { id: string; role: 'coach' }, batchId: string) {
    const api = await as(coach);
    const add = async (kind: string, name: string) =>
      (await api.post(`/api/v1/lessons/${kind}`, { batchId, name })).body.data.id as string;
    const s1 = await add('stages', 'Warm-up');
    const s2 = await add('stages', 'Main');
    const e1 = await add('events', 'Serve');
    const e2 = await add('events', 'Rally');
    return { api, s1, s2, e1, e2 };
  }

  it('saves, loads, copies and deletes a grid', async () => {
    const { coach, admin, batch, otherCoach } = await makeAcademy();
    const { api, s1, s2, e1, e2 } = await library(coach as { id: string; role: 'coach' }, batch.id);
    const plan = {
      batchId: batch.id,
      date: '2026-03-09',
      stageIds: [s1, s2],
      eventIds: [e1, e2],
      notes: 'Focus on consistency',
      cells: [
        { eventId: e1, stageId: s1, content: '  Shadow serves  ' },
        { eventId: e2, stageId: s2, content: 'Cross-court rally' },
        { eventId: e2, stageId: s1, content: '   ' },
      ],
    };
    // Batches in the factory run Monday–Saturday: Sunday can't have a plan.
    const sunday = await api
      .put('/api/v1/lessons/plans/day', { ...plan, date: '2026-03-15' })
      .expect(422);
    expect(sunday.body.error.message).toMatch(/doesn't run on this day/);
    const saved = await api.put('/api/v1/lessons/plans/day', plan).expect(200);
    expect(saved.body.data).toMatchObject({
      stages: [
        { id: s1, name: 'Warm-up' },
        { id: s2, name: 'Main' },
      ],
      events: [{ id: e1 }, { id: e2 }],
      cells: expect.arrayContaining([{ eventId: e1, stageId: s1, content: 'Shadow serves' }]),
    });
    expect(saved.body.data.cells).toHaveLength(2);

    // Re-saving replaces the grid.
    const resaved = await api
      .put('/api/v1/lessons/plans/day', { ...plan, eventIds: [e1], cells: plan.cells })
      .expect(200);
    expect(resaved.body.data.cells).toHaveLength(1);

    const day = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-09`)
      .expect(200);
    expect(day.body.data).toMatchObject({
      isSessionDay: true,
      plan: { notes: 'Focus on consistency' },
    });
    const empty = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-15`)
      .expect(200);
    expect(empty.body.data).toMatchObject({ isSessionDay: false, plan: null });

    const copy = await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10', '2026-03-11', '2026-03-09'],
      })
      .expect(200);
    expect(copy.body.data).toEqual({
      copied: ['2026-03-10', '2026-03-11'],
      skipped: ['2026-03-09'],
    });
    const again = await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10'],
      })
      .expect(200);
    expect(again.body.data.skipped).toEqual(['2026-03-10']);
    const forced = await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10'],
        overwrite: true,
      })
      .expect(200);
    expect(forced.body.data.copied).toEqual(['2026-03-10']);
    await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        fromDate: '2026-04-01',
        toDates: ['2026-04-02'],
      })
      .expect(404);

    const cal = await api
      .get(`/api/v1/lessons/plans?batchId=${batch.id}&from=2026-03-09&to=2026-03-15`)
      .expect(200);
    expect(cal.body.data.days.filter((d: { planId: string | null }) => d.planId)).toHaveLength(3);
    expect(cal.body.data.days[0]).toMatchObject({
      date: '2026-03-09',
      filledCells: 1,
      totalCells: 2,
      isSessionDay: true,
    });
    await api
      .get(`/api/v1/lessons/plans?batchId=${batch.id}&from=2026-03-15&to=2026-03-01`)
      .expect(400);

    // Admin can view; other coaches cannot.
    await (
      await as(admin)
    )
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-09`)
      .expect(200);
    await (
      await as(otherCoach)
    )
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-09`)
      .expect(404);

    await api.delete(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-11`).expect(204);
    const after = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-11`)
      .expect(200);
    expect(after.body.data.plan).toBeNull();

    const overview = await api.get('/api/v1/attendance/overview?date=2026-03-10').expect(200);
    expect(overview.body.data.sessions[0].hasLessonPlan).toBe(true);
  });

  it('rejects stages/events from another batch template and duplicate columns', async () => {
    const { coach, otherCoach, batch, otherBatch } = await makeAcademy();
    const mine = await library(coach as { id: string; role: 'coach' }, batch.id);
    const theirs = await library(otherCoach as { id: string; role: 'coach' }, otherBatch.id);
    const base = {
      batchId: batch.id,
      date: '2026-03-09',
      stageIds: [mine.s1],
      eventIds: [mine.e1],
      cells: [],
    };
    await mine.api.put('/api/v1/lessons/plans/day', { ...base, stageIds: [theirs.s1] }).expect(400);
    await mine.api
      .put('/api/v1/lessons/plans/day', { ...base, stageIds: [mine.s1, mine.s1] })
      .expect(400);
    await mine.api
      .put('/api/v1/lessons/plans/day', { ...base, batchId: otherBatch.id })
      .expect(404);
    await mine.api
      .put('/api/v1/lessons/plans/day', { ...base, stageIds: [], eventIds: [] })
      .expect(200);
    await mine.api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        toBatchId: otherBatch.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10'],
      })
      .expect(404);
  });
});

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
      attendance: { scheduled: 3, present: 1, absent: 1, unmarked: 1 },
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
      attendanceSummary: { scheduled: 3 },
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

describe('lesson plans on non-session days', () => {
  it('skips Sundays and cancelled sessions when copying', async () => {
    setToday('2026-03-09');
    const { coach, batch } = await makeAcademy();
    const api = await as(coach);
    const stage = await api
      .post('/api/v1/lessons/stages', { batchId: batch.id, name: 'Warm-up' })
      .expect(201);
    const event = await api
      .post('/api/v1/lessons/events', { batchId: batch.id, name: 'Footwork' })
      .expect(201);
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [stage.body.data.id],
        eventIds: [event.body.data.id],
        cells: [{ eventId: event.body.data.id, stageId: stage.body.data.id, content: 'Drill' }],
      })
      .expect(200);
    await api
      .post(`/api/v1/batches/${batch.id}/cancellations`, { date: '2026-03-11', reason: 'Rain' })
      .expect(201);
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-11',
        stageIds: [stage.body.data.id],
        eventIds: [event.body.data.id],
        cells: [],
      })
      .expect(422);
    const copy = await api
      .post('/api/v1/lessons/plans/copy', {
        batchId: batch.id,
        fromDate: '2026-03-09',
        toDates: ['2026-03-10', '2026-03-11', '2026-03-15'],
      })
      .expect(200);
    expect(copy.body.data).toEqual({
      copied: ['2026-03-10'],
      skipped: ['2026-03-11', '2026-03-15'],
    });
  });
});
