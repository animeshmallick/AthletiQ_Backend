import { and, count, eq, gte, ilike, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { invoices, payments, students } from '../../db/schema/index.js';
import { todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok, pageMeta } from '../../lib/http.js';
import {
  parse,
  zId,
  zIdParam,
  zIsoDate,
  zOptionalText,
  zPagination,
} from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { getAcademySettings } from '../settings/settings.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import {
  buildShare,
  displayStatus,
  getInvoiceForUser,
  invoiceScope,
  invoiceSortSql,
  invoicePdfData,
} from './invoices.service.js';
import { activeAdminIds, notifyInBackground, notifyUsers } from '../push/push.service.js';
import { formatInr } from '../../lib/money.js';
import { postFeeSplit, reverseFeeSplit } from '../funds/ledger.js';
import { noticeFeeShares, noticeSharesReversed } from '../funds/notices.js';

export const invoicesRouter = Router();

const ListQuery = zPagination.extend({
  status: z.enum(['due', 'overdue', 'paid', 'refunded', 'cancelled', 'open']).optional(),
  studentId: zId.optional(),
  batchId: zId.optional(),
  coachId: zId.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['issueDateDesc', 'dueDateAsc', 'amountDesc']).default('issueDateDesc'),
});

invoicesRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const today = todayInAppTz();

  const filters: SQL[] = [];
  const scope = invoiceScope(user);
  if (scope) filters.push(scope);
  if (q.status === 'overdue') filters.push(eq(invoices.status, 'due'), lt(invoices.dueDate, today));
  else if (q.status === 'due')
    filters.push(eq(invoices.status, 'due'), gte(invoices.dueDate, today));
  else if (q.status === 'open') filters.push(eq(invoices.status, 'due'));
  else if (q.status) filters.push(eq(invoices.status, q.status));
  if (q.studentId) filters.push(eq(invoices.studentId, q.studentId));
  if (q.batchId) filters.push(eq(invoices.batchId, q.batchId));
  if (q.coachId) filters.push(eq(invoices.coachId, q.coachId));
  if (q.from) filters.push(gte(invoices.issueDate, q.from));
  if (q.to) filters.push(lte(invoices.issueDate, q.to));
  if (q.search) {
    const term = `%${q.search}%`;
    filters.push(
      or(ilike(invoices.number, term), ilike(students.fullName, term), ilike(students.code, term))!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        cycleNumber: invoices.cycleNumber,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalAmount: invoices.totalAmount,
        status: invoices.status,
        paidAt: invoices.paidAt,
        batchName: invoices.batchName,
        feePlanName: invoices.feePlanName,
        student: {
          id: students.id,
          code: students.code,
          fullName: students.fullName,
          phone: students.phone,
        },
      })
      .from(invoices)
      .innerJoin(students, eq(students.id, invoices.studentId))
      .where(where)
      .orderBy(invoiceSortSql[q.sort])
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db
      .select({
        total: count(),
        amount: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
      })
      .from(invoices)
      .innerJoin(students, eq(students.id, invoices.studentId))
      .where(where),
  ]);

  ok(
    res,
    rows.map((r) => ({ ...r, displayStatus: displayStatus(r.status, r.dueDate, today) })),
    { ...pageMeta(q.page, q.pageSize, totals?.total ?? 0), totalAmount: totals?.amount ?? 0 },
  );
});

invoicesRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  ok(res, await getInvoiceForUser(currentUser(req), id));
});

