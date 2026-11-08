import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { invoices, payments, students, users } from '../../db/schema/index.js';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { formatInr } from '../../lib/money.js';
import { studentScope } from '../access/access.js';
import type { AuthUser } from '../auth/auth.types.js';
import { getAcademySettings } from '../settings/settings.js';
import type { InvoicePdfData } from './invoice-pdf.js';
import { signInvoiceLink, whatsappLink } from './share-links.js';

/**
 * Coaches see invoices of students they currently coach, plus invoices raised while the student
 * was in their batch (historical ownership snapshot).
 */
export function invoiceScope(user: AuthUser): SQL | undefined {
  const current = studentScope(user, invoices.studentId);
  if (!current) return undefined;
  return or(current, eq(invoices.coachId, user.id));
}

/** Derived display status: "overdue" is a due invoice past its due date. */
export function displayStatus(status: string, dueDate: string, today = todayInAppTz()) {
  return status === 'due' && dueDate < today ? 'overdue' : status;
}

export async function getInvoiceForUser(user: AuthUser, invoiceId: string) {
  const scope = invoiceScope(user);
  const [row] = await db
    .select({
      invoice: invoices,
      student: {
        id: students.id,
        code: students.code,
        fullName: students.fullName,
        guardianName: students.guardianName,
        phone: students.phone,
        address: students.address,
        status: students.status,
      },
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .where(and(eq(invoices.id, invoiceId), scope));
  if (!row) throw AppError.notFound('Invoice');

  const history = await db
    .select({
      id: payments.id,
      amount: payments.amount,
      mode: payments.mode,
      reference: payments.reference,
      paidOn: payments.paidOn,
      note: payments.note,
      status: payments.status,
      createdAt: payments.createdAt,
      recordedBy: { id: users.id, name: users.name },
      reversedAt: payments.reversedAt,
      reversalReason: payments.reversalReason,
      reversedById: payments.reversedById,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.recordedById))
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(desc(payments.createdAt));

  return {
    ...row.invoice,
    displayStatus: displayStatus(row.invoice.status, row.invoice.dueDate),
    student: row.student,
    payments: history,
  };
}

export type InvoiceDetail = Awaited<ReturnType<typeof getInvoiceForUser>>;

export function toPdfData(inv: InvoiceDetail): InvoicePdfData {
  const completed = inv.payments.find((p) => p.status === 'completed');
  return {
    number: inv.number,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    status: inv.status,
    feePlanName: inv.feePlanName,
    batchName: inv.batchName,
    baseAmount: inv.baseAmount,
    discountAmount: inv.discountAmount,
    totalAmount: inv.totalAmount,
    student: inv.student,
    payment: completed
      ? { paidOn: completed.paidOn, mode: completed.mode, reference: completed.reference }
      : null,
  };
}

/** Message + wa.me link + signed PDF link for sharing an invoice or receipt with the family. */
export async function buildShare(inv: InvoiceDetail) {
  const academy = await getAcademySettings();
  const link = signInvoiceLink(inv.id);
  const greeting = `Hi ${inv.student.guardianName ?? inv.student.fullName},`;
  const period = `${formatDisplayDate(inv.periodStart)} – ${formatDisplayDate(inv.periodEnd)}`;

  const lines =
    inv.status === 'paid'
      ? [
          greeting,
          '',
          `Thank you! We have received ${formatInr(inv.totalAmount)} for ${inv.student.fullName}'s coaching fee (${period}).`,
          '',
          `Receipt (${inv.number}): ${link.url}`,
        ]
      : [
          greeting,
          '',
          `The coaching fee for ${inv.student.fullName} for ${period} is ${formatInr(inv.totalAmount)}${
            inv.displayStatus === 'overdue'
              ? `, which was due on ${formatDisplayDate(inv.dueDate)}. Kindly clear it at the earliest.`
              : `, due by ${formatDisplayDate(inv.dueDate)}.`
          }`,
          '',
          `Invoice ${inv.number}: ${link.url}`,
          ...(academy.upiId ? [`Pay via UPI: ${academy.upiId}`] : []),
        ];
  const message = [...lines, '', `– ${academy.name}`].join('\n');

  return {
    message,
    pdfUrl: link.url,
    expiresAt: link.expiresAt,
    whatsappUrl: whatsappLink(inv.student.phone, message),
  };
}

export const invoiceSortSql = {
  issueDateDesc: sql`${invoices.issueDate} desc, ${invoices.number} desc`,
  dueDateAsc: sql`${invoices.dueDate} asc, ${invoices.number} asc`,
  amountDesc: sql`${invoices.totalAmount} desc`,
};
