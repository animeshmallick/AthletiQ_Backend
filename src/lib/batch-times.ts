/**
 * Batch timings: every batch has a default start/end time, and any of its weekdays can run at
 * a different time ("Mon 6–8 am, Sat 7–9 am"). Overrides are stored per ISO weekday
 * (1 = Monday … 7 = Sunday) in `batches.day_times`; days without one use the default.
 */
import { isoWeekday, type IsoDate } from './dates.js';

export interface TimeSlot {
  start: string;
  end: string;
}

/** ISO weekday ("1"…"7") → that day's own time, when it differs from the batch default. */
export type DayTimes = Partial<Record<string, TimeSlot>>;

export interface Timed {
  startTime: string;
  endTime: string;
  dayTimes?: DayTimes | null;
}

/** The batch's time on an ISO weekday, or on a date. */
export function timesOn(b: Timed, day: number | IsoDate): { startTime: string; endTime: string } {
  const weekday = typeof day === 'number' ? day : isoWeekday(day);
  const own = b.dayTimes?.[String(weekday)];
  return own
    ? { startTime: own.start, endTime: own.end }
    : { startTime: b.startTime, endTime: b.endTime };
}

/** The batch as it runs on a date: its start/end replaced with that day's time. */
export function onDay<T extends Timed>(b: T, day: IsoDate): T {
  return { ...b, ...timesOn(b, day) };
}

/**
 * Keeps only overrides for days the batch runs that actually differ from the default, so
 * "same as usual" never lingers as an override when the default later changes.
 */
export function normalizeDayTimes(
  dayTimes: DayTimes | null | undefined,
  weekdays: number[],
  startTime: string,
  endTime: string,
): DayTimes {
  const out: DayTimes = {};
  for (const d of [...weekdays].sort((a, b) => a - b)) {
    const t = dayTimes?.[String(d)];
    if (t && (t.start !== startTime || t.end !== endTime)) out[String(d)] = t;
  }
  return out;
}

/** True when any day runs at its own time. */
export const hasDayTimes = (b: Timed) => Object.keys(b.dayTimes ?? {}).length > 0;

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "17:00:00" → "5:00 pm" */
export function clockLabel(t: string): string {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

const range = (t: { startTime: string; endTime: string }) =>
  `${clockLabel(t.startTime)}–${clockLabel(t.endTime)}`;

/**
 * "Mon · Wed · Fri · 6:00 am–8:00 am" when every day runs at the same time, otherwise the
 * days grouped by time: "Mon · Wed 6:00 am–8:00 am, Sat 7:00 am–9:00 am".
 */
export function scheduleLabel(b: Timed & { weekdays: number[] }): string {
  const days = [...b.weekdays].sort((x, y) => x - y);
  const groups = new Map<string, number[]>();
  for (const d of days) {
    const r = range(timesOn(b, d));
    groups.set(r, [...(groups.get(r) ?? []), d]);
  }
  const label = (ds: number[]) => ds.map((d) => DAY[d]).join(' · ');
  if (groups.size <= 1) return `${label(days)} · ${range(b)}`;
  return [...groups].map(([r, ds]) => `${label(ds)} ${r}`).join(', ');
}
