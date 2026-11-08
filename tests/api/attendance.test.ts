import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, makeBatch, makeStudent, setToday, checkIn } from '../helpers/factories';

// 2026-03-09 is a Monday. Batches run Mon–Sat; students train Mon/Wed/Fri by default.
const MON = '2026-03-09';
const TUE = '2026-03-10';

async function setup() {
  const a = await makeAcademy();
  const s1 = await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, fullName: 'Anya', joiningDate: '2026-02-01' },
    a.admin.id,
  );
  const s2 = await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, fullName: 'Bhavin', joiningDate: '2026-02-01' },
    a.admin.id,
  );
  return { ...a, s1, s2 };
}

describe('student attendance', () => {
  it('builds the session sheet and saves marks idempotently', async () => {
    setToday(MON);
    const { coach, batch, s1, s2 } = await setup();
    const api = await as(coach);

    // Not checked in yet: the sheet is read-only and saving is refused.
    const locked = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${MON}`)
      .expect(200);
    expect(locked.body.data).toMatchObject({
      editable: false,
      needsCheckIn: true,
      lockedReason: 'Check in to this session to mark attendance.',
    });
    const refused = await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s1.id, status: 'present' }],
      })
      .expect(422);
    expect(refused.body.error.message).toMatch(/Check in/);
    await checkIn(coach.id, batch.id, MON);

    const sheet = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${MON}`)
      .expect(200);
    expect(sheet.body.data).toMatchObject({
      isScheduledDay: true,
      editable: true,
      needsCheckIn: false,
      lockedReason: null,
      summary: { total: 2, unmarked: 2 },
    });

    const body = {
      batchId: batch.id,
      date: MON,
      records: [
        { studentId: s1.id, status: 'present' },
        { studentId: s2.id, status: 'late', note: 'Traffic' },
      ],
    };
    await api.put('/api/v1/attendance/session', body).expect(200, { data: { saved: 2 } });
    await api
      .put('/api/v1/attendance/session', {
        ...body,
        records: [{ studentId: s2.id, status: 'absent' }],
      })
      .expect(200);

    const after = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${MON}`)
      .expect(200);
    expect(after.body.data.summary).toMatchObject({ present: 1, absent: 1, late: 0, unmarked: 0 });
    expect(
      after.body.data.students.find((r: { studentId: string }) => r.studentId === s2.id),
    ).toMatchObject({ status: 'absent', note: null });
  });

  it('enforces session rules', async () => {
    setToday(TUE);
    const { coach, otherCoach, batch, s1, admin, location } = await setup();
    const api = await as(coach);
    await checkIn(coach.id, batch.id, MON, TUE);
    const mark = (date: string, studentId = s1.id) => ({
      batchId: batch.id,
      date,
      records: [{ studentId, status: 'present' }],
    });

    await api.put('/api/v1/attendance/session', mark('2026-03-11')).expect(422); // future
    const old = await api.put('/api/v1/attendance/session', mark('2026-03-02')).expect(422); // beyond coach window
    expect(old.body.error.message).toMatch(/Ask an admin/);
    await api.put('/api/v1/attendance/session', mark(TUE)).expect(422); // s1 doesn't train Tuesdays
    const sunBatch = await makeBatch(coach.id, location.id, { weekdays: [1, 3] });
    await api.put('/api/v1/attendance/session', { ...mark(TUE), batchId: sunBatch.id }).expect(422); // batch not running
    await (await as(otherCoach)).put('/api/v1/attendance/session', mark(MON)).expect(404);

    // Admin can correct older records; the edit is audited.
    const adminApi = await as(admin);
    await adminApi.put('/api/v1/attendance/session', mark('2026-03-02')).expect(200);
    const logs = await adminApi
      .get(`/api/v1/admin/audit-logs?entityType=batch&entityId=${batch.id}`)
      .expect(200);
    expect(logs.body.data[0].action).toBe('attendance.backdated_edit');
    const sheet = await adminApi
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-02`)
      .expect(200);
    expect(sheet.body.data.editable).toBe(true);
  });

  it('keeps previously marked students visible after they transfer out', async () => {
    setToday(MON);
    const { admin, coach, batch, otherBatch, s1 } = await setup();
    const api = await as(coach);
    await checkIn(coach.id, batch.id, MON, TUE);
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s1.id, status: 'present' }],
      })
      .expect(200);
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${s1.id}/transfer`, {
        batchId: otherBatch.id,
        trainingDays: [1, 3, 5],
        effectiveFrom: MON,
      })
      .expect(200);
    const sheet = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${MON}`)
      .expect(200);
    expect(
      sheet.body.data.students.find((r: { studentId: string }) => r.studentId === s1.id),
    ).toMatchObject({ status: 'present', isMakeup: false });
    // Still editable for that student because a mark already exists.
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [{ studentId: s1.id, status: 'excused' }],
      })
      .expect(200);
  });

  it('includes makeup students in the roster and marks them as makeups', async () => {
    setToday(TUE);
    const { coach, admin, batch, otherBatch, plan } = await setup();
    const visitor = await makeStudent(
      { batchId: otherBatch.id, feePlanId: plan.id, joiningDate: '2026-02-01' },
      admin.id,
    );
    await (
      await as(admin)
    )
      .post(`/api/v1/students/${visitor.id}/makeups`, { batchId: batch.id, date: TUE })
      .expect(201);
    const api = await as(coach);
    await checkIn(coach.id, batch.id, MON, TUE);
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: TUE,
        records: [{ studentId: visitor.id, status: 'present' }],
      })
      .expect(200);
    const sheet = await api
      .get(`/api/v1/attendance/session?batchId=${batch.id}&date=${TUE}`)
      .expect(200);
    expect(sheet.body.data.students).toEqual([
      expect.objectContaining({ studentId: visitor.id, isMakeup: true, status: 'present' }),
    ]);
  });

  it('summarises a day across batches', async () => {
    setToday(MON);
    const { coach, admin, batch, s1, s2 } = await setup();
    const api = await as(coach);
    // Real GPS check-in first (attendance requires it), then mark.
    await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(200);
    await api
      .put('/api/v1/attendance/session', {
        batchId: batch.id,
        date: MON,
        records: [
          { studentId: s1.id, status: 'present' },
          { studentId: s2.id, status: 'absent' },
        ],
      })
      .expect(200);

    const overview = await api.get('/api/v1/attendance/overview').expect(200);
    expect(overview.body.data.sessions).toEqual([
      expect.objectContaining({
        batch: expect.objectContaining({ id: batch.id }),
        expectedStudents: 2,
        marked: 2,
        present: 1,
        attendanceComplete: true,
        hasLessonPlan: false,
        coachSession: expect.objectContaining({ flagged: false, checkOutAt: null }),
      }),
    ]);
    const all = await (
      await as(admin)
    )
      .get('/api/v1/attendance/overview?date=2026-03-15')
      .expect(200); // Sunday
    expect(all.body.data.sessions).toEqual([]);
    const adminMon = await (
      await as(admin)
    )
      .get(`/api/v1/attendance/overview?date=${MON}`)
      .expect(200);
    expect(adminMon.body.data.sessions).toHaveLength(2);
  });

  it('reports per-student history with attendance rate and a batch register', async () => {
    setToday('2026-03-14');
    const { admin, coach, batch, s1 } = await setup();
    const adminApi = await as(admin);
    for (const [date, status] of [
      ['2026-03-09', 'present'],
      ['2026-03-11', 'late'],
      ['2026-03-13', 'absent'],
      ['2026-03-06', 'excused'],
    ] as const) {
      await adminApi
        .put('/api/v1/attendance/session', {
          batchId: batch.id,
          date,
          records: [{ studentId: s1.id, status }],
        })
        .expect(200);
    }
    const api = await as(coach);
    const hist = await api
      .get(`/api/v1/attendance/students/${s1.id}?from=2026-03-01&to=2026-03-14`)
      .expect(200);
    expect(hist.body.data.summary).toMatchObject({
      total: 4,
      present: 1,
      late: 1,
      absent: 1,
      excused: 1,
      attendanceRate: 66.7,
    });
    const defaultRange = await api.get(`/api/v1/attendance/students/${s1.id}`).expect(200);
    expect(defaultRange.body.data.from).toBe('2026-02-13');
    await api.get(`/api/v1/attendance/students/${s1.id}?from=2024-01-01&to=2026-03-14`).expect(400);

    const reg = await api
      .get(`/api/v1/attendance/register?batchId=${batch.id}&from=2026-03-09&to=2026-03-15`)
      .expect(200);
    expect(reg.body.data.dates).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
    ]);
    expect(reg.body.data.students[0].marks).toEqual({
      '2026-03-09': 'present',
      '2026-03-11': 'late',
      '2026-03-13': 'absent',
    });
    await api
      .get(`/api/v1/attendance/register?batchId=${batch.id}&from=2026-03-15&to=2026-03-09`)
      .expect(400);
    await api
      .get(`/api/v1/attendance/register?batchId=${batch.id}&from=2026-01-01&to=2026-03-09`)
      .expect(400);

    const empty = await api
      .get(`/api/v1/attendance/students/${s1.id}?from=2026-01-01&to=2026-01-31`)
      .expect(200);
    expect(empty.body.data.summary.attendanceRate).toBeNull();
  });
});

