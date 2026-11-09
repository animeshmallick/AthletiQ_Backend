import { and, desc, eq, gte, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  enrollments,
  batches,
  feePlans,
  invoices,
  payments,
  students,
  users,
} from '../../db/schema/index.js';
import {
  addDays,
  addMonthsClamped,
  diffDays,
  startOfMonth,
  todayInAppTz,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIsoDate } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { isAdmin, studentScope } from '../access/access.js';
import { effectiveMonthlyFee } from '../students/students.service.js';
import { nextUpcomingCycle } from './cycle.js';
import { invoiceScope } from './invoices.service.js';

export const financeRouter = Router();

const SummaryQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  coachId: zId.optional(),
  batchId: zId.optional(),
});

/**
 * Finance dashboard. Admins see the academy (optionally filtered by coach/batch); coaches see
 * only their students. All amounts in paise.
 *
 *  - billed:      invoices issued in range (excluding cancelled)
 *  - collected:   payments received in range (completed only)
 *  - outstanding: everything currently unpaid (not range-bound), split into due / overdue
 */
financeRouter.get('/summary', async (req, res) => {
  const user = currentUser(req);
  const q = parse(SummaryQuery, req.query);
  const today = todayInAppTz();
  const to = q.to ?? today;
  const from = q.from ?? startOfMonth(today);
  if (to < from) throw AppError.badRequest('"to" must be on or after "from"');
  if (diffDays(from, to) > 731) throw AppError.badRequest('Date range cannot exceed two years');

  const scope: SQL[] = [];
  const s = invoiceScope(user);
  if (s) scope.push(s);
  if (isAdmin(user) && q.coachId) scope.push(eq(invoices.coachId, q.coachId));
  if (q.batchId) scope.push(eq(invoices.batchId, q.batchId));

  const trendStart = startOfMonth(addMonthsClamped(today, -11));

  const [
    billed,
    collected,
    outstanding,
    byMode,
    trendBilled,
    trendCollected,
    byBatch,
    defaulters,
    receivers,
  ] = await Promise.all([
    db
      .select({
        amount: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
        count: sql<number>`count(*)::int`,
        discounts: sql<number>`coalesce(sum(${invoices.discountAmount}), 0)::int`,
      })
      .from(invoices)
      .where(
        and(
          ...scope,
          ne(invoices.status, 'cancelled'),
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
        ),
      ),
    db
      .select({
        amount: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'completed'), 0)::int`,
        count: sql<number>`(count(*) filter (where ${payments.status} = 'completed'))::int`,
        refunded: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'refunded'), 0)::int`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(...scope, gte(payments.paidOn, from), lte(payments.paidOn, to))),
    db
      .select({
        due: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.dueDate} >= ${today}), 0)::int`,
        dueCount: sql<number>`(count(*) filter (where ${invoices.dueDate} >= ${today}))::int`,
        overdue: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.dueDate} < ${today}), 0)::int`,
        overdueCount: sql<number>`(count(*) filter (where ${invoices.dueDate} < ${today}))::int`,
      })
      .from(invoices)
      .where(and(...scope, eq(invoices.status, 'due'))),
    db
      .select({
        mode: payments.mode,
        amount: sql<number>`sum(${payments.amount})::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(
        and(
          ...scope,
          eq(payments.status, 'completed'),
          gte(payments.paidOn, from),
          lte(payments.paidOn, to),
        ),
      )
      .groupBy(payments.mode),
    db
      .select({
        month: sql<string>`to_char(${invoices.issueDate}, 'YYYY-MM')`,
        amount: sql<number>`sum(${invoices.totalAmount})::int`,
      })
      .from(invoices)
      .where(and(...scope, ne(invoices.status, 'cancelled'), gte(invoices.issueDate, trendStart)))
      .groupBy(sql`1`),
    db
      .select({
        month: sql<string>`to_char(${payments.paidOn}, 'YYYY-MM')`,
        amount: sql<number>`sum(${payments.amount})::int`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(...scope, eq(payments.status, 'completed'), gte(payments.paidOn, trendStart)))
      .groupBy(sql`1`),
    db
      .select({
        batchId: invoices.batchId,
        batchName: invoices.batchName,
        coachId: invoices.coachId,
        coachName: users.name,
        billed: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.issueDate} between ${from} and ${to} and ${invoices.status} <> 'cancelled'), 0)::int`,
        outstanding: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due'), 0)::int`,
        overdue: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'due' and ${invoices.dueDate} < ${today}), 0)::int`,
      })
      .from(invoices)
      .leftJoin(users, eq(users.id, invoices.coachId))
      .where(and(...scope))
      .groupBy(invoices.batchId, invoices.batchName, invoices.coachId, users.name),
    db
      .select({
        studentId: students.id,
        code: students.code,
        fullName: students.fullName,
        phone: students.phone,
        overdue: sql<number>`sum(${invoices.totalAmount})::int`,
        invoices: sql<number>`count(*)::int`,
        oldestDueDate: sql<string>`min(${invoices.dueDate})`,
      })
      .from(invoices)
      .innerJoin(students, eq(students.id, invoices.studentId))
      .where(and(...scope, eq(invoices.status, 'due'), lt(invoices.dueDate, today)))
      .groupBy(students.id)
      .orderBy(desc(sql`sum(${invoices.totalAmount})`))
      .limit(10),
    // Who received the money: the person who marked the invoice paid. Coaches see only
    // what they received themselves.
    db
      .select({
        userId: payments.recordedById,
        name: users.name,
        role: users.role,
        amount: sql<number>`sum(${payments.amount})::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(users, eq(users.id, payments.recordedById))
      .where(
        and(
          ...scope,
          ...(isAdmin(user) ? [] : [eq(payments.recordedById, user.id)]),
          eq(payments.status, 'completed'),
          gte(payments.paidOn, from),
          lte(payments.paidOn, to),
        ),
      )
      .groupBy(payments.recordedById, users.name, users.role)
      .orderBy(desc(sql`sum(${payments.amount})`)),
  ]);

  const months: string[] = [];
  for (let i = 0; i < 12; i++) months.push(addMonthsClamped(trendStart, i).slice(0, 7));
  const billedMap = new Map(trendBilled.map((r) => [r.month, r.amount]));
  const collectedMap = new Map(trendCollected.map((r) => [r.month, r.amount]));

  const b = billed[0]!;
  const c = collected[0]!;
  ok(res, {
    range: { from, to },
    totals: {
      billed: b.amount,
      invoicesIssued: b.count,
      discounts: b.discounts,
      collected: c.amount,
      paymentsReceived: c.count,
      refunded: c.refunded,
      ...outstanding[0]!,
      outstanding: outstanding[0]!.due + outstanding[0]!.overdue,
      collectionRate: b.amount > 0 ? Math.round((c.amount / b.amount) * 1000) / 10 : null,
    },
    trend: months.map((m) => ({
      month: m,
      billed: billedMap.get(m) ?? 0,
      collected: collectedMap.get(m) ?? 0,
    })),
    byPaymentMode: byMode,
    byReceiver: receivers,
    byBatch: byBatch
      .filter((r) => r.billed > 0 || r.outstanding > 0)
      .sort((x, y) => y.outstanding - x.outstanding),
    topOverdue: defaulters,
  });
});

