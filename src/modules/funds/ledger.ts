import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { feePlanSplits, fundEntries, fundTxns, payees, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { formatInr } from '../../lib/money.js';
import { computeShares, type SplitNode } from './split.js';

export type Account = (typeof fundEntries.$inferInsert)['account'];

export interface Entry {
  account: Account;
  userId?: string | null;
  payeeId?: string | null;
  amount: number;
  label?: string | null;
  share?: boolean;
}

/** Serialises money movements so balance checks cannot race (transaction-scoped). */
const FUNDS_LOCK = 0x46554e44; // "FUND"
export async function lockFunds(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${FUNDS_LOCK})`);
}

/** Inserts a txn and its entries. Cash moved must equal the claims moved. */
export async function postTxn(
  tx: DbOrTx,
  txn: Omit<typeof fundTxns.$inferInsert, 'id'>,
  entries: Entry[],
) {
  const rows = entries.filter((e) => e.amount !== 0);
  const cash = rows.filter((e) => e.account === 'cash').reduce((s, e) => s + e.amount, 0);
  const claims = rows.filter((e) => e.account !== 'cash').reduce((s, e) => s + e.amount, 0);
  if (cash !== claims) throw new Error(`Unbalanced ledger txn: cash ${cash} ≠ claims ${claims}`);
  const [t] = await tx.insert(fundTxns).values(txn).returning();
  await tx.insert(fundEntries).values(
    rows.map((e) => ({
      txnId: t!.id,
      account: e.account,
      userId: e.userId ?? null,
      payeeId: e.payeeId ?? null,
      amount: e.amount,
      label: e.label ?? null,
      share: e.share ?? false,
    })),
  );
  return t!;
}

/** Current balance of one account (userId null + cash = the academy's cash). */
export async function balanceOf(
  tx: DbOrTx,
  account: Account,
  who: { userId?: string | null; payeeId?: string | null } = {},
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${fundEntries.amount}), 0)::int` })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .where(
      and(
        isNull(fundTxns.reversedAt),
        eq(fundEntries.account, account),
        who.payeeId ? eq(fundEntries.payeeId, who.payeeId) : undefined,
        who.payeeId
          ? undefined
          : who.userId
            ? eq(fundEntries.userId, who.userId)
            : isNull(fundEntries.userId),
      ),
    );
  return row?.total ?? 0;
}

/** 422 unless `holder` (null = academy) has at least `amount` in cash. */
export async function requireCash(tx: DbOrTx, holderId: string | null, amount: number) {
  const have = await balanceOf(tx, 'cash', { userId: holderId });
  if (have < amount) {
    throw AppError.unprocessable(
      `${holderId ? 'Only' : 'The academy has only'} ${formatInr(Math.max(have, 0))} in hand${
        holderId ? ' with this person' : ''
      }.`,
    );
  }
}

type SplitRow = typeof feePlanSplits.$inferSelect;

/** Builds the nested tree from a plan's rows. */
export function buildTree(rows: SplitRow[]): SplitNode[] {
  const sorted = [...rows].sort((x, y) => x.position - y.position);
  const toNode = (r: SplitRow): SplitNode => ({
    name: r.name,
    kind: r.kind,
    value: r.value,
    recipient: r.recipient,
    userId: r.userId,
    payeeId: r.payeeId,
    children: sorted.filter((c) => c.parentId === r.id).map(toNode),
  });
  return sorted.filter((r) => !r.parentId).map(toNode);
}

export async function loadSplitTree(tx: DbOrTx, feePlanId: string | null): Promise<SplitNode[]> {
  if (!feePlanId) return [];
  return buildTree(
    await tx.select().from(feePlanSplits).where(eq(feePlanSplits.feePlanId, feePlanId)),
  );
}

export interface FeeSplitInput {
  paymentId: string;
  amount: number;
  paidOn: string;
  title: string;
  feePlanId: string | null;
  batchCoachId: string | null;
  collector: { id: string; role: 'admin' | 'coach' };
  /** Where the money physically is now. Admin collections always go to the academy. */
  heldBy: 'collector' | 'academy';
}

/**
 * Records the distribution of a received fee. The holder's cash goes up by the full amount and
 * each section's recipient is credited. A coach holding the cash keeps their own share straight
 * away, so they only owe the academy the rest.
 */
export async function postFeeSplit(tx: DbOrTx, input: FeeSplitInput) {
  const tree = await loadSplitTree(tx, input.feePlanId);
  const shares = computeShares(tree, input.amount, input.batchCoachId);
  const holder =
    input.collector.role === 'coach' && input.heldBy === 'collector' ? input.collector.id : null;
  const kept = holder
    ? shares
        .filter((s) => s.account === 'staff_due' && s.userId === holder)
        .reduce((n, s) => n + s.amount, 0)
    : 0;
  return postTxn(
    tx,
    {
      type: 'fee_split',
      occurredOn: input.paidOn,
      amount: input.amount,
      title: input.title,
      paymentId: input.paymentId,
      userId: input.collector.id,
      createdById: input.collector.id,
    },
    [
      { account: 'cash', userId: holder, amount: input.amount },
      ...shares.map((s) => ({ ...s, share: true })),
      // Coach keeps their own share out of the cash they collected.
      { account: 'staff_due', userId: holder, amount: -kept, label: 'Kept by coach' },
      { account: 'cash', userId: holder, amount: -kept },
    ],
  );
}

/** Undoes the split of a payment that was reverted or refunded. */
export async function reverseFeeSplit(tx: DbOrTx, paymentId: string, byId: string, reason: string) {
  await tx
    .update(fundTxns)
    .set({ reversedAt: new Date(), reversedById: byId, reversalReason: reason })
    .where(and(eq(fundTxns.paymentId, paymentId), isNull(fundTxns.reversedAt)));
}

/** The live split of one payment (optionally only one staff member's lines). */
export async function paymentShares(paymentId: string, onlyUserId?: string) {
  const rows = await db
    .select({
      label: fundEntries.label,
      account: fundEntries.account,
      userId: fundEntries.userId,
      amount: fundEntries.amount,
      userName: users.name,
      payeeName: payees.name,
    })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .leftJoin(users, eq(users.id, fundEntries.userId))
    .leftJoin(payees, eq(payees.id, fundEntries.payeeId))
    .where(
      and(
        isNull(fundTxns.reversedAt),
        eq(fundTxns.paymentId, paymentId),
        eq(fundEntries.share, true),
        onlyUserId ? eq(fundEntries.userId, onlyUserId) : undefined,
      ),
    );
  return rows.map((r) => ({
    label: r.label ?? 'Academy',
    name: r.account === 'academy_fund' ? 'Academy' : (r.payeeName ?? r.userName ?? 'Unknown'),
    amount: r.amount,
  }));
}
