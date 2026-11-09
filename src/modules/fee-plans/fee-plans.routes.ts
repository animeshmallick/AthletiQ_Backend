import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, feePlans } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import {
  parse,
  zBoolQuery,
  zIdParam,
  zName,
  zOptionalText,
  zPaise,
  patchOf,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { saveSplit, splitTrees } from '../funds/split.routes.js';
import { audit, auditCtx } from '../audit/audit.service.js';

export const feePlansRouter = Router();

const PlanBody = z.object({
  name: zName,
  description: zOptionalText(500),
  daysPerWeek: z.number().int().min(1).max(7),
  /** Paise. */
  monthlyFee: zPaise,
  isActive: z.boolean().default(true),
});

const ListQuery = z.object({ active: zBoolQuery });

feePlansRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const usage = db
    .select({ feePlanId: batches.feePlanId, n: count().as('n') })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(isNull(enrollments.effectiveTo))
    .groupBy(batches.feePlanId)
    .as('usage');

  const rows = await db
    .select({ plan: feePlans, activeStudents: usage.n })
    .from(feePlans)
    .leftJoin(usage, eq(usage.feePlanId, feePlans.id))
    .where(q.active === undefined ? undefined : eq(feePlans.isActive, q.active))
    .orderBy(asc(feePlans.daysPerWeek), asc(feePlans.monthlyFee));

  // Admins also get each plan's fee split ([] = everything to the academy).
  const splits = currentUser(req).role === 'admin' ? await splitTrees() : null;
  ok(
    res,
    rows.map((r) => ({
      ...r.plan,
      activeStudents: Number(r.activeStudents ?? 0),
      ...(splits ? { split: splits.get(r.plan.id) ?? [] } : {}),
    })),
  );
});

feePlansRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(PlanBody, req.body);
  const [plan] = await db.insert(feePlans).values(body).returning();
  await audit({
    ...auditCtx(req),
    action: 'fee_plan.created',
    entityType: 'fee_plan',
    entityId: plan!.id,
    metadata: body,
  });
  created(res, plan);
});

/**
 * Price changes apply to invoices generated from now on; already-issued invoices keep the
 * amount snapshotted at generation.
 */
feePlansRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(patchOf(PlanBody), req.body);

  if (body.isActive === false) {
    const [inUse] = await db
      .select({ n: count() })
      .from(batches)
      .where(and(eq(batches.feePlanId, id), eq(batches.isActive, true)));
    if ((inUse?.n ?? 0) > 0) {
      throw AppError.unprocessable(
        'Active batches use this plan. Give them another plan before deactivating it.',
      );
    }
  }

  const before = await db.query.feePlans.findFirst({ where: eq(feePlans.id, id) });
  if (!before) throw AppError.notFound('Fee plan');
  const [plan] = await db.update(feePlans).set(body).where(eq(feePlans.id, id)).returning();
  await audit({
    ...auditCtx(req),
    action: 'fee_plan.updated',
    entityType: 'fee_plan',
    entityId: id,
    metadata: {
      before: { monthlyFee: before.monthlyFee, daysPerWeek: before.daysPerWeek },
      changes: body,
    },
  });
  ok(res, plan);
});

feePlansRouter.put('/:id/split', requireAdmin, saveSplit);
