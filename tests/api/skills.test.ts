import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client';
import { students } from '../../src/db/schema';
import { tasksFor } from '../../src/modules/tasks/tasks.service';
import { as, getApp, makeAcademy, makeSport, makeStudent, setToday } from '../helpers/factories';

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function setup() {
  setToday('2026-03-20');
  const a = await makeAcademy();
  const asha = await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, fullName: 'Asha Rao' },
    a.admin.id,
  );
  const ben = await makeStudent(
    { batchId: a.batch.id, feePlanId: a.plan.id, fullName: 'Ben Das' },
    a.admin.id,
  );
  // The coach's API client; `relogin` after moving the clock (tokens expire).
  const api = { c: await as(a.coach) };
  const sheet = (await api.c.get(`/api/v1/skills/batches/${a.batch.id}`).expect(200)).body.data;
  const skillIds: string[] = sheet.framework.areas.flatMap((x: { skills: { id: string }[] }) =>
    x.skills.map((k) => k.id),
  );
  const rate = (studentId: string, ratings: number[], extra: object = {}) =>
    api.c.put('/api/v1/skills/assessments', {
      batchId: a.batch.id,
      studentId,
      ratings: skillIds.map((skillId, i) => ({ skillId, rating: ratings[i] })),
      ...extra,
    });
  const relogin = async () => {
    api.c = await as(a.coach);
  };
  return {
    ...a,
    asha,
    ben,
    get c() {
      return api.c;
    },
    relogin,
    sheet,
    skillIds,
    rate,
  };
}

describe('sports and frameworks', () => {
  it('lists sports with skills and levels; admins edit, retiring rated skills', async () => {
    const s = await setup();
    const admin = await as(s.admin);
    const list = (await s.c.get('/api/v1/sports').expect(200)).body.data;
    expect(list[0]).toMatchObject({ sport: { name: 'Badminton' }, batches: 2 });
    expect(list[0].levels.map((l: { name: string }) => l.name)).toEqual([
      'Foundation',
      'Bronze',
      'Gold',
    ]);
    await s.c.post('/api/v1/sports', { name: 'Football' }).expect(403);

    const football = (await admin.post('/api/v1/sports', { name: 'Football' }).expect(201)).body
      .data;
    // New sports start on the standard A1–C2 ladder.
    expect(football.levels.map((l: { code: string }) => l.code)).toEqual([
      'A1',
      'A2',
      'B1',
      'B2',
      'C1',
      'C2',
    ]);
    await admin.post('/api/v1/sports', { name: 'football' }).expect(409);

    // Rate once so the first skill has history, then remove it from the framework.
    await s.rate(s.asha.id, [3, 3, 3, 3]).expect(200);
    const f = list[0];
    const body = {
      areas: f.areas.map(
        (
          area: { id: string; name: string; skills: { id: string; name: string }[] },
          i: number,
        ) => ({
          id: area.id,
          name: area.name,
          skills: (i === 0 ? area.skills.slice(1) : area.skills).map((k) => ({
            id: k.id,
            name: k.name,
          })),
        }),
      ),
      levels: [
        { name: 'Starter', minScore: 100 },
        { name: 'Pro', minScore: 400 },
      ],
    };
    body.areas.push({
      name: 'Fitness',
      skills: [{ name: 'Stamina', description: 'Lasts a full game' }],
    });
    const saved = (await admin.put(`/api/v1/sports/${f.sport.id}/framework`, body).expect(200)).body
      .data;
    expect(saved.areas.map((x: { name: string }) => x.name)).toEqual([
      'Footwork',
      'Strokes',
      'Fitness',
    ]);
    const retired = saved.areas[0].skills.find((k: { isActive: boolean }) => !k.isActive);
    expect(retired.name).toBe('Split step'); // kept for history, no longer assessed
    expect(saved.levels.map((l: { name: string }) => l.name)).toEqual(['Starter', 'Pro']);

    await admin
      .put(`/api/v1/sports/${f.sport.id}/framework`, {
        ...body,
        levels: [
          { name: 'A', minScore: 200 },
          { name: 'B', minScore: 200 },
        ],
      })
      .expect(422);
    // A sport used by active batches can't be switched off.
    await admin.patch(`/api/v1/sports/${f.sport.id}`, { isActive: false }).expect(422);
    await admin.patch(`/api/v1/sports/${football.sport.id}`, { isActive: false }).expect(200);
  });
});

