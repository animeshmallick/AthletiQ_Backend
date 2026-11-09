import { eq, lte, max, sql } from 'drizzle-orm';
import { INVOICE_DUE_DAYS, INVOICE_PREFIX } from '../../config/constants.js';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  enrollments,
  feePlans,
  invoiceSequences,
  invoices,
  students,
} from '../../db/schema/index.js';
import { addDays, financialYear, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { mapPgError } from '../../lib/pg-errors.js';
import { effectiveMonthlyFee } from '../students/students.service.js';
import { cyclesDue, type Cycle } from './cycle.js';

/** Allocates the next gap-free number for the financial year of `issueDate` (row-locked). */
export async function nextInvoiceNumber(tx: DbOrTx, issueDate: IsoDate): Promise<string> {
  const fy = financialYear(issueDate);
  const [row] = await tx
    .insert(invoiceSequences)
    .values({ financialYear: fy, lastValue: 1 })
    .onConflictDoUpdate({
      target: invoiceSequences.financialYear,
      set: { lastValue: sql`${invoiceSequences.lastValue} + 1` },
    })
    .returning({ value: invoiceSequences.lastValue });
  return `${INVOICE_PREFIX}/${fy}/${String(row!.value).padStart(5, '0')}`;
}

export interface GenerationStats {
  runDate: IsoDate;
  /** Batch memberships looked at. */
  studentsScanned: number;
  invoicesCreated: number;
  skippedExisting: number;
  failures: { studentId: string; enrollmentId: string; cycleNumber: number; error: string }[];
}

/**
 * Generates every (prepaid) invoice due to be issued by `today`, for every batch membership
 * (enrollment): the first one at acceptance, then one at the start of each month. A student in two
 * batches gets two invoices, each priced by its own batch's plan. Idempotent and self-healing: if
 * the server was down for days, the next run catches up; re-running never duplicates (unique
 * enrollment + cycle). Each invoice is its own transaction so one bad record cannot block the rest.
 *
 * Pass `studentId` to bill one student's memberships immediately (e.g. right after acceptance).
 */
export async function generateDueInvoices(
  today: IsoDate = todayInAppTz(),
  opts: { studentId?: string } = {},
): Promise<GenerationStats> {
  const lastCycle = db
    .select({ enrollmentId: invoices.enrollmentId, last: max(invoices.cycleNumber).as('last') })
    .from(invoices)
    .groupBy(invoices.enrollmentId)
    .as('last_cycle');

  const rows = await db
    .select({
      id: enrollments.id,
      studentId: students.id,
      code: students.code,
      joiningDate: enrollments.effectiveFrom,
      billingAnchorDate: enrollments.billingAnchorDate,
      cycleOffset: enrollments.cycleOffset,
      billingStartsOn: enrollments.billingStartsOn,
      leftOn: enrollments.effectiveTo,
      customMonthlyFee: enrollments.customMonthlyFee,
      monthlyDiscount: enrollments.monthlyDiscount,
      batch: { id: batches.id, name: batches.name, coachId: batches.coachId },
      plan: { id: feePlans.id, name: feePlans.name, monthlyFee: feePlans.monthlyFee },
      lastInvoicedCycle: sql<number>`coalesce(${lastCycle.last}, 0)::int`,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .innerJoin(feePlans, eq(feePlans.id, batches.feePlanId))
    .leftJoin(lastCycle, eq(lastCycle.enrollmentId, enrollments.id))
    .where(
      opts.studentId
        ? eq(enrollments.studentId, opts.studentId)
        : lte(enrollments.billingStartsOn, today),
    );

  const stats: GenerationStats = {
    runDate: today,
    studentsScanned: rows.length,
    invoicesCreated: 0,
    skippedExisting: 0,
    failures: [],
  };

  // Process in chronological order so invoice numbers follow issue dates (then student code).
  const work = rows
    .flatMap((e) => cyclesDue(e, today).map((cycle) => ({ e, cycle })))
    .sort(
      (a, b) =>
        a.cycle.issueDate.localeCompare(b.cycle.issueDate) ||
        a.e.code.localeCompare(b.e.code) ||
        a.e.batch.name.localeCompare(b.e.batch.name),
    );

  const failed = new Set<string>();
  for (const { e, cycle } of work) {
    // Keep each membership's cycles in order: after a failure, retry the rest on the next run.
    if (failed.has(e.id)) continue;
    try {
      const createdInvoice = await createCycleInvoice(e, cycle);
      if (createdInvoice) stats.invoicesCreated++;
      else stats.skippedExisting++;
    } catch (err) {
      logger.error(
        { err, studentId: e.studentId, enrollmentId: e.id, cycle: cycle.cycleNumber },
        'Invoice generation failed',
      );
      failed.add(e.id);
      stats.failures.push({
        studentId: e.studentId,
        enrollmentId: e.id,
        cycleNumber: cycle.cycleNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}

async function createCycleInvoice(
  e: {
    id: string;
    studentId: string;
    customMonthlyFee: number | null;
    monthlyDiscount: number;
    batch: { id: string; name: string; coachId: string };
    plan: { id: string; name: string; monthlyFee: number };
  },
  cycle: Cycle,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const fee = effectiveMonthlyFee(e.plan.monthlyFee, e.customMonthlyFee, e.monthlyDiscount);
      const number = await nextInvoiceNumber(tx, cycle.issueDate);
      await tx.insert(invoices).values({
        number,
        studentId: e.studentId,
        enrollmentId: e.id,
        cycleNumber: cycle.cycleNumber,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        issueDate: cycle.issueDate,
        dueDate: addDays(cycle.issueDate, INVOICE_DUE_DAYS),
        feePlanId: e.plan.id,
        feePlanName: e.plan.name,
        batchId: e.batch.id,
        batchName: e.batch.name,
        coachId: e.batch.coachId,
        baseAmount: fee.base,
        discountAmount: fee.discount,
        totalAmount: fee.total,
        // A zero-amount cycle (100% discount) is settled immediately.
        status: fee.total === 0 ? 'paid' : 'due',
        paidAt: fee.total === 0 ? new Date() : null,
      });
      return true;
    });
  } catch (err) {
    // Another process created this cycle concurrently — the transaction rolled back (including
    // the sequence increment), so numbering stays gap-free.
    if (mapPgError(err)?.code === 'CONFLICT') return false;
    throw err;
  }
}

/**
 * Prepaid billing: issue a newly accepted (or rejoined) student's first invoice right away.
 * Never throws — if it fails, the nightly job issues it on its next run.
 */
export async function billOnAcceptance(studentId: string): Promise<void> {
  try {
    const stats = await generateDueInvoices(todayInAppTz(), { studentId });
    if (stats.failures.length)
      logger.warn({ studentId, failures: stats.failures }, 'First invoice deferred to nightly run');
  } catch (err) {
    logger.error({ err, studentId }, 'First invoice deferred to nightly run');
  }
}
