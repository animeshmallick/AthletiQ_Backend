import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { getAcademySettings } from '../settings/settings.js';
import { payeeInsights, payeeSummaries } from './payee-insights.js';
import { renderPayeeStatement } from './payee-statement-pdf.js';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  feePlanSplits,
  fundEntries,
  fundTxns,
  invoices,
  payees,
  payments,
  students,
  users,
} from '../../db/schema/index.js';
import { diffDays, startOfMonth, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { formatInr } from '../../lib/money.js';
import { created, ok, pageMeta } from '../../lib/http.js';
import {
  parse,
  zBoolQuery,
  zId,
  zIdParam,
  zIsoDate,
  zName,
  zOptionalText,
  zPagination,
  patchOf,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { noticeAdmins, noticeStaff } from './notices.js';
import type { AuthUser } from '../auth/auth.types.js';
import { balanceOf, lockFunds, postFeeSplit, postTxn, requireCash, type Entry } from './ledger.js';

export const fundsRouter = Router();

export const EXPENSE_CATEGORIES = [
  'equipment',
  'venue',
  'travel',
  'tournament',
  'maintenance',
  'refreshments',
  'other',
] as const;

const zAmount = z.number().int().min(1, 'Enter an amount').max(100_000_000);
const zPastDate = zIsoDate.refine((d) => d <= todayInAppTz(), 'Date cannot be in the future');

const isAdminUser = (u: AuthUser) => u.role === 'admin';

async function staffMember(id: string) {
  const u = await db.query.users.findFirst({
    columns: { id: true, name: true, role: true, status: true },
    where: eq(users.id, id),
  });
  if (!u) throw AppError.notFound('Staff member');
  return u;
}

/**
 * Payees a coach may pay from the cash they hold: those named in the fee split of a plan used by
 * a current student of a batch the coach is in charge of.
 */
async function coachPayeeIds(coachId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ payeeId: feePlanSplits.payeeId })
    .from(feePlanSplits)
    .innerJoin(batches, eq(batches.feePlanId, feePlanSplits.feePlanId))
    .innerJoin(
      enrollments,
      and(eq(enrollments.batchId, batches.id), isNull(enrollments.effectiveTo)),
    )
    .where(and(eq(batches.coachId, coachId), sql`${feePlanSplits.payeeId} is not null`));
  return rows.map((r) => r.payeeId!);
}

// ─── Payees ──────────────────────────────────────────────────────────────────

const PayeeBody = z.object({
  name: zName.max(80),
  note: zOptionalText(300),
  isActive: z.boolean().default(true),
});

fundsRouter.get('/payees', requireAdmin, async (_req, res) => {
  ok(res, await db.select().from(payees).orderBy(desc(payees.isActive), asc(payees.name)));
});

const PeriodQuery = z
  .object({ from: zIsoDate.optional(), to: zIsoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'From must be before to' });

/** Payees with what they're owed, earned and paid (the Payees page list). */
fundsRouter.get('/payees/summary', requireAdmin, async (req, res) => {
  const period = parse(PeriodQuery, req.query);
  const list = await payeeSummaries(period);
  list.sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      b.owedNow - a.owedNow ||
      a.name.localeCompare(b.name),
  );
  ok(res, list);
});

/** Everything about one payee: totals, monthly trend, sources, plans, expected share, history. */
fundsRouter.get('/payees/:id/insights', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  ok(res, await payeeInsights(id, parse(PeriodQuery, req.query)));
});