describe('monthly assessments', () => {
  it('the main coach rates every skill this month; the level follows the average', async () => {
    const s = await setup();
    expect(s.sheet).toMatchObject({ editable: true, month: '2026-03-01' });
    expect(s.sheet.students.map((x: { fullName: string }) => x.fullName)).toEqual([
      'Asha Rao',
      'Ben Das',
    ]);

    // Every skill must be rated.
    const partial = await s.c
      .put('/api/v1/skills/assessments', {
        batchId: s.batch.id,
        studentId: s.asha.id,
        ratings: [{ skillId: s.skillIds[0], rating: 3 }],
      })
      .expect(400);
    expect(partial.body.error.message).toBe('Rate every skill (3 left)');

    const saved = await s.rate(s.asha.id, [3, 2, 3, 2], {
      comment: 'Good effort',
      goals: 'Net play',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ average: 250, levelName: 'Bronze', levelCode: 'B1' });
    // Editing within the month updates the same assessment; the level can go down.
    const again = (await s.rate(s.asha.id, [2, 2, 2, 2]).expect(200)).body.data;
    expect(again).toMatchObject({ id: saved.body.data.id, average: 200, levelName: 'Foundation' });

    // Not the batch's coach / admins can't rate; not a member; not this batch's skills.
    await (
      await as(s.otherCoach)
    )
      .put('/api/v1/skills/assessments', {
        batchId: s.batch.id,
        studentId: s.asha.id,
        ratings: [{ skillId: s.skillIds[0], rating: 3 }],
      })
      .expect(403);
    await (
      await as(s.admin)
    )
      .put('/api/v1/skills/assessments', {
        batchId: s.batch.id,
        studentId: s.asha.id,
        ratings: [{ skillId: s.skillIds[0], rating: 3 }],
      })
      .expect(403);
    await (await as(s.otherCoach)).get(`/api/v1/skills/batches/${s.batch.id}`).expect(404);
    const outsider = await makeStudent(
      { batchId: s.otherBatch.id, feePlanId: s.plan.id },
      s.admin.id,
    );
    await s.rate(outsider.id, [3, 3, 3, 3]).expect(422);

    // Admins view read-only.
    const adminView = (
      await (await as(s.admin)).get(`/api/v1/skills/batches/${s.batch.id}`).expect(200)
    ).body.data;
    expect(adminView.editable).toBe(false);
    expect(adminView.students[0].current).toMatchObject({ average: 200, comment: null });

    // Next month: last month is locked, and shows as the previous assessment.
    setToday('2026-04-02');
    await s.relogin();
    const march = (await s.c.get(`/api/v1/skills/batches/${s.batch.id}?month=2026-03`).expect(200))
      .body.data;
    expect(march.editable).toBe(false);
    const april = (await s.c.get(`/api/v1/skills/batches/${s.batch.id}`).expect(200)).body.data;
    expect(april.students[0]).toMatchObject({ current: null, previous: { average: 200 } });
    await s.c.get(`/api/v1/skills/batches/${s.batch.id}?month=2026-05`).expect(400);
    await s.rate(s.asha.id, [4, 4, 4, 4]).expect(200);

    const history = (await s.c.get(`/api/v1/skills/students/${s.asha.id}`).expect(200)).body.data;
    expect(history).toHaveLength(1);
    expect(history[0].assessments.map((x: { month: string }) => x.month)).toEqual([
      '2026-03-01',
      '2026-04-01',
    ]);
    expect(history[0].current).toMatchObject({ average: 400, levelName: 'Gold', change: 200 });
    expect(history[0].areas[0]).toMatchObject({ name: 'Footwork', now: 400, before: 200 });
    await (await as(s.otherCoach)).get(`/api/v1/skills/students/${s.asha.id}`).expect(404);
  });

  it('summarises coverage, batches, movers and levels', async () => {
    const s = await setup();
    await s.rate(s.asha.id, [2, 2, 2, 2]).expect(200);
    await s.rate(s.ben.id, [4, 4, 4, 4]).expect(200);
    setToday('2026-04-20');
    await s.relogin();
    await s.rate(s.asha.id, [4, 4, 3, 3]).expect(200); // up 1.5, Foundation → Bronze

    const mine = (await s.c.get('/api/v1/skills/insights').expect(200)).body.data;
    expect(mine.totals).toMatchObject({
      students: 2,
      assessed: 1,
      coverage: 50,
      improved: 1,
      promoted: 1,
    });
    expect(mine.coverage).toHaveLength(1); // only their own batch
    expect(mine.coverage[0].pending.map((p: { fullName: string }) => p.fullName)).toEqual([
      'Ben Das',
    ]);
    expect(mine.improved[0]).toMatchObject({ fullName: 'Asha Rao', change: 150, levelChange: 1 });
    expect(mine.heatmap[0].areas).toEqual([
      expect.objectContaining({ name: 'Footwork', average: 400 }), // Asha 4,4 and Ben 4,4
      expect.objectContaining({ name: 'Strokes', average: 350 }),
    ]);
    expect(mine.levels[0].levels).toEqual([
      { code: 'A1', name: 'Foundation', n: 0 },
      { code: 'B1', name: 'Bronze', n: 1 },
      { code: 'C1', name: 'Gold', n: 1 },
    ]);
    expect(mine.coaches).toEqual([]);
    expect(mine.trend.at(-1)).toMatchObject({ month: '2026-04-01', assessed: 1 });

    const all = (await (await as(s.admin)).get('/api/v1/skills/insights').expect(200)).body.data;
    expect(all.coverage).toHaveLength(2);
    expect(all.coaches.find((c: { name: string }) => c.name === s.coach.name)).toMatchObject({
      students: 2,
      assessed: 1,
      averageGiven: 350,
    });

    // From the 15th, the coach is reminded about students still to assess.
    const tasks = await tasksFor({
      id: s.coach.id,
      role: 'coach',
      name: s.coach.name,
      email: s.coach.email,
    });
    expect(tasks.items.find((t) => t.kind === 'skill-assessments')).toMatchObject({
      title: '1 student to assess this month',
      count: 1,
    });
  });
});

