import { describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { makeupSessions, sessionChanges, sessionPlans } from '../../src/db/schema';
import { expireStale } from '../../src/modules/schedule/session-changes';
import {
  as,
  checkIn,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

/**
 * 2026-03-08 is a Sunday. "today" is 12:00 IST that Sunday unless a test moves the clock.
 * main:      Mon / Wed / Fri 06:00–08:00 (coach)
 * neighbour: Tue / Thu 17:00–19:00 at the same ground (other coach)
 * evening:   the coach's own Tue / Thu 18:00–19:00 batch at another ground
 */
async function setup() {
  setToday('2026-03-08', '06:30:00');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const otherCoach = await makeUser('coach');
  const subCoach = await makeUser('coach');
  const ground = await makeLocation();
  const elsewhere = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3 });
  const plan2 = await makePlan({ daysPerWeek: 2 });
  const main = await makeBatch(coach.id, ground.id, { weekdays: [1, 3, 5], feePlanId: plan.id });
  const neighbour = await makeBatch(otherCoach.id, ground.id, {
    weekdays: [2, 4],
    startTime: '17:00:00',
    endTime: '19:00:00',
    feePlanId: plan2.id,
  });
  const evening = await makeBatch(coach.id, elsewhere.id, {
    weekdays: [2, 4],
    startTime: '18:00:00',
    endTime: '19:00:00',
    feePlanId: plan2.id,
  });
  const student = await makeStudent({ batchId: main.id }, admin.id);
  return {
    admin,
    coach,
    otherCoach,
    subCoach,
    main,
    neighbour,
    evening,
    student,
    admin$: await as(admin),
    coach$: await as(coach),
    other$: await as(otherCoach),
    sub$: await as(subCoach),
  };
}

const sessionsOn = async (api: Awaited<ReturnType<typeof as>>, date: string) =>
  (await api.get(`/api/v1/attendance/overview?date=${date}`).expect(200)).body.data.sessions as {
    batch: { id: string; startTime: string; endTime: string };
    expectedStudents: number;
    origin: { kind: string; originalDate: string | null };
  }[];