/** Downloadable statement for a period. */
fundsRouter.get('/payees/:id/statement', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const data = await payeeInsights(id, parse(PeriodQuery, req.query));
  const pdf = await renderPayeeStatement(data, await getAcademySettings());
  const slug = data.payee.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="Statement-${slug}.pdf"`)
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
});

fundsRouter.get('/payable', async (req, res) => {
  const user = currentUser(req);
  const ids = isAdminUser(user) ? null : await coachPayeeIds(user.id);
  const list =
    ids && !ids.length
      ? []
      : await db
          .select({ id: payees.id, name: payees.name })
          .from(payees)
          .where(and(eq(payees.isActive, true), ids ? inArray(payees.id, ids) : undefined))
          .orderBy(asc(payees.name));
  const owed = await Promise.all(list.map((p) => balanceOf(db, 'payee_due', { payeeId: p.id })));
  ok(res, {
    cash: isAdminUser(user) ? null : await balanceOf(db, 'cash', { userId: user.id }),
    payees: list.map((p, i) => ({ ...p, owed: owed[i]! })),
  });
});

fundsRouter.post('/payees', requireAdmin, async (req, res) => {
  const body = parse(PayeeBody, req.body);
  const [p] = await db.insert(payees).values(body).onConflictDoNothing().returning();
  if (!p) throw AppError.conflict('A payee with this name already exists');
  await audit({
    ...auditCtx(req),
    action: 'payee.created',
    entityType: 'payee',
    entityId: p.id,
    metadata: body,
  });
  created(res, p);
});

fundsRouter.patch('/payees/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(patchOf(PayeeBody), req.body);
  const [p] = await db.update(payees).set(body).where(eq(payees.id, id)).returning();
  if (!p) throw AppError.notFound('Payee');
  await audit({
    ...auditCtx(req),
    action: 'payee.updated',
    entityType: 'payee',
    entityId: id,
    metadata: body,
  });
  ok(res, p);
});

// ─── Overview ────────────────────────────────────────────────────────────────

const RangeQuery = z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() });

function range(q: z.output<typeof RangeQuery>) {
  const today = todayInAppTz();
  const to = q.to ?? today;
  const from = q.from ?? startOfMonth(today);
  if (to < from) throw AppError.badRequest('"to" must be on or after "from"');
  if (diffDays(from, to) > 731) throw AppError.badRequest('Date range cannot exceed two years');
  return { from, to };
}

const live = isNull(fundTxns.reversedAt);
const sumEntries = sql<number>`coalesce(sum(${fundEntries.amount}), 0)::int`;
const sumTxns = sql<number>`coalesce(sum(${fundTxns.amount}), 0)::int`;

/**
 * GET /funds/overview?from&to
 * Admin: every balance now (who holds cash, the academy's own fund, who is owed), plus what
 * happened in the period (collected, where fees went, kept by coaches, handed over, spent, paid
 * out, other income). Coach: the same for themselves only.
 */
fundsRouter.get('/overview', async (req, res) => {
  const user = currentUser(req);
  const { from, to } = range(parse(RangeQuery, req.query));
  const inPeriod = and(live, gte(fundTxns.occurredOn, from), lte(fundTxns.occurredOn, to));

  if (!isAdminUser(user)) {
    const mine = eq(fundEntries.userId, user.id);
    const [cash, due, byType, earned, kept] = await Promise.all([
      balanceOf(db, 'cash', { userId: user.id }),
      balanceOf(db, 'staff_due', { userId: user.id }),
      db
        .select({ type: fundTxns.type, amount: sumTxns })
        .from(fundTxns)
        .where(and(inPeriod, eq(fundTxns.userId, user.id)))
        .groupBy(fundTxns.type),
      db
        .select({ label: fundEntries.label, amount: sumEntries })
        .from(fundEntries)
        .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
        .where(
          and(inPeriod, mine, eq(fundEntries.account, 'staff_due'), eq(fundEntries.share, true)),
        )
        .groupBy(fundEntries.label)
        .orderBy(desc(sumEntries)),
      db
        .select({ amount: sumEntries })
        .from(fundEntries)
        .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
        .where(
          and(
            inPeriod,
            mine,
            eq(fundTxns.type, 'fee_split'),
            eq(fundEntries.account, 'staff_due'),
            eq(fundEntries.share, false),
          ),
        ),
    ]);
    const t = (type: string) => byType.find((r) => r.type === type)?.amount ?? 0;
    return ok(res, {
      scope: 'self' as const,
      from,
      to,
      cash,
      due,
      period: {
        collected: t('fee_split'),
        earned: earned.reduce((s, r) => s + r.amount, 0),
        earnedBy: earned,
        kept: -(kept[0]?.amount ?? 0),
        handedOver: t('handover'),
        spent: t('expense'),
        paidToMe: t('payout'),
      },
    });
  }

  const [balances, byType, distribution, categories, kept] = await Promise.all([
    db
      .select({
        account: fundEntries.account,
        userId: fundEntries.userId,
        payeeId: fundEntries.payeeId,
        amount: sumEntries,
      })
      .from(fundEntries)
      .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
      .where(live)
      .groupBy(fundEntries.account, fundEntries.userId, fundEntries.payeeId),
    db
      .select({ type: fundTxns.type, amount: sumTxns, n: count() })
      .from(fundTxns)
      .where(inPeriod)
      .groupBy(fundTxns.type),
    db
      .select({
        label: fundEntries.label,
        account: fundEntries.account,
        userId: fundEntries.userId,
        payeeId: fundEntries.payeeId,
        amount: sumEntries,
      })
      .from(fundEntries)
      .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
      .where(and(inPeriod, eq(fundEntries.share, true)))
      .groupBy(fundEntries.label, fundEntries.account, fundEntries.userId, fundEntries.payeeId)
      .orderBy(desc(sumEntries)),
    db
      .select({ category: fundTxns.category, amount: sumTxns, n: count() })
      .from(fundTxns)
      .where(and(inPeriod, eq(fundTxns.type, 'expense')))
      .groupBy(fundTxns.category)
      .orderBy(desc(sumTxns)),
    db
      .select({ userId: fundEntries.userId, amount: sumEntries })
      .from(fundEntries)
      .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
      .where(
        and(
          inPeriod,
          eq(fundTxns.type, 'fee_split'),
          eq(fundEntries.account, 'staff_due'),
          eq(fundEntries.share, false),
        ),
      )
      .groupBy(fundEntries.userId),
  ]);

  const userIds = [
    ...new Set(
      [...balances, ...distribution, ...kept].flatMap((r) => (r.userId ? [r.userId] : [])),
    ),
  ];
  const payeeIds = [
    ...new Set([...balances, ...distribution].flatMap((r) => (r.payeeId ? [r.payeeId] : []))),
  ];
  const [people, parties] = await Promise.all([
    userIds.length
      ? db
          .select({ id: users.id, name: users.name, role: users.role })
          .from(users)
          .where(inArray(users.id, userIds))
      : [],
    payeeIds.length
      ? db
          .select({ id: payees.id, name: payees.name })
          .from(payees)
          .where(inArray(payees.id, payeeIds))
      : [],
  ]);
  const person = (id: string | null) => people.find((p) => p.id === id);
  const party = (id: string | null) => parties.find((p) => p.id === id);
  const bal = (account: Entry['account']) =>
    balances.filter((b) => b.account === account && b.amount !== 0);
  const staffRows = (account: Entry['account']) =>
    bal(account)
      .filter((b) => b.userId)
      .map((b) => ({
        userId: b.userId!,
        name: person(b.userId)?.name ?? 'Unknown',
        role: person(b.userId)?.role ?? 'coach',
        amount: b.amount,
      }))
      .sort((a, b) => b.amount - a.amount);
  const academyCash = bal('cash').find((b) => !b.userId)?.amount ?? 0;
  const holders = staffRows('cash');
  const staffDue = staffRows('staff_due');
  const payeeDue = bal('payee_due')
    .map((b) => ({
      payeeId: b.payeeId!,
      name: party(b.payeeId)?.name ?? 'Unknown',
      amount: b.amount,
    }))
    .sort((a, b) => b.amount - a.amount);
  const t = (type: string) => byType.find((r) => r.type === type)?.amount ?? 0;
  const recipientName = (r: (typeof distribution)[number]) =>
    r.account === 'academy_fund'
      ? 'Academy'
      : r.payeeId
        ? (party(r.payeeId)?.name ?? 'Unknown')
        : (person(r.userId)?.name ?? 'Unknown');

  // Group the distribution by recipient as well as by section.
  const byRecipient = new Map<
    string,
    { key: string; kind: string; name: string; amount: number }
  >();
  for (const r of distribution) {
    const key = r.account === 'academy_fund' ? 'academy' : (r.payeeId ?? r.userId)!;
    const kind = r.account === 'academy_fund' ? 'academy' : r.payeeId ? 'payee' : 'staff';
    const row = byRecipient.get(key) ?? { key, kind, name: recipientName(r), amount: 0 };
    row.amount += r.amount;
    byRecipient.set(key, row);
  }

  ok(res, {
    scope: 'academy' as const,
    from,
    to,
    balances: {
      academyCash,
      withStaff: holders.reduce((s, h) => s + h.amount, 0),
      academyFund: bal('academy_fund')[0]?.amount ?? 0,
      owedToStaff: staffDue.reduce((s, h) => s + h.amount, 0),
      owedToPayees: payeeDue.reduce((s, h) => s + h.amount, 0),
      holders,
      staffDue,
      payeeDue,
    },
    period: {
      collected: t('fee_split'),
      payments: byType.find((r) => r.type === 'fee_split')?.n ?? 0,
      keptByStaff: -kept.reduce((s, k) => s + k.amount, 0),
      keptBy: kept
        .filter((k) => k.amount !== 0)
        .map((k) => ({
          userId: k.userId!,
          name: person(k.userId)?.name ?? 'Unknown',
          amount: -k.amount,
        })),
      handedOver: t('handover'),
      spent: t('expense'),
      paidOut: t('payout'),
      income: t('income'),
      distribution: distribution.map((r) => ({
        label: r.label ?? 'Academy',
        account: r.account,
        userId: r.userId,
        payeeId: r.payeeId,
        name: recipientName(r),
        amount: r.amount,
      })),
      byRecipient: [...byRecipient.values()].sort((a, b) => b.amount - a.amount),
      expensesByCategory: categories.map((c) => ({
        category: c.category ?? 'other',
        amount: c.amount,
        count: c.n,
      })),
    },
  });
});

// ─── Ledger ──────────────────────────────────────────────────────────────────

const TxnQuery = zPagination.extend({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  type: z.enum(['fee_split', 'handover', 'expense', 'payout', 'income']).optional(),
  userId: zId.optional(),
  payeeId: zId.optional(),
  includeReversed: zBoolQuery,
});

/** GET /funds/txns — newest first. Coaches see only entries that involve them. */
fundsRouter.get('/txns', async (req, res) => {
  const user = currentUser(req);
  const q = parse(TxnQuery, req.query);
  const admin = isAdminUser(user);
  const involves = (id: string) =>
    or(
      eq(fundTxns.userId, id),
      exists(
        db
          .select({ one: sql`1` })
          .from(fundEntries)
          .where(and(eq(fundEntries.txnId, fundTxns.id), eq(fundEntries.userId, id))),
      ),
    )!;
  const filters: SQL[] = [];
  if (!admin) filters.push(involves(user.id));
  else if (q.userId) filters.push(involves(q.userId));
  if (admin && q.payeeId)
    filters.push(
      or(
        eq(fundTxns.payeeId, q.payeeId),
        exists(
          db
            .select({ one: sql`1` })
            .from(fundEntries)
            .where(and(eq(fundEntries.txnId, fundTxns.id), eq(fundEntries.payeeId, q.payeeId))),
        ),
      )!,
    );
  if (q.from) filters.push(gte(fundTxns.occurredOn, q.from));
  if (q.to) filters.push(lte(fundTxns.occurredOn, q.to));
  if (q.type) filters.push(eq(fundTxns.type, q.type));
  if (!q.includeReversed) filters.push(live);
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [total]] = await Promise.all([
    db
      .select({
        txn: fundTxns,
        invoice: { id: invoices.id, number: invoices.number },
      })
      .from(fundTxns)
      .leftJoin(payments, eq(payments.id, fundTxns.paymentId))
      .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(where)
      .orderBy(desc(fundTxns.occurredOn), desc(fundTxns.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(fundTxns).where(where),
  ]);

  const ids = rows.map((r) => r.txn.id);
  const entries = ids.length
    ? await db
        .select({
          txnId: fundEntries.txnId,
          account: fundEntries.account,
          userId: fundEntries.userId,
          payeeId: fundEntries.payeeId,
          amount: fundEntries.amount,
          label: fundEntries.label,
          share: fundEntries.share,
        })
        .from(fundEntries)
        .where(
          and(inArray(fundEntries.txnId, ids), admin ? undefined : eq(fundEntries.userId, user.id)),
        )
    : [];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.txn.userId, r.txn.createdById, r.txn.reversedById])
        .concat(entries.map((e) => e.userId))
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const payeeIds = [
    ...new Set(
      [...rows.map((r) => r.txn.payeeId), ...entries.map((e) => e.payeeId)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
  const [people, parties] = await Promise.all([
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [],
    payeeIds.length
      ? db
          .select({ id: payees.id, name: payees.name })
          .from(payees)
          .where(inArray(payees.id, payeeIds))
      : [],
  ]);
  const name = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  const payeeName = (id: string | null) =>
    id ? (parties.find((p) => p.id === id)?.name ?? null) : null;

  ok(
    res,
    rows.map(({ txn, invoice }) => ({
      id: txn.id,
      type: txn.type,
      occurredOn: txn.occurredOn,
      amount: txn.amount,
      title: txn.title,
      category: txn.category,
      note: txn.note,
      reference: txn.reference,
      createdAt: txn.createdAt,
      user: txn.userId ? { id: txn.userId, name: name(txn.userId) } : null,
      payee: txn.payeeId ? { id: txn.payeeId, name: payeeName(txn.payeeId) } : null,
      createdBy: { id: txn.createdById, name: name(txn.createdById) },
      invoice: invoice?.id ? invoice : null,
      reversedAt: txn.reversedAt,
      reversedBy: txn.reversedById ? { id: txn.reversedById, name: name(txn.reversedById) } : null,
      reversalReason: txn.reversalReason,
      entries: entries
        .filter((e) => e.txnId === txn.id)
        .map(({ txnId: _t, ...e }) => ({
          ...e,
          name:
            e.account === 'academy_fund' || (e.account === 'cash' && !e.userId)
              ? 'Academy'
              : (payeeName(e.payeeId) ?? name(e.userId)),
        })),
    })),
    pageMeta(q.page, q.pageSize, total?.n ?? 0),
  );
});

// ─── Money movements ─────────────────────────────────────────────────────────

const HandoverBody = z.object({
  amount: zAmount,
  occurredOn: zPastDate,
  note: zOptionalText(500),
  /** Admin only: the staff member who handed the cash over. Coaches always hand over their own. */
  userId: zId.optional(),
});

/** A staff member hands cash they hold to the academy. */
fundsRouter.post('/handovers', async (req, res) => {
  const user = currentUser(req);
  const body = parse(HandoverBody, req.body);
  const fromId = isAdminUser(user) ? body.userId : user.id;
  if (!fromId) throw AppError.badRequest('Choose who handed over the cash');
  const from = await staffMember(fromId);
  const txn = await db.transaction(async (tx) => {
    await lockFunds(tx);
    await requireCash(tx, from.id, body.amount);
    const t = await postTxn(
      tx,
      {
        type: 'handover',
        occurredOn: body.occurredOn,
        amount: body.amount,
        title: `Cash handed over by ${from.name}`,
        note: body.note,
        userId: from.id,
        createdById: user.id,
      },
      [
        { account: 'cash', userId: from.id, amount: -body.amount },
        { account: 'cash', userId: null, amount: body.amount },
      ],
    );
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.handover',
        entityType: 'fund_txn',
        entityId: t.id,
        metadata: { amount: body.amount, from: from.id },
      },
      tx,
    );
    return t;
  });
  const handed = `Cash handed over · ${formatInr(body.amount)}`;
  noticeAdmins(
    user,
    handed,
    `${from.name} → academy${isAdminUser(user) ? ` · recorded by ${user.name}` : ''}`,
  );
  noticeStaff(
    from.id,
    user,
    handed,
    `${user.name} recorded ${formatInr(body.amount)} received from you.`,
  );
  created(res, txn);
});

const ExpenseBody = z.object({
  amount: zAmount,
  occurredOn: zPastDate,
  title: z.string().trim().min(2, 'What was bought?').max(120),
  category: z.enum(EXPENSE_CATEGORIES).default('equipment'),
  note: zOptionalText(500),
  reference: zOptionalText(120),
  /**
   * academy: paid from the academy's cash (admins).
   * cash:    paid from cash the staff member holds for the academy.
   * own:     paid from their own pocket; the academy now owes them (reimbursement).
   */
  paidFrom: z.enum(['academy', 'cash', 'own']),
  /** Admin only: whose cash / pocket. Coaches always record their own. */
  userId: zId.optional(),
});

/** Equipment and other purchases, always charged to the academy's own fund. */
fundsRouter.post('/expenses', async (req, res) => {
  const user = currentUser(req);
  const body = parse(ExpenseBody, req.body);
  const admin = isAdminUser(user);
  if (!admin && body.paidFrom === 'academy')
    throw AppError.forbidden('Only admins can spend from the academy’s cash');
  const spenderId = body.paidFrom === 'academy' ? null : admin ? (body.userId ?? user.id) : user.id;
  const spender = spenderId ? await staffMember(spenderId) : null;

  const txn = await db.transaction(async (tx) => {
    await lockFunds(tx);
    let source: Entry;
    if (body.paidFrom === 'own') {
      source = {
        account: 'staff_due',
        userId: spender!.id,
        amount: body.amount,
        label: 'Reimbursement',
      };
    } else {
      await requireCash(tx, spender?.id ?? null, body.amount);
      source = { account: 'cash', userId: spender?.id ?? null, amount: -body.amount };
    }
    const t = await postTxn(
      tx,
      {
        type: 'expense',
        occurredOn: body.occurredOn,
        amount: body.amount,
        title: body.title,
        category: body.category,
        note: body.note,
        reference: body.reference,
        userId: spender?.id ?? null,
        createdById: user.id,
      },
      [source, { account: 'academy_fund', amount: -body.amount }],
    );
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.expense',
        entityType: 'fund_txn',
        entityId: t.id,
        metadata: {
          amount: body.amount,
          title: body.title,
          paidFrom: body.paidFrom,
          userId: spender?.id ?? null,
        },
      },
      tx,
    );
    return t;
  });
  const bought = `Purchase · ${formatInr(body.amount)}`;
  const how =
    body.paidFrom === 'own'
      ? `paid by ${spender!.name}, to reimburse`
      : body.paidFrom === 'cash'
        ? `from ${spender!.name}'s cash`
        : 'from academy cash';
  noticeAdmins(user, bought, `${body.title} · ${how} · by ${user.name}`);
  noticeStaff(spender?.id, user, bought, `${user.name} recorded “${body.title}” ${how}.`);
  created(res, txn);
});

