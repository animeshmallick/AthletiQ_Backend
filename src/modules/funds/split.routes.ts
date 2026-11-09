import { and, eq, inArray } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { db } from '../../db/client.js';
import { feePlans, feePlanSplits, payees, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zIdParam } from '../../lib/validation.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { buildTree, loadSplitTree } from './ledger.js';
import { validateTree, type SplitNode } from './split.js';
import { SplitBody, toTree } from './split-schema.js';

/** All plans' split trees, keyed by plan id (plans without one are absent). */
export async function splitTrees(): Promise<Map<string, SplitNode[]>> {
  const rows = await db.select().from(feePlanSplits);
  const byPlan = new Map<string, typeof rows>();
  for (const r of rows) byPlan.set(r.feePlanId, [...(byPlan.get(r.feePlanId) ?? []), r]);
  return new Map([...byPlan].map(([planId, planRows]) => [planId, buildTree(planRows)]));
}

/**
 * PUT /fee-plans/:id/split (admin). Replaces the plan's whole split. Applies to payments
 * recorded from now on; earlier payments keep the split they were recorded with unless an admin
 * recalculates them.
 */
export async function saveSplit(req: Request, res: Response) {
  const { id } = parse(zIdParam, req.params);
  const tree = toTree(parse(SplitBody, req.body).sections);
  const plan = await db.query.feePlans.findFirst({ where: eq(feePlans.id, id) });
  if (!plan) throw AppError.notFound('Fee plan');

  const errors = tree.length ? validateTree(tree) : [];
  const leaves = tree.flatMap((n) => (n.children.length ? n.children : [n]));
  const userIds = [...new Set(leaves.flatMap((n) => (n.userId ? [n.userId] : [])))];
  const payeeIds = [...new Set(leaves.flatMap((n) => (n.payeeId ? [n.payeeId] : [])))];
  if (userIds.length) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.status, 'active')));
    if (found.length !== userIds.length)
      errors.push({ path: 'sections', message: 'A chosen staff member is not active' });
  }
  if (payeeIds.length) {
    const found = await db
      .select({ id: payees.id })
      .from(payees)
      .where(and(inArray(payees.id, payeeIds), eq(payees.isActive, true)));
    if (found.length !== payeeIds.length)
      errors.push({ path: 'sections', message: 'A chosen payee is not active' });
  }
  if (errors.length) {
    throw new AppError('VALIDATION_ERROR', errors[0]!.message, {
      fields: errors.map((e) => ({
        path: `sections${e.path ? `.${e.path}` : ''}`,
        message: e.message,
      })),
    });
  }

  const before = await loadSplitTree(db, id);
  await db.transaction(async (tx) => {
    await tx.delete(feePlanSplits).where(eq(feePlanSplits.feePlanId, id));
    for (const [i, n] of tree.entries()) {
      const { children, ...rest } = n;
      const [parent] = await tx
        .insert(feePlanSplits)
        .values({ ...rest, feePlanId: id, position: i })
        .returning({ id: feePlanSplits.id });
      if (children.length) {
        await tx.insert(feePlanSplits).values(
          children.map(({ children: _none, ...c }, j) => ({
            ...c,
            feePlanId: id,
            parentId: parent!.id,
            position: j,
          })),
        );
      }
    }
    await audit(
      {
        ...auditCtx(req),
        action: 'fee_plan.split_updated',
        entityType: 'fee_plan',
        entityId: id,
        metadata: { before, after: tree },
      },
      tx,
    );
  });
  ok(res, await loadSplitTree(db, id));
}
