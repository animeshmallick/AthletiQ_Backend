import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { makeBatch, makeLocation, makeUser } from '../helpers/factories';
import { db } from '../helpers/test-db';

type Row = Record<string, unknown>;
const q = async (s: string) => {
  const r = (await db.execute(sql.raw(s))) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};
const ids = (v: unknown) => (Array.isArray(v) ? v : String(v).replace(/[{}]/g, '').split(','));

const file = readFileSync(path.join(__dirname, '../../drizzle/0017_lesson_library.sql'), 'utf8');
const statements = file.split('--> statement-breakpoint').map((s) => s.trim());
/** The data step: minutes out of stage names, then one item per name per coach. */
const dataStep = statements.filter(
  (s) => s.startsWith('UPDATE "lesson_stages" SET') || s.startsWith('WITH "d"'),
);
const coachIndexes = statements.filter((s) =>
  /CREATE (UNIQUE )?INDEX "lesson_(stages|events)_coach/.test(s),
);

describe('0017 lesson library migration', () => {
  it('reads minutes from stage names and merges a coach’s per-batch templates', async () => {
    const c = await makeUser('coach');
    const loc = await makeLocation();
    const b1 = await makeBatch(c.id, loc.id);
    const b2 = await makeBatch(c.id, loc.id, { startTime: '09:00:00', endTime: '10:00:00' });
    // Back to per-batch names, as before the migration.
    for (const t of ['lesson_stages', 'lesson_events']) {
      await q(`DROP INDEX "${t}_coach_name_uq"`);
      await q(`DROP INDEX "${t}_coach_idx"`);
    }
    const stage = async (batch: string, name: string, at: string) =>
      String(
        (
          await q(
            `INSERT INTO lesson_stages (batch_id, coach_id, name, created_at) VALUES ('${batch}', '${c.id}', '${name}', '${at}') RETURNING id`,
          )
        )[0]!.id,
      );
    const event = async (batch: string, name: string, at: string) =>
      String(
        (
          await q(
            `INSERT INTO lesson_events (batch_id, coach_id, name, created_at) VALUES ('${batch}', '${c.id}', '${name}', '${at}') RETURNING id`,
          )
        )[0]!.id,
      );
    const warm1 = await stage(b1.id, '10min Warm-up', '2026-01-01');
    const drills = await stage(b1.id, 'Ball drills (20 mins)', '2026-01-02');
    const cool = await stage(b1.id, 'Cool down - 5 minutes', '2026-01-03');
    const plain = await stage(b1.id, 'Free play', '2026-01-04');
    const only = await stage(b1.id, '15 min', '2026-01-05'); // nothing left: kept as is
    const warm2 = await stage(b2.id, 'Warm-up 8min', '2026-02-01'); // same name in another batch
    const serve1 = await event(b1.id, 'Serve', '2026-01-01');
    const serve2 = await event(b2.id, 'serve', '2026-02-01');

    const [plan] = await q(
      `INSERT INTO lesson_plans (batch_id, coach_id, date, stage_ids, event_ids)
       VALUES ('${b2.id}', '${c.id}', '2026-03-10', ARRAY['${warm2}']::uuid[], ARRAY['${serve2}']::uuid[]) RETURNING id`,
    );
    const planId = String(plan!.id);
    await q(
      `INSERT INTO lesson_plan_cells (plan_id, event_id, stage_id, content)
       VALUES ('${planId}', '${serve2}', '${warm2}', 'Shadow serves')`,
    );

    for (const s of dataStep) await q(s);
    for (const s of coachIndexes) await q(s); // names are now unique per coach

    const stages = await q(
      `SELECT id, name, duration_min FROM lesson_stages WHERE coach_id = '${c.id}' ORDER BY created_at`,
    );
    expect(stages.map((s) => [s.id, s.name, s.duration_min])).toEqual([
      [warm1, 'Warm-up', 10],
      [drills, 'Ball drills', 20],
      [cool, 'Cool down', 5],
      [plain, 'Free play', null],
      [only, '15 min', null],
    ]);
    const events = await q(`SELECT id FROM lesson_events WHERE coach_id = '${c.id}'`);
    expect(events.map((e) => e.id)).toEqual([serve1]);

    // The plan and its cell now point at the kept items.
    const [p] = await q(`SELECT stage_ids, event_ids FROM lesson_plans WHERE id = '${planId}'`);
    expect(ids(p!.stage_ids)).toEqual([warm1]);
    expect(ids(p!.event_ids)).toEqual([serve1]);
    const [cell] = await q(
      `SELECT stage_id, event_id, content FROM lesson_plan_cells WHERE plan_id = '${planId}'`,
    );
    expect(cell).toMatchObject({ stage_id: warm1, event_id: serve1, content: 'Shadow serves' });
  });
});
