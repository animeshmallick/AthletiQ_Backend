/**
 * Calendar-date helpers operating on ISO `YYYY-MM-DD` strings.
 *
 * Business dates (joining date, attendance day, invoice period) are *calendar days* in the
 * academy timezone, not instants, so we avoid `Date` objects with local-time semantics. All
 * arithmetic is done in UTC on midnight values, which is timezone-independent and DST-safe.
 */
import { APP_TIMEZONE } from '../config/constants.js';

export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toUtc(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function dateParts(date: IsoDate): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
}

export function makeDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/**
 * Adds calendar months while keeping the *anchor day*; when the target month is shorter, the
 * last day of that month is used (31 Jan +1 → 28/29 Feb, 31 Jan +2 → 31 Mar).
 */
export function addMonthsClamped(date: IsoDate, months: number, anchorDay?: number): IsoDate {
  const { year, month, day } = dateParts(date);
  const anchor = anchorDay ?? day;
  const totalMonths = year * 12 + (month - 1) + months;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  return makeDate(y, m, Math.min(anchor, daysInMonth(y, m)));
}

/** Whole days from `a` to `b` (positive when b is after a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const dow = toUtc(date).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Monday of the week containing `date`. */
export function startOfIsoWeek(date: IsoDate): IsoDate {
  return addDays(date, 1 - isoWeekday(date));
}

/** Sunday of the week containing `date`. */
export function endOfIsoWeek(date: IsoDate): IsoDate {
  return addDays(startOfIsoWeek(date), 6);
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = dateParts(date);
  return makeDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = dateParts(date);
  return makeDate(year, month, daysInMonth(year, month));
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date in the academy timezone at the given instant (defaults to now). */
export function todayInAppTz(now: Date = new Date()): IsoDate {
  return dayFormatter.format(now);
}

/** Indian financial year label (April–March) for a date, e.g. 2026-11-08 → "2026-27". */
export function financialYear(date: IsoDate): string {
  const { year, month } = dateParts(date);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const displayFormatter = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** e.g. "08 Nov 2026". */
export function formatDisplayDate(date: IsoDate): string {
  return displayFormatter.format(toUtc(date));
}
