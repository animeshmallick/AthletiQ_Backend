import { and, eq, lte, max, sql } from 'drizzle-orm';
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
  studentsScanned: number;
  invoicesCreated: number;
  skippedExisting: number;
  failures: { studentId: string; cycleNumber: number; error: string }[];
}

/**
 * Generates every invoice whose cycle has completed by `today`. Idempotent and self-healing:
 * if the server was down for days, the next run catches up; re-running never duplicates
 * (unique student+cycle). Each invoice is its own transaction so one bad record cannot block
 * the rest.
 */
export async function generateDueInvoices(
  today: IsoDate = todayInAppTz(),
): Promise<GenerationStats> {
  const lastCycle = db
    .select({ studentId: invoices.studentId, last: max(invoices.cycleNumber).as('last') })
    .from(invoices)
    .groupBy(invoices.studentId)
    .as('last_cycle');

  const candidates = await db
    .select({
      id: students.id,
      code: students.code,
      joiningDate: students.joiningDate,
      billingStartsOn: students.billingStartsOn,
      leftOn: students.leftOn,
      customMonthlyFee: students.customMonthlyFee,
      monthlyDiscount: students.monthlyDiscount,
      plan: { id: feePlans.id, name: feePlans.name, monthlyFee: feePlans.monthlyFee },
      lastInvoicedCycle: sql<number>`coalesce(${lastCycle.last}, 0)::int`,
    })
    .from(students)
    .innerJoin(feePlans, eq(feePlans.id, students.feePlanId))
    .leftJoin(lastCycle, eq(lastCycle.studentId, students.id))
    .where(lte(students.joiningDate, addDays(today, -28)));

  const stats: GenerationStats = {
    runDate: today,
    studentsScanned: candidates.length,
    invoicesCreated: 0,
    skippedExisting: 0,
    failures: [],
  };

  // Process in chronological order so invoice numbers follow issue dates (then student code).
  const work = candidates
    .flatMap((s) => cyclesDue(s, today).map((cycle) => ({ s, cycle })))
    .sort(
      (a, b) =>
        a.cycle.issueDate.localeCompare(b.cycle.issueDate) || a.s.code.localeCompare(b.s.code),
    );

  const failedStudents = new Set<string>();
  for (const { s, cycle } of work) {
    // Keep each student's cycles in order: after a failure, retry the rest on the next run.
    if (failedStudents.has(s.id)) continue;
    try {
      const createdInvoice = await createCycleInvoice(s, cycle);
      if (createdInvoice) stats.invoicesCreated++;
      else stats.skippedExisting++;
    } catch (err) {
      logger.error({ err, studentId: s.id, cycle: cycle.cycleNumber }, 'Invoice generation failed');
      failedStudents.add(s.id);
      stats.failures.push({
        studentId: s.id,
        cycleNumber: cycle.cycleNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}

async function createCycleInvoice(
  s: {
    id: string;
    customMonthlyFee: number | null;
    monthlyDiscount: number;
    plan: { id: string; name: string; monthlyFee: number };
  },
  cycle: Cycle,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      // Batch/coach responsible during the cycle (latest enrollment that started within it).
      const [owner] = await tx
        .select({ batchId: batches.id, batchName: batches.name, coachId: batches.coachId })
        .from(enrollments)
        .innerJoin(batches, eq(batches.id, enrollments.batchId))
        .where(
          and(eq(enrollments.studentId, s.id), lte(enrollments.effectiveFrom, cycle.periodEnd)),
        )
        .orderBy(sql`${enrollments.effectiveFrom} desc`)
        .limit(1);

      const fee = effectiveMonthlyFee(s.plan.monthlyFee, s.customMonthlyFee, s.monthlyDiscount);
      const number = await nextInvoiceNumber(tx, cycle.issueDate);
      await tx.insert(invoices).values({
        number,
        studentId: s.id,
        cycleNumber: cycle.cycleNumber,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        issueDate: cycle.issueDate,
        dueDate: addDays(cycle.issueDate, INVOICE_DUE_DAYS),
        feePlanId: s.plan.id,
        feePlanName: s.plan.name,
        batchId: owner?.batchId ?? null,
        batchName: owner?.batchName ?? null,
        coachId: owner?.coachId ?? null,
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
