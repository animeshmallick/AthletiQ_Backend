import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batches, invoices, makeupSessions, studentAttendance } from '../../src/db/schema';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import {
  as,
  checkIn,
  makeBatch,
  makeLocation,
  makePlan,
  makeSport,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

/**
 * main: Mon / Wed / Fri 06:00–08:00 (missed on Wed 11 Mar 2026). evening: Tue / Thu / Sat
 * 17:00–18:00, same coach, ground and sport. "Now" is Thu 12 Mar 2026, 12:00 IST.
 */
async function setup() {
  setToday('2026-02-20');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const other = await makeUser('coach');
  const ground = await makeLocation();
  const sport = await makeSport();
  const plan = await makePlan({ daysPerWeek: 3 });
  const base = {
    feePlanId: plan.id,
    sportId: sport.id,
    courseMonths: 1,
    courseSetOn: '2026-03-10',
  };
  const main = await makeBatch(coach.id, ground.id, { ...base, name: 'Main', weekdays: [1, 3, 5] });
  const evening = await makeBatch(coach.id, ground.id, {
    ...base,
    name: 'Evening',
    weekdays: [2, 4, 6],
    startTime: '17:00:00',
    endTime: '18:00:00',
    capacity: 3,
  });
  const theirs = await makeBatch(other.id, ground.id, {
    ...base,
    name: 'Theirs',
    weekdays: [2, 4, 6],
    startTime: '19:00:00',
    endTime: '20:00:00',
  });
  const away = await makeBatch(coach.id, (await makeLocation()).id, {
    ...base,
    name: 'Away',
    weekdays: [7],
    startTime: '10:00:00',
    endTime: '11:00:00',
  });
  const chess = await makeBatch(coach.id, ground.id, {
    ...base,
    name: 'Chess',
    sportId: (await makeSport('Chess')).id,
    weekdays: [7],
    startTime: '10:00:00',
    endTime: '11:00:00',
  });
  const join = (fullName: string, batchId: string) =>
    makeStudent({ batchId, joiningDate: '2026-03-02', fullName }, admin.id);
  const anya = await join('Anya', main.id);
  const bhavin = await join('Bhavin', main.id);
  await join('Evie', evening.id);
  setToday('2026-03-12');
  const coach$ = await as(coach);
  await coach$
    .post(`/api/v1/batches/${main.id}/cancellations`, { date: '2026-03-11', reason: 'Unwell' })
    .expect(201);
  return {
    admin,
    coach,
    other,
    ground,
    main,
    evening,
    theirs,
    away,
    chess,
    anya,
    bhavin,
    admin$: await as(admin),
    coach$,
    other$: await as(other),
  };
}
/** Moves the clock; sign-ins are renewed for the new day. */
async function goTo(s: Ctx, day: string, time?: string) {
  setToday(day, time);
  s.admin$ = await as(s.admin);
  s.coach$ = await as(s.coach);
  s.other$ = await as(s.other);
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const ROOT = '/api/v1/session-changes/missed';
const DAY = '2026-03-11';
const key = (s: Ctx, studentId: string) => ({ batchId: s.main.id, originalDate: DAY, studentId });
const book = (s: Ctx, studentId: string, extra: object = {}, api = s.coach$) =>
  api.post(`${ROOT}/makeups`, {
    ...key(s, studentId),
    toBatchId: s.evening.id,
    toDate: '2026-03-14',
    ...extra,
  });
const people = async (s: Ctx, api = s.coach$) =>
  (await api.get(`${ROOT}/students?batchId=${s.main.id}&originalDate=${DAY}`).expect(200)).body.data
    .students as {
    fullName: string;
    state: string;
    lapsed: boolean;
    makeup: { id: string; mark: string | null } | null;
  }[];
const open = async (s: Ctx, api = s.coach$) =>
  (await api.get(ROOT).expect(200)).body.data.open.filter(
    (m: { batch: { id: string } }) => m.batch.id === s.main.id,
  );
const mark = (s: Ctx, batchId: string, date: string, records: object[]) =>
  s.admin$.put('/api/v1/attendance/session', { batchId, date, records });
const roster = async (s: Ctx, batchId: string, date: string) =>
  (await s.admin$.get(`/api/v1/attendance/session?batchId=${batchId}&date=${date}`).expect(200))
    .body.data.students as { studentId: string; fullName: string; isMakeup: boolean }[];
const cycleOf = async (s: Ctx, studentId: string) =>
  (await s.admin$.get(`/api/v1/cycles/students/${studentId}`).expect(200)).body.data[0].cycles[0];

describe('making up a missed session student by student', () => {
  it('is cleared only when every student is made up, and counts in their own batch', async () => {
    const s = await setup();
    const bills = (await db.select().from(invoices)).length;
    expect((await open(s))[0]).toMatchObject({ students: 2, pending: 2, booked: 0 });
    await book(s, s.anya.id).expect(201);
    await book(s, s.anya.id).expect(409); // already booked
    expect((await open(s))[0]).toMatchObject({ students: 2, pending: 1, booked: 1 });
    expect(await roster(s, s.evening.id, '2026-03-14')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fullName: 'Anya', isMakeup: true }),
        expect.objectContaining({ fullName: 'Evie', isMakeup: false }),
      ]),
    );
    await book(s, s.bhavin.id).expect(201);
    // Only waiting now: listed, but nothing to do.
    expect((await open(s))[0]).toMatchObject({ pending: 0, booked: 2 });
    const todo = async () =>
      (await tasksFor({ ...s.coach, role: 'coach' } as never)).items.some(
        (t) => t.kind === 'missed-sessions',
      );
    expect(await todo()).toBe(false);
    expect((await cycleOf(s, s.anya.id)).upcoming).toBeGreaterThan(0);

    // Held: one came, one didn't. Both have had their session.
    await goTo(s, '2026-03-14', '13:00:00');
    await checkIn(s.coach.id, s.evening.id, '2026-03-14');
    await mark(s, s.evening.id, '2026-03-14', [
      { studentId: s.anya.id, status: 'present' },
      { studentId: s.bhavin.id, status: 'absent' },
    ]).expect(200);
    expect(await open(s)).toEqual([]);
    expect((await people(s)).map((p) => [p.fullName, p.state, p.makeup?.mark])).toEqual([
      ['Anya', 'made-up', 'present'],
      ['Bhavin', 'made-up', 'absent'],
    ]);
    const c = await cycleOf(s, s.anya.id);
    expect(c).toMatchObject({ conducted: 1, attended: 1, missed: 0 });
    expect(c.sessions.find((x: { date: string }) => x.date === DAY)).toMatchObject({
      state: 'held',
      mark: 'present',
      makeup: { batchName: 'Evening', date: '2026-03-14' },
    });
    expect(await cycleOf(s, s.bhavin.id)).toMatchObject({ conducted: 1, attended: 0, absent: 1 });
    // Counted at home, not in the batch they visited.
    expect((await db.select().from(studentAttendance))[0]!.homeBatchId).toBe(s.main.id);
    const insights = async (id: string) =>
      (await s.admin$.get(`/api/v1/batches/${id}/insights`).expect(200)).body.data;
    expect((await insights(s.evening.id)).summary.attendanceRate).toBeNull();
    const home = (await insights(s.main.id)).roster;
    expect(home.map((r: { attendance: { rate: number } }) => r.attendance.rate)).toEqual([100, 0]);
    const reg = async (id: string) =>
      (
        await s.admin$
          .get(`/api/v1/attendance/register?batchId=${id}&from=2026-03-01&to=2026-03-31`)
          .expect(200)
      ).body.data.students;
    expect(await reg(s.evening.id)).toEqual([]);
    expect((await reg(s.main.id))[0]).toMatchObject({
      fullName: 'Anya',
      marks: { [DAY]: 'present' },
    });
    // Nothing billed, and what happened can't be undone by accident.
    expect((await db.select().from(invoices)).length).toBe(bills);
    const [row] = await db.select().from(makeupSessions);
    await s.coach$.delete(`${ROOT}/makeups/${row!.id}`).expect(409);
    await s.coach$.delete(`/api/v1/students/${row!.studentId}/makeups/${row!.id}`).expect(409);
    await s.coach$.delete(`/api/v1/batches/${s.main.id}/cancellations/${DAY}`).expect(409);
  });

  it('offers a coach only their own batches, same place and sport; admins any coach’s', async () => {
    const s = await setup();
    const options = async (api = s.coach$) =>
      (
        await api
          .get(`${ROOT}/options?batchId=${s.main.id}&originalDate=${DAY}&studentId=${s.anya.id}`)
          .expect(200)
      ).body.data as { batch: { name: string }; date: string }[];
    const mine = await options();
    expect([...new Set(mine.map((o) => o.batch.name))]).toEqual(['Evening']);
    expect(mine[0]!.date).toBe('2026-03-12'); // today, still to start
    expect(mine.at(-1)!.date <= '2026-04-10').toBe(true); // 30 days
    const all = await options(s.admin$);
    expect([...new Set(all.map((o) => o.batch.name))].sort()).toEqual(['Evening', 'Theirs']);
    expect(all.at(-1)!.date > '2026-04-10').toBe(true);

    await book(s, s.anya.id, { toBatchId: s.theirs.id }).expect(422);
    for (const b of [s.away, s.chess])
      await book(s, s.anya.id, { toBatchId: b.id, toDate: '2026-03-15' }, s.admin$).expect(422);
    await book(s, s.anya.id, { toBatchId: s.main.id, toDate: '2026-03-13' }).expect(422); // own batch
    await book(s, s.anya.id, { toDate: '2026-03-10' }).expect(422); // before it
    await book(s, s.anya.id, { toDate: '2026-03-13' }).expect(422); // doesn't run
    await book(s, s.anya.id, { toDate: '2026-04-11' }).expect(422); // past 30 days
    await book(s, s.anya.id, { toDate: '2026-04-11' }, s.admin$).expect(201);
    // Not their batch.
    await book(s, s.bhavin.id, {}, s.other$).expect(404);
    await s.other$.get(`${ROOT}/students?batchId=${s.main.id}&originalDate=${DAY}`).expect(404);
    // A session that wasn't missed.
    await s.coach$
      .post(`${ROOT}/makeups`, {
        ...key(s, s.bhavin.id),
        originalDate: '2026-03-13',
        toBatchId: s.evening.id,
        toDate: '2026-03-14',
      })
      .expect(422);
  });

  it('warns about a full session, and never double-books a student', async () => {
    const s = await setup();
    await db.update(batches).set({ capacity: 1 }).where(eq(batches.id, s.evening.id));
    const full = await book(s, s.anya.id).expect(409);
    expect(full.body.error.details.warnings).toEqual([{ code: 'full' }]);
    await book(s, s.anya.id, { confirm: true }).expect(201);
    // Bhavin also trains then elsewhere.
    const clash = await makeBatch(s.other.id, (await makeLocation()).id, {
      weekdays: [6],
      startTime: '17:30:00',
      endTime: '18:30:00',
      name: 'Clash',
      courseMonths: 1,
    });
    await s.admin$.post(`/api/v1/students/${s.bhavin.id}/batches`, {
      batchId: clash.id,
      joinedOn: '2026-03-12',
      startsOn: '2026-03-12',
    });
    const { enrollments } = await import('../../src/db/schema');
    if (!(await db.select().from(enrollments).where(eq(enrollments.batchId, clash.id))).length)
      await db.insert(enrollments).values({
        studentId: s.bhavin.id,
        batchId: clash.id,
        trainingDays: [6],
        effectiveFrom: '2026-03-12',
        billingStartsOn: '2026-03-12',
      });
    const r = await book(s, s.bhavin.id, { confirm: true }).expect(422);
    expect(r.body.error.message).toContain('Clash');
    // Two at the same moment: one booking.
    const both = await Promise.all([
      book(s, s.bhavin.id, { toDate: '2026-03-17', confirm: true }),
      book(s, s.bhavin.id, { toDate: '2026-03-19', confirm: true }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
  });

  it('brings a student back when their makeup session is cancelled', async () => {
    const s = await setup();
    await book(s, s.anya.id).expect(201);
    await book(s, s.bhavin.id, { toDate: '2026-03-17' }).expect(201);
    await s.coach$
      .post(`/api/v1/batches/${s.evening.id}/cancellations`, {
        date: '2026-03-14',
        reason: 'Rain',
      })
      .expect(201);
    expect((await open(s))[0]).toMatchObject({ pending: 1, booked: 1 });
    expect((await people(s))[0]).toMatchObject({
      fullName: 'Anya',
      state: 'pending',
      lapsed: true,
    });
    await book(s, s.anya.id, { toDate: '2026-03-17' }).expect(201); // replaces it
    expect(await db.select().from(makeupSessions)).toHaveLength(2);
    // Never held either (no check-in, no attendance).
    await goTo(s, '2026-03-18');
    expect((await open(s))[0]).toMatchObject({ pending: 2, booked: 0 });
    // The evening session is rescheduled: whoever is booked moves with it.
    await book(s, s.anya.id, { toDate: '2026-03-19' }).expect(201);
    await s.coach$
      .post(`/api/v1/batches/${s.evening.id}/session-changes`, {
        sessionDate: '2026-03-19',
        date: '2026-03-20',
        startTime: '17:00',
        endTime: '18:00',
        confirm: true,
      })
      .expect(201);
    expect((await roster(s, s.evening.id, '2026-03-20')).map((x) => x.fullName)).toContain('Anya');
    expect((await people(s))[0]).toMatchObject({ state: 'booked' });
    const id = (await people(s))[0]!.makeup!.id;
    await s.other$.delete(`${ROOT}/makeups/${id}`).expect(404);
    await s.coach$.delete(`${ROOT}/makeups/${id}`).expect(204);
    expect((await people(s))[0]).toMatchObject({ state: 'pending', lapsed: false });
  });

  it('reschedules the session for the students left, keeping or releasing bookings', async () => {
    const s = await setup();
    await book(s, s.anya.id).expect(201);
    const move = (body: object) =>
      s.coach$.post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: DAY,
        date: '2026-03-15',
        startTime: '06:00',
        endTime: '08:00',
        confirm: true,
        ...body,
      });
    const preview = (
      await s.coach$.post(`/api/v1/batches/${s.main.id}/session-changes/preview`, {
        sessionDate: DAY,
        date: '2026-03-15',
        startTime: '06:00',
        endTime: '08:00',
      })
    ).body.data;
    expect(preview).toMatchObject({ ok: true, affected: 1, booked: 1 });
    const kept = await move({}).expect(201);
    expect((await roster(s, s.main.id, '2026-03-15')).map((x) => x.fullName)).toEqual(['Bhavin']);
    expect(await open(s)).toEqual([]);
    await s.coach$.post(`/api/v1/session-changes/${kept.body.data.id}/cancel`).expect(200);
    expect((await open(s))[0]).toMatchObject({ pending: 1, booked: 1 });
    await move({ releaseMakeups: true }).expect(201);
    expect((await roster(s, s.main.id, '2026-03-15')).map((x) => x.fullName).sort()).toEqual([
      'Anya',
      'Bhavin',
    ]);
    expect(await db.select().from(makeupSessions)).toEqual([]);
  });

  it('lists a student whose makeup fell through after the session was rescheduled without them', async () => {
    const s = await setup();
    await book(s, s.anya.id, { toDate: '2026-03-17' }).expect(201);
    await s.coach$
      .post(`/api/v1/batches/${s.main.id}/session-changes`, {
        sessionDate: DAY,
        date: '2026-03-15',
        startTime: '06:00',
        endTime: '08:00',
        confirm: true,
      })
      .expect(201);
    await goTo(s, '2026-03-15', '05:00:00');
    await checkIn(s.coach.id, s.main.id, '2026-03-15');
    await mark(s, s.main.id, '2026-03-15', [{ studentId: s.bhavin.id, status: 'present' }]).expect(
      200,
    );
    await goTo(s, '2026-03-18'); // the 17th was never held
    expect((await open(s))[0]).toMatchObject({ makeupOnly: true, students: 1, pending: 1 });
    await book(s, s.bhavin.id, { toDate: '2026-03-19' }).expect(422); // he was there
    await book(s, s.anya.id, { toDate: '2026-03-19' }).expect(201);
    await goTo(s, '2026-03-19', '13:00:00');
    await checkIn(s.coach.id, s.evening.id, '2026-03-19');
    expect(await open(s)).toEqual([]);
    expect(await cycleOf(s, s.anya.id)).toMatchObject({ conducted: 1, attended: 0 });
  });

  it('lets a coach mark a student as not needing it, with a reason, and undo it', async () => {
    const s = await setup();
    await s.coach$.post(`${ROOT}/excuse`, { ...key(s, s.anya.id), reason: '' }).expect(400);
    await s.coach$
      .post(`${ROOT}/excuse`, { ...key(s, s.anya.id), reason: 'Family travelling' })
      .expect(201);
    await book(s, s.anya.id).expect(409);
    expect((await open(s))[0]).toMatchObject({ students: 1, excused: 1 });
    const told = (await s.admin$.get('/api/v1/me/notifications')).body.data.items.map(
      (n: { title: string }) => n.title,
    );
    expect(told).toContainEqual(expect.stringContaining('Anya won’t make up Main'));
    await s.coach$
      .post(`${ROOT}/excuse`, { ...key(s, s.bhavin.id), reason: 'Declined' })
      .expect(201);
    expect(await open(s)).toEqual([]);
    await s.coach$.post(`${ROOT}/unexcuse`, key(s, s.anya.id)).expect(200);
    expect((await open(s))[0]).toMatchObject({ pending: 1, excused: 1 });
    // Restoring the session starts afresh.
    await s.coach$.delete(`/api/v1/batches/${s.main.id}/cancellations/${DAY}`).expect(204);
    await s.coach$
      .post(`/api/v1/batches/${s.main.id}/cancellations`, { date: DAY, reason: 'Unwell again' })
      .expect(201);
    expect((await open(s))[0]).toMatchObject({ pending: 2, excused: 0 });
  });

  it('drops bookings when the student leaves, and stops when the session is closed', async () => {
    const s = await setup();
    await book(s, s.anya.id).expect(201);
    await s.admin$
      .post(`/api/v1/students/${s.anya.id}/leave`, { leftOn: '2026-03-12', reason: 'Moved away' })
      .expect(200);
    expect(await db.select().from(makeupSessions)).toEqual([]);
    await s.admin$
      .post(`${ROOT}/close`, { batchId: s.main.id, date: DAY, reason: 'Holiday' })
      .expect(200);
    await book(s, s.bhavin.id).expect(422);
    expect(await open(s)).toEqual([]);
  });
});
