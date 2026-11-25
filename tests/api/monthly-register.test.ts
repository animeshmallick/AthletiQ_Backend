import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { makeupSessions, sessionCancellations, studentAttendance } from '../../src/db/schema';
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

/** Mon / Wed / Fri 06:00–08:00. "Now" is Fri 20 Mar 2026, 12:00 IST. */
async function setup() {
  setToday('2026-02-01');
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const other = await makeUser('coach');
  const ground = await makeLocation();
  const sport = await makeSport();
  const plan = await makePlan({ daysPerWeek: 3 });
  const base = { feePlanId: plan.id, sportId: sport.id, weekdays: [1, 3, 5] };
  const main = await makeBatch(coach.id, ground.id, { ...base, name: 'Main' });
  const visit = await makeBatch(other.id, ground.id, {
    ...base,
    name: 'Visit',
    weekdays: [2, 4, 6],
    startTime: '17:00:00',
    endTime: '18:00:00',
  });
  const join = (fullName: string, joiningDate: string) =>
    makeStudent({ batchId: main.id, joiningDate, fullName }, admin.id);
  const anya = await join('Anya', '2026-02-01');
  const bhavin = await join('Bhavin', '2026-02-01');
  const charu = await join('Charu', '2026-03-11');
  const mark = (
    studentId: string,
    date: string,
    status: 'present' | 'absent' | 'late' | 'excused',
    batchId = main.id,
    homeBatchId: string | null = null,
  ) =>
    db.insert(studentAttendance).values({
      batchId,
      studentId,
      date,
      status,
      markedById: coach.id,
      isMakeup: !!homeBatchId,
      homeBatchId,
    });
  // February: Anya 2 of 4.
  await mark(anya.id, '2026-02-20', 'absent');
  await mark(anya.id, '2026-02-23', 'late');
  await mark(anya.id, '2026-02-25', 'present');
  await mark(anya.id, '2026-02-27', 'absent');
  for (const d of ['2026-03-02', '2026-03-04', '2026-03-06']) {
    await mark(anya.id, d, 'present');
    await mark(bhavin.id, d, 'absent');
  }
  await mark(anya.id, '2026-03-09', 'late');
  await mark(bhavin.id, '2026-03-09', 'excused');
  await mark(charu.id, '2026-03-13', 'present');
  // Wed 11 cancelled; Anya made it up in Visit on Thu 12.
  await db
    .insert(sessionCancellations)
    .values({ batchId: main.id, date: '2026-03-11', reason: 'Rain' });
  await db.insert(makeupSessions).values({
    studentId: anya.id,
    batchId: visit.id,
    date: '2026-03-12',
    missedBatchId: main.id,
    missedDate: '2026-03-11',
  });
  await mark(anya.id, '2026-03-12', 'present', visit.id, main.id);
  await checkIn(coach.id, main.id, '2026-03-02');
  setToday('2026-03-20');
  return { admin, coach, other, main, visit, anya, bhavin, charu };
}

