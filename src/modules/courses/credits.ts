/**
 * Student credits: money owed to a student that comes off a later invoice, or is refunded.
 *
 *  held        waiting for a course decision (re-admit / move → assigned; leave → refund or forfeit)
 *  assigned    taken off the next invoice(s) of `enrollmentId`, oldest credit first
 *  applied     taken off `appliedInvoiceId` (a credit larger than an invoice is split)
 *  refund_due  owed back; an admin records it as refunded (or forfeited)
 *
 * Every function takes the caller's transaction: credits always move together with the invoice
 * or membership change that caused them.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { enrollments, invoices, studentCredits } from '../../db/schema/index.js';

/**
 * Takes assigned credits off an invoice being created for `enrollmentId`: returns how much to
 * subtract (≤ `total`) and the credits to mark applied once the invoice exists.
 */
export async function takeCredits(
  tx: DbOrTx,
  enrollmentId: string,
  total: number,
): Promise<{ amount: number; apply: (invoiceId: string) => Promise<void> }> {
  if (total <= 0) return { amount: 0, apply: () => Promise.resolve() };
  const open = await tx
    .select()
    .from(studentCredits)
    .where(
      and(eq(studentCredits.enrollmentId, enrollmentId), eq(studentCredits.status, 'assigned')),
    )
    .orderBy(asc(studentCredits.createdAt))
    .for('update');
  let left = total;
  const plan: { id: string; use: number; rest: number }[] = [];
  for (const c of open) {
    if (left <= 0) break;
    const use = Math.min(c.amount, left);
    plan.push({ id: c.id, use, rest: c.amount - use });
    left -= use;
  }
  const amount = total - left;
  return {
    amount,
    apply: async (invoiceId: string) => {
      for (const p of plan) {
        const [c] = await tx
          .update(studentCredits)
          .set({ status: 'applied', amount: p.use, appliedInvoiceId: invoiceId })
          .where(eq(studentCredits.id, p.id))
          .returning();
        // The part not needed stays assigned to the same membership (a new credit row).
        if (p.rest > 0)
          await tx.insert(studentCredits).values({
            studentId: c!.studentId,
            kind: c!.kind,
            amount: p.rest,
            status: 'assigned',
            enrollmentId: c!.enrollmentId,
            roundId: c!.roundId,
            sourceInvoiceId: c!.sourceInvoiceId,
            reason: c!.reason,
            note: 'Remainder after part was applied',
          });
      }
    },
  };
}

/**
 * Credits applied to an invoice that is being cancelled or refunded go back: to `to` when given
 * (e.g. held for a course decision), otherwise assigned again to the same membership while it is
 * open, or owed back (refund_due) once it has ended. Returns their ids.
 */
export async function releaseApplied(
  tx: DbOrTx,
  invoiceId: string,
  to?: { status: 'held'; roundId: string },
): Promise<string[]> {
  const rows = await tx
    .select({ id: studentCredits.id, enrollmentId: studentCredits.enrollmentId })
    .from(studentCredits)
    .where(
      and(eq(studentCredits.appliedInvoiceId, invoiceId), eq(studentCredits.status, 'applied')),
    )
    .for('update');
  for (const r of rows) {
    let status: 'held' | 'assigned' | 'refund_due' = 'refund_due';
    if (to) status = to.status;
    else if (r.enrollmentId) {
      const open = await tx.$count(
        enrollments,
        and(eq(enrollments.id, r.enrollmentId), isNull(enrollments.effectiveTo)),
      );
      if (open) status = 'assigned';
    }
    await tx
      .update(studentCredits)
      .set({
        status,
        appliedInvoiceId: null,
        ...(to ? { roundId: to.roundId } : {}),
      })
      .where(eq(studentCredits.id, r.id));
  }
  return rows.map((r) => r.id);
}

/**
 * Applies an assigned credit to its membership's oldest unpaid invoice right away (instead of
 * waiting for the next one to be issued). Splits the credit when it is larger than the invoice.
 * Returns the invoice it went on, or null when there is no unpaid invoice (it stays assigned).
 */
export async function applyToUnpaidInvoice(tx: DbOrTx, creditId: string): Promise<string | null> {
  const [c] = await tx
    .select()
    .from(studentCredits)
    .where(eq(studentCredits.id, creditId))
    .for('update');
  if (c?.status !== 'assigned' || !c.enrollmentId) return null;
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.enrollmentId, c.enrollmentId), eq(invoices.status, 'due')))
    .orderBy(asc(invoices.issueDate))
    .limit(1)
    .for('update');
  if (!inv || inv.totalAmount <= 0) return null;
  const use = Math.min(c.amount, inv.totalAmount);
  const totalAmount = inv.totalAmount - use;
  await tx
    .update(invoices)
    .set({
      creditAmount: inv.creditAmount + use,
      totalAmount,
      ...(totalAmount === 0 ? { status: 'paid' as const, paidAt: new Date() } : {}),
      notes: inv.notes ? `${inv.notes}\n${c.reason}` : c.reason,
    })
    .where(eq(invoices.id, inv.id));
  await tx
    .update(studentCredits)
    .set({ status: 'applied', amount: use, appliedInvoiceId: inv.id })
    .where(eq(studentCredits.id, c.id));
  if (c.amount > use)
    await tx.insert(studentCredits).values({
      studentId: c.studentId,
      kind: c.kind,
      amount: c.amount - use,
      status: 'assigned',
      enrollmentId: c.enrollmentId,
      roundId: c.roundId,
      sourceInvoiceId: c.sourceInvoiceId,
      reason: c.reason,
      note: 'Remainder after part was applied',
    });
  return inv.id;
}