const PayoutBody = z
  .object({
    amount: zAmount,
    occurredOn: zPastDate,
    note: zOptionalText(500),
    reference: zOptionalText(120),
    /** Exactly one of userId (staff) or payeeId. */
    userId: zId.optional(),
    payeeId: zId.optional(),
    /** Whose cash pays: the academy's (default) or a staff member's. */
    fromUserId: zId.nullable().default(null),
  })
  .refine((b) => Boolean(b.userId) !== Boolean(b.payeeId), {
    message: 'Choose who is being paid',
    path: ['userId'],
  });

/**
 * Settles what the academy owes a staff member or a payee. Admins pay anyone from any wallet;
 * coaches pay only their batches' payees, from the cash they hold.
 */
fundsRouter.post('/payouts', async (req, res) => {
  const user = currentUser(req);
  const body = parse(PayoutBody, req.body);
  if (!isAdminUser(user)) {
    if (!body.payeeId) throw AppError.forbidden('Coaches can only pay payees');
    if (body.fromUserId && body.fromUserId !== user.id)
      throw AppError.forbidden('You can only pay from the cash you hold');
    if (!(await coachPayeeIds(user.id)).includes(body.payeeId))
      throw AppError.forbidden('This payee is not linked to your batches');
    body.fromUserId = user.id;
  }
  const to = body.userId
    ? { kind: 'staff' as const, ...(await staffMember(body.userId)) }
    : await (async () => {
        const p = await db.query.payees.findFirst({ where: eq(payees.id, body.payeeId!) });
        if (!p) throw AppError.notFound('Payee');
        return { kind: 'payee' as const, id: p.id, name: p.name };
      })();
  const from = body.fromUserId ? await staffMember(body.fromUserId) : null;

  const txn = await db.transaction(async (tx) => {
    await lockFunds(tx);
    const account = to.kind === 'staff' ? 'staff_due' : 'payee_due';
    const who = to.kind === 'staff' ? { userId: to.id } : { payeeId: to.id };
    const owed = await balanceOf(tx, account, who);
    if (owed < body.amount)
      throw AppError.unprocessable(`Only ${formatInr(Math.max(owed, 0))} is owed to ${to.name}.`);
    await requireCash(tx, from?.id ?? null, body.amount);
    const t = await postTxn(
      tx,
      {
        type: 'payout',
        occurredOn: body.occurredOn,
        amount: body.amount,
        title: `Paid to ${to.name}${from ? ` from ${from.name}’s cash` : ''}`,
        note: body.note,
        reference: body.reference,
        userId: to.kind === 'staff' ? to.id : null,
        payeeId: to.kind === 'payee' ? to.id : null,
        createdById: user.id,
      },
      [
        { account, ...who, amount: -body.amount },
        { account: 'cash', userId: from?.id ?? null, amount: -body.amount },
      ],
    );
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.payout',
        entityType: 'fund_txn',
        entityId: t.id,
        metadata: { amount: body.amount, to: to.id, kind: to.kind, from: from?.id ?? null },
      },
      tx,
    );
    return t;
  });
  const paid = `Paid · ${formatInr(body.amount)}`;
  if (to.kind === 'staff')
    noticeStaff(
      to.id,
      user,
      `Payment to you · ${formatInr(body.amount)}`,
      `Recorded by ${user.name}${from ? ` from ${from.name}'s cash` : ''}.`,
    );
  if (from && from.id !== to.id)
    noticeStaff(
      from.id,
      user,
      paid,
      `${user.name} recorded ${formatInr(body.amount)} paid from your cash to ${to.name}.`,
    );
  noticeAdmins(
    user,
    paid,
    `${to.name}${from ? ` · from ${from.name}'s cash` : ' · from academy cash'} · by ${user.name}`,
  );
  created(res, txn);
});

