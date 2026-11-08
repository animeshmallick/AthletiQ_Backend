import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, locations, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { todayInAppTz } from '../../lib/dates.js';
import { created, ok } from '../../lib/http.js';
import {
  parse,
  zBoolQuery,
  zId,
  zIdParam,
  zIsoDate,
  zName,
  zTime,
  zWeekdays,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { currentMembers, expectedRoster } from './roster.js';

export const batchesRouter = Router();

const coach = alias(users, 'coach');

const memberCounts = () =>
  db
    .select({ batchId: enrollments.batchId, n: count().as('n') })
    .from(enrollments)
    .where(isNull(enrollments.effectiveTo))
    .groupBy(enrollments.batchId)
    .as('members');

function batchSelect(members: ReturnType<typeof memberCounts>) {
  return {
    id: batches.id,
    name: batches.name,
    weekdays: batches.weekdays,
    startTime: batches.startTime,
    endTime: batches.endTime,
    capacity: batches.capacity,
    isActive: batches.isActive,
    createdAt: batches.createdAt,
    coach: { id: coach.id, name: coach.name, phone: coach.phone },
    location: {
      id: locations.id,
      name: locations.name,
      latitude: locations.latitude,
      longitude: locations.longitude,
      radiusMeters: locations.radiusMeters,
    },
    memberCount: sql<number>`coalesce(${members.n}, 0)::int`,
  };
}

const ListQuery = z.object({
  active: zBoolQuery,
  coachId: zId.optional(),
  locationId: zId.optional(),
});

batchesRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  if (!isAdmin(user)) filters.push(eq(batches.coachId, user.id));
  else if (q.coachId) filters.push(eq(batches.coachId, q.coachId));
  if (q.locationId) filters.push(eq(batches.locationId, q.locationId));
  if (q.active !== undefined) filters.push(eq(batches.isActive, q.active));

  const members = memberCounts();
  const rows = await db
    .select(batchSelect(members))
    .from(batches)
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .leftJoin(members, eq(members.batchId, batches.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(batches.startTime), asc(batches.name));
  ok(res, rows);
});

batchesRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertBatchAccess(currentUser(req), id);
  const members = memberCounts();
  const [row] = await db
    .select(batchSelect(members))
    .from(batches)
    .innerJoin(coach, eq(coach.id, batches.coachId))
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .leftJoin(members, eq(members.batchId, batches.id))
    .where(eq(batches.id, id));
  ok(res, { ...row, members: await currentMembers(id) });
});

/** Students expected at the session on `date` (defaults to today). */
batchesRouter.get('/:id/roster', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { date } = parse(z.object({ date: zIsoDate.optional() }), req.query);
  await assertBatchAccess(currentUser(req), id);
  const day = date ?? todayInAppTz();
  ok(res, { date: day, students: await expectedRoster(id, day) });
});

// ─── Admin mutations ─────────────────────────────────────────────────────────

const BatchBody = z.object({
  name: zName,
  coachId: zId,
  locationId: zId,
  weekdays: zWeekdays,
  startTime: zTime,
  endTime: zTime,
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  isActive: z.boolean().default(true),
});

async function assertCoach(coachId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, coachId) });
  if (u?.role !== 'coach') throw AppError.unprocessable('Selected coach does not exist');
  if (u.status === 'disabled') throw AppError.unprocessable('Selected coach is disabled');
}

async function assertLocation(locationId: string) {
  const l = await db.query.locations.findFirst({ where: eq(locations.id, locationId) });
  if (!l) throw AppError.unprocessable('Selected location does not exist');
  if (!l.isActive) throw AppError.unprocessable('Selected location is inactive');
}

batchesRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(BatchBody, req.body);
  if (body.endTime <= body.startTime)
    throw AppError.badRequest('End time must be after start time');
  await Promise.all([assertCoach(body.coachId), assertLocation(body.locationId)]);
  const [batch] = await db
    .insert(batches)
    .values({ ...body, capacity: body.capacity ?? null })
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'batch.created',
    entityType: 'batch',
    entityId: batch!.id,
    metadata: body,
  });
  created(res, batch);
});

batchesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(BatchBody.partial(), req.body);
  const existing = await assertBatchAccess(currentUser(req), id);

  const start = body.startTime ?? existing.startTime;
  const end = body.endTime ?? existing.endTime;
  if (end <= start) throw AppError.badRequest('End time must be after start time');
  if (body.coachId && body.coachId !== existing.coachId) await assertCoach(body.coachId);
  if (body.locationId && body.locationId !== existing.locationId)
    await assertLocation(body.locationId);

  const members = await currentMembers(id);
  if (body.weekdays) {
    const allowed = new Set(body.weekdays);
    const conflicts = members.filter((m) => m.trainingDays.some((d) => !allowed.has(d)));
    if (conflicts.length) {
      throw AppError.unprocessable(
        'Some students train on days this batch would no longer run. Update their training days first.',
        {
          students: conflicts.map((c) => ({
            id: c.studentId,
            name: c.fullName,
            trainingDays: c.trainingDays,
          })),
        },
      );
    }
  }
  if (body.isActive === false && members.length) {
    throw AppError.unprocessable('Transfer all students out of this batch before deactivating it.');
  }

  const [batch] = await db.update(batches).set(body).where(eq(batches.id, id)).returning();
  await audit({
    ...auditCtx(req),
    action:
      body.coachId && body.coachId !== existing.coachId
        ? 'batch.coach_reassigned'
        : 'batch.updated',
    entityType: 'batch',
    entityId: id,
    metadata: { changes: body, previousCoachId: existing.coachId },
  });
  ok(res, batch);
});
