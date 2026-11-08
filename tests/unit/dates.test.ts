import { describe, expect, it } from '@jest/globals';
import {
  addDays,
  addMonthsClamped,
  dateParts,
  daysInMonth,
  diffDays,
  eachDay,
  endOfIsoWeek,
  endOfMonth,
  financialYear,
  formatDisplayDate,
  isIsoDate,
  isoWeekday,
  makeDate,
  maxDate,
  minDate,
  startOfIsoWeek,
  startOfMonth,
  todayInAppTz,
} from '../../src/lib/dates';

describe('dates', () => {
  it('validates ISO calendar dates strictly', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('not a date')).toBe(false);
  });

  it('splits and builds dates', () => {
    expect(dateParts('2026-03-09')).toEqual({ year: 2026, month: 3, day: 9 });
    expect(makeDate(2026, 3, 9)).toBe('2026-03-09');
  });

  it('knows month lengths including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('adds months keeping the anchor day and clamping short months', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsClamped('2026-01-31', 3)).toBe('2026-04-30');
    expect(addMonthsClamped('2028-01-30', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonthsClamped('2026-03-15', -3)).toBe('2025-12-15');
    expect(addMonthsClamped('2026-02-28', 1, 31)).toBe('2026-03-31');
  });

  it('computes day differences and ranges', () => {
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(30);
    expect(diffDays('2026-03-10', '2026-03-01')).toBe(-9);
    expect(eachDay('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(eachDay('2026-03-02', '2026-03-01')).toEqual([]);
    expect(minDate('2026-01-02', '2026-01-01')).toBe('2026-01-01');
    expect(maxDate('2026-01-02', '2026-01-01')).toBe('2026-01-02');
  });

  it('uses ISO weekdays and Monday-based weeks', () => {
    expect(isoWeekday('2026-11-09')).toBe(1); // Monday
    expect(isoWeekday('2026-11-15')).toBe(7); // Sunday
    expect(startOfIsoWeek('2026-11-15')).toBe('2026-11-09');
    expect(startOfIsoWeek('2026-11-09')).toBe('2026-11-09');
    expect(endOfIsoWeek('2026-11-11')).toBe('2026-11-15');
  });

  it('finds month boundaries', () => {
    expect(startOfMonth('2026-02-17')).toBe('2026-02-01');
    expect(endOfMonth('2026-02-17')).toBe('2026-02-28');
  });

  it('computes "today" in IST, not UTC', () => {
    // 20:00 UTC on 31 Dec is already 1 Jan in India (+05:30).
    expect(todayInAppTz(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
    expect(todayInAppTz(new Date('2026-12-31T18:00:00Z'))).toBe('2026-12-31');
    expect(todayInAppTz()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('labels Indian financial years (April–March)', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2099-12-01')).toBe('2099-00');
  });

  it('formats dates for display', () => {
    expect(formatDisplayDate('2026-11-08')).toBe('08 Nov 2026');
  });
});
