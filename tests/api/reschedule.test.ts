import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batchCycles, sessionPlans } from '../../src/db/schema';
import { runSessionAlerts } from '../../src/jobs/alerts';
import { sendSessionReminders } from '../../src/jobs/session-reminders';
import { setPushSender } from '../../src/modules/push/push.service';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import {
  as,
  bookMakeup,
  checkIn,
  makeBatch,
  makeLocation,
  makePlan,
  makeStudent,
  makeUser,
  setToday,
} from '../helpers/factories';

/**
 * main: Mon / Wed / Fri 06:00–08:00. Anya's month runs 2 Mar–1 Apr, Bhavin's 20 Feb–19 Mar.
 * "Now" is Tue 10 Mar 2026, 12:00 IST unless a test moves it.
 */
async function setup(now = '2026-03-10') {
  setToday('2026-02-20');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const sub = await makeUser('coach');
  const ground = await makeLocation();
  const plan = await makePlan({ daysPerWeek: 3 });
  const main = await makeBatch(coach.id, ground.id, {
    weekdays: [1, 3, 5],
    feePlanId: plan.id,
    courseMonths: 1,
    courseSetOn: '2026-02-20',
  });
  const anya = await makeStudent(
    { batchId: main.id, joiningDate: '2026-03-02', fullName: 'Anya' },
    admin.id,
  );
  const bhavin = await makeStudent(
    { batchId: main.id, joiningDate: '2026-02-20', fullName: 'Bhavin' },
    admin.id,
  );
  setToday(now);
  return {
    admin,
    coach,
    sub,
    ground,
    plan,
    main,
    anya,
    bhavin,
    admin$: await as(admin),
    coach$: await as(coach),
    sub$: await as(sub),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const cancel = (s: Ctx, date: string, api = s.coach$) =>
  api
    .post(`/api/v1/batches/${s.main.id}/cancellations`, { date, reason: 'Coach unwell' })
    .expect(201);
const change = (s: Ctx, body: object, api = s.coach$) =>
  api.post(`/api/v1/batches/${s.main.id}/session-changes`, {
    startTime: '06:00',
    endTime: '08:00',
    ...body,
  });
const overview = async (s: Ctx, date: string) =>
  (await s.admin$.get(`/api/v1/attendance/overview?date=${date}`).expect(200)).body.data.sessions;

describe('rescheduling', () => {
  it('coach: a missed session, at once, with admins told; the roster and cycle stay the original’s', async () => {
    const s = await setup();
    await change(s, { date: '2026-03-15' }).expect(422); // extras are for admins
    await db.insert(sessionPlans).values({ batchId: s.main.id, date: '2026-03-11', blocks: [] });
    await cancel(s, '2026-03-11');
    const late = await makeStudent({ batchId: s.main.id, joiningDate: '2026-03-12' }, s.admin.id);
    const r = await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(201);
    expect(r.body.data).toMatchObject({ originalDate: '2026-03-11', date: '2026-03-12' });
    const [session] = (await overview(s, '2026-03-12')).filter(
      (x: { batch: { id: string } }) => x.batch.id === s.main.id,
    );
    expect(session).toMatchObject({
      cancelled: null,
      expectedStudents: 2,
      origin: { kind: 'moved' },
    });
    expect(await overview(s, '2026-03-11')).toEqual([]);
    expect((await db.select().from(sessionPlans)).map((p) => p.date)).toEqual(['2026-03-12']);
    const titles = (await s.admin$.get('/api/v1/me/notifications')).body.data.items.map(
      (n: { title: string }) => n.title,
    );
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringContaining('is cancelled'),
        expect.stringContaining('Session rescheduled'),
      ]),
    );
    // The cancellation can't be lifted while it runs elsewhere.
    await s.coach$.delete(`/api/v1/batches/${s.main.id}/cancellations/2026-03-11`).expect(409);
    void late;
    // Held on the new day: counts for the original's cycle.
    await checkIn(s.coach.id, s.main.id, '2026-03-12');
    const hist = (await s.admin$.get(`/api/v1/cycles/students/${s.anya.id}`)).body.data;
    expect(hist[0].cycles[0].sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-03-12', originalDate: '2026-03-11', state: 'held' }),
      ]),
    );
    await s.coach$.post(`/api/v1/session-changes/${r.body.data.id}/cancel`).expect(409);
  });

  it('held after the month: settles the old cycle, is extra to the new one', async () => {
    const s = await setup('2026-03-18');
    await cancel(s, '2026-03-18', s.admin$);
    const r = await change(s, { sessionDate: '2026-03-18', date: '2026-03-21' });
    expect(r.status).toBe(409);
    expect(r.body.error.details.warnings[0]).toMatchObject({
      code: 'outside-window',
      students: [{ fullName: 'Bhavin' }],
    });
    await change(s, { sessionDate: '2026-03-18', date: '2026-03-21', confirm: true }).expect(201);
    await checkIn(s.coach.id, s.main.id, '2026-03-21');
    setToday('2026-03-22');
    const { renewCycles } = await import('../../src/modules/cycles/cycles');
    await renewCycles('2026-03-22');
    const hist = (await (await as(s.admin)).get(`/api/v1/cycles/students/${s.bhavin.id}`)).body
      .data;
    const on = (round: number) =>
      hist[0].cycles
        .find((c: { roundNo: number }) => c.roundNo === round)
        .sessions.map((x: { date: string }) => x.date);
    expect(on(1)).toContain('2026-03-21');
    expect(on(2)).not.toContain('2026-03-21');
    expect(await db.$count(batchCycles, eq(batchCycles.studentId, s.bhavin.id))).toBe(2);
  });

  it('30 days for coaches, longer for admins; never twice in a day, never with the coach busy', async () => {
    const s = await setup();
    await makeBatch(s.coach.id, (await makeLocation()).id, {
      weekdays: [4],
      startTime: '07:00:00',
      endTime: '09:00:00',
      feePlanId: s.plan.id,
    });
    await cancel(s, '2026-03-11');
    const msg = async (body: object, api = s.coach$) =>
      (await change(s, { sessionDate: '2026-03-11', ...body }, api)).body.error?.message as string;
    expect(await msg({ date: '2026-03-13' })).toContain('already runs');
    expect(await msg({ date: '2026-03-12' })).toContain('The coach already has');
    expect(await msg({ date: '2026-03-10', startTime: '05:00' })).toContain('after the missed');
    expect(await msg({ date: '2026-04-12' })).toContain('Ask an admin for a later day');
    expect(await msg({ date: '2026-07-12' }, s.admin$)).toContain('within 90 days');
    expect(await msg({ date: '2026-03-11', startTime: '18:00', endTime: '19:00' })).toContain(
      'after the missed',
    );
    expect(await msg({ date: '2026-03-14', endTime: '05:00' })).toContain('end after');
    await change(
      s,
      { sessionDate: '2026-03-11', date: '2026-04-12', confirm: true },
      s.admin$,
    ).expect(201);
    await cancel(s, '2026-03-20');
    expect(
      (await change(s, { sessionDate: '2026-03-20', date: '2026-04-12' })).body.error.message,
    ).toContain('already has a session');
    await change(s, { sessionDate: '2026-03-12', date: '2026-03-14' }).expect(422);
    await s.sub$.get(`/api/v1/batches/${s.main.id}/smart-dates?sessionDate=2026-03-20`).expect(404);
  });

  it('missed again: keeps its original date; the old day is left clean', async () => {
    const s = await setup();
    await cancel(s, '2026-03-11');
    const a = (await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(201)).body
      .data;
    await cancel(s, '2026-03-12');
    const b = (await change(s, { sessionDate: '2026-03-12', date: '2026-03-14' }).expect(201)).body
      .data;
    expect(b.originalDate).toBe('2026-03-11');
    await s.coach$.post(`/api/v1/session-changes/${a.id}/cancel`).expect(409);
    // Undo: missed again on its original day; the 12th isn't left cancelled.
    await s.coach$.post(`/api/v1/session-changes/${b.id}/cancel`).expect(200);
    const back = (await overview(s, '2026-03-11'))[0];
    expect(back).toMatchObject({ cancelled: 'Coach unwell' });
    await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(201);
    expect((await overview(s, '2026-03-12'))[0]).toMatchObject({ cancelled: null });
  });

  it('coach: moves an upcoming session in advance, again, and back; admins are told', async () => {
    const s = await setup();
    const m = (await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(201)).body
      .data;
    expect(await overview(s, '2026-03-11')).toEqual([]);
    expect((await overview(s, '2026-03-12'))[0]).toMatchObject({
      cancelled: null,
      expectedStudents: 2,
      origin: { kind: 'moved', originalDate: '2026-03-11' },
    });
    const notes = (await s.admin$.get('/api/v1/me/notifications')).body.data.items;
    expect(notes[0]).toMatchObject({
      title: expect.stringContaining('Session rescheduled'),
      body: expect.stringContaining(s.coach.name),
    });
    // Nothing is missed, and it can move again within 30 days of its own date.
    const open = (await s.coach$.get('/api/v1/session-changes/missed').expect(200)).body.data.open;
    expect(open).toEqual([]);
    const far = await change(s, { sessionDate: '2026-03-12', date: '2026-04-11', confirm: true });
    expect(far.body.error.message).toContain('Ask an admin for a later day');
    const again = (await change(s, { sessionDate: '2026-03-12', date: '2026-03-14' }).expect(201))
      .body.data;
    await s.coach$.post(`/api/v1/session-changes/${m.id}/cancel`).expect(409);
    await s.coach$.post(`/api/v1/session-changes/${again.id}/cancel`).expect(200);
    expect((await overview(s, '2026-03-11'))[0]).toMatchObject({ origin: { kind: 'regular' } });
    expect(
      (await change(s, { sessionDate: '2026-03-11', date: '2026-03-13' })).body.error.message,
    ).toContain('already runs');
    await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }, s.sub$).expect(404);
    // Recorded or started: it stays put.
    await checkIn(s.coach.id, s.main.id, '2026-03-11');
    await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(422);
    setToday('2026-03-13', '06:30:00');
    const late = await (
      await as(s.coach)
    ).post(`/api/v1/batches/${s.main.id}/session-changes`, {
      sessionDate: '2026-03-13',
      date: '2026-03-14',
      startTime: '06:00',
      endTime: '08:00',
    });
    expect(late.body.error.message).toContain('already started');
  });

  it('a move and a check-in at the same moment: only one wins', async () => {
    const s = await setup('2026-03-11');
    setToday('2026-03-11', '00:20:00'); // 05:50 IST
    const c = await as(s.coach);
    const [move, visit] = await Promise.all([
      change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }, c),
      c.post('/api/v1/coach-sessions/check-in', {
        batchId: s.main.id,
        latitude: 12.9716,
        longitude: 77.5946,
      }),
    ]);
    expect([move.status === 201, visit.status === 200].filter(Boolean)).toHaveLength(1);
  });

  it('a rescheduled missed session can’t be moved back onto its cancelled day', async () => {
    const s = await setup();
    await cancel(s, '2026-03-13');
    await change(s, { sessionDate: '2026-03-13', date: '2026-03-14' }).expect(201);
    const r = await change(s, { sessionDate: '2026-03-14', date: '2026-03-13' });
    expect(r.body.error.message).toContain('Undo the reschedule');
  });

  it('admins can move a session in advance and add extras; coaches can’t undo those', async () => {
    const s = await setup();
    const m = (
      await change(s, { sessionDate: '2026-03-13', date: '2026-03-14' }, s.admin$).expect(201)
    ).body.data;
    const x = (await change(s, { date: '2026-03-15' }, s.admin$).expect(201)).body.data;
    expect((await overview(s, '2026-03-15'))[0]).toMatchObject({ expectedStudents: 2 });
    await s.coach$.post(`/api/v1/session-changes/${m.id}/cancel`).expect(403);
    expect(
      (await change(s, { sessionDate: '2026-03-14', date: '2026-03-21', confirm: true })).body.error
        .message,
    ).toContain('Someone else moved');
    await s.coach$.post(`/api/v1/session-changes/${x.id}/cancel`).expect(404);
    expect(
      (await s.coach$.get(`/api/v1/batches/${s.main.id}/session-changes`).expect(200)).body.data,
    ).toHaveLength(2);
    await s.sub$.get(`/api/v1/batches/${s.main.id}/session-changes`).expect(404);
    await change(s, { sessionDate: '2026-03-15', date: '2026-03-17' }, s.admin$).expect(201);
    await s.admin$.post(`/api/v1/session-changes/${m.id}/cancel`).expect(200);
    expect((await overview(s, '2026-03-13'))[0]).toMatchObject({ origin: { kind: 'regular' } });
    expect((await change(s, { date: '2026-09-01' }, s.admin$)).body.error.message).toContain(
      '90 days',
    );
    // A same-day new time, and not back once its usual time has gone.
    const t = (
      await change(
        s,
        { sessionDate: '2026-03-11', date: '2026-03-11', startTime: '18:00', endTime: '20:00' },
        s.admin$,
      ).expect(201)
    ).body.data;
    setToday('2026-03-11', '03:00:00');
    await (await as(s.admin)).post(`/api/v1/session-changes/${t.id}/cancel`).expect(409);
  });

  it('a substitute can reschedule what they cover; shared ground and busy students are warned', async () => {
    const s = await setup();
    await s.admin$
      .post('/api/v1/substitutions', {
        batchId: s.main.id,
        substituteCoachId: s.sub.id,
        fromDate: '2026-03-11',
        toDate: '2026-03-11',
      })
      .expect(201);
    const other = await makeBatch(s.sub.id, s.ground.id, {
      weekdays: [6],
      startTime: '07:00:00',
      endTime: '09:00:00',
      feePlanId: s.plan.id,
    });
    await s.admin$
      .post(`/api/v1/students/${s.anya.id}/batches`, {
        batchId: other.id,
        effectiveFrom: '2026-03-10',
      })
      .expect(201);
    // In advance: the batch's own coach or an admin only.
    const early = await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }, s.sub$);
    expect(early.body.error.message).toContain('only reschedule missed');
    await cancel(s, '2026-03-11', s.sub$);
    const p = (
      await s.sub$
        .post(`/api/v1/batches/${s.main.id}/session-changes/preview`, {
          sessionDate: '2026-03-11',
          date: '2026-03-14',
          startTime: '06:00',
          endTime: '08:00',
        })
        .expect(200)
    ).body.data;
    expect(p.ok).toBe(true);
    expect(p.warnings.map((w: { code: string }) => w.code)).toEqual([
      'location-overlap',
      'students-busy',
    ]);
    await change(
      s,
      { sessionDate: '2026-03-11', date: '2026-03-14', confirm: true },
      s.sub$,
    ).expect(201);
  });
});