describe('coach GPS check-in / check-out', () => {
  // Location is at 12.9716, 77.5946 with a 200 m radius.
  it('records an in-fence session with duration', async () => {
    setToday(MON, '00:30:00'); // 06:00 IST
    const { coach, batch } = await setup();
    const api = await as(coach);

    const today = await api.get('/api/v1/coach-sessions/today').expect(200);
    expect(today.body.data.sessions).toEqual([
      expect.objectContaining({ batch: expect.objectContaining({ id: batch.id }), session: null }),
    ]);

    const inRes = await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9717,
        longitude: 77.5947,
        accuracy: 12,
      })
      .expect(200);
    expect(inRes.body.data.session).toMatchObject({
      checkInWithinFence: true,
      flagged: false,
      durationMinutes: null,
    });
    expect(inRes.body.data.message).toMatch(/^Checked in at/);
    await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9717,
        longitude: 77.5947,
      })
      .expect(409);

    setToday(MON, '02:30:00'); // 08:00 IST — access tokens expire after 15 min, so sign in again
    const later = await as(coach);
    const outRes = await later
      .post('/api/v1/coach-sessions/check-out', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(200);
    expect(outRes.body.data.session).toMatchObject({
      checkOutWithinFence: true,
      durationMinutes: 120,
    });
    await later
      .post('/api/v1/coach-sessions/check-out', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(409);
  });

  it('accepts but flags readings outside the geofence for admin review', async () => {
    setToday(MON);
    const { coach, admin, batch } = await setup();
    const api = await as(coach);
    const res = await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.99,
        longitude: 77.5946,
        note: 'Parking',
      })
      .expect(200);
    expect(res.body.data.session.flagged).toBe(true);
    expect(res.body.data.message).toMatch(/flagged for review/);
    const out = await api
      .post('/api/v1/coach-sessions/check-out', {
        batchId: batch.id,
        latitude: 13.5,
        longitude: 77.5946,
      })
      .expect(200);
    expect(out.body.data.message).toMatch(/check-out has been flagged/);

    const adminApi = await as(admin);
    const flagged = await adminApi
      .get(`/api/v1/coach-sessions?flagged=true&coachId=${coach.id}&batchId=${batch.id}`)
      .expect(200);
    expect(flagged.body.data.summary).toMatchObject({
      sessions: 1,
      flagged: 1,
      unreviewedFlagged: 1,
    });
    const id = flagged.body.data.sessions[0].id as string;
    const reviewed = await adminApi
      .post(`/api/v1/coach-sessions/${id}/review`, { note: 'Verified by phone' })
      .expect(200);
    expect(reviewed.body.data.reviewNote).toBe('Verified by phone');
    await adminApi
      .post('/api/v1/coach-sessions/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c/review', {})
      .expect(404);
    await api.post(`/api/v1/coach-sessions/${id}/review`, {}).expect(403);
  });

  it('enforces ownership and schedule', async () => {
    setToday('2026-03-15'); // Sunday
    const { coach, otherBatch, batch, admin } = await setup();
    const api = await as(coach);
    await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: otherBatch.id,
        latitude: 1,
        longitude: 1,
      })
      .expect(404);
    await api
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(422);
    await api
      .post('/api/v1/coach-sessions/check-out', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(422);
    await (
      await as(admin)
    )
      .post('/api/v1/coach-sessions/check-in', { batchId: batch.id, latitude: 1, longitude: 1 })
      .expect(403);

    await (await as(admin)).patch(`/api/v1/batches/${batch.id}`, { isActive: false }).expect(422); // has students
  });

  it('rejects check-in for inactive batches', async () => {
    setToday(MON);
    const { coach, location } = await setup();
    const inactive = await makeBatch(coach.id, location.id, { isActive: false });
    await (
      await as(coach)
    )
      .post('/api/v1/coach-sessions/check-in', {
        batchId: inactive.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(422);
  });

  it('lists a coach’s own history with summary and validates range', async () => {
    setToday(MON);
    const { coach, batch } = await setup();
    const api = await as(coach);
    await api.post('/api/v1/coach-sessions/check-in', {
      batchId: batch.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });
    setToday('2026-03-11');
    const later = await as(coach);
    const list = await later.get('/api/v1/coach-sessions').expect(200);
    expect(list.body.data.summary).toMatchObject({
      sessions: 1,
      missingCheckOut: 1,
      totalHours: 0,
    });
    await later.get('/api/v1/coach-sessions?from=2020-01-01&to=2026-03-11').expect(400);
  });
});

