import { describe, expect, it } from '@jest/globals';
import { as, makeAcademy, makeBatch, makeStudent, setToday } from '../helpers/factories';

const GPS = { latitude: 12.9716, longitude: 77.5946, accuracy: 10 };

describe('substitute coaches', () => {
  async function setup() {
    setToday('2026-03-09', '00:30:00'); // Monday, before sessions
    const a = await makeAcademy();
    await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id }, a.admin.id);
    return {
      ...a,
      admin$: await as(a.admin),
      coach$: await as(a.coach),
      sub$: await as(a.otherCoach),
    };
  }

  it('lets an admin assign a substitute who runs the batch only on covered days', async () => {
    const { batch, otherCoach, admin$, sub$ } = await setup();
    const res = await admin$
      .post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-09',
        toDate: '2026-03-11',
        reason: 'Coach at a tournament',
      })
      .expect(201);
    expect(res.body.data).toMatchObject({
      status: 'approved',
      sessions: 3,
      substitute: { id: otherCoach.id },
      batch: { id: batch.id },
    });

    // The batch shows up for the substitute, marked with the days they cover.
    const list = (await sub$.get('/api/v1/batches?active=true').expect(200)).body.data;
    expect(list.find((b: { id: string }) => b.id === batch.id).substitution).toMatchObject({
      fromDate: '2026-03-09',
      toDate: '2026-03-11',
    });

    // Today, calendar and check-in work on a covered day.
    const today = (await sub$.get('/api/v1/coach-sessions/today').expect(200)).body.data;
    expect(today.sessions.map((s: { batch: { id: string } }) => s.batch.id)).toContain(batch.id);
    expect(
      today.sessions.find((s: { batch: { id: string } }) => s.batch.id === batch.id),
    ).toMatchObject({ asSubstitute: true, substitute: { id: otherCoach.id } });
    const cal = (
      await sub$.get('/api/v1/attendance/calendar?from=2026-03-09&to=2026-03-15').expect(200)
    ).body.data;
    const covered = cal.days
      .filter((d: { sessions: { batch: { id: string } }[] }) =>
        d.sessions.some((s) => s.batch.id === batch.id),
      )
      .map((d: { date: string }) => d.date);
    expect(covered).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
    setToday('2026-03-09', '00:40:00');
    await sub$.post('/api/v1/coach-sessions/check-in', { batchId: batch.id, ...GPS }).expect(200);

    // Session tools on covered days only.
    await sub$.get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-10`).expect(200);
    await sub$.get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-12`).expect(404);
    await sub$.get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-11`).expect(200);
    await sub$.get(`/api/v1/lessons/plans/day?batchId=${batch.id}&date=2026-03-13`).expect(404);

    // Never the batch's history, students or fees.
    await sub$
      .get(`/api/v1/attendance/register?batchId=${batch.id}&from=2026-03-01&to=2026-03-09`)
      .expect(404);
    const students = (await sub$.get(`/api/v1/students?batchId=${batch.id}`).expect(200)).body.data;
    expect(students).toEqual([]);
    const invoices = (await sub$.get('/api/v1/invoices').expect(200)).body.data;
    expect(invoices).toEqual([]);
  });

  it('runs coach requests through admin approval, with conflict checks', async () => {
    const { batch, otherCoach, coach, location, admin$, coach$, sub$ } = await setup();
    const request = (body: Record<string, unknown> = {}) =>
      coach$.post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-10',
        toDate: '2026-03-12',
        ...body,
      });

    // Only the batch's own coach can ask; dates and people are validated.
    await sub$
      .post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-10',
        toDate: '2026-03-10',
      })
      .expect(403);
    await request({ substituteCoachId: coach.id }).expect(400);
    await request({ fromDate: '2026-03-01', toDate: '2026-03-02' }).expect(400);
    await request({ fromDate: '2026-03-15', toDate: '2026-03-15' }).expect(422); // Sunday

    const pending = (await request({ reason: 'Exams' }).expect(201)).body.data;
    expect(pending).toMatchObject({
      status: 'pending',
      sessions: 3,
      requestedBy: { id: coach.id },
    });
    // Pending gives no access yet; admins see it as a task.
    await sub$.get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-10`).expect(404);
    const tasks = (await admin$.get('/api/v1/me/tasks').expect(200)).body.data;
    expect(tasks.items.map((t: { kind: string }) => t.kind)).toContain('substitute-requests');

    // Coaches can't approve; admins can, once.
    await coach$.post(`/api/v1/substitutions/${pending.id}/approve`, {}).expect(403);
    const approved = await admin$
      .post(`/api/v1/substitutions/${pending.id}/approve`, { note: 'OK' })
      .expect(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', reviewNote: 'OK' });
    await admin$.post(`/api/v1/substitutions/${pending.id}/approve`, {}).expect(409);
    await sub$.get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-10`).expect(200);

    // One substitute per batch per day.
    const third = await (await import('../helpers/factories')).makeUser('coach');
    const clashSameBatch = await admin$.post('/api/v1/substitutions', {
      batchId: batch.id,
      substituteCoachId: third.id,
      fromDate: '2026-03-12',
      toDate: '2026-03-13',
    });
    expect(clashSameBatch.status).toBe(409);
    expect(clashSameBatch.body.error.message).toMatch(/already has/);

    // A substitute can't be in two places at once.
    const early = await makeBatch(coach.id, location.id, {
      startTime: '07:00:00',
      endTime: '09:00:00',
    });
    const busy = await admin$.post('/api/v1/substitutions', {
      batchId: early.id,
      substituteCoachId: otherCoach.id,
      fromDate: '2026-03-10',
      toDate: '2026-03-10',
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/already coaches/);

    // Rejecting and cancelling.
    const another = (
      await coach$
        .post('/api/v1/substitutions', {
          batchId: early.id,
          substituteCoachId: third.id,
          fromDate: '2026-03-16',
          toDate: '2026-03-16',
        })
        .expect(201)
    ).body.data;
    const rejected = await admin$
      .post(`/api/v1/substitutions/${another.id}/reject`, { note: 'Not needed' })
      .expect(200);
    expect(rejected.body.data.status).toBe('rejected');
    await coach$.post(`/api/v1/substitutions/${another.id}/cancel`, {}).expect(409);
    await sub$.post(`/api/v1/substitutions/${pending.id}/cancel`, {}).expect(404);
    const cancelled = await coach$
      .post(`/api/v1/substitutions/${pending.id}/cancel`, {})
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    await sub$.get(`/api/v1/attendance/session?batchId=${batch.id}&date=2026-03-10`).expect(404);

    // Lists are scoped: the outsider coach sees only what involves them.
    const mine = (await sub$.get('/api/v1/substitutions').expect(200)).body.data;
    expect(mine.map((r: { id: string }) => r.id)).toEqual([pending.id]);
    const all = (await admin$.get('/api/v1/substitutions?status=rejected').expect(200)).body.data;
    expect(all.map((r: { id: string }) => r.id)).toEqual([another.id]);
  });

  it('reports substitute sessions for admins and coaches', async () => {
    const { batch, otherCoach, coach, admin$, coach$, sub$ } = await setup();
    await admin$
      .post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-09',
        toDate: '2026-03-14',
      })
      .expect(201);
    await coach$
      .post('/api/v1/substitutions', {
        batchId: batch.id,
        substituteCoachId: otherCoach.id,
        fromDate: '2026-03-20',
        toDate: '2026-03-20',
      })
      .expect(201);
    const coaches = (await coach$.get('/api/v1/substitutions/coaches').expect(200)).body.data;
    expect(coaches.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([coach.id, otherCoach.id]),
    );
    const range = '?from=2026-03-01&to=2026-03-31';
    const academy = (await admin$.get(`/api/v1/substitutions/insights${range}`).expect(200)).body
      .data;
    expect(academy.totals).toMatchObject({ substitutions: 1, sessions: 6, pending: 1, active: 1 });
    expect(academy.bySubstitute).toEqual([
      expect.objectContaining({ id: otherCoach.id, sessions: 6, substitutions: 1 }),
    ]);
    expect(academy.byCoach).toEqual([expect.objectContaining({ id: coach.id, sessions: 6 })]);
    const covering = (await sub$.get(`/api/v1/substitutions/insights${range}`).expect(200)).body
      .data;
    expect(covering.totals).toMatchObject({ coveredByMe: 6, coveredForMe: 0 });
    const covered = (await coach$.get(`/api/v1/substitutions/insights${range}`).expect(200)).body
      .data;
    expect(covered.totals).toMatchObject({ coveredByMe: 0, coveredForMe: 6, pending: 1 });
    await admin$.get('/api/v1/substitutions/insights?from=2026-03-31&to=2026-03-01').expect(400);
  });
});
