/**
 * Everything about one payee: what they earned (fee shares), what they were paid, what is owed and
 * since when, where the money comes from (batches, plans, students), which plans include them and
 * what to expect each month. Amounts are paise. Reversed transactions are excluded from totals
 * but stay visible in the history.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  feePlans,
  feePlanSplits,
  fundEntries,
  fundTxns,
  invoices,
  payees,
  payments,
  students,
  users,
} from '../../db/schema/index.js';
import { todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { effectiveMonthlyFee } from '../students/students.service.js';
import { loadSplitTree } from './ledger.js';
import { computeShares } from './split.js';

export interface Period {
  from?: IsoDate;
  to?: IsoDate;
}

export interface HistoryItem {
  id: string;
  kind: 'share' | 'payout';
  date: IsoDate;
  /** + earned, − paid. */
  amount: number;
  title: string;
  detail: string | null;
  reversed: boolean;
  reversalReason: string | null;
  /** Owed to the payee after this item (reversed items don't move it). */
  balance: number;
  invoice?: { id: string; number: string } | null;
  student?: { id: string; name: string } | null;
}

const inPeriod = (d: IsoDate, p: Period) => (!p.from || d >= p.from) && (!p.to || d <= p.to);
const monthOf = (d: IsoDate) => d.slice(0, 7);

/** Months from `from` to `to` inclusive, as "YYYY-MM". */
function months(from: IsoDate, to: IsoDate): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const end = monthOf(to);
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= end) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function sharesOf(payeeId: string) {
  return db
    .select({
      entryId: fundEntries.id,
      amount: fundEntries.amount,
      label: fundEntries.label,
      date: fundTxns.occurredOn,
      reversedAt: fundTxns.reversedAt,
      reversalReason: fundTxns.reversalReason,
      mode: payments.mode,
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      invoiceTotal: invoices.totalAmount,
      batchId: invoices.batchId,
      batchName: invoices.batchName,
      feePlanId: invoices.feePlanId,
      feePlanName: invoices.feePlanName,
      studentId: students.id,
      studentName: students.fullName,
    })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .leftJoin(payments, eq(payments.id, fundTxns.paymentId))
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(students, eq(students.id, invoices.studentId))
    .where(and(eq(fundEntries.payeeId, payeeId), eq(fundEntries.share, true)))
    .orderBy(asc(fundTxns.occurredOn), asc(fundTxns.createdAt));
}

async function payoutsOf(payeeId: string) {
  const fromUser = alias(users, 'from_user');
  const byUser = alias(users, 'by_user');
  const fromEntry = alias(fundEntries, 'from_entry');
  return db
    .select({
      id: fundTxns.id,
      date: fundTxns.occurredOn,
      amount: fundTxns.amount,
      note: fundTxns.note,
      reference: fundTxns.reference,
      createdAt: fundTxns.createdAt,
      reversedAt: fundTxns.reversedAt,
      reversalReason: fundTxns.reversalReason,
      fromName: fromUser.name,
      byName: byUser.name,
    })
    .from(fundTxns)
    .leftJoin(fromEntry, and(eq(fromEntry.txnId, fundTxns.id), eq(fromEntry.account, 'cash')))
    .leftJoin(fromUser, eq(fromUser.id, fromEntry.userId))
    .leftJoin(byUser, eq(byUser.id, fundTxns.createdById))
    .where(and(eq(fundTxns.type, 'payout'), eq(fundTxns.payeeId, payeeId)))
    .orderBy(asc(fundTxns.occurredOn), asc(fundTxns.createdAt));
}