describe('rescheduling a session', () => {
  it('moves a session for everyone: overview, roster, attendance, makeups and plan follow it', async () => {
    const s = await setup();
    // A makeup booked into Wednesday's session, and Wednesday's own lesson plan.
    const visitor = await makeStudent({ batchId: s.neighbour.id }, s.admin.id);
    await s.admin$
      .post(`/api/v1/students/${visitor.id}/makeups`, { batchId: s.main.id, date: '2026-03-11' })
      .expect(201);
    await db.insert(sessionPlans).values({
      batchId: s.main.id,
      date: '2026-03-11',
      blocks: [{ name: 'Warm-up', color: null, minutes: 120, drills: [] }],
      coachId: s.coach.id,
    });

    const body = {
      sessionDate: '2026-03-11',
      date: '2026-03-12',
      startTime: '07:00',
      endTime: '09:00',
      reason: 'Ground booked for an event',
    };
    const preview = (
      await s.admin$.post(`/api/v1/batches/${s.main.id}/session-changes/preview`, body).expect(200)
    ).body.data;
    expect(preview).toMatchObject({
      ok: true,
      errors: [],
      kind: 'reschedule',
      originalDate: '2026-03-11',
      needsApproval: false,
    });
    const res = await s.admin$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, body)
      .expect(201);
    expect(res.body.data).toMatchObject({
      kind: 'reschedule',
      status: 'approved',
      originalDate: '2026-03-11',
      date: '2026-03-12',
      startTime: '07:00:00',
      from: { date: '2026-03-11', startTime: '06:00:00', endTime: '08:00:00' },
    });

    expect((await sessionsOn(s.admin$, '2026-03-11')).map((x) => x.batch.id)).not.toContain(
      s.main.id,
    );
    const thu = (await sessionsOn(s.admin$, '2026-03-12')).find((x) => x.batch.id === s.main.id)!;
    expect(thu).toMatchObject({
      batch: { startTime: '07:00:00', endTime: '09:00:00' },
      origin: { kind: 'moved', originalDate: '2026-03-11' },
      expectedStudents: 2, // the student + the makeup visitor
    });

    const session = (
      await s.coach$.get(`/api/v1/attendance/session?batchId=${s.main.id}&date=2026-03-12`)
    ).body.data;
    expect(session).toMatchObject({ isScheduledDay: true, origin: { kind: 'moved' } });
    expect(session.students.map((x: { studentId: string }) => x.studentId).sort()).toEqual(
      [s.student.id, visitor.id].sort(),
    );
    const old = (
      await s.coach$.get(`/api/v1/attendance/session?batchId=${s.main.id}&date=2026-03-11`)
    ).body.data;
    expect(old).toMatchObject({ isScheduledDay: false, students: [] });

    const makeups = await db
      .select()
      .from(makeupSessions)
      .where(eq(makeupSessions.batchId, s.main.id));
    expect(makeups.map((m) => m.date)).toEqual(['2026-03-12']);
    const plans = await db.select().from(sessionPlans).where(eq(sessionPlans.batchId, s.main.id));
    expect(plans.map((p) => p.date)).toEqual(['2026-03-12']);
    const lesson = (
      await s.coach$.get(`/api/v1/lessons/session?batchId=${s.main.id}&date=2026-03-11`)
    ).body.data;
    expect(lesson.lockedReason).toBe('This session was moved to 2026-03-12.');
    const moved = (
      await s.coach$.get(`/api/v1/lessons/session?batchId=${s.main.id}&date=2026-03-12`)
    ).body.data;
    expect(moved).toMatchObject({ lockedReason: null, minutes: 120, source: 'session' });

    // Register lists the new day and marks it as moved.
    const reg = (
      await s.admin$
        .get(`/api/v1/attendance/register?batchId=${s.main.id}&from=2026-03-09&to=2026-03-15`)
        .expect(200)
    ).body.data;
    expect(reg.dates).toEqual(['2026-03-09', '2026-03-12', '2026-03-13']);
    expect(reg.origins['2026-03-12']).toMatchObject({ kind: 'moved', originalDate: '2026-03-11' });

    // On the day: check-in at the new time, attendance on the new day only.
    setToday('2026-03-12', '01:40:00'); // 07:10 IST
    s.coach$ = await as(s.coach); // fresh tokens at the new time
    s.admin$ = await as(s.admin);
    const today = (await s.coach$.get('/api/v1/coach-sessions/today').expect(200)).body.data;
    expect(today.sessions[0]).toMatchObject({
      batch: { id: s.main.id, startTime: '07:00:00' },
      origin: { kind: 'moved' },
    });
    await s.coach$
      .post('/api/v1/coach-sessions/check-in', {
        batchId: s.main.id,
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 5,
      })
      .expect(200);
    await s.coach$
      .put('/api/v1/attendance/session', {
        batchId: s.main.id,
        date: '2026-03-12',
        records: [{ studentId: s.student.id, status: 'present' }],
      })
      .expect(200);
    // A started / recorded session can't move or be reverted any more.
    await s.admin$.post(`/api/v1/session-changes/${res.body.data.id}/cancel`).expect(409);
  });

  it('lets a coach move with 24 h notice straight away, and waits for an admin otherwise', async () => {
    const s = await setup();
    const now = await s.coach$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-13',
        date: '2026-03-14',
        startTime: '06:00',
        endTime: '08:00',
      })
      .expect(201);
    expect(now.body.data.status).toBe('approved');

    // Monday is 18 h away → pending, nothing changes yet.
    const ask = await s.coach$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-09',
        date: '2026-03-10',
        startTime: '06:00',
        endTime: '08:00',
        reason: 'Rain forecast',
      })
      .expect(201);
    expect(ask.body.data.status).toBe('pending');
    expect((await sessionsOn(s.admin$, '2026-03-09')).map((x) => x.batch.id)).toContain(s.main.id);
    // A second request for the same session, or the same day, is refused.
    await s.coach$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-09',
        date: '2026-03-08',
        startTime: '17:00',
        endTime: '18:00',
      })
      .expect(422);

    const tasks = (await s.admin$.get('/api/v1/me/tasks').expect(200)).body.data;
    expect(tasks.items.map((t: { kind: string }) => t.kind)).toContain('reschedule-requests');
    const list = (await s.admin$.get('/api/v1/session-changes?status=pending').expect(200)).body
      .data;
    expect(list.map((r: { id: string }) => r.id)).toEqual([ask.body.data.id]);
    // Coaches can't approve; the other coach doesn't even see it.
    await s.coach$.post(`/api/v1/session-changes/${ask.body.data.id}/approve`).expect(403);
    const theirs = (await s.other$.get('/api/v1/session-changes').expect(200)).body.data;
    expect(theirs).toEqual([]);

    // Admin approves: in effect.
    const ok = await s.admin$
      .post(`/api/v1/session-changes/${ask.body.data.id}/approve`, { note: 'Fine' })
      .expect(200);
    expect(ok.body.data).toMatchObject({ status: 'approved', reviewNote: 'Fine' });
    expect((await sessionsOn(s.admin$, '2026-03-09')).map((x) => x.batch.id)).not.toContain(
      s.main.id,
    );
    await s.admin$.post(`/api/v1/session-changes/${ask.body.data.id}/approve`).expect(409);
    await s.admin$.post(`/api/v1/session-changes/${ask.body.data.id}/reject`).expect(409);
  });

  it('can be rejected, withdrawn, and expires when the session starts', async () => {
    const s = await setup();
    const ask = (date: string, sessionDate = '2026-03-09') =>
      s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          sessionDate,
          date,
          startTime: '07:00',
          endTime: '08:00',
        })
        .expect(201);
    const a = (await ask('2026-03-10')).body.data;
    const rejected = await s.admin$
      .post(`/api/v1/session-changes/${a.id}/reject`, { note: 'No ground' })
      .expect(200);
    expect(rejected.body.data.status).toBe('rejected');

    const b = (await ask('2026-03-10')).body.data;
    await s.other$.post(`/api/v1/session-changes/${b.id}/cancel`).expect(404);
    expect(
      (await s.coach$.post(`/api/v1/session-changes/${b.id}/cancel`).expect(200)).body.data.status,
    ).toBe('cancelled');
    await s.coach$.post(`/api/v1/session-changes/${b.id}/cancel`).expect(409);

    const c = (await ask('2026-03-10')).body.data;
    expect(await expireStale(new Date('2026-03-09T00:00:00Z'))).toBe(0); // 05:30 IST
    expect(await expireStale(new Date('2026-03-09T00:30:00Z'))).toBe(1); // 06:00 IST: started
    const row = await db.query.sessionChanges.findFirst({ where: eq(sessionChanges.id, c.id) });
    expect(row!.status).toBe('expired');
  });

  it('blocks impossible moves', async () => {
    const s = await setup();
    const post = (body: Record<string, unknown>, api = s.admin$) =>
      api.post(`/api/v1/batches/${s.main.id}/session-changes/preview`, {
        sessionDate: '2026-03-11',
        startTime: '07:00',
        endTime: '08:00',
        ...body,
      });
    const errors = async (body: Record<string, unknown>, api = s.admin$) =>
      (await post(body, api).expect(200)).body.data.errors as string[];

    expect(await errors({ date: '2026-03-13' })).toEqual([
      expect.stringContaining('already runs on'),
    ]);
    expect(await errors({ date: '2026-03-26' })).toEqual([
      'A session can move up to 14 days from its regular day.',
    ]);
    expect(await errors({ date: '2026-03-07' })).toContain('Choose a time in the future.');
    expect(await errors({ date: '2026-03-12', startTime: '09:00', endTime: '08:00' })).toContain(
      'The session must end after it starts.',
    );
    expect(await errors({ date: '2026-03-11', startTime: '06:00', endTime: '08:00' })).toEqual([
      'That is when the session already runs.',
    ]);
    // The coach has their evening batch Thu 18:00–19:00.
    expect(await errors({ date: '2026-03-12', startTime: '17:30', endTime: '18:30' })).toEqual([
      expect.stringContaining(`already coaches ${s.evening.name}`),
    ]);
    expect(
      await errors({ date: '2026-03-12', startTime: '17:30', endTime: '18:30' }, s.coach$),
    ).toEqual([expect.stringContaining(`You already coach ${s.evening.name}`)]);
    // No session that day at all.
    await post({ sessionDate: '2026-03-10', date: '2026-03-12' }).expect(422);
    // Only the batch's people.
    await post({ date: '2026-03-12' }, s.other$).expect(404);

    // Cancelled sessions and sessions that happened stay put.
    await s.admin$
      .post(`/api/v1/batches/${s.main.id}/cancellations`, {
        date: '2026-03-11',
        reason: 'Holiday',
      })
      .expect(201);
    expect(await errors({ date: '2026-03-12' })).toEqual([
      'This session was cancelled. Restore it before moving it.',
    ]);
    setToday('2026-03-09', '02:00:00'); // 07:30 IST Monday
    s.admin$ = await as(s.admin);
    expect(
      await errors({
        sessionDate: '2026-03-09',
        date: '2026-03-10',
        startTime: '10:00',
        endTime: '11:00',
      }),
    ).toContain('This session has already started.');
    setToday('2026-03-09', '00:00:00'); // 05:30 IST
    s.admin$ = await as(s.admin);
    await checkIn(s.coach.id, s.main.id, '2026-03-09');
    expect(
      await errors({
        sessionDate: '2026-03-09',
        date: '2026-03-10',
        startTime: '10:00',
        endTime: '11:00',
      }),
    ).toEqual(['Attendance or a check-in is already recorded for this session.']);
    // Creating runs the same checks.
    await s.admin$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-09',
        date: '2026-03-10',
        startTime: '10:00',
        endTime: '11:00',
      })
      .expect(422);
  });

  it('warns about a shared ground and busy students, and goes ahead once confirmed', async () => {
    const s = await setup();
    // The student also trains in the neighbour batch (Tue/Thu 17–19).
    const both = await makeStudent(
      { batchId: s.main.id, batches: [{ batchId: s.main.id }, { batchId: s.neighbour.id }] },
      s.admin.id,
    );
    const body = {
      sessionDate: '2026-03-11',
      date: '2026-03-12',
      startTime: '16:30',
      endTime: '17:30',
    };
    const preview = (
      await s.admin$.post(`/api/v1/batches/${s.main.id}/session-changes/preview`, body).expect(200)
    ).body.data;
    expect(preview.ok).toBe(true);
    expect(preview.warnings).toEqual([
      expect.objectContaining({
        code: 'location-overlap',
        batches: [{ id: s.neighbour.id, name: s.neighbour.name }],
      }),
      expect.objectContaining({
        code: 'students-busy',
        message: '1 student has another batch then.',
        students: [expect.objectContaining({ id: both.id, batchName: s.neighbour.name })],
      }),
    ]);
    const refused = await s.admin$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, body)
      .expect(409);
    expect(refused.body.error.details.warnings).toHaveLength(2);
    await s.admin$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, { ...body, confirm: true })
      .expect(201);
  });

  it('moves a moved session again, and reverts it to its usual day', async () => {
    const s = await setup();
    const visitor = await makeStudent({ batchId: s.neighbour.id }, s.admin.id);
    await s.admin$
      .post(`/api/v1/students/${visitor.id}/makeups`, { batchId: s.main.id, date: '2026-03-11' })
      .expect(201);
    const first = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          sessionDate: '2026-03-11',
          date: '2026-03-12',
          startTime: '06:00',
          endTime: '08:00',
        })
        .expect(201)
    ).body.data;
    // Move it again (by its current day): the first change steps aside.
    const second = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          sessionDate: '2026-03-12',
          date: '2026-03-14',
          startTime: '09:00',
          endTime: '11:00',
        })
        .expect(201)
    ).body.data;
    expect(second).toMatchObject({ status: 'approved', originalDate: '2026-03-11' });
    const firstNow = await db.query.sessionChanges.findFirst({
      where: eq(sessionChanges.id, first.id),
    });
    expect(firstNow!.status).toBe('cancelled');
    const md = async () =>
      (
        await db
          .select({ date: makeupSessions.date })
          .from(makeupSessions)
          .where(eq(makeupSessions.batchId, s.main.id))
      ).map((m) => m.date);
    expect(await md()).toEqual(['2026-03-14']);

    // Back to Wednesday 06:00.
    await s.coach$.post(`/api/v1/session-changes/${second.id}/cancel`).expect(200);
    expect(await md()).toEqual(['2026-03-11']);
    const wed = (await sessionsOn(s.admin$, '2026-03-11')).find((x) => x.batch.id === s.main.id);
    expect(wed).toMatchObject({ origin: { kind: 'regular' }, batch: { startTime: '06:00:00' } });

    // A same-day time change.
    const later = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          sessionDate: '2026-03-11',
          date: '2026-03-11',
          startTime: '16:00',
          endTime: '18:00',
        })
        .expect(201)
    ).body.data;
    expect(later).toMatchObject({ originalDate: '2026-03-11', date: '2026-03-11' });
    const wed2 = (await sessionsOn(s.admin$, '2026-03-11')).find((x) => x.batch.id === s.main.id);
    expect(wed2).toMatchObject({ origin: { kind: 'moved' }, batch: { startTime: '16:00:00' } });
    // Close to the session, a coach can't move a moved session again.
    setToday('2026-03-10', '12:00:00'); // Tue 17:30 IST, < 24 h before Wed 16:00
    s.coach$ = await as(s.coach);
    s.admin$ = await as(s.admin);
    const late = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes/preview`, {
          sessionDate: '2026-03-11',
          date: '2026-03-12',
          startTime: '06:00',
          endTime: '08:00',
        })
        .expect(200)
    ).body.data;
    expect(late.errors).toEqual([expect.stringContaining('ask an admin')]);
    // …but an admin can.
    await s.admin$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-11',
        date: '2026-03-12',
        startTime: '06:00',
        endTime: '08:00',
      })
      .expect(201);
  });

  it('adds extra sessions that every member attends', async () => {
    const s = await setup();
    const extra = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          date: '2026-03-15',
          startTime: '08:00',
          endTime: '10:00',
          reason: 'Makeup for the rain-out',
        })
        .expect(201)
    ).body.data;
    expect(extra).toMatchObject({ kind: 'extra', status: 'approved', originalDate: null });
    const sun = (await sessionsOn(s.admin$, '2026-03-15')).find((x) => x.batch.id === s.main.id)!;
    expect(sun).toMatchObject({ origin: { kind: 'extra' }, expectedStudents: 1 });
    // Not on a day the batch runs, nor twice on a day, nor too far ahead.
    const bad = (date: string) =>
      s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes/preview`, {
          date,
          startTime: '08:00',
          endTime: '10:00',
        })
        .expect(200);
    expect((await bad('2026-03-16')).body.data.errors[0]).toContain('already runs on');
    expect((await bad('2026-03-15')).body.data.errors[0]).toContain('already has a moved or extra');
    expect((await bad('2026-06-01')).body.data.errors[0]).toContain('up to 60 days ahead');

    // A makeup booked into it keeps it from being dropped.
    const visitor = await makeStudent({ batchId: s.neighbour.id }, s.admin.id);
    await s.admin$
      .post(`/api/v1/students/${visitor.id}/makeups`, { batchId: s.main.id, date: '2026-03-15' })
      .expect(201);
    await s.coach$.post(`/api/v1/session-changes/${extra.id}/cancel`).expect(409);
    await db
      .delete(makeupSessions)
      .where(and(eq(makeupSessions.batchId, s.main.id), eq(makeupSessions.date, '2026-03-15')));
    await s.coach$.post(`/api/v1/session-changes/${extra.id}/cancel`).expect(200);
    expect((await sessionsOn(s.admin$, '2026-03-15')).map((x) => x.batch.id)).not.toContain(
      s.main.id,
    );
    // Cancelling a closed change again.
    await s.coach$.post(`/api/v1/session-changes/${extra.id}/cancel`).expect(409);
  });

  it('lets a substitute for the day move it; the batch list shows changes', async () => {
    const s = await setup();
    await s.admin$
      .post('/api/v1/substitutions', {
        batchId: s.main.id,
        substituteCoachId: s.subCoach.id,
        fromDate: '2026-03-11',
        toDate: '2026-03-12',
      })
      .expect(201);
    await s.sub$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-13',
        date: '2026-03-14',
        startTime: '06:00',
        endTime: '08:00',
      })
      .expect(404);
    const moved = await s.sub$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: '2026-03-11',
        date: '2026-03-12',
        startTime: '06:00',
        endTime: '08:00',
      })
      .expect(201);
    expect(moved.body.data.requestedBy.id).toBe(s.subCoach.id);
    const list = (await s.coach$.get(`/api/v1/batches/${s.main.id}/session-changes`).expect(200))
      .body.data;
    expect(list).toHaveLength(1);
    await s.other$.get(`/api/v1/batches/${s.main.id}/session-changes`).expect(404);
    const mine = (await s.sub$.get('/api/v1/session-changes').expect(200)).body.data;
    expect(mine).toHaveLength(1);
  });
});

