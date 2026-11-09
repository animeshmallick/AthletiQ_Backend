import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { batches, coachSessions } from '../../src/db/schema';
import { normalizeDayTimes, scheduleLabel, timesOn } from '../../src/lib/batch-times';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import { as, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

const MON = '2026-03-09';
const WED = '2026-03-11';
/** IST clock time on a date → the UTC time setToday expects. */
const ist = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const mins = h * 60 + m - 330;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;
};

describe('batch times (helpers)', () => {
  const b = {
    weekdays: [1, 3, 6],
    startTime: '06:00:00',
    endTime: '08:00:00',
    dayTimes: { '6': { start: '07:00:00', end: '09:00:00' } },
  };

  it('resolves a day’s own time, falling back to the default', () => {
    expect(timesOn(b, 6)).toEqual({ startTime: '07:00:00', endTime: '09:00:00' });
    expect(timesOn(b, 1)).toEqual({ startTime: '06:00:00', endTime: '08:00:00' });
    expect(timesOn(b, '2026-03-14')).toEqual({ startTime: '07:00:00', endTime: '09:00:00' });
    expect(timesOn({ ...b, dayTimes: null }, 6).startTime).toBe('06:00:00');
  });

  it('labels the schedule compactly, grouping days by time', () => {
    expect(scheduleLabel({ ...b, dayTimes: {} })).toBe('Mon · Wed · Sat · 6:00 am–8:00 am');
    expect(scheduleLabel(b)).toBe('Mon · Wed 6:00 am–8:00 am, Sat 7:00 am–9:00 am');
  });

  it('keeps only overrides for running days that differ from the default', () => {
    expect(
      normalizeDayTimes(
        {
          '1': { start: '06:00:00', end: '08:00:00' }, // same as default
          '2': { start: '10:00:00', end: '11:00:00' }, // not a batch day
          '6': { start: '07:00:00', end: '09:00:00' },
        },
        [1, 3, 6],
        '06:00:00',
        '08:00:00',
      ),
    ).toEqual({ '6': { start: '07:00:00', end: '09:00:00' } });
  });
});

