/**
 * Billing-cycle rules (pure functions, unit-tested).
 *
 *  - A student's cycles are anchored on the joining date's day-of-month.
 *    Joined 10 Mar → cycle 1 = 10 Mar–09 Apr, cycle 2 = 10 Apr–09 May, …
 *  - Short months clamp to their last day but keep the anchor:
 *    Joined 31 Jan → cycles start 31 Jan, 28/29 Feb, 31 Mar, 30 Apr, …
 *  - A cycle is invoiced when it completes, i.e. on the start day of the next cycle
 *    (the "issue date"). Billing never pauses.
 *  - Cycles that ended before `billingStartsOn` are not auto-billed (lets admins import existing
 *    students without back-billing settled months).
 *  - When a student leaves, only cycles that fully completed on or before the leaving date are
 *    billed.
 */
import { addDays, addMonthsClamped, dateParts, type IsoDate } from '../../lib/dates.js';

export interface Cycle {
  cycleNumber: number;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Date the cycle completes and its invoice is generated. */
  issueDate: IsoDate;
}

export function cycleFor(joiningDate: IsoDate, cycleNumber: number): Cycle {
  if (cycleNumber < 1) throw new RangeError('cycleNumber is 1-based');
  const anchor = dateParts(joiningDate).day;
  const periodStart = addMonthsClamped(joiningDate, cycleNumber - 1, anchor);
  const issueDate = addMonthsClamped(joiningDate, cycleNumber, anchor);
  return { cycleNumber, periodStart, periodEnd: addDays(issueDate, -1), issueDate };
}

export interface BillableStudent {
  joiningDate: IsoDate;
  billingStartsOn: IsoDate;
  leftOn: IsoDate | null;
  /** Highest cycle already invoiced (0 if none). */
  lastInvoicedCycle: number;
}

/** Safety valve: never generate more than this many invoices for one student in one run. */
export const MAX_CYCLES_PER_RUN = 36;

/** Cycles that have completed by `today` and still need an invoice. */
export function cyclesDue(student: BillableStudent, today: IsoDate): Cycle[] {
  const due: Cycle[] = [];
  for (let n = student.lastInvoicedCycle + 1; due.length < MAX_CYCLES_PER_RUN; n++) {
    const cycle = cycleFor(student.joiningDate, n);
    if (cycle.issueDate > today) break;
    if (student.leftOn && cycle.periodEnd > student.leftOn) break;
    if (cycle.periodEnd < student.billingStartsOn) continue;
    due.push(cycle);
  }
  return due;
}

/** The next cycle that will be invoiced in the future (for projections). */
export function nextUpcomingCycle(student: BillableStudent, today: IsoDate): Cycle | null {
  let n = Math.max(student.lastInvoicedCycle + 1, 1);
  for (let guard = 0; guard < 1200; guard++, n++) {
    const cycle = cycleFor(student.joiningDate, n);
    if (student.leftOn && cycle.periodEnd > student.leftOn) return null;
    if (cycle.issueDate > today && cycle.periodEnd >= student.billingStartsOn) return cycle;
  }
  return null;
}