describe('student photos', () => {
  it('stores a real JPEG or PNG for people who can see the student', async () => {
    const s = await setup();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    );
    await s.c
      .put(`/api/v1/students/${s.asha.id}/photo`, { data: png.toString('base64') })
      .expect(200);
    const got = await s.c
      .get(`/api/v1/students/${s.asha.id}/photo`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    await s.c
      .put(`/api/v1/students/${s.asha.id}/photo`, {
        data: Buffer.from('<svg onload=alert(1)>').toString('base64'),
      })
      .expect(422);
    await (await as(s.otherCoach)).get(`/api/v1/students/${s.asha.id}/photo`).expect(404);
    const sheet = (await s.c.get(`/api/v1/skills/batches/${s.batch.id}`).expect(200)).body.data;
    expect(sheet.students[0].hasPhoto).toBe(true);
    await s.c.delete(`/api/v1/students/${s.asha.id}/photo`).expect(200);
    await s.c.get(`/api/v1/students/${s.asha.id}/photo`).expect(404);
  });
});

describe('registration numbers and report links', () => {
  it('gives every student a registration number, shown only on the profile', async () => {
    const s = await setup();
    const [asha, ben] = await Promise.all(
      [s.asha.id, s.ben.id].map((id) =>
        db.query.students.findFirst({ where: eq(students.id, id) }),
      ),
    );
    expect(ben!.registrationNo).toBe(asha!.registrationNo + 1);
    expect(asha!.registrationNo).toBeGreaterThanOrEqual(1001);
    const profile = (await s.c.get(`/api/v1/students/${s.asha.id}`).expect(200)).body.data;
    expect(JSON.stringify(profile)).toContain(String(asha!.registrationNo));
    const list = (await s.c.get('/api/v1/students').expect(200)).body.data;
    expect(list[0].registrationNo).toBeUndefined();
  });

  it('opens a report link only with the right registration number, and locks after five misses', async () => {
    const s = await setup();
    await s
      .rate(s.asha.id, [3, 3, 4, 4], { comment: 'Strong smash', goals: 'Footwork' })
      .expect(200);
    const link = (await s.c.post(`/api/v1/reports/students/${s.asha.id}/links`).expect(201)).body
      .data;
    expect(link.url).toMatch(/^https:\/\/app\.test\/share\/report\/[\w-]{20,}$/);
    const token = link.url.split('/').pop() as string;
    const regNo = String(
      (await db.query.students.findFirst({ where: eq(students.id, s.asha.id) }))!.registrationNo,
    );

    const info = (await request(getApp()).get(`/api/v1/public/reports/${token}`).expect(200)).body
      .data;
    expect(info).toMatchObject({ kind: 'report', student: 'Asha', title: 'Progress report' });

    const pdf = await request(getApp())
      .post(`/api/v1/public/reports/${token}/pdf`)
      .send({ registrationNo: regNo })
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const listed = (await s.c.get(`/api/v1/reports/students/${s.asha.id}/links`).expect(200)).body
      .data;
    expect(listed).toEqual([expect.objectContaining({ id: link.id, views: 1 })]);

    // Five wrong numbers lock the link, even for the right number.
    for (let i = 0; i < 4; i++) {
      await request(getApp())
        .post(`/api/v1/public/reports/${token}/pdf`)
        .send({ registrationNo: '0000' })
        .expect(403);
    }
    const locked = await request(getApp())
      .post(`/api/v1/public/reports/${token}/pdf`)
      .send({ registrationNo: '0000' })
      .expect(429);
    expect(locked.body.error.message).toBe(
      'Too many wrong registration numbers. Try again in 30 minutes.',
    );
    await request(getApp())
      .post(`/api/v1/public/reports/${token}/pdf`)
      .send({ registrationNo: regNo })
      .expect(429);

    // Another coach can't revoke; the creator can, and then it's dead.
    await (await as(s.otherCoach)).delete(`/api/v1/reports/links/${link.id}`).expect(404);
    await s.c.delete(`/api/v1/reports/links/${link.id}`).expect(200);
    await request(getApp()).get(`/api/v1/public/reports/${token}`).expect(403);

    // Links expire after 30 days.
    const fresh = (await s.c.post(`/api/v1/reports/students/${s.asha.id}/links`).expect(201)).body
      .data;
    expect(new Date(fresh.expiresAt).getTime() - Date.now()).toBe(30 * 86_400_000);
    setToday('2026-04-21');
    await s.relogin();
    await request(getApp())
      .get(`/api/v1/public/reports/${fresh.url.split('/').pop()}`)
      .expect(403);
  });
});