describe('session change approvals and edges', () => {
  it('approves a short-notice extra session, re-checking it at approval time', async () => {
    const s = await setup();
    setToday('2026-03-09', '02:30:00'); // Mon 08:00 IST: Tue 06:00 is 22 h away
    s.coach$ = await as(s.coach);
    s.admin$ = await as(s.admin);
    const ask = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          date: '2026-03-10',
          startTime: '06:00',
          endTime: '07:00',
        })
        .expect(201)
    ).body.data;
    expect(ask).toMatchObject({ kind: 'extra', status: 'pending' });
    const list = (
      await s.admin$.get(`/api/v1/session-changes?status=pending&batchId=${s.main.id}`).expect(200)
    ).body.data;
    expect(list).toHaveLength(1);
    const ok = await s.admin$.post(`/api/v1/session-changes/${ask.id}/approve`).expect(200);
    expect(ok.body.data.status).toBe('approved');
    // Unknown ids.
    const none = '00000000-0000-0000-0000-000000000000';
    await s.admin$.post(`/api/v1/session-changes/${none}/approve`).expect(404);
    await s.admin$.post(`/api/v1/session-changes/${none}/reject`).expect(404);
    await s.admin$.post(`/api/v1/session-changes/${none}/cancel`).expect(404);
  });

  it('refuses approval when the coach got busy meanwhile', async () => {
    const s = await setup();
    setToday('2026-03-09', '02:30:00'); // Mon 08:00 IST
    s.coach$ = await as(s.coach);
    s.admin$ = await as(s.admin);
    const ask = (
      await s.coach$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          date: '2026-03-10',
          startTime: '06:00',
          endTime: '07:00',
        })
        .expect(201)
    ).body.data;
    expect(ask.status).toBe('pending');
    // Meanwhile the coach is given a Tuesday-morning batch at that time.
    await makeBatch(s.coach.id, (await makeLocation()).id, {
      weekdays: [2],
      startTime: '06:00:00',
      endTime: '07:00:00',
      feePlanId: (await makePlan({ daysPerWeek: 1 })).id,
    });
    const res = await s.admin$.post(`/api/v1/session-changes/${ask.id}/approve`);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('already coaches');
  });

  it('can’t revert once the regular time has passed', async () => {
    const s = await setup();
    // Move Mon 9 Mar to Tue 10 Mar 10:00; on Mon at 07:00 the regular 06:00 has gone.
    const moved = (
      await s.admin$
        .post(`/api/v1/batches/${s.main.id}/session-changes`, {
          sessionDate: '2026-03-09',
          date: '2026-03-10',
          startTime: '10:00',
          endTime: '11:00',
        })
        .expect(201)
    ).body.data;
    setToday('2026-03-09', '01:30:00');
    const admin$ = await as(s.admin);
    const res = await admin$.post(`/api/v1/session-changes/${moved.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('regular time has passed');
  });
});
