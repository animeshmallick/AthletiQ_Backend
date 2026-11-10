import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

describe('coach lesson library', () => {
  it('keeps one library per coach, shared by all their batches', async () => {
    const { coach, otherCoach, admin, batch, otherBatch, location } = await makeAcademy();
    const api = await as(coach);
    const B = batch.id;
    const stages = (q = '') => api.get(`/api/v1/lessons/stages?${q}`).expect(200);

    const warm = await api
      .post('/api/v1/lessons/stages', { batchId: B, name: 'Warm-up', durationMin: 10 })
      .expect(201);
    const main = await api.post('/api/v1/lessons/stages', { name: 'Main' }).expect(201);
    expect([warm.body.data.sortOrder, main.body.data.sortOrder]).toEqual([0, 1]);
    expect(warm.body.data).toMatchObject({ batchId: B, coachId: coach.id, durationMin: 10 });
    // Names are unique per coach, across batches.
    const second = await makeBatch(coach.id, location.id, {
      startTime: '09:00:00',
      endTime: '10:00:00',
    });
    await api.post('/api/v1/lessons/stages', { batchId: second.id, name: 'warm-up' }).expect(409);
    await api.post('/api/v1/lessons/stages', { name: 'Bad', color: 'green' }).expect(400);
    await api.post('/api/v1/lessons/stages', { name: 'Long', durationMin: 500 }).expect(400);
    await api.post('/api/v1/lessons/stages', { batchId: otherBatch.id, name: 'X' }).expect(404);
    const drill = await api
      .post('/api/v1/lessons/events', { name: 'Footwork', description: 'Ladder' })
      .expect(201);
    expect(drill.body.data.description).toBe('Ladder');
    // The same library whichever batch is being planned; other coaches have their own.
    expect((await stages(`batchId=${second.id}`)).body.data).toHaveLength(2);
    await (await as(otherCoach)).post('/api/v1/lessons/stages', { name: 'Warm-up' }).expect(201);

    await api
      .put('/api/v1/lessons/stages/order', { ids: [main.body.data.id, warm.body.data.id] })
      .expect(204);
    await api
      .put('/api/v1/lessons/stages/order', { ids: ['6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c'] })
      .expect(400);
    expect((await stages()).body.data.map((s: { name: string }) => s.name)).toEqual([
      'Main',
      'Warm-up',
    ]);

    await api.patch(`/api/v1/lessons/stages/${warm.body.data.id}`, { durationMin: 15 }).expect(200);
    await api
      .patch(`/api/v1/lessons/stages/${warm.body.data.id}`, { isArchived: true })
      .expect(200);
    expect((await stages()).body.data).toHaveLength(1);
    const all = (await stages('includeArchived=true')).body.data;
    expect(all.find((s: { id: string }) => s.id === warm.body.data.id).durationMin).toBe(15);
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

    // Admins read (not edit) the library of a batch's coach.
    const adminApi = await as(admin);
    const viaAdmin = await adminApi.get(`/api/v1/lessons/events?batchId=${B}`).expect(200);
    expect(viaAdmin.body.data[0].name).toBe('Footwork II');
    await adminApi.get('/api/v1/lessons/events').expect(400);
    await adminApi.post('/api/v1/lessons/events', { batchId: B, name: 'Nope' }).expect(403);
  });

  it('copies a plan to another of the coach’s batches with the same items', async () => {
    const { coach, batch, location } = await makeAcademy();
    const api = await as(coach);
    const second = await makeBatch(coach.id, location.id, {
      startTime: '09:00:00',
      endTime: '10:00:00',
    });
    const add = async (kind: string, name: string) =>
      (await api.post(`/api/v1/lessons/${kind}`, { name }).expect(201)).body.data.id as string;
    const s1 = await add('stages', 'Warm-up');
    const e1 = await add('events', 'Serve');
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [s1],
        eventIds: [e1],
        durations: { [s1]: 12 },
        focus: 'Serve consistency',
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
    expect(day.body.data.plan).toMatchObject({
      focus: 'Serve consistency',
      totalMinutes: 12,
      stages: [{ id: s1, minutes: 12 }],
      cells: [{ eventId: e1, stageId: s1, content: 'Shadow serves' }],
    });
  });
});

