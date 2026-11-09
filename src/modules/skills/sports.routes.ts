/**
 * Sports and their skill frameworks.
 *  - GET  /sports                 every sport with its areas, skills and levels (all signed-in users).
 *  - POST /sports                 admin: a new sport (starts with the standard five-level ladder).
 *  - PATCH /sports/:id            admin: rename / activate / deactivate.
 *  - PUT  /sports/:id/framework   admin: save areas, skills and levels in one go. Skills or areas
 *    that have ratings are retired (kept for history) rather than deleted.
 */
import { and, count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  skillAreas,
  skillRatings,
  skills,
  sportLevels,
  sports,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zName, zOptionalText } from '../../lib/validation.js';
import { requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { loadFramework, loadFrameworks, STANDARD_LEVELS } from './framework.js';

export const sportsRouter = Router();

/** New sports start on the standard A1–C2 ladder. */
const DEFAULT_LEVELS = STANDARD_LEVELS;

sportsRouter.get('/', async (_req, res) => {
  const rows = await db.select({ id: sports.id }).from(sports).orderBy(sports.name);
  const [frameworks, usage] = await Promise.all([
    loadFrameworks(rows.map((r) => r.id)),
    db.select({ sportId: batches.sportId, n: count() }).from(batches).groupBy(batches.sportId),
  ]);
  ok(
    res,
    rows.map((r) => {
      const f = frameworks.find((x) => x.sport.id === r.id)!;
      return { ...f, batches: usage.find((u) => u.sportId === r.id)?.n ?? 0 };
    }),
  );
});

const SportBody = z.object({ name: zName.max(60) });

sportsRouter.post('/', requireAdmin, async (req, res) => {
  const { name } = parse(SportBody, req.body);
  const sport = await db.transaction(async (tx) => {
    const [s] = await tx.insert(sports).values({ name }).returning();
    await tx
      .insert(sportLevels)
      .values(DEFAULT_LEVELS.map((l, i) => ({ ...l, sportId: s!.id, position: i + 1 })));
    return s!;
  });
  await audit({
    ...auditCtx(req),
    action: 'sport.created',
    entityType: 'sport',
    entityId: sport.id,
    metadata: { name },
  });
  created(res, await loadFramework(sport.id));
});

sportsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(
    z.object({ name: zName.max(60).optional(), isActive: z.boolean().optional() }),
    req.body,
  );
  if (body.isActive === false) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(batches)
      .where(and(eq(batches.sportId, id), eq(batches.isActive, true)));
    if (n) throw AppError.unprocessable(`${n} active batches train this sport. Move them first.`);
  }
  const [s] = await db.update(sports).set(body).where(eq(sports.id, id)).returning();
  if (!s) throw AppError.notFound('Sport');
  await audit({
    ...auditCtx(req),
    action: 'sport.updated',
    entityType: 'sport',
    entityId: id,
    metadata: body,
  });
  ok(res, await loadFramework(id));
});

const FrameworkBody = z.object({
  areas: z
    .array(
      z.object({
        id: zId.optional(),
        name: zName.max(60),
        skills: z
          .array(
            z.object({
              id: zId.optional(),
              name: zName.max(80),
              description: zOptionalText(300),
            }),
          )
          .min(1, 'Each area needs at least one skill')
          .max(20),
      }),
    )
    .min(1, 'Add at least one skill area')
    .max(15),
  levels: z
    .array(
      z.object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z][0-9]?$/, 'A letter and a digit, e.g. B1')
          .nullable()
          .optional(),
        name: zName.max(60),
        minScore: z.number().int().min(100).max(500),
      }),
    )
    .max(10),
});