describe('calendar', () => {
  it('returns each day of a week with its sessions, for the user’s scope', async () => {
    setToday(MON);
    const { coach, admin, batch, otherBatch } = await setup();
    const res = await (
      await as(coach)
    )
      .get('/api/v1/attendance/calendar?from=2026-03-09&to=2026-03-15')
      .expect(200);
    expect(res.body.data.days).toHaveLength(7);
    expect(res.body.data.today).toBe(MON);
    const monday = res.body.data.days[0];
    expect(monday.date).toBe(MON);
    expect(monday.sessions.map((s: { batch: { id: string } }) => s.batch.id)).toEqual([batch.id]);
    expect(res.body.data.days[6].sessions).toEqual([]); // Sunday
    // Admins see every batch.
    const all = await (
      await as(admin)
    )
      .get('/api/v1/attendance/calendar?from=2026-03-09&to=2026-03-09')
      .expect(200);
    expect(
      all.body.data.days[0].sessions.map((s: { batch: { id: string } }) => s.batch.id).sort(),
    ).toEqual([batch.id, otherBatch.id].sort());
    await (
      await as(coach)
    )
      .get('/api/v1/attendance/calendar?from=2026-03-09&to=2026-05-30')
      .expect(400);
    await (
      await as(coach)
    )
      .get('/api/v1/attendance/calendar?from=2026-03-10&to=2026-03-09')
      .expect(400);
  });
});