describe('session minutes, focus and saved plans', () => {
  it('uses the stage default unless the session sets its own minutes', async () => {
    const { coach, batch } = await makeAcademy();
    const api = await as(coach);
    const warm = (
      await api.post('/api/v1/lessons/stages', { name: 'Warm-up', durationMin: 10 }).expect(201)
    ).body.data.id as string;
    const main = (
      await api.post('/api/v1/lessons/stages', { name: 'Main', durationMin: 30 }).expect(201)
    ).body.data.id as string;
    const free = (await api.post('/api/v1/lessons/stages', { name: 'Free play' }).expect(201)).body
      .data.id as string;
    const saved = await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [warm, main, free],
        eventIds: [],
        // Minutes for a stage that isn't in the plan are dropped.
        durations: { [main]: 40, '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c': 5 },
        focus: 'Match play',
        cells: [],
      })
      .expect(200);
    expect(saved.body.data).toMatchObject({
      focus: 'Match play',
      totalMinutes: 50,
      durations: { [main]: 40 },
      stages: [
        { id: warm, minutes: 10, durationMin: 10 },
        { id: main, minutes: 40, durationMin: 30 },
        { id: free, minutes: null },
      ],
    });
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [warm],
        eventIds: [],
        durations: { [warm]: 0 },
        cells: [],
      })
      .expect(400);
  });

  it('counts a plan as done once anything is filled in; an empty one stays pending', async () => {
    const { coach, batch } = await makeAcademy();
    const api = await as(coach);
    const warm = (await api.post('/api/v1/lessons/stages', { name: 'Warm-up' }).expect(201)).body
      .data.id as string;
    const save = (extra: object) =>
      api
        .put('/api/v1/lessons/plans/day', {
          batchId: batch.id,
          date: '2026-03-10',
          stageIds: [warm],
          eventIds: [],
          cells: [],
          ...extra,
        })
        .expect(200);
    const state = async () => {
      const [cal, overview] = await Promise.all([
        api.get(`/api/v1/lessons/plans?batchId=${batch.id}&from=2026-03-10&to=2026-03-10`),
        api.get('/api/v1/attendance/overview?date=2026-03-10'),
      ]);
      return [cal.body.data.days[0].hasContent, overview.body.data.sessions[0].hasLessonPlan];
    };
    await save({});
    expect(await state()).toEqual([false, false]);
    await save({ focus: 'Footwork' });
    expect(await state()).toEqual([true, true]);
    await save({ focus: null, notes: '   ' });
    expect(await state()).toEqual([false, false]);
  });

  it('saves a plan under a name and applies it to many sessions', async () => {
    const { coach, otherCoach, batch, otherBatch, location } = await makeAcademy();
    const api = await as(coach);
    const second = await makeBatch(coach.id, location.id, {
      startTime: '09:00:00',
      endTime: '10:00:00',
    });
    const s1 = (await api.post('/api/v1/lessons/stages', { name: 'Warm-up' }).expect(201)).body.data
      .id as string;
    const e1 = (await api.post('/api/v1/lessons/events', { name: 'Serve' }).expect(201)).body.data
      .id as string;
    await api
      .put('/api/v1/lessons/plans/day', {
        batchId: batch.id,
        date: '2026-03-09',
        stageIds: [s1],
        eventIds: [e1],
        durations: { [s1]: 15 },
        focus: 'Footwork',
        cells: [{ eventId: e1, stageId: s1, content: '' }],
      })
      .expect(200);

    // From a day's plan…
    const fromDay = await api
      .post('/api/v1/lessons/saved', {
        name: 'Footwork day',
        from: { batchId: batch.id, date: '2026-03-09' },
      })
      .expect(201);
    expect(fromDay.body.data).toMatchObject({
      name: 'Footwork day',
      focus: 'Footwork',
      totalMinutes: 15,
      cells: [{ eventId: e1, stageId: s1, content: '' }],
    });
    // …or built directly.
    const built = await api
      .post('/api/v1/lessons/saved', {
        name: 'Quick warm-up',
        stageIds: [s1],
        eventIds: [],
        cells: [],
      })
      .expect(201);
    await api
      .post('/api/v1/lessons/saved', {
        name: 'footwork DAY',
        stageIds: [],
        eventIds: [],
        cells: [],
      })
      .expect(409);
    await api
      .post('/api/v1/lessons/saved', {
        name: 'Missing',
        from: { batchId: batch.id, date: '2026-03-10' },
      })
      .expect(404);
    const theirStage = (
      await (await as(otherCoach)).post('/api/v1/lessons/stages', { name: 'Theirs' }).expect(201)
    ).body.data.id as string;
    await api
      .post('/api/v1/lessons/saved', {
        name: 'Borrowed',
        stageIds: [theirStage],
        eventIds: [],
        cells: [],
      })
      .expect(400);

    const list = await api.get('/api/v1/lessons/saved').expect(200);
    expect(list.body.data.map((p: { name: string }) => p.name)).toEqual([
      'Footwork day',
      'Quick warm-up',
    ]);

    // The whole week, on two batches: Sunday and the other coach's batch are refused / skipped.
    const id = fromDay.body.data.id as string;
    const applied = await api
      .post(`/api/v1/lessons/saved/${id}/apply`, {
        targets: [
          { batchId: batch.id, dates: ['2026-03-09', '2026-03-10', '2026-03-15'] },
          { batchId: second.id, dates: ['2026-03-10'] },
        ],
      })
      .expect(200);
    expect(applied.body.data.copied).toEqual([
      { batchId: batch.id, date: '2026-03-10' },
      { batchId: second.id, date: '2026-03-10' },
    ]);
    expect(applied.body.data.skipped).toEqual(
      expect.arrayContaining([
        { batchId: batch.id, date: '2026-03-15' },
        { batchId: batch.id, date: '2026-03-09' },
      ]),
    );
    const overwritten = await api
      .post(`/api/v1/lessons/saved/${built.body.data.id}/apply`, {
        targets: [{ batchId: batch.id, dates: ['2026-03-09'] }],
        overwrite: true,
      })
      .expect(200);
    expect(overwritten.body.data.copied).toHaveLength(1);
    const day = await api
      .get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-09`)
      .expect(200);
    expect(day.body.data.plan.events).toEqual([]);
    await api
      .post(`/api/v1/lessons/saved/${id}/apply`, {
        targets: [{ batchId: otherBatch.id, dates: ['2026-03-10'] }],
      })
      .expect(404);

    // Only the owner can rename, delete or apply.
    const other = await as(otherCoach);
    await other.patch(`/api/v1/lessons/saved/${id}`, { name: 'Mine now' }).expect(404);
    await other
      .post(`/api/v1/lessons/saved/${id}/apply`, {
        targets: [{ batchId: otherBatch.id, dates: ['2026-03-10'] }],
      })
      .expect(404);
    await api.patch(`/api/v1/lessons/saved/${id}`, { name: 'Footwork focus' }).expect(204);
    await api.delete(`/api/v1/lessons/saved/${built.body.data.id}`).expect(204);
    await other.delete(`/api/v1/lessons/saved/${id}`).expect(404);
    expect((await api.get('/api/v1/lessons/saved').expect(200)).body.data).toMatchObject([
      { name: 'Footwork focus' },
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
    // A blank cell still marks the drill as part of that block.
    expect(saved.body.data.cells).toHaveLength(3);

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

  it('rejects stages/drills from another coach’s library and duplicate columns', async () => {
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