describe('smart dates', () => {
  it('marks days inside every affected student’s billing month', async () => {
    const s = await setup();
    await cancel(s, '2026-03-11');
    const r = (
      await s.coach$
        .get(`/api/v1/batches/${s.main.id}/smart-dates?sessionDate=2026-03-11`)
        .expect(200)
    ).body.data;
    const smart = r.days
      .filter((d: { smart: boolean }) => d.smart)
      .map((d: { date: string }) => d.date);
    // Bhavin's month ends on the 19th; Mon/Wed/Fri are taken.
    expect(smart).toEqual(['2026-03-12', '2026-03-14', '2026-03-15', '2026-03-17', '2026-03-19']);
    expect(r.message).toBeNull();
    expect(r.days.find((d: { date: string }) => d.date === '2026-03-21').outside).toEqual([
      'Bhavin',
    ]);
    expect(r.days.at(-1).date).toBe('2026-04-10');
    await s.coach$
      .get(`/api/v1/batches/${s.main.id}/smart-dates?sessionDate=2026-03-12`)
      .expect(422);
  });

  it('says so when no day suits everyone', async () => {
    const s = await setup('2026-03-19');
    await cancel(s, '2026-03-18');
    setToday('2026-03-19', '15:00:00');
    const r = (
      await (
        await as(s.coach)
      )
        .get(`/api/v1/batches/${s.main.id}/smart-dates?sessionDate=2026-03-18`)
        .expect(200)
    ).body.data;
    expect(r.days.some((d: { smart: boolean }) => d.smart)).toBe(false);
    expect(r.message).toContain('No day suits every student');
  });
});

