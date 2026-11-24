import { describe, expect, it } from '@jest/globals';
import { addDays } from '../../src/lib/dates';
import {
  courseTarget,
  cycleContaining,
  reachedOn,
  replayRounds,
  roundMonth,
  sessionsPerMonth,
  unusedValue,
} from '../../src/modules/courses/course-math';

describe('course arithmetic', () => {
  it('gives 4 sessions a month per weekly day, and whole-month targets', () => {
    expect(sessionsPerMonth([1, 3, 5])).toBe(12);
    expect(sessionsPerMonth([6])).toBe(4);
    expect([1, 2, 3, 4].map((m) => courseTarget([1, 3, 5], m))).toEqual([12, 24, 36, 48]);
  });

  it('completes on the day of the session that reaches the target', () => {
    const d = ['2026-03-02', '2026-03-04', '2026-03-06'];
    expect(reachedOn(d, 3)).toBe('2026-03-06');
    expect(reachedOn(d, 2)).toBe('2026-03-04');
    expect(reachedOn(d, 4)).toBeNull();
    expect(reachedOn(d, 0)).toBeNull();
  });

  it('values unused sessions of a month, never below zero', () => {
    // ₹2,500 a month, 12 sessions, 1 used: 11/12 back.
    expect(unusedValue(250_000, 12, 1)).toBe(229_167);
    expect(unusedValue(250_000, 12, 0)).toBe(250_000);
    expect(unusedValue(250_000, 12, 12)).toBe(0);
    expect(unusedValue(250_000, 12, 15)).toBe(0); // makeups beyond the month
    expect(unusedValue(0, 12, 1)).toBe(0);
    expect(unusedValue(250_000, 0, 1)).toBe(0);
  });

  it('counts the months of a round in billing cycles', () => {
    // Anchor on the 2nd: cycles 2 Mar–1 Apr, 2 Apr–1 May, …
    expect(cycleContaining('2026-03-02', '2026-03-02')).toBe(1);
    expect(cycleContaining('2026-03-02', '2026-04-01')).toBe(1);
    expect(cycleContaining('2026-03-02', '2026-04-02')).toBe(2);
    expect(cycleContaining('2026-03-02', '2026-02-01')).toBe(1);
    expect(roundMonth('2026-03-02', '2026-03-02', '2026-03-31')).toBe(1);
    expect(roundMonth('2026-03-02', '2026-03-02', '2026-04-03')).toBe(2);
    // A round that started mid-cycle counts that cycle as its first month.
    expect(roundMonth('2026-03-02', '2026-03-20', '2026-03-25')).toBe(1);
    expect(roundMonth('2026-03-02', '2026-03-20', '2026-04-10')).toBe(2);
  });

  it('replays attendance into consecutive rounds', () => {
    const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-03-01', i));
    const r = replayRounds(dates, 3, '2026-03-01', (d) => addDays(d, 1));
    expect(r.completed).toEqual([
      { startedOn: '2026-03-01', completedOn: '2026-03-03' },
      { startedOn: '2026-03-04', completedOn: '2026-03-06' },
    ]);
    expect(r.openFrom).toBe('2026-03-07');
    // Two sessions on the completion day: the second doesn't carry into the next round.
    const twice = replayRounds(
      ['2026-03-01', '2026-03-02', '2026-03-02', '2026-03-03'],
      2,
      '2026-03-01',
      (d) => addDays(d, 1),
    );
    expect(twice.completed).toEqual([{ startedOn: '2026-03-01', completedOn: '2026-03-02' }]);
    expect(twice.openFrom).toBe('2026-03-03');
    expect(replayRounds([], 3, '2026-03-01', (d) => d)).toEqual({
      completed: [],
      openFrom: '2026-03-01',
    });
  });
});