const IncomeBody = z.object({
  amount: zAmount,
  occurredOn: zPastDate,
  title: z.string().trim().min(2, 'Describe the income').max(120),
  note: zOptionalText(500),
  reference: zOptionalText(120),
});

/** Admin: money the academy receives outside fees (opening balance, sponsorship, events…). */
fundsRouter.post('/income', requireAdmin, async (req, res) => {
  const user = currentUser(req);
  const body = parse(IncomeBody, req.body);
  const txn = await db.transaction(async (tx) => {
    const t = await postTxn(
      tx,
      {
        type: 'income',
        occurredOn: body.occurredOn,
        amount: body.amount,
        title: body.title,
        note: body.note,
        reference: body.reference,
        createdById: user.id,
      },
      [
        { account: 'cash', userId: null, amount: body.amount },
        { account: 'academy_fund', amount: body.amount },
      ],
    );
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.income',
        entityType: 'fund_txn',
        entityId: t.id,
        metadata: { amount: body.amount, title: body.title },
      },
      tx,
    );
    return t;
  });
  noticeAdmins(
    user,
    `Income · ${formatInr(body.amount)}`,
    `${body.title} · recorded by ${user.name}`,
  );
  created(res, txn);
});

const ReverseBody = z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(500) });

/** Admin: cancels a wrong entry. Fee splits are undone by reverting the payment instead. */
fundsRouter.post('/txns/:id/reverse', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { reason } = parse(ReverseBody, req.body);
  const user = currentUser(req);
  const txn = await db.transaction(async (tx) => {
    await lockFunds(tx);
    const [t] = await tx.select().from(fundTxns).where(eq(fundTxns.id, id)).for('update');
    if (!t) throw AppError.notFound('Entry');
    if (t.reversedAt) throw AppError.conflict('This entry was already reversed');
    if (t.type === 'fee_split')
      throw AppError.unprocessable('Revert the payment from its invoice to undo a fee split.');
    const [r] = await tx
      .update(fundTxns)
      .set({ reversedAt: new Date(), reversedById: user.id, reversalReason: reason })
      .where(eq(fundTxns.id, id))
      .returning();
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.reversed',
        entityType: 'fund_txn',
        entityId: id,
        metadata: { type: t.type, amount: t.amount, reason },
      },
      tx,
    );
    return { row: r!, before: t };
  });
  const undone = `Entry reversed · ${formatInr(txn.before.amount)}`;
  noticeStaff(
    txn.before.userId,
    user,
    undone,
    `“${txn.before.title}” was reversed by ${user.name}: ${reason}`,
  );
  noticeAdmins(user, undone, `${txn.before.title} · by ${user.name}: ${reason}`);
  ok(res, txn.row);
});