/** Fee plans whose split includes this payee, with what each current student brings them. */
async function plansOf(payeeId: string) {
  const planIds = (
    await db
      .selectDistinct({ id: feePlanSplits.feePlanId })
      .from(feePlanSplits)
      .where(eq(feePlanSplits.payeeId, payeeId))
  ).map((r) => r.id);
  if (!planIds.length) return [];
  const [plans, members] = await Promise.all([
    db.select().from(feePlans).where(inArray(feePlans.id, planIds)),
    db
      .select({
        feePlanId: batches.feePlanId,
        batchId: batches.id,
        batchName: batches.name,
        coachId: batches.coachId,
        customMonthlyFee: enrollments.customMonthlyFee,
        monthlyDiscount: enrollments.monthlyDiscount,
      })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .where(
        and(
          inArray(batches.feePlanId, planIds),
          isNull(enrollments.effectiveTo),
          eq(batches.isActive, true),
        ),
      ),
  ]);
  return Promise.all(
    plans.map(async (p) => {
      const tree = await loadSplitTree(db, p.id);
      const shareOf = (amount: number, coachId: string | null) =>
        computeShares(tree, amount, coachId)
          .filter((l) => l.payeeId === payeeId)
          .reduce((n, l) => n + l.amount, 0);
      const mine = members.filter((m) => m.feePlanId === p.id);
      const byBatch = new Map<
        string,
        { id: string; name: string; students: number; expected: number }
      >();
      for (const m of mine) {
        const fee = effectiveMonthlyFee(p.monthlyFee, m.customMonthlyFee, m.monthlyDiscount).total;
        const b = byBatch.get(m.batchId) ?? {
          id: m.batchId,
          name: m.batchName,
          students: 0,
          expected: 0,
        };
        b.students++;
        b.expected += shareOf(fee, m.coachId);
        byBatch.set(m.batchId, b);
      }
      const batchList = [...byBatch.values()].sort((a, b) => b.expected - a.expected);
      return {
        id: p.id,
        name: p.name,
        monthlyFee: p.monthlyFee,
        isActive: p.isActive,
        /** The payee's share of one full plan fee. */
        perStudent: shareOf(p.monthlyFee, null),
        students: mine.length,
        /** From current students at their own fee, per month. */
        expectedMonthly: batchList.reduce((n, b) => n + b.expected, 0),
        batches: batchList,
      };
    }),
  );
}