describe('missed sessions', () => {
  it('lists unconfirmed ones for an admin to confirm; cancelled ones to reschedule or close', async () => {
    const s = await setup();
    const list = async (api = s.admin$) =>
      (await api.get('/api/v1/session-changes/missed').expect(200)).body.data;
    const before = await list();
    expect(before.open).toEqual([]);
    expect(before.unconfirmed.map((m: { date: string }) => m.date)).toContain('2026-03-09');
    const key = { batchId: s.main.id, date: '2026-03-09' };
    await s.coach$.post('/api/v1/session-changes/missed/confirm', key).expect(403);
    await s.admin$
      .post('/api/v1/session-changes/missed/confirm', { ...key, date: '2026-03-11' })
      .expect(422);
    await s.admin$
      .post('/api/v1/session-changes/missed/confirm', { ...key, date: '2026-03-10' })
      .expect(422);
    await checkIn(s.coach.id, s.main.id, '2026-03-06');
    await s.admin$
      .post('/api/v1/session-changes/missed/confirm', { ...key, date: '2026-03-06' })
      .expect(409);
    await s.admin$.post('/api/v1/session-changes/missed/confirm', key).expect(200);
    await s.admin$.post('/api/v1/session-changes/missed/confirm', key).expect(409);
    expect((await list(s.coach$)).open).toEqual([
      expect.objectContaining({
        date: '2026-03-09',
        missed: true,
        students: 2,
        coachUntil: '2026-04-08',
      }),
    ]);
    expect((await list(s.sub$)).open).toEqual([]);
    const kinds = async (u: typeof s.admin) =>
      (await tasksFor(u as never)).items.map((t) => t.kind);
    expect(await kinds(s.admin)).toEqual(
      expect.arrayContaining(['missed-sessions', 'unconfirmed-sessions']),
    );
    expect(await kinds(s.coach)).not.toContain('unconfirmed-sessions');
    await s.coach$
      .post('/api/v1/session-changes/missed/close', { ...key, reason: 'No ground' })
      .expect(403);
    await s.admin$
      .post('/api/v1/session-changes/missed/close', { ...key, reason: 'No ground' })
      .expect(200);
    await s.admin$
      .post('/api/v1/session-changes/missed/close', { ...key, reason: 'No ground' })
      .expect(404);
    expect((await list()).open).toEqual([]);
    expect(
      (await change(s, { sessionDate: '2026-03-09', date: '2026-03-14' })).body.error.message,
    ).toContain('closed');
    // Past the 30 days it turns critical.
    setToday('2026-03-13');
    await cancel({ ...s, coach$: await as(s.coach) }, '2026-03-13');
    setToday('2026-04-20');
    expect(
      (await tasksFor(s.admin as never)).items.find((t) => t.kind === 'missed-sessions'),
    ).toMatchObject({
      severity: 'critical',
    });
  });

  it('students who have left are no longer waited for', async () => {
    const s = await setup();
    await cancel(s, '2026-03-11');
    for (const st of [s.anya, s.bhavin])
      await s.admin$.post(`/api/v1/students/${st.id}/leave`, { leftOn: '2026-03-10' }).expect(200);
    expect((await s.admin$.get('/api/v1/session-changes/missed')).body.data.open).toEqual([]);
  });
});

