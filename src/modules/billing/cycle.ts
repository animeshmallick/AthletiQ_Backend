/**
 * Billing-cycle rules — PREPAID (pure functions, unit-tested).
 *
 *  - A student's cycles are anchored on the joining date's day-of-month.
 *    Joined 10 Mar → cycle 1 = 10 Mar–09 Apr, cycle 2 = 10 Apr–09 May, …
 *  - Short months clamp to their last day but keep the anchor:
 *    Joined 31 Jan → cycles start 31 Jan, 28/29 Feb, 31 Mar, 30 Apr, …
 *  - Fees are paid in advance. The FIRST invoice is issued when the student is accepted
 *    (`billingStartsOn`, normally the acceptance day — even if training starts later); every
 *    following invoice is issued on the day its month starts. Billing never pauses.
 *  - Cycles that started before `billingStartsOn` are never billed (lets admins import existing
 *    students without back-billing months settled outside the system).
 *  - When a student leaves, no cycle starting after the leaving date is billed. The month in
 *    progress was already paid in advance (adjust/refund it from the invoice if needed).
 *  - If they rejoin, cycles restart from the rejoin date (billingAnchorDate) and continue the
 *    cycle numbering (cycleOffset); the first new invoice is issued at rejoin.
 */
import { addDays, addMonthsClamped, dateParts, type IsoDate } from '../../lib/dates.js';

export interface Cycle {
  cycleNumber: number;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Date the invoice for this cycle is generated (in advance of / at the start of the period). */
  issueDate: IsoDate;
}

/** Cycle `n` (1-based) of an anchor, issued on its own start date. */
export function cycleFor(anchorDate: IsoDate, cycleNumber: number): Cycle {
  if (cycleNumber < 1) throw new RangeError('cycleNumber is 1-based');
  const anchor = dateParts(anchorDate).day;
  const periodStart = addMonthsClamped(anchorDate, cycleNumber - 1, anchor);
  const nextStart = addMonthsClamped(anchorDate, cycleNumber, anchor);
  return { cycleNumber, periodStart, periodEnd: addDays(nextStart, -1), issueDate: periodStart };
}

export interface BillableStudent {
  joiningDate: IsoDate;
  /** Anchor for the current billing run (rejoin date); null/undefined means the joining date. */
  billingAnchorDate?: IsoDate | null;
  /** Cycles invoiced before the current anchor (0 unless the student rejoined). */
  cycleOffset?: number;
  /** Acceptance date: the first invoice is issued here; earlier-starting cycles are not billed. */
  billingStartsOn: IsoDate;
  leftOn: IsoDate | null;
  /** Highest cycle number already invoiced (0 if none). */
  lastInvoicedCycle: number;
}

/** Safety valve: never generate more than this many invoices for one student in one run. */
export const MAX_CYCLES_PER_RUN = 36;

function anchorOf(student: BillableStudent): IsoDate {
  return student.billingAnchorDate ?? student.joiningDate;
}

/**
 * Cycle `k` (1-based) of the current anchor, numbered globally as `offset + k` so invoice cycle
 * numbers stay unique across a leave → rejoin. The first billable cycle is issued on
 * `billingStartsOn` (acceptance) instead of waiting for its start date.
 */
function billedCycle(student: BillableStudent, k: number): Cycle | null {
  const base = cycleFor(anchorOf(student), k);
  if (base.periodStart < student.billingStartsOn) return null; // settled outside the system
  const isFirstBillable =
    k === 1 || cycleFor(anchorOf(student), k - 1).periodStart < student.billingStartsOn;
  return {
    ...base,
    cycleNumber: (student.cycleOffset ?? 0) + k,
    issueDate:
      isFirstBillable && student.billingStartsOn < base.periodStart
        ? student.billingStartsOn
        : base.periodStart,
  };
}

function firstLocalCycle(student: BillableStudent): number {
  return Math.max(student.lastInvoicedCycle - (student.cycleOffset ?? 0), 0) + 1;
}

/** Cycles whose invoice is due to be issued by `today` and has not been generated yet. */
export function cyclesDue(student: BillableStudent, today: IsoDate): Cycle[] {
  const due: Cycle[] = [];
  for (
    let k = firstLocalCycle(student), guard = 0;
    due.length < MAX_CYCLES_PER_RUN && guard < 1200;
    k++, guard++
  ) {
    const start = cycleFor(anchorOf(student), k).periodStart;
    if (student.leftOn && start > student.leftOn) break;
    const cycle = billedCycle(student, k);
    if (!cycle) continue;
    if (cycle.issueDate > today) break;
    due.push(cycle);
  }
  return due;
}

/** The next invoice that will be issued after `today` (for projections). */
export function nextUpcomingCycle(student: BillableStudent, today: IsoDate): Cycle | null {
  for (let k = firstLocalCycle(student), guard = 0; guard < 1200; k++, guard++) {
    const start = cycleFor(anchorOf(student), k).periodStart;
    if (student.leftOn && start > student.leftOn) return null;
    const cycle = billedCycle(student, k);
    if (cycle && cycle.issueDate > today) return cycle;
  }
  return null;
}
