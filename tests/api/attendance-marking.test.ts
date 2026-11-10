import { describe, expect, it } from '@jest/globals';
import { as, checkIn, makeAcademy, makeStudent, setToday } from '../helpers/factories';

// The factory batch runs Mon–Sat 6–8 am.
const MON = '2026-03-09';
const TUE = '2026-03-10';
const WED = '2026-03-11';
const THU = '2026-03-12';

async function setup() {
  setToday(MON);
  const a = await makeAcademy();
  const s = await makeStudent(
    { fullName: 'Asha', batchId: a.batch.id, feePlanId: a.plan.id, joiningDate: '2026-03-02' },
    a.admin.id,
  );
  // A fresh sign-in per request: the tests move the clock forward by days.
  const api = () => as(a.coach);
  const mark = async (date: string, status: string | null) =>
    (await api()).put('/api/v1/attendance/session', {
      batchId: a.batch.id,
      date,
      records: [{ studentId: s.id, status }],
    });
  const sheet = async (date: string) =>
    (
      await (
        await api()
      )
        .get(`/api/v1/attendance/session?batchId=${a.batch.id}&date=${date}`)
        .expect(200)
    ).body.data as {
      students: {
        studentId: string;
        status: string | null;
        recent: { date: string; status: string }[];
        rate30: number | null;
      }[];
    };
  return { ...a, s, mark, sheet };
}

describe('attendance marking for coaches', () => {
  it('shows each student’s last sessions and 30-day rate', async () => {
    const { coach, batch, s, mark, sheet } = await setup();
    for (const [day, status] of [
      [MON, 'present'],
      [TUE, 'absent'],
      [WED, 'late'],
    ] as const) {
      setToday(day);
      await checkIn(coach.id, batch.id, day);
      expect((await mark(day, status)).status).toBe(200);
    }
    setToday(THU);
    const row = (await sheet(THU)).students.find((r) => r.studentId === s.id)!;
    // Newest first, only sessions before this one.
    expect(row.recent.map((r) => r.status)).toEqual(['late', 'absent', 'present']);
    expect(row.recent[0]!.date).toBe(WED);
    expect(row.rate30).toBe(67); // present + late of 3
  });

  it('clears a mark when saved without a status (undo)', async () => {
    const { coach, batch, s, mark, sheet } = await setup();
    await checkIn(coach.id, batch.id, MON);
    expect((await mark(MON, 'absent')).status).toBe(200);
    expect((await sheet(MON)).students[0]!.status).toBe('absent');
    expect((await mark(MON, null)).status).toBe(200);
    const row = (await sheet(MON)).students.find((r) => r.studentId === s.id)!;
    expect(row.status).toBeNull();
    expect(row.rate30).toBeNull();
  });
});