describe('who is alerted', () => {
  it('the substitute, not the regular coach; checks in', async () => {
    const s = await setup();
    await s.admin$
      .post('/api/v1/substitutions', {
        batchId: s.main.id,
        substituteCoachId: s.sub.id,
        fromDate: '2026-03-11',
        toDate: '2026-03-11',
      })
      .expect(201);
    setToday('2026-03-11', '00:20:00'); // 05:50 IST
    setPushSender(() => Promise.resolve('ok'));
    await sendSessionReminders('2026-03-11');
    await runSessionAlerts(new Date('2026-03-11T00:20:00Z'));
    setPushSender(undefined);
    const titles = async (u: typeof s.coach) =>
      (await (await as(u)).get('/api/v1/me/notifications')).body.data.items.map(
        (n: { title: string }) => n.title,
      ) as string[];
    const about = (t: string[]) => t.filter((x) => /starts at|session today/.test(x)).length;
    expect(about(await titles(s.sub))).toBe(2);
    expect(about(await titles(s.coach))).toBe(0);
    const r = await (
      await as(s.sub)
    ).post('/api/v1/coach-sessions/check-in', {
      batchId: s.main.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });
    expect(r.body.data.session.flagged).toBe(false); // 10 minutes early is fine
    const admin$ = await as(s.admin);
    await admin$
      .post(`/api/v1/batches/${s.main.id}/cancellations`, {
        date: '2026-03-11',
        reason: 'Too late',
      })
      .expect(422);
  });

  it('approved makeups booked earlier still show, and move with a session', async () => {
    const s = await setup();
    const other = await makeBatch(s.sub.id, s.ground.id, { weekdays: [2], feePlanId: s.plan.id });
    const guest = await makeStudent({ batchId: other.id }, s.admin.id);
    await bookMakeup(guest.id, s.main.id, '2026-03-11');
    await cancel(s, '2026-03-11');
    await change(s, { sessionDate: '2026-03-11', date: '2026-03-12' }).expect(201);
    expect((await overview(s, '2026-03-12'))[0]).toMatchObject({ expectedStudents: 3 });
  });
});