describe('monthly register', () => {
  it('lists every member with their marks, totals and the month’s insights', async () => {
    const s = await setup();
    const api = await as(s.admin);
    const r = (
      await api.get(`/api/v1/attendance/registers/${s.main.id}?month=2026-03-15`).expect(200)
    ).body.data;
    expect(r.month).toBe('2026-03-01');
    expect(r.sessions).toHaveLength(13);
    const day = (d: string) => r.sessions.find((x: { date: string }) => x.date === d);
    expect(day('2026-03-02')).toMatchObject({
      state: 'held',
      expected: 2,
      present: 1,
      absent: 1,
      rate: 50,
      checkedIn: { lateBy: 0 },
    });
    expect(day('2026-03-11')).toMatchObject({ state: 'cancelled', reason: 'Rain', marked: 0 });
    expect(day('2026-03-16').state).toBe('unrecorded');
    expect(day('2026-03-23').state).toBe('upcoming');
    const [anya, bhavin, charu] = r.students;
    expect(anya).toMatchObject({
      fullName: 'Anya',
      present: 4,
      late: 1,
      absent: 0,
      unmarked: 1, // 13 Mar was held
      rate: 100,
      previousRate: 50,
      change: 50,
      joinedOn: null,
    });
    expect(anya.cells['2026-03-11']).toMatchObject({
      mark: 'present',
      madeUp: 'Visit on 2026-03-12',
    });
    expect(anya.cells['2026-03-16']).toEqual({ mark: null });
    expect(bhavin).toMatchObject({ absent: 3, excused: 1, rate: 0, absentRun: 3 });
    // Joined on the 11th: not a member before.
    expect(charu).toMatchObject({ joinedOn: '2026-03-11', rate: 100 });
    expect(charu.cells['2026-03-02']).toBeUndefined();
    expect(r.summary).toMatchObject({
      students: 3,
      held: 5,
      cancelled: 1,
      unrecorded: 3,
      madeUp: 1,
      rate: 67, // 6 of 9
      previousRate: 50,
      punctuality: 100,
    });
    expect(r.insights.absentRuns.map((p: { fullName: string }) => p.fullName)).toEqual(['Bhavin']);
    expect(r.insights.low.map((p: { fullName: string }) => p.fullName)).toEqual(['Bhavin']);
    expect(r.insights.perfect.map((p: { fullName: string }) => p.fullName)).toEqual(['Anya']);
    expect(r.insights.improved.map((p: { fullName: string }) => p.fullName)).toEqual(['Anya']);
    expect(r.insights.byWeekday.find((x: { weekday: number }) => x.weekday === 1).sessions).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/fee|paise|invoice|amount/i);
    // The batch visited isn't affected by the guest.
    const v = (
      await api.get(`/api/v1/attendance/registers/${s.visit.id}?month=2026-03-01`).expect(200)
    ).body.data;
    expect(v.students).toEqual([]);
    expect(v.summary.rate).toBeNull();
    expect(v.sessions.find((x: { date: string }) => x.date === '2026-03-12').state).toBe('held');
  });

  it('gives a tile per batch: admins all, coaches their own', async () => {
    const s = await setup();
    const names = async (u: typeof s.admin) =>
      (
        await (await as(u)).get('/api/v1/attendance/registers?month=2026-03-01').expect(200)
      ).body.data.batches.map((b: { batch: { name: string } }) => b.batch.name);
    expect(await names(s.admin)).toEqual(['Main', 'Visit']);
    expect(await names(s.coach)).toEqual(['Main']);
    const [tile] = (await (await as(s.coach)).get('/api/v1/attendance/registers').expect(200)).body
      .data.batches;
    expect(tile).toMatchObject({ low: 1, absentRuns: 1, perfect: 1, summary: { rate: 67 } });
    expect(tile.trend).toHaveLength(5);
    expect(tile.students).toBeUndefined();
  });

  it('keeps other coaches out, refuses future months, and prints a PDF', async () => {
    const s = await setup();
    const url = `/api/v1/attendance/registers/${s.main.id}`;
    await (await as(s.other)).get(url).expect(404);
    await (await as(s.other)).get(`${url}/pdf`).expect(404);
    const coach = await as(s.coach);
    await coach.get(`${url}?month=2026-04-01`).expect(400);
    await coach.get(`${url}?month=march`).expect(400);
    const pdf = await coach.get(`${url}/pdf?month=2026-03-01`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('main-attendance-2026-03.pdf');
    // An empty month still works.
    const empty = (await coach.get(`${url}?month=2025-12-01`).expect(200)).body.data;
    expect(empty.students).toEqual([]);
    await coach.get(`${url}/pdf?month=2025-12-01`).expect(200);
  });

  it('prints a full class over several pages', async () => {
    const s = await setup();
    const { renderRegisterPdf } = await import('../../src/modules/attendance/register-pdf');
    const { monthlyRegister, registerBatches } =
      await import('../../src/modules/attendance/monthly-register');
    const { getAcademySettings } = await import('../../src/modules/settings/settings');
    const b = (await registerBatches()).find((x) => x.id === s.main.id)!;
    const r = await monthlyRegister(b, '2026-03-01');
    const many = {
      ...r,
      students: Array.from({ length: 60 }, (_, i) => ({
        ...r.students[0]!,
        fullName: `A student with a really rather long name number ${i}`,
      })),
    };
    const pdf = await renderRegisterPdf(many, await getAcademySettings());
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)!.length).toBe(2 + 1);
    if (process.env.REGISTER_PDF)
      (await import('node:fs')).writeFileSync(process.env.REGISTER_PDF, pdf);
  });
});