const ResplitBody = z.object({
  feePlanId: zId.optional(),
  from: zIsoDate,
  to: zIsoDate,
});

/**
 * Admin: recalculates fee splits of payments received in a date range with the plans' current
 * splits (e.g. after setting a split up for the first time). Cash stays with whoever held it.
 */
fundsRouter.post('/resplit', requireAdmin, async (req, res) => {
  const body = parse(ResplitBody, req.body);
  if (body.to < body.from) throw AppError.badRequest('"to" must be on or after "from"');
  const user = currentUser(req);
  const updated = await db.transaction(async (tx) => {
    await lockFunds(tx);
    const rows = await tx
      .select({ txn: fundTxns, invoice: invoices, collector: { id: users.id, role: users.role } })
      .from(fundTxns)
      .innerJoin(payments, eq(payments.id, fundTxns.paymentId))
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(users, eq(users.id, fundTxns.userId))
      .where(
        and(
          live,
          eq(fundTxns.type, 'fee_split'),
          gte(fundTxns.occurredOn, body.from),
          lte(fundTxns.occurredOn, body.to),
          body.feePlanId ? eq(invoices.feePlanId, body.feePlanId) : undefined,
        ),
      );
    for (const { txn, invoice, collector } of rows) {
      const [held] = await tx
        .select({ userId: fundEntries.userId })
        .from(fundEntries)
        .where(
          and(
            eq(fundEntries.txnId, txn.id),
            eq(fundEntries.account, 'cash'),
            sql`${fundEntries.amount} > 0`,
          ),
        );
      await tx
        .update(fundTxns)
        .set({
          reversedAt: new Date(),
          reversedById: user.id,
          reversalReason: 'Recalculated with the current split',
        })
        .where(eq(fundTxns.id, txn.id));
      await postFeeSplit(tx, {
        paymentId: txn.paymentId!,
        amount: txn.amount,
        paidOn: txn.occurredOn,
        title: txn.title,
        feePlanId: invoice.feePlanId,
        batchCoachId: invoice.coachId,
        collector,
        heldBy: held?.userId ? 'collector' : 'academy',
      });
    }

    // Completed payments with no split at all (e.g. recorded by an older version): add one.
    const missing = await tx
      .select({
        payment: payments,
        invoice: invoices,
        student: students.fullName,
        collector: { id: users.id, role: users.role },
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(students, eq(students.id, invoices.studentId))
      .innerJoin(users, eq(users.id, payments.recordedById))
      .where(
        and(
          eq(payments.status, 'completed'),
          gte(payments.paidOn, body.from),
          lte(payments.paidOn, body.to),
          body.feePlanId ? eq(invoices.feePlanId, body.feePlanId) : undefined,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(fundTxns)
              .where(and(eq(fundTxns.paymentId, payments.id), live)),
          ),
        ),
      );
    for (const { payment, invoice, student, collector } of missing) {
      await postFeeSplit(tx, {
        paymentId: payment.id,
        amount: payment.amount,
        paidOn: payment.paidOn,
        title: `Fee · ${invoice.number} · ${student}`,
        feePlanId: invoice.feePlanId,
        batchCoachId: invoice.coachId,
        collector,
        heldBy: 'collector',
      });
    }

    const total = rows.length + missing.length;
    await audit(
      {
        ...auditCtx(req),
        action: 'funds.resplit',
        entityType: 'fee_plan',
        entityId: body.feePlanId ?? null,
        metadata: { ...body, payments: total, added: missing.length },
      },
      tx,
    );
    return total;
  });
  ok(res, { updated });
});
