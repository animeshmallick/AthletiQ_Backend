import { and, asc, count, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_GEOFENCE_RADIUS_M } from '../../config/constants.js';
import { db } from '../../db/client.js';
import { batches, locations } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { parse, zBoolQuery, zIdParam, zName, zOptionalText } from '../../lib/validation.js';
import { requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';

export const locationsRouter = Router();

const LocationBody = z.object({
  name: zName,
  address: zOptionalText(500),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(5000).default(DEFAULT_GEOFENCE_RADIUS_M),
  isActive: z.boolean().default(true),
});

const ListQuery = z.object({ active: zBoolQuery });

locationsRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const usage = db
    .select({ locationId: batches.locationId, n: count().as('n') })
    .from(batches)
    .where(eq(batches.isActive, true))
    .groupBy(batches.locationId)
    .as('usage');

  const rows = await db
    .select({ location: locations, activeBatches: usage.n })
    .from(locations)
    .leftJoin(usage, eq(usage.locationId, locations.id))
    .where(q.active === undefined ? undefined : eq(locations.isActive, q.active))
    .orderBy(asc(locations.name));

  ok(
    res,
    rows.map((r) => ({ ...r.location, activeBatches: Number(r.activeBatches ?? 0) })),
  );
});

locationsRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const loc = await db.query.locations.findFirst({ where: eq(locations.id, id) });
  if (!loc) throw AppError.notFound('Location');
  ok(res, loc);
});

locationsRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(LocationBody, req.body);
  const [loc] = await db.insert(locations).values(body).returning();
  await audit({
    ...auditCtx(req),
    action: 'location.created',
    entityType: 'location',
    entityId: loc!.id,
  });
  created(res, loc);
});

locationsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(LocationBody.partial(), req.body);

  if (body.isActive === false) {
    const [inUse] = await db
      .select({ n: count() })
      .from(batches)
      .where(and(eq(batches.locationId, id), eq(batches.isActive, true)));
    if ((inUse?.n ?? 0) > 0) {
      throw AppError.unprocessable(
        'Move active batches to another location before deactivating this one.',
      );
    }
  }

  const [loc] = await db.update(locations).set(body).where(eq(locations.id, id)).returning();
  if (!loc) throw AppError.notFound('Location');
  await audit({
    ...auditCtx(req),
    action: 'location.updated',
    entityType: 'location',
    entityId: id,
    metadata: body,
  });
  ok(res, loc);
});