describe('batch times (API)', () => {
  it('saves per-day times, validates each day and keeps them on unrelated edits', async () => {
    const { admin, coach, location, batch, plan } = await makeAcademy();
    const api = await as(admin);
    const body = {
      name: 'Split',
      coachId: coach.id,
      locationId: location.id,
      weekdays: [1, 3, 6],
      startTime: '17:00',
      endTime: '18:30',
      capacity: 10,
      sportId: batch.sportId,
      feePlanId: plan.id,
    };
    const bad = await api
      .post('/api/v1/batches', { ...body, dayTimes: { '3': { start: '19:00', end: '18:00' } } })
      .expect(400);
    expect(bad.body.error.message).toBe('Wednesday: end time must be after start time');
    expect(bad.body.error.details.fields[0].path).toBe('dayTimes.3');
    await api.post('/api/v1/batches', { ...body, dayTimes: { '9': {} } }).expect(400);

    const res = await api
      .post('/api/v1/batches', {
        ...body,
        dayTimes: {
          '1': { start: '17:00', end: '18:30' }, // same as the default: dropped
          '6': { start: '07:00', end: '09:00' },
        },
      })
      .expect(201);
    const id = res.body.data.id as string;
    expect(res.body.data.dayTimes).toEqual({ '6': { start: '07:00:00', end: '09:00:00' } });

    // A rename keeps the day times (and doesn't touch other fields).
    await api.patch(`/api/v1/batches/${id}`, { isActive: false }).expect(200);
    const renamed = await api.patch(`/api/v1/batches/${id}`, { name: 'Split 2' }).expect(200);
    expect(renamed.body.data).toMatchObject({
      isActive: false,
      dayTimes: { '6': { start: '07:00:00', end: '09:00:00' } },
    });
    // Dropping Saturday drops its override; listing returns them.
    await api.patch(`/api/v1/batches/${id}`, { weekdays: [1, 3, 5] }).expect(200);
    const list = await api.get('/api/v1/batches').expect(200);
    expect(list.body.data.find((b: { id: string }) => b.id === id).dayTimes).toEqual({});
    // Moving the default onto an override's time drops that override too.
    await api
      .patch(`/api/v1/batches/${id}`, { dayTimes: { '5': { start: '08:00', end: '09:00' } } })
      .expect(200);
    const same = await api
      .patch(`/api/v1/batches/${id}`, { startTime: '08:00', endTime: '09:00' })
      .expect(200);
    expect(same.body.data.dayTimes).toEqual({});
  });

  it('runs each day at its own time: overview, check-in, tasks and history', async () => {
    const a = await makeAcademy();
    // The factory batch runs Mon–Sat 6–8 am; Wednesdays are 5–7 pm.
    await db
      .update(batches)
      .set({ dayTimes: { '3': { start: '17:00:00', end: '19:00:00' } } })
      .where(eq(batches.id, a.batch.id));
    await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: MON }, a.admin.id);
    const coachApi = async () => as(a.coach);
    const coach = { ...a.coach, role: 'coach' as const };

    // Wednesday 6:40 am: the session hasn't started, so no missed check-in.
    setToday(WED, ist('06:40'));
    const morning = await tasksFor(coach, new Date());
    expect(morning.items.map((t) => t.kind)).not.toContain('missed-check-in');
    const overview = await (await coachApi()).get('/api/v1/attendance/overview').expect(200);
    expect(overview.body.data.sessions[0].batch).toMatchObject({
      startTime: '17:00:00',
      endTime: '19:00:00',
    });
    const today = await (await coachApi()).get('/api/v1/coach-sessions/today').expect(200);
    expect(today.body.data.sessions[0].batch.startTime).toBe('17:00:00');

    // 5:40 pm without a check-in: now it's missed.
    setToday(WED, ist('17:40'));
    const evening = await tasksFor(coach, new Date());
    expect(evening.items.find((t) => t.kind === 'missed-check-in')?.detail).toContain('5:00 pm');

    // Checking in snapshots the day's time.
    await (
      await coachApi()
    )
      .post('/api/v1/coach-sessions/check-in', {
        batchId: a.batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(200);
    const [cs] = await db.select().from(coachSessions);
    expect(cs).toMatchObject({ scheduledStart: '17:00:00', scheduledEnd: '19:00:00' });

    // Later timing changes don't rewrite that session.
    await (await as(a.admin)).patch(`/api/v1/batches/${a.batch.id}`, { dayTimes: {} }).expect(200);
    const history = await (await as(a.admin)).get(`/api/v1/coach-sessions?to=${WED}`).expect(200);
    expect(history.body.data.sessions[0].batch).toMatchObject({
      startTime: '17:00:00',
      endTime: '19:00:00',
    });
    // The attendance sheet for a day shows that day's time.
    setToday(MON);
    const sheet = await (
      await as(a.admin)
    )
      .get(`/api/v1/attendance/session?batchId=${a.batch.id}&date=${MON}`)
      .expect(200);
    expect(sheet.body.data.batch.startTime).toBe('06:00:00');
  });

  it('checks a substitute’s clashes against each day’s own time', async () => {
    const a = await makeAcademy();
    // The other coach's batch runs 5–7 pm, but at 6–8 am on Wednesdays.
    await db
      .update(batches)
      .set({ dayTimes: { '3': { start: '06:00:00', end: '08:00:00' } } })
      .where(eq(batches.id, a.otherBatch.id));
    setToday(MON);
    const api = await as(a.admin);
    const ask = (fromDate: string, toDate: string) =>
      api.post('/api/v1/substitutions', {
        batchId: a.batch.id,
        substituteCoachId: a.otherCoach.id,
        fromDate,
        toDate,
      });
    // Tuesday is free (the other batch is in the evening)…
    const ok = await ask('2026-03-10', '2026-03-10');
    expect(ok.status).toBeLessThan(300);
    // …but on Wednesday both run 6–8 am.
    const clash = await ask(WED, WED);
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/already coaches/);
  });

  it('a batch made without day times runs at one time', async () => {
    const a = await makeAcademy();
    const b = await makeBatch(a.coach.id, a.location.id, { feePlanId: a.plan.id, name: 'Plain' });
    expect(b.dayTimes).toEqual({});
  });
});
