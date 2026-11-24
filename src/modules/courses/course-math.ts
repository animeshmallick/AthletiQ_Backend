/**
 * Course arithmetic (pure, unit-tested).
 *
 *  - Sessions per month = days a week × 4 (3 days → 12). Target = sessions per month × months.
 *  - A round completes on the day of the session that brings the count to the target.
 *  - Months of a round are the membership's billing cycles, from the one the round starts in.
 *    A month past the course length is an extension month (billed in full in advance); when the
 *    course completes during one, the sessions of it that weren't needed are credited:
 *    month value ÷ sessions per month × unused sessions.
 */
import type { Paise } from '../../lib/money.js';
import type { IsoDate } from '../../lib/dates.js';
import { cycleFor } from '../billing/cycle.js';

export const WEEKS_PER_MONTH = 4;

export const sessionsPerMonth = (weekdays: readonly number[]) => weekdays.length * WEEKS_PER_MONTH;

export const courseTarget = (weekdays: readonly number[], months: number) =>
  sessionsPerMonth(weekdays) * months;

/** The day the `target`-th counted session happened (dates sorted ascending), else null. */
export function reachedOn(dates: readonly IsoDate[], target: number): IsoDate | null {
  if (target < 1) return null;
  return dates.length >= target ? dates[target - 1]! : null;
}

/** Value of the unused part of a month: value ÷ per month × unused (rounded to the paisa). */
export function unusedValue(monthValue: Paise, perMonth: number, used: number): Paise {
  if (perMonth < 1 || monthValue <= 0) return 0;
  const unused = Math.max(0, perMonth - used);
  return Math.round((monthValue * unused) / perMonth);
}

/** Local billing cycle (1-based, of the anchor) that contains `date`. */
export function cycleContaining(anchor: IsoDate, date: IsoDate): number {
  if (date < anchor) return 1;
  for (let k = 1; k < 1300; k++) if (cycleFor(anchor, k).periodEnd >= date) return k;
  return 1300;
}

/**
 * Which month of the round `date` falls in (1 = the cycle the round started in), counting the
 * membership's billing cycles.
 */
export function roundMonth(anchor: IsoDate, startedOn: IsoDate, date: IsoDate): number {
  return cycleContaining(anchor, date) - cycleContaining(anchor, startedOn) + 1;
}

/**
 * Replays attendance into rounds: each time the count reaches the target, a round completes and
 * the next starts the day after. Returns the completed rounds and the start of the open one.
 */
export function replayRounds(
  dates: readonly IsoDate[],
  target: number,
  startedOn: IsoDate,
  nextDay: (d: IsoDate) => IsoDate,
): { completed: { startedOn: IsoDate; completedOn: IsoDate }[]; openFrom: IsoDate } {
  const completed: { startedOn: IsoDate; completedOn: IsoDate }[] = [];
  let from = startedOn;
  let rest = dates.filter((d) => d >= from);
  for (let reached = reachedOn(rest, target); reached; reached = reachedOn(rest, target)) {
    completed.push({ startedOn: from, completedOn: reached });
    from = nextDay(reached);
    rest = rest.filter((d) => d >= from);
  }
  return { completed, openFrom: from };
}
