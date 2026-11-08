import { describe, expect, it } from '@jest/globals';
import {
  cycleFor,
  cyclesDue,
  MAX_CYCLES_PER_RUN,
  nextUpcomingCycle,
  type BillableStudent,
} from '../../src/modules/billing/cycle';

const student = (overrides: Partial<BillableStudent> = {}): BillableStudent => ({
  joiningDate: '2026-03-10',
  billingStartsOn: '2026-03-10',
  leftOn: null,
  lastInvoicedCycle: 0,
  ...overrides,
});

describe('cycleFor', () => {
  it('anchors cycles on the joining day', () => {
    expect(cycleFor('2026-03-10', 1)).toEqual({
      cycleNumber: 1,
      periodStart: '2026-03-10',
      periodEnd: '2026-04-09',
      issueDate: '2026-04-10',
    });
    expect(cycleFor('2026-03-10', 10)).toMatchObject({
      periodStart: '2026-12-10',
      issueDate: '2027-01-10',
    });
  });

  it('clamps to month end for late joiners but keeps the original anchor', () => {
    const join = '2026-01-31';
    expect(cycleFor(join, 1)).toMatchObject({
      periodStart: '2026-01-31',
      periodEnd: '2026-02-27',
      issueDate: '2026-02-28',
    });
    expect(cycleFor(join, 2)).toMatchObject({
      periodStart: '2026-02-28',
      periodEnd: '2026-03-30',
      issueDate: '2026-03-31',
    });
    expect(cycleFor(join, 3)).toMatchObject({
      periodStart: '2026-03-31',
      periodEnd: '2026-04-29',
      issueDate: '2026-04-30',
    });
  });

  it('handles leap years', () => {
    expect(cycleFor('2028-01-29', 1).issueDate).toBe('2028-02-29');
    expect(cycleFor('2027-01-29', 1).issueDate).toBe('2027-02-28');
  });

  it('produces contiguous, non-overlapping periods', () => {
    for (let n = 1; n < 24; n++) {
      const a = cycleFor('2026-01-31', n);
      const b = cycleFor('2026-01-31', n + 1);
      expect(b.periodStart).toBe(a.issueDate);
    }
  });

  it('rejects non-positive cycle numbers', () => {
    expect(() => cycleFor('2026-01-01', 0)).toThrow(RangeError);
  });
});

describe('cyclesDue', () => {
  it('returns nothing before the first month completes', () => {
    expect(cyclesDue(student(), '2026-04-09')).toEqual([]);
  });

  it('bills on the day the month completes', () => {
    const due = cyclesDue(student(), '2026-04-10');
    expect(due.map((c) => c.cycleNumber)).toEqual([1]);
  });

  it('catches up on several missed cycles in order', () => {
    expect(cyclesDue(student(), '2026-07-15').map((c) => c.cycleNumber)).toEqual([1, 2, 3, 4]);
  });

  it('skips cycles already invoiced', () => {
    expect(
      cyclesDue(student({ lastInvoicedCycle: 3 }), '2026-07-15').map((c) => c.cycleNumber),
    ).toEqual([4]);
  });

  it('does not back-bill cycles that ended before billing started', () => {
    const imported = student({ joiningDate: '2025-06-10', billingStartsOn: '2026-03-01' });
    const due = cyclesDue(imported, '2026-04-12');
    // Cycle 9 (10 Feb–09 Mar) overlaps billingStartsOn; cycle 10 (10 Mar–09 Apr) is complete.
    expect(due.map((c) => c.periodStart)).toEqual(['2026-02-10', '2026-03-10']);
  });

  it('stops at the leaving date and never bills a partial final month', () => {
    const left = student({ leftOn: '2026-06-20' });
    const due = cyclesDue(left, '2026-12-31');
    expect(due.map((c) => c.cycleNumber)).toEqual([1, 2, 3]);
    expect(due.at(-1)!.periodEnd).toBe('2026-06-09');
  });

  it('bills the final cycle when the student leaves exactly at its end', () => {
    expect(
      cyclesDue(student({ leftOn: '2026-04-09' }), '2026-12-31').map((c) => c.cycleNumber),
    ).toEqual([1]);
  });

  it('caps the number of cycles generated per run', () => {
    const ancient = student({ joiningDate: '2010-01-01', billingStartsOn: '2010-01-01' });
    expect(cyclesDue(ancient, '2026-12-31')).toHaveLength(MAX_CYCLES_PER_RUN);
  });
});

describe('nextUpcomingCycle', () => {
  it('returns the next cycle to be invoiced', () => {
    expect(nextUpcomingCycle(student({ lastInvoicedCycle: 1 }), '2026-04-15')).toMatchObject({
      cycleNumber: 2,
      issueDate: '2026-05-10',
    });
  });

  it('skips already-completed but un-invoiced cycles', () => {
    expect(nextUpcomingCycle(student(), '2026-05-11')?.issueDate).toBe('2026-06-10');
  });

  it('returns null for students who will not be billed again', () => {
    expect(nextUpcomingCycle(student({ leftOn: '2026-04-20' }), '2026-04-15')).toBeNull();
  });

  it('respects billingStartsOn for future billing', () => {
    expect(
      nextUpcomingCycle(
        student({ joiningDate: '2026-01-10', billingStartsOn: '2026-08-01' }),
        '2026-02-01',
      )?.issueDate,
    ).toBe('2026-08-10');
  });
});
