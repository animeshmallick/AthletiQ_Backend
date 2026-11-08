import { describe, expect, it } from '@jest/globals';
import { addDays } from '../../src/lib/dates';
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

const numbers = (s: BillableStudent, today: string) =>
  cyclesDue(s, today).map((c) => c.cycleNumber);

describe('cycleFor (prepaid)', () => {
  it('anchors cycles on the joining day and issues each at its start', () => {
    expect(cycleFor('2026-03-10', 1)).toEqual({
      cycleNumber: 1,
      periodStart: '2026-03-10',
      periodEnd: '2026-04-09',
      issueDate: '2026-03-10',
    });
    expect(cycleFor('2026-03-10', 10)).toMatchObject({
      periodStart: '2026-12-10',
      periodEnd: '2027-01-09',
      issueDate: '2026-12-10',
    });
  });

  it('clamps to month end for late joiners but keeps the original anchor', () => {
    const join = '2026-01-31';
    expect(cycleFor(join, 1)).toMatchObject({ periodStart: '2026-01-31', periodEnd: '2026-02-27' });
    expect(cycleFor(join, 2)).toMatchObject({ periodStart: '2026-02-28', periodEnd: '2026-03-30' });
    expect(cycleFor(join, 3)).toMatchObject({ periodStart: '2026-03-31', periodEnd: '2026-04-29' });
  });

  it('handles leap years', () => {
    expect(cycleFor('2028-01-29', 2).periodStart).toBe('2028-02-29');
    expect(cycleFor('2027-01-29', 2).periodStart).toBe('2027-02-28');
  });

  it('produces contiguous, non-overlapping periods', () => {
    for (let n = 1; n < 24; n++) {
      expect(cycleFor('2026-01-31', n + 1).periodStart).toBe(
        addDays(cycleFor('2026-01-31', n).periodEnd, 1),
      );
    }
  });

  it('rejects non-positive cycle numbers', () => {
    expect(() => cycleFor('2026-01-01', 0)).toThrow(RangeError);
  });
});

describe('cyclesDue (prepaid)', () => {
  it('issues the first invoice on acceptance day and nothing before', () => {
    expect(numbers(student(), '2026-03-09')).toEqual([]);
    expect(cyclesDue(student(), '2026-03-10')).toEqual([
      {
        cycleNumber: 1,
        periodStart: '2026-03-10',
        periodEnd: '2026-04-09',
        issueDate: '2026-03-10',
      },
    ]);
  });

  it('bills each following month on the day it starts', () => {
    expect(numbers(student(), '2026-04-09')).toEqual([1]);
    expect(numbers(student(), '2026-04-10')).toEqual([1, 2]);
  });

  it('bills a future joiner immediately at acceptance', () => {
    const accepted = student({ joiningDate: '2026-03-10', billingStartsOn: '2026-03-01' });
    expect(cyclesDue(accepted, '2026-03-01')).toEqual([
      {
        cycleNumber: 1,
        periodStart: '2026-03-10',
        periodEnd: '2026-04-09',
        issueDate: '2026-03-01',
      },
    ]);
    // The second month is still issued on its own start date.
    expect(cyclesDue({ ...accepted, lastInvoicedCycle: 1 }, '2026-04-09')).toEqual([]);
    expect(numbers({ ...accepted, lastInvoicedCycle: 1 }, '2026-04-10')).toEqual([2]);
  });

  it('catches up on several missed months in order', () => {
    expect(numbers(student(), '2026-07-15')).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips months already invoiced', () => {
    expect(numbers(student({ lastInvoicedCycle: 3 }), '2026-07-15')).toEqual([4, 5]);
  });

  it('does not back-bill months that started before billing started (imports)', () => {
    const imported = student({ joiningDate: '2025-06-10', billingStartsOn: '2026-03-01' });
    // 10 Feb – 09 Mar started before 1 Mar → settled outside the system. The 10 Mar month is the
    // first billable one and is issued at acceptance (1 Mar).
    expect(cyclesDue(imported, '2026-03-05')).toEqual([
      {
        cycleNumber: 10,
        periodStart: '2026-03-10',
        periodEnd: '2026-04-09',
        issueDate: '2026-03-01',
      },
    ]);
  });

  it('stops after the leaving date (the month in progress was already prepaid)', () => {
    const due = cyclesDue(student({ leftOn: '2026-06-20' }), '2026-12-31');
    expect(due.map((c) => c.cycleNumber)).toEqual([1, 2, 3, 4]);
    expect(due.at(-1)!.periodStart).toBe('2026-06-10');
    expect(numbers(student({ leftOn: '2026-03-15' }), '2026-12-31')).toEqual([1]);
  });

  it('caps the number of invoices generated per run', () => {
    const ancient = student({ joiningDate: '2010-01-01', billingStartsOn: '2010-01-01' });
    expect(cyclesDue(ancient, '2026-12-31')).toHaveLength(MAX_CYCLES_PER_RUN);
  });
});

describe('nextUpcomingCycle (prepaid)', () => {
  it('returns the next invoice to be issued', () => {
    expect(nextUpcomingCycle(student({ lastInvoicedCycle: 1 }), '2026-04-01')).toMatchObject({
      cycleNumber: 2,
      issueDate: '2026-04-10',
    });
  });

  it('skips months that are already due but not yet generated', () => {
    expect(nextUpcomingCycle(student(), '2026-04-15')?.issueDate).toBe('2026-05-10');
  });

  it('returns null once a student has left', () => {
    expect(
      nextUpcomingCycle(student({ lastInvoicedCycle: 1, leftOn: '2026-03-20' }), '2026-03-25'),
    ).toBeNull();
  });

  it('respects a future billing start (issued at that date)', () => {
    expect(
      nextUpcomingCycle(
        student({ joiningDate: '2026-01-10', billingStartsOn: '2026-08-01' }),
        '2026-02-01',
      ),
    ).toMatchObject({ periodStart: '2026-08-10', issueDate: '2026-08-01' });
  });
});

describe('rejoin anchor (prepaid)', () => {
  const rejoined = student({
    joiningDate: '2026-01-10',
    billingAnchorDate: '2026-05-05',
    cycleOffset: 2,
    billingStartsOn: '2026-05-05',
    lastInvoicedCycle: 2,
  });

  it('bills from the new anchor at rejoin, with continued numbering', () => {
    expect(cyclesDue(rejoined, '2026-05-05')).toEqual([
      {
        cycleNumber: 3,
        periodStart: '2026-05-05',
        periodEnd: '2026-06-04',
        issueDate: '2026-05-05',
      },
    ]);
    expect(numbers({ ...rejoined, lastInvoicedCycle: 3 }, '2026-06-05')).toEqual([4]);
  });

  it('projects the next month from the new anchor', () => {
    expect(nextUpcomingCycle({ ...rejoined, lastInvoicedCycle: 3 }, '2026-05-20')).toMatchObject({
      cycleNumber: 4,
      issueDate: '2026-06-05',
    });
  });
});