describe('batch sport', () => {
  it('batches show their sport and can move to another one', async () => {
    const s = await setup();
    const tennis = await makeSport('Tennis');
    const admin = await as(s.admin);
    const b = (await admin.get(`/api/v1/batches/${s.batch.id}`).expect(200)).body.data;
    expect(b.sport.name).toBe('Badminton');
    await admin.patch(`/api/v1/batches/${s.batch.id}`, { sportId: tennis.id }).expect(200);
    const sheet = (await s.c.get(`/api/v1/skills/batches/${s.batch.id}`).expect(200)).body.data;
    expect(sheet.framework.sport.name).toBe('Tennis');
  });
});

describe('framework edge cases', () => {
  it('retires areas with history, deletes empty ones, and validates input', async () => {
    const s = await setup();
    await s.rate(s.asha.id, [3, 3, 3, 3]).expect(200); // Footwork and Strokes now have history
    const admin = await as(s.admin);
    const f = (await admin.get('/api/v1/sports').expect(200)).body.data[0];
    const levels = [{ name: 'Starter', minScore: 100 }];
    // Add an empty-to-be area, then drop it and Footwork.
    const added = (
      await admin
        .put(`/api/v1/sports/${f.sport.id}/framework`, {
          areas: [
            ...f.areas.map(
              (a: { id: string; name: string; skills: { id: string; name: string }[] }) => ({
                id: a.id,
                name: a.name,
                skills: a.skills.map((k) => ({ id: k.id, name: k.name })),
              }),
            ),
            { name: 'Mindset', skills: [{ name: 'Focus' }] },
          ],
          levels,
        })
        .expect(200)
    ).body.data;
    const strokes = added.areas.find((a: { name: string }) => a.name === 'Strokes');
    const saved = (
      await admin
        .put(`/api/v1/sports/${f.sport.id}/framework`, {
          areas: [
            {
              id: strokes.id,
              name: 'Strokes',
              skills: strokes.skills.map((k: { id: string; name: string }) => ({
                id: k.id,
                name: k.name,
              })),
            },
          ],
          levels,
        })
        .expect(200)
    ).body.data;
    // Footwork had ratings: kept but retired. Mindset never rated: gone.
    expect(
      saved.areas.map((a: { name: string; isActive: boolean }) => [a.name, a.isActive]),
    ).toEqual([
      ['Strokes', true],
      ['Footwork', false],
    ]);
    const unknown = '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c';
    await admin
      .put(`/api/v1/sports/${f.sport.id}/framework`, {
        areas: [{ id: unknown, name: 'X', skills: [{ name: 'Y' }] }],
        levels,
      })
      .expect(422);
    await admin
      .put(`/api/v1/sports/${f.sport.id}/framework`, {
        areas: [{ name: 'X', skills: [{ id: unknown, name: 'Y' }] }],
        levels,
      })
      .expect(422);
    await admin
      .put(`/api/v1/sports/${f.sport.id}/framework`, {
        areas: [{ name: 'X', skills: [{ name: 'Y' }] }],
        levels: [
          { name: 'A', minScore: 100 },
          { name: 'a', minScore: 200 },
        ],
      })
      .expect(422);
    await admin
      .put(`/api/v1/sports/${unknown}/framework`, {
        areas: [{ name: 'X', skills: [{ name: 'Y' }] }],
        levels,
      })
      .expect(404);
    await admin.patch(`/api/v1/sports/${unknown}`, { name: 'Nope' }).expect(404);
    // Ratings for skills outside the batch's framework are refused.
    await s.c
      .put('/api/v1/skills/assessments', {
        batchId: s.batch.id,
        studentId: s.asha.id,
        ratings: [{ skillId: unknown, rating: 3 }],
      })
      .expect(422);
  });

  it('limits batch reports to the coach’s own batches and checks photo size', async () => {
    const s = await setup();
    await s.c
      .get(`/api/v1/reports/students/${s.asha.id}/pdf?batchId=${s.batch.id}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    await s.c
      .get(`/api/v1/reports/students/${s.asha.id}/pdf?batchId=${s.otherBatch.id}`)
      .expect(422);
    const big = Buffer.alloc(450 * 1024, 0xff);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    await s.c
      .put(`/api/v1/students/${s.asha.id}/photo`, { data: big.toString('base64') })
      .expect(400);
    await (
      await as(s.admin)
    )
      .delete('/api/v1/reports/links/6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c')
      .expect(404);
    // Admins can revoke anyone's link.
    const link = (await s.c.post(`/api/v1/reports/students/${s.asha.id}/links`).expect(201)).body
      .data;
    await (await as(s.admin)).delete(`/api/v1/reports/links/${link.id}`).expect(200);
  });
});