/** Projected billing over the next N days based on each active student's next cycle. */
financeRouter.get('/projection', async (req, res) => {
  const user = currentUser(req);
  const { days } = parse(
    z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
    req.query,
  );
  const today = todayInAppTz();
  const until = addDays(today, days);

  const lastCycle = db
    .select({
      enrollmentId: invoices.enrollmentId,
      last: sql<number>`max(${invoices.cycleNumber})`.as('last'),
    })
    .from(invoices)
    .groupBy(invoices.enrollmentId)
    .as('lc');

  const scope = studentScope(user, students.id);
  const rows = await db
    .select({
      id: students.id,
      code: students.code,
      fullName: students.fullName,
      joiningDate: enrollments.effectiveFrom,
      billingAnchorDate: enrollments.billingAnchorDate,
      cycleOffset: enrollments.cycleOffset,
      billingStartsOn: enrollments.billingStartsOn,
      leftOn: enrollments.effectiveTo,
      customMonthlyFee: enrollments.customMonthlyFee,
      monthlyDiscount: enrollments.monthlyDiscount,
      planFee: feePlans.monthlyFee,
      batchName: batches.name,
      lastInvoicedCycle: sql<number>`greatest(coalesce(${lastCycle.last}, 0), ${enrollments.lastFreeCycle})::int`,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
    .leftJoin(lastCycle, eq(lastCycle.enrollmentId, enrollments.id))
    .where(
      and(
        eq(students.status, 'active'),
        sql`${enrollments.effectiveTo} is null`,
        // Coaches: only memberships of their own batches.
        user.role === 'admin' ? undefined : eq(batches.coachId, user.id),
        scope,
      ),
    );

  const upcoming = rows
    .map((r) => {
      const cycle = nextUpcomingCycle(r, today);
      if (!cycle || cycle.issueDate > until) return null;
      const amount = effectiveMonthlyFee(r.planFee, r.customMonthlyFee, r.monthlyDiscount).total;
      if (amount === 0) return null; // free: no invoice
      return {
        studentId: r.id,
        code: r.code,
        fullName: r.fullName,
        batchName: r.batchName,
        issueDate: cycle.issueDate,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        amount,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate));

  ok(res, {
    from: addDays(today, 1),
    to: until,
    totalAmount: upcoming.reduce((sum, u) => sum + u.amount, 0),
    invoices: upcoming,
  });
});