describe('admin check-out', () => {
  it('lets an admin close a session a coach forgot to check out of', async () => {
    setToday(MON, '04:00:00'); // 09:30 IST
    const { coach, admin, otherCoach, batch } = await setup();
    await (
      await as(coach)
    )
      .post('/api/v1/coach-sessions/check-in', {
        batchId: batch.id,
        latitude: 12.9716,
        longitude: 77.5946,
      })
      .expect(200);
    const list = await (
      await as(admin)
    )
      .get(`/api/v1/coach-sessions?from=${MON}&to=${MON}`)
      .expect(200);
    const id = list.body.data.sessions[0].id as string;

    await (await as(otherCoach)).post(`/api/v1/coach-sessions/${id}/check-out`, {}).expect(403);
    const adminApi = await as(admin);
    await adminApi
      .post(`/api/v1/coach-sessions/${id}/check-out`, { at: '2026-03-08T10:00:00Z' })
      .expect(400); // before check-in
    await adminApi
      .post(`/api/v1/coach-sessions/${id}/check-out`, { at: '2026-03-09T09:00:00Z' })
      .expect(400); // future
    const res = await adminApi
      .post(`/api/v1/coach-sessions/${id}/check-out`, {
        at: '2026-03-09T04:00:30Z',
        reason: 'Forgot',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      checkOutAt: '2026-03-09T04:00:30.000Z',
      checkOutLat: null,
      note: expect.stringContaining('Checked out by'),
    });
    expect(res.body.data.note).toContain('Forgot');
    await adminApi.post(`/api/v1/coach-sessions/${id}/check-out`, {}).expect(409);
  });
});
