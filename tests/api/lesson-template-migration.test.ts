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

/** Puts the lesson tables back to their pre-0007 shape: templates owned per coach. */
async function oldSchema() {
  for (const t of ['lesson_stages', 'lesson_events']) {
    await q(`ALTER TABLE "${t}" DROP CONSTRAINT "${t}_batch_id_batches_id_fk"`);
    await q(`DROP INDEX "${t}_batch_name_uq"`);
    await q(`DROP INDEX "${t}_batch_idx"`);
    await q(`ALTER TABLE "${t}" DROP COLUMN "batch_id"`);
    await q(`CREATE UNIQUE INDEX "${t}_coach_name_uq" ON "${t}" ("coach_id", lower("name"))`);
    await q(`CREATE INDEX "${t}_coach_idx" ON "${t}" ("coach_id", "sort_order")`);
  }
}

describe('0007 batch lesson templates migration', () => {
  it('gives every batch its own copy of the template its plans use', async () => {
    const c = await makeUser('coach');
    const d = await makeUser('coach');
    const e = await makeUser('coach'); // no batches
    const loc = await makeLocation();
    const b1 = await makeBatch(c.id, loc.id);
    const b2 = await makeBatch(c.id, loc.id, { startTime: '09:00:00', endTime: '10:00:00' });
    // b3 is now D's, but was planned by C earlier (with C's items).
    const b3 = await makeBatch(d.id, loc.id, { startTime: '11:00:00', endTime: '12:00:00' });
    await oldSchema();

    const [s] = await q(
      `INSERT INTO lesson_stages (coach_id, name, color, sort_order) VALUES ('${c.id}', 'Warm-up', '#22c55e', 0) RETURNING id`,
    );
    const [ev] = await q(
      `INSERT INTO lesson_events (coach_id, name, description, sort_order) VALUES ('${c.id}', 'Serve', 'Basics', 0) RETURNING id`,
    );
    await q(
      `INSERT INTO lesson_stages (coach_id, name, sort_order) VALUES ('${d.id}', 'warm-up', 0)`,
    );
    await q(
      `INSERT INTO lesson_events (coach_id, name, sort_order) VALUES ('${e.id}', 'Lonely', 0)`,
    );
    const sId = String(s!.id);
    const evId = String(ev!.id);
    const plans: Record<string, string> = {};
    for (const b of [b1, b2, b3]) {
      const [p] = await q(
        `INSERT INTO lesson_plans (batch_id, coach_id, date, stage_ids, event_ids)
         VALUES ('${b.id}', '${c.id}', '2026-03-09', ARRAY['${sId}']::uuid[], ARRAY['${evId}']::uuid[]) RETURNING id`,
      );
      plans[b.id] = String(p!.id);
      await q(
        `INSERT INTO lesson_plan_cells (plan_id, event_id, stage_id, content)
         VALUES ('${plans[b.id]}', '${evId}', '${sId}', 'Drill ${b.name}')`,
      );
    }

    const file = readFileSync(
      path.join(__dirname, '../../drizzle/0007_batch_lesson_templates.sql'),
      'utf8',
    );
    // The DROP INDEX statements at the top target the old indexes recreated above.
    for (const stmt of file.split('--> statement-breakpoint')) await q(stmt);

    const stages = await q(
      `SELECT id, batch_id, coach_id, name, color FROM lesson_stages ORDER BY batch_id, name`,
    );
    const events = await q(`SELECT id, batch_id, name, description FROM lesson_events`);
    // C's items: one per batch (original kept in b1); D's own stage in b3; E's unused item gone.
    expect(events.map((x) => x.name).sort()).toEqual(['Serve', 'Serve', 'Serve']);
    expect(new Set(events.map((x) => x.batch_id))).toEqual(new Set([b1.id, b2.id, b3.id]));
    expect(events.every((x) => x.description === 'Basics')).toBe(true);
    expect(events.find((x) => x.batch_id === b1.id)!.id).toBe(evId);
    expect(
      stages
        .filter((x) => x.batch_id === b3.id)
        .map((x) => x.name)
        .sort(),
    ).toEqual([expect.stringMatching(/^warm-up$/i), expect.stringMatching(/^warm-up \(2\)$/i)]);

    // Every plan and cell now points only at its own batch's template.
    for (const b of [b1, b2, b3]) {
      const [p] = await q(
        `SELECT stage_ids, event_ids FROM lesson_plans WHERE id = '${plans[b.id]}'`,
      );
      const own = (rows: Row[]) => rows.filter((x) => x.batch_id === b.id).map((x) => x.id);
      const ids = (v: unknown) =>
        Array.isArray(v) ? v : String(v).replace(/[{}]/g, '').split(',');
      expect(own(stages)).toEqual(expect.arrayContaining(ids(p!.stage_ids)));
      expect(own(events)).toEqual(ids(p!.event_ids));
      const [cell] = await q(
        `SELECT stage_id, event_id, content FROM lesson_plan_cells WHERE plan_id = '${plans[b.id]}'`,
      );
      expect(ids(p!.stage_ids)).toEqual([cell!.stage_id]);
      expect(ids(p!.event_ids)).toEqual([cell!.event_id]);
    }
    const leftovers = await q(
      `SELECT count(*)::int AS n FROM lesson_stages WHERE batch_id IS NULL`,
    );
    expect(leftovers[0]!.n).toBe(0);
  });
});