sportsRouter.put('/:id/framework', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(FrameworkBody, req.body);
  const levels = [...body.levels].sort((a, b) => a.minScore - b.minScore);
  if (new Set(levels.map((l) => l.minScore)).size !== levels.length)
    throw AppError.unprocessable('Each level needs a different minimum score');
  if (new Set(levels.map((l) => l.name.toLowerCase())).size !== levels.length)
    throw AppError.unprocessable('Level names must be different');

  await db.transaction(async (tx) => {
    const sport = await tx.query.sports.findFirst({ where: eq(sports.id, id) });
    if (!sport) throw AppError.notFound('Sport');
    const existingAreas = await tx.select().from(skillAreas).where(eq(skillAreas.sportId, id));
    const existingSkills = existingAreas.length
      ? await tx
          .select()
          .from(skills)
          .where(
            inArray(
              skills.areaId,
              existingAreas.map((a) => a.id),
            ),
          )
      : [];
    const areaIds = new Set(existingAreas.map((a) => a.id));
    const skillIds = new Set(existingSkills.map((k) => k.id));

    const keptSkills: string[] = [];
    const keptAreas: string[] = [];
    for (const [ai, area] of body.areas.entries()) {
      let areaId = area.id;
      if (areaId) {
        if (!areaIds.has(areaId)) throw AppError.unprocessable('Unknown skill area');
        await tx
          .update(skillAreas)
          .set({ name: area.name, position: ai + 1, isActive: true })
          .where(eq(skillAreas.id, areaId));
      } else {
        const [a] = await tx
          .insert(skillAreas)
          .values({ sportId: id, name: area.name, position: ai + 1 })
          .returning();
        areaId = a!.id;
      }
      keptAreas.push(areaId);
      for (const [si, skill] of area.skills.entries()) {
        const values = {
          areaId,
          name: skill.name,
          description: skill.description ?? null,
          position: si + 1,
          isActive: true,
        };
        if (skill.id) {
          if (!skillIds.has(skill.id)) throw AppError.unprocessable('Unknown skill');
          await tx.update(skills).set(values).where(eq(skills.id, skill.id));
          keptSkills.push(skill.id);
        } else {
          const [k] = await tx.insert(skills).values(values).returning();
          keptSkills.push(k!.id);
        }
      }
    }

    // Removed skills: delete if never rated, otherwise retire (history keeps their ratings).
    const removed = existingSkills.filter((k) => !keptSkills.includes(k.id)).map((k) => k.id);
    if (removed.length) {
      const rated = await tx
        .selectDistinct({ skillId: skillRatings.skillId })
        .from(skillRatings)
        .where(inArray(skillRatings.skillId, removed));
      const ratedIds = rated.map((r) => r.skillId);
      const unrated = removed.filter((r) => !ratedIds.includes(r));
      if (ratedIds.length)
        await tx.update(skills).set({ isActive: false }).where(inArray(skills.id, ratedIds));
      if (unrated.length) await tx.delete(skills).where(inArray(skills.id, unrated));
    }
    const removedAreas = existingAreas.filter((a) => !keptAreas.includes(a.id)).map((a) => a.id);
    if (removedAreas.length) {
      // Areas still holding (retired) skills are retired; empty ones go.
      const holding = await tx
        .selectDistinct({ areaId: skills.areaId })
        .from(skills)
        .where(inArray(skills.areaId, removedAreas));
      const holdingIds = holding.map((h) => h.areaId);
      if (holdingIds.length)
        await tx
          .update(skillAreas)
          .set({ isActive: false, position: sql`${skillAreas.position} + 100` })
          .where(inArray(skillAreas.id, holdingIds));
      const empty = removedAreas.filter((a) => !holdingIds.includes(a));
      if (empty.length) await tx.delete(skillAreas).where(inArray(skillAreas.id, empty));
    }

    // Levels are a ladder; assessments keep a snapshot of the level name, so replace freely.
    await tx.delete(sportLevels).where(eq(sportLevels.sportId, id));
    if (levels.length)
      await tx.insert(sportLevels).values(
        levels.map((l, i) => ({
          sportId: id,
          code: l.code ?? null,
          name: l.name,
          minScore: l.minScore,
          position: i + 1,
        })),
      );
    // Keep retired skills out of the way of the ones assessed.
    if (keptAreas.length)
      await tx
        .update(skills)
        .set({ position: sql`${skills.position} + 100` })
        .where(
          and(
            inArray(skills.areaId, keptAreas),
            eq(skills.isActive, false),
            notInArray(skills.id, keptSkills.length ? keptSkills : [id]),
            sql`${skills.position} < 100`,
          ),
        );
  });
  await audit({
    ...auditCtx(req),
    action: 'sport.framework_updated',
    entityType: 'sport',
    entityId: id,
    metadata: {
      areas: body.areas.length,
      skills: body.areas.reduce((n, a) => n + a.skills.length, 0),
      levels: levels.length,
    },
  });
  ok(res, await loadFramework(id));
});
