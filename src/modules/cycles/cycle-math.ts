/**
 * Batch cycles (pure). A cycle is a whole number of the student's own billing months; it ends with
 * its last month, whatever was attended. Sessions per month = days a week × 4.
 */
import type { IsoDate } from '../../lib/dates.js';
import { cycleFor } from '../billing/cycle.js';

export const sessionsPerMonth = (weekdays: readonly number[]) => weekdays.length * 4;

/** Billing month (1-based, of the anchor) containing `date`. */
export function monthContaining(anchor: IsoDate, date: IsoDate): number {
  let k = 1;
  while (cycleFor(anchor, k).periodEnd < date) k++;
  return k;
}

/** First billing month starting on or after `date`. */
export function monthStartingFrom(anchor: IsoDate, date: IsoDate): number {
  const k = monthContaining(anchor, date);
  return cycleFor(anchor, k).periodStart >= date ? k : k + 1;
}

/** Days covered by `months` billing months from month `firstMonth`. */
export function cycleRange(anchor: IsoDate, firstMonth: number, months: number) {
  return {
    startsOn: cycleFor(anchor, firstMonth).periodStart,
    endsOn: cycleFor(anchor, firstMonth + months - 1).periodEnd,
  };
}
