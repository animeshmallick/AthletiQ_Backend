/** Who covers which batch on which day (approved substitutions only). */
import { and, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { batchSubstitutions, batches, users } from '../../db/schema/index.js';
import { todayInAppTz, type IsoDate } from '../../lib/dates.js';

const approvedOn = (day: IsoDate) =>
  and(
    eq(batchSubstitutions.status, 'approved'),
    lte(batchSubstitutions.fromDate, day),
    gte(batchSubstitutions.toDate, day),
  );

/** SQL: the batch is covered by `userId` on `day`. */
export function coveredBy(userId: string, day: IsoDate): SQL {
  return inArray(
    batches.id,
    db
      .select({ id: batchSubstitutions.batchId })
      .from(batchSubstitutions)
      .where(and(eq(batchSubstitutions.substituteCoachId, userId), approvedOn(day))),
  );
}

/** SQL: `userId` covers the batch on some current or upcoming day. */
export function coveringNowOrLater(userId: string): SQL {
  return inArray(
    batches.id,
    db
      .select({ id: batchSubstitutions.batchId })
      .from(batchSubstitutions)
      .where(
        and(
          eq(batchSubstitutions.substituteCoachId, userId),
          eq(batchSubstitutions.status, 'approved'),
          gte(batchSubstitutions.toDate, todayInAppTz()),
        ),
      ),
  );
}

/** The substitute (if any) for each batch on `day`. */
export async function substitutesOn(batchIds: string[], day: IsoDate) {
  if (!batchIds.length) return new Map<string, { id: string; name: string }>();
  const rows = await db
    .select({
      batchId: batchSubstitutions.batchId,
      id: users.id,
      name: users.name,
    })
    .from(batchSubstitutions)
    .innerJoin(users, eq(users.id, batchSubstitutions.substituteCoachId))
    .where(and(inArray(batchSubstitutions.batchId, batchIds), approvedOn(day)));
  return new Map(rows.map((r) => [r.batchId, { id: r.id, name: r.name }]));
}

/** A coach's current and upcoming substitutions, keyed by batch (earliest first). */
export async function myCoverage(userId: string) {
  const rows = await db
    .select({
      id: batchSubstitutions.id,
      batchId: batchSubstitutions.batchId,
      fromDate: batchSubstitutions.fromDate,
      toDate: batchSubstitutions.toDate,
    })
    .from(batchSubstitutions)
    .where(
      and(
        eq(batchSubstitutions.substituteCoachId, userId),
        eq(batchSubstitutions.status, 'approved'),
        gte(batchSubstitutions.toDate, todayInAppTz()),
      ),
    )
    .orderBy(batchSubstitutions.fromDate);
  const map = new Map<string, { id: string; fromDate: string; toDate: string }>();
  for (const r of rows) if (!map.has(r.batchId)) map.set(r.batchId, r);
  return map;
}