invoicesRouter.get('/:id/pdf', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const inv = await getInvoiceForUser(currentUser(req), id);
  const pdf = await renderInvoicePdf(await invoicePdfData(inv), await getAcademySettings());
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="${inv.number.replaceAll('/', '-')}.pdf"`)
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
});

invoicesRouter.post('/:id/share', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const inv = await getInvoiceForUser(currentUser(req), id);
  if (inv.status === 'cancelled')
    throw AppError.unprocessable('Cancelled invoices cannot be shared');
  await audit({ ...auditCtx(req), action: 'invoice.shared', entityType: 'invoice', entityId: id });
  ok(res, await buildShare(inv));
});

// ─── Payments ────────────────────────────────────────────────────────────────

const PaymentBody = z.object({
  mode: z.enum(['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other']),
  reference: zOptionalText(120),
  paidOn: zIsoDate,
  note: zOptionalText(500),
  /** Coaches only: the money is with them (default) or went straight to the academy's account. */
  heldBy: z.enum(['collector', 'academy']).default('collector'),
});

/**
 * Coaches and admins can mark an invoice as paid (full amount). The fee is distributed by the
 * plan's split in the same transaction.
 */
invoicesRouter.post('/:id/payments', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(PaymentBody, req.body);
  const user = currentUser(req);
  const inv = await getInvoiceForUser(user, id); // access check
  if (body.paidOn > todayInAppTz())
    throw AppError.badRequest('Payment date cannot be in the future');
  if (body.paidOn < inv.periodStart)
    throw AppError.badRequest('Payment date cannot be before the billing period started');

  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
    if (locked?.status !== 'due') {
      throw AppError.conflict(
        locked?.status === 'paid'
          ? 'This invoice is already paid'
          : `This invoice is ${locked?.status}`,
      );
    }
    const [payment] = await tx
      .insert(payments)
      .values({
        invoiceId: id,
        amount: locked.totalAmount,
        mode: body.mode,
        reference: body.reference,
        paidOn: body.paidOn,
        note: body.note,
        recordedById: user.id,
      })
      .returning();
    await postFeeSplit(tx, {
      paymentId: payment!.id,
      amount: locked.totalAmount,
      paidOn: body.paidOn,
      title: `Fee · ${locked.number} · ${inv.student.fullName}`,
      feePlanId: locked.feePlanId,
      batchCoachId: locked.coachId,
      collector: user,
      heldBy: body.heldBy,
    });
    await tx
      .update(invoices)
      .set({ status: 'paid', paidAt: new Date() })
      .where(eq(invoices.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'invoice.marked_paid',
        entityType: 'invoice',
        entityId: id,
        metadata: { amount: locked.totalAmount, mode: body.mode, paidOn: body.paidOn },
      },
      tx,
    );
  });

  const paid = await getInvoiceForUser(user, id);
  const completed = paid.payments.find((p) => p.status === 'completed');
  if (completed)
    noticeFeeShares(completed.id, user, paid.student.fullName, body.heldBy === 'academy');
  notifyInBackground(async () => {
    const admins = (await activeAdminIds()).filter((a) => a !== user.id);
    await notifyUsers(admins, {
      title: `Fee received · ${formatInr(paid.totalAmount)}`,
      body: `${paid.student.fullName} · ${body.mode.toUpperCase()} · received by ${user.name}`,
      link: `/finance?tab=invoices&status=paid&invoice=${id}`,
      tag: `paid-${id}`,
    });
  });
  ok(res, paid);
});

const ReversalBody = z.object({
  reason: z.string().trim().min(3, 'Please give a reason').max(500),
});

/**
 * Admin only.
 *  - revert: the payment was recorded by mistake → invoice becomes due again.
 *  - refund: money was returned to the family → invoice becomes refunded (closed).
 */
for (const action of ['revert', 'refund'] as const) {
  invoicesRouter.post(`/:id/payments/:paymentId/${action}`, requireAdmin, async (req, res) => {
    const { id, paymentId } = parse(z.object({ id: zId, paymentId: zId }), req.params);
    const { reason } = parse(ReversalBody, req.body);
    const user = currentUser(req);

    await db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.invoiceId, id)))
        .for('update');
      if (!p) throw AppError.notFound('Payment');
      if (p.status !== 'completed') throw AppError.conflict(`This payment was already ${p.status}`);

      await tx
        .update(payments)
        .set({
          status: action === 'revert' ? 'reverted' : 'refunded',
          reversedById: user.id,
          reversedAt: new Date(),
          reversalReason: reason,
        })
        .where(eq(payments.id, paymentId));
      await tx
        .update(invoices)
        .set(action === 'revert' ? { status: 'due', paidAt: null } : { status: 'refunded' })
        .where(eq(invoices.id, id));
      await reverseFeeSplit(
        tx,
        paymentId,
        user.id,
        `Payment ${action === 'revert' ? 'reverted' : 'refunded'}: ${reason}`,
      );
      await audit(
        {
          ...auditCtx(req),
          action: `invoice.payment_${action === 'revert' ? 'reverted' : 'refunded'}`,
          entityType: 'invoice',
          entityId: id,
          metadata: { paymentId, amount: p.amount, reason },
        },
        tx,
      );
    });

    noticeSharesReversed(paymentId, user, action === 'revert' ? 'reverted' : 'refunded');
    ok(res, await getInvoiceForUser(user, id));
  });
}

/** Admin only: waive / void an unpaid invoice (e.g. raised in error). */
invoicesRouter.post('/:id/cancel', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { reason } = parse(ReversalBody, req.body);
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
    if (!inv) throw AppError.notFound('Invoice');
    if (inv.status !== 'due') throw AppError.conflict('Only unpaid invoices can be cancelled');
    await tx
      .update(invoices)
      .set({ status: 'cancelled', cancelledReason: reason })
      .where(eq(invoices.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'invoice.cancelled',
        entityType: 'invoice',
        entityId: id,
        metadata: { reason },
      },
      tx,
    );
  });
  ok(res, await getInvoiceForUser(currentUser(req), id));
});

const AdjustBody = z.object({
  /** New discount for this invoice only (paise). The student's regular fee is unchanged. */
  discountAmount: z.number().int().min(0),
  reason: z.string().trim().min(3, 'Please give a reason').max(500),
});

/** Admin only: one-off concession on an unpaid invoice (e.g. missed sessions, hardship). */
invoicesRouter.post('/:id/adjust', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { discountAmount, reason } = parse(AdjustBody, req.body);
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
    if (!inv) throw AppError.notFound('Invoice');
    if (inv.status !== 'due') throw AppError.conflict('Only unpaid invoices can be adjusted');
    if (discountAmount > inv.baseAmount) {
      throw new AppError('VALIDATION_ERROR', 'Discount cannot exceed the invoice amount', {
        fields: [{ path: 'discountAmount', message: 'Cannot exceed the invoice amount' }],
      });
    }
    const totalAmount = inv.baseAmount - discountAmount;
    await tx
      .update(invoices)
      .set({
        discountAmount,
        totalAmount,
        // A fully waived invoice is settled, consistent with zero-fee cycles.
        ...(totalAmount === 0 ? { status: 'paid' as const, paidAt: new Date() } : {}),
      })
      .where(eq(invoices.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'invoice.adjusted',
        entityType: 'invoice',
        entityId: id,
        metadata: {
          before: { discountAmount: inv.discountAmount, totalAmount: inv.totalAmount },
          after: { discountAmount, totalAmount },
          reason,
        },
      },
      tx,
    );
  });
  ok(res, await getInvoiceForUser(currentUser(req), id));
});
