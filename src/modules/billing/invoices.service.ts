import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  invoices,
  locations,
  payments,
  students,
  users,
} from '../../db/schema/index.js';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { formatInr } from '../../lib/money.js';
import { studentScope } from '../access/access.js';
import { paymentShares } from '../funds/ledger.js';
import type { AuthUser } from '../auth/auth.types.js';
import { getAcademySettings } from '../settings/settings.js';
import type { InvoicePdfData } from './invoice-pdf.js';
import { signInvoiceLink, whatsappLink } from './share-links.js';

/**
 * Admins see every invoice. Coaches see the invoices of the batches they run (a student in two
 * batches has a separate invoice for each, seen by that batch's coach).
 */
export function invoiceScope(user: AuthUser): SQL | undefined {
  if (!studentScope(user, invoices.studentId)) return undefined;
  return or(
    eq(invoices.coachId, user.id),
    inArray(
      invoices.batchId,
      db.select({ id: batches.id }).from(batches).where(eq(batches.coachId, user.id)),
    ),
  );
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
        joiningDate: students.joiningDate,
      },
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .where(and(eq(invoices.id, invoiceId), scope));
  if (!row) throw AppError.notFound('Invoice');

  // Context for the invoice page: the batch (coach, place, times), the student's training days,
  // and what else they owe (that this user can see).
  const [[batch], enrollment, [otherDue], [joined]] = await Promise.all([
    row.invoice.batchId
      ? db
          .select({
            startTime: batches.startTime,
            endTime: batches.endTime,
            coachName: users.name,
            locationName: locations.name,
          })
          .from(batches)
          .innerJoin(users, eq(users.id, batches.coachId))
          .innerJoin(locations, eq(locations.id, batches.locationId))
          .where(eq(batches.id, row.invoice.batchId))
      : Promise.resolve([]),
    db.query.enrollments.findFirst({
      columns: { trainingDays: true, billingStartsOn: true },
      where: eq(enrollments.id, row.invoice.enrollmentId),
    }),
    db
      .select({
        count: count(),
        amount: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.studentId, row.student.id),
          eq(invoices.status, 'due'),
          ne(invoices.id, invoiceId),
          scope,
        ),
      ),
    // When the student joined this batch: the start of their earliest enrollment in it.
    row.invoice.batchId
      ? db
          .select({ on: sql<string | null>`min(${enrollments.effectiveFrom})::text` })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.studentId, row.student.id),
              eq(enrollments.batchId, row.invoice.batchId),
            ),
          )
      : Promise.resolve([]),
  ]);

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

  // Where the fee went. Coaches see only their own share.
  const completed = history.find((p) => p.status === 'completed');
  const split = completed
    ? await paymentShares(completed.id, user.role === 'admin' ? undefined : user.id)
    : [];

  return {
    ...row.invoice,
    displayStatus: displayStatus(row.invoice.status, row.invoice.dueDate),
    student: row.student,
    payments: history,
    split,
    about: {
      coachName: batch?.coachName ?? null,
      locationName: batch?.locationName ?? null,
      startTime: batch?.startTime ?? null,
      endTime: batch?.endTime ?? null,
      trainingDays: enrollment?.trainingDays ?? null,
      batchJoinedOn: joined?.on ?? null,
      billingStartsOn: enrollment?.billingStartsOn ?? null,
      otherDue: { count: otherDue?.count ?? 0, amount: otherDue?.amount ?? 0 },
    },
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

/** PDF data plus the extras shown on it: coach, training days, other dues, payment history. */
export async function invoicePdfData(inv: InvoiceDetail): Promise<InvoicePdfData> {
  const [coach, enrollment, otherDue] = await Promise.all([
    inv.coachId
      ? db.query.users.findFirst({ columns: { name: true }, where: eq(users.id, inv.coachId) })
      : Promise.resolve(undefined),
    db.query.enrollments.findFirst({
      columns: { trainingDays: true },
      where: eq(enrollments.id, inv.enrollmentId),
    }),
    db
      .select({ number: invoices.number, dueDate: invoices.dueDate, amount: invoices.totalAmount })
      .from(invoices)
      .where(
        and(
          eq(invoices.studentId, inv.student.id),
          eq(invoices.status, 'due'),
          ne(invoices.id, inv.id),
        ),
      )
      .orderBy(asc(invoices.dueDate)),
  ]);
  return {
    ...toPdfData(inv),
    coachName: coach?.name ?? null,
    trainingDays: enrollment?.trainingDays ?? null,
    otherDue,
    history: inv.payments
      .filter((p) => p.status !== 'completed')
      .map((p) => ({
        paidOn: p.paidOn,
        amount: p.amount,
        mode: p.mode,
        status: p.status,
        reason: p.reversalReason,
      })),
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
  const message = [
    ...lines,
    '',
    `Open the link with ${inv.student.fullName}'s registration number.`,
    '',
    `– ${academy.name}`,
  ].join('\n');

  return {
    message,
    pdfUrl: link.url,
    expiresAt: link.expiresAt,
    whatsappUrl: whatsappLink(inv.student.phone, message),
  };
}

export const invoiceSortSql = {
  issueDateDesc: sql`${invoices.issueDate} desc, ${invoices.number} desc`,
  issueDateAsc: sql`${invoices.issueDate} asc, ${invoices.number} asc`,
  dueDateAsc: sql`${invoices.dueDate} asc, ${invoices.number} asc`,
  dueDateDesc: sql`${invoices.dueDate} desc, ${invoices.number} desc`,
  amountDesc: sql`${invoices.totalAmount} desc, ${invoices.number} asc`,
  amountAsc: sql`${invoices.totalAmount} asc, ${invoices.number} asc`,
  studentAsc: sql`lower(${students.fullName}) asc, ${invoices.issueDate} asc`,
  numberAsc: sql`${invoices.number} asc`,
  numberDesc: sql`${invoices.number} desc`,
};
export type InvoiceSort = keyof typeof invoiceSortSql;