export async function payeeInsights(payeeId: string, period: Period) {
  const payee = await db.query.payees.findFirst({ where: eq(payees.id, payeeId) });
  if (!payee) throw AppError.notFound('Payee');
  const today = todayInAppTz();
  const [shares, payouts, plans] = await Promise.all([
    sharesOf(payeeId),
    payoutsOf(payeeId),
    plansOf(payeeId),
  ]);

  // One chronological ledger with a running balance.
  const items: (HistoryItem & { sort: string })[] = [
    ...shares.map((s) => ({
      id: s.entryId,
      kind: 'share' as const,
      date: s.date,
      amount: s.amount,
      title: s.studentName ? `Share of ${s.studentName}’s fee` : (s.label ?? 'Fee share'),
      detail: [s.invoiceNumber, s.batchName, s.label].filter(Boolean).join(' · ') || null,
      reversed: !!s.reversedAt,
      reversalReason: s.reversalReason,
      balance: 0,
      invoice: s.invoiceId ? { id: s.invoiceId, number: s.invoiceNumber! } : null,
      student: s.studentId ? { id: s.studentId, name: s.studentName! } : null,
      sort: `${s.date}|0`,
    })),
    ...payouts.map((p) => ({
      id: p.id,
      kind: 'payout' as const,
      date: p.date,
      amount: -p.amount,
      title: `Paid${p.fromName ? ` from ${p.fromName}’s cash` : ' from academy cash'}`,
      detail:
        [p.reference && `Ref ${p.reference}`, p.note, p.byName && `by ${p.byName}`]
          .filter(Boolean)
          .join(' · ') || null,
      reversed: !!p.reversedAt,
      reversalReason: p.reversalReason,
      balance: 0,
      sort: `${p.date}|1|${p.createdAt.toISOString()}`,
    })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));
  let running = 0;
  for (const i of items) {
    if (!i.reversed) running += i.amount;
    i.balance = running;
  }
  const live = items.filter((i) => !i.reversed);
  const owedNow = running;

  const sum = (list: typeof items) => list.reduce((n, i) => n + i.amount, 0);
  const liveShares = live.filter((i) => i.kind === 'share');
  const livePayouts = live.filter((i) => i.kind === 'payout');
  const periodShares = liveShares.filter((i) => inPeriod(i.date, period));
  const periodPayouts = livePayouts.filter((i) => inPeriod(i.date, period));
  const opening = period.from ? sum(live.filter((i) => i.date < period.from!)) : 0;

  // Oldest share not yet covered by payouts (first-in, first-out): how long they've waited.
  const paidTotal = -sum(livePayouts);
  let covered = 0;
  let unpaidSince: IsoDate | null = null;
  for (const s of liveShares) {
    covered += s.amount;
    if (covered > paidTotal) {
      unpaidSince = s.date;
      break;
    }
  }

  // Month by month across the period (or since the first activity).
  const first = live[0]?.date ?? today;
  const range = months(period.from ?? first, period.to && period.to < today ? period.to : today);
  const monthly = range.map((month) => ({
    month,
    earned: sum(periodShares.filter((i) => monthOf(i.date) === month)),
    paid: -sum(periodPayouts.filter((i) => monthOf(i.date) === month)),
  }));

  // Where the money came from in the period.
  const group = (
    key: (s: (typeof shares)[number]) => string | null,
    name: (s: (typeof shares)[number]) => string,
  ) => {
    const map = new Map<string, { id: string; name: string; amount: number; count: number }>();
    for (const s of shares) {
      if (s.reversedAt || !inPeriod(s.date, period)) continue;
      const k = key(s) ?? 'other';
      const row = map.get(k) ?? { id: k, name: name(s), amount: 0, count: 0 };
      row.amount += s.amount;
      row.count++;
      map.set(k, row);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  };
  const byBatch = group(
    (s) => s.batchId,
    (s) => s.batchName ?? 'Other',
  );
  const byPlan = group(
    (s) => s.feePlanId,
    (s) => s.feePlanName ?? 'Other',
  );
  const byStudent = group(
    (s) => s.studentId,
    (s) => s.studentName ?? 'Other',
  );

  const earned = sum(periodShares);
  const activeMonths = Math.max(1, monthly.filter((m) => m.month <= monthOf(today)).length);
  const lastPayout = livePayouts.at(-1);
  const expectedMonthly = plans.reduce((n, p) => n + p.expectedMonthly, 0);

  return {
    payee,
    period: { from: period.from ?? null, to: period.to ?? null },
    summary: {
      owedNow,
      unpaidSince,
      unpaidDays: unpaidSince
        ? Math.round((Date.parse(today) - Date.parse(unpaidSince)) / 86_400_000)
        : 0,
      earned,
      paid: -sum(periodPayouts),
      opening,
      closing: opening + sum(periodShares) + sum(periodPayouts),
      avgMonthly: Math.round(earned / activeMonths),
      lifetimeEarned: sum(liveShares),
      lifetimePaid: paidTotal,
      payouts: periodPayouts.length,
      shares: periodShares.length,
      students: byStudent.filter((s) => s.id !== 'other').length,
      lastPayout: lastPayout ? { date: lastPayout.date, amount: -lastPayout.amount } : null,
      expectedMonthly,
      /** Share of everything earned that has been paid out, in %. */
      payoutRate: sum(liveShares) ? Math.round((paidTotal / sum(liveShares)) * 100) : null,
    },
    monthly,
    sources: { byBatch, byPlan, byStudent: byStudent.slice(0, 10) },
    plans,
    history: items
      .filter((i) => inPeriod(i.date, period))
      .reverse()
      .map(({ sort: _s, ...i }) => i),
  };
}

export type PayeeInsights = Awaited<ReturnType<typeof payeeInsights>>;

/** Per-payee totals for the Payees list (all time, plus this period's earnings). */
export async function payeeSummaries(period: Period) {
  const rows = await db.select().from(payees);
  return Promise.all(
    rows.map(async (p) => {
      const i = await payeeInsights(p.id, period);
      return {
        ...p,
        owedNow: i.summary.owedNow,
        unpaidDays: i.summary.unpaidDays,
        earned: i.summary.earned,
        paid: i.summary.paid,
        lastPayout: i.summary.lastPayout,
        expectedMonthly: i.summary.expectedMonthly,
        plans: i.plans.length,
        students: i.plans.reduce((n, pl) => n + pl.students, 0),
      };
    }),
  );
}
