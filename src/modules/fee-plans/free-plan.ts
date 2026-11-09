import { eq } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { feePlans } from '../../db/schema/index.js';

const NAMES = ['Free', 'Free (no fee)', 'Free plan'];

/**
 * The built-in ₹0 plan, created on first use. It fits a batch on any number of days and never
 * produces invoices. Not listed on the Fee plans page and can't be edited.
 */
export async function ensureFreePlan(tx: DbOrTx = db) {
  const existing = await tx.query.feePlans.findFirst({ where: eq(feePlans.isSystem, true) });
  if (existing) return existing;
  for (const name of NAMES) {
    // A clash on the name (an academy plan called "Free") tries the next one; a clash on the
    // one-system-plan index means another request just created it.
    const [row] = await tx
      .insert(feePlans)
      .values({
        name,
        description: 'No fee. No invoices are created.',
        daysPerWeek: 7,
        monthlyFee: 0,
        isSystem: true,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const now = await tx.query.feePlans.findFirst({ where: eq(feePlans.isSystem, true) });
    if (now) return now;
  }
  throw new Error('Could not create the free fee plan');
}
