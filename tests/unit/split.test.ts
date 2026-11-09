import { describe, expect, it } from '@jest/globals';
import {
  allocate,
  computeShares,
  validateTree,
  type SplitNode,
} from '../../src/modules/funds/split';

const pct = (name: string, percent: number, extra: Partial<SplitNode> = {}): SplitNode => ({
  name,
  kind: 'percent',
  value: Math.round(percent * 100),
  recipient: 'academy',
  userId: null,
  payeeId: null,
  children: [],
  ...extra,
});
const flat = (name: string, paise: number, extra: Partial<SplitNode> = {}): SplitNode => ({
  ...pct(name, 0, extra),
  kind: 'flat',
  value: paise,
  ...extra,
});

describe('allocate', () => {
  it('takes flats first, then divides the rest by percentage', () => {
    expect(allocate([flat('Rent', 20_000), pct('A', 50), pct('B', 50)], 200_000)).toEqual([
      20_000, 90_000, 90_000,
    ]);
  });

  it('gives rounding paise to the largest percentage (first on a tie)', () => {
    expect(allocate([pct('A', 33.33), pct('B', 33.34), pct('C', 33.33)], 100)).toEqual([
      33, 34, 33,
    ]);
    expect(allocate([pct('A', 50), pct('B', 50)], 101)).toEqual([51, 50]);
  });

  it('pays flats in order until the money runs out', () => {
    expect(allocate([flat('A', 600), flat('B', 600), pct('C', 100)], 1000)).toEqual([600, 400, 0]);
  });

  it('leaves money unassigned when there is no percentage (caught by validation)', () => {
    expect(allocate([flat('A', 300)], 1000)).toEqual([300]);
  });
});

describe('computeShares', () => {
  const tree: SplitNode[] = [
    pct('Academy', 50, {
      recipient: null,
      children: [
        pct('Society', 35, { recipient: 'payee', payeeId: 'society' }),
        pct('Academy', 65),
      ],
    }),
    pct('Coach', 50, { recipient: 'batch_coach' }),
  ];

  it('splits ₹2,000: half to the coach, and 35% of the academy half to the society', () => {
    expect(computeShares(tree, 200_000, 'coach-1')).toEqual([
      {
        label: 'Society',
        account: 'payee_due',
        userId: null,
        payeeId: 'society',
        amount: 35_000,
      },
      {
        label: 'Academy',
        account: 'academy_fund',
        userId: null,
        payeeId: null,
        amount: 65_000,
      },
      { label: 'Coach', account: 'staff_due', userId: 'coach-1', payeeId: null, amount: 100_000 },
    ]);
  });

  it('gives the coach share to the academy when the invoice has no coach', () => {
    const lines = computeShares(tree, 200_000, null);
    expect(lines.at(-1)).toMatchObject({ label: 'Coach', account: 'academy_fund' });
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(200_000);
  });

  it('pays a fixed staff member, drops zero lines and uses the academy when unsplit', () => {
    const t = [flat('Kit', 50_000, { recipient: 'staff', userId: 'u1' }), pct('Rest', 100)];
    expect(computeShares(t, 30_000, null)).toEqual([
      { label: 'Kit', account: 'staff_due', userId: 'u1', payeeId: null, amount: 30_000 },
    ]);
    expect(computeShares([], 1_000, null)).toEqual([
      { label: 'Academy', account: 'academy_fund', userId: null, payeeId: null, amount: 1_000 },
    ]);
  });

  it('never loses money on a malformed tree', () => {
    const lines = computeShares([flat('Only', 300)], 1_000, null);
    expect(lines.at(-1)).toMatchObject({ label: 'Unassigned', amount: 700 });
  });
});

describe('validateTree', () => {
  const messages = (t: SplitNode[]) => validateTree(t).map((e) => `${e.path}: ${e.message}`);

  it('accepts a valid two-level tree', () => {
    expect(
      validateTree([
        flat('Rent', 10_000),
        pct('Academy', 60, {
          recipient: null,
          children: [pct('Society', 100, { recipient: 'payee', payeeId: 'p' })],
        }),
        pct('Coach', 40, { recipient: 'batch_coach' }),
      ]),
    ).toEqual([]);
  });

  it('reports every kind of problem', () => {
    expect(messages([])).toEqual([': Add at least one section']);
    expect(messages([flat('A', 10)])).toEqual([
      ': Add a percentage section to receive what is left',
    ]);
    expect(messages([pct('A', 60), pct('a', 30)])).toEqual([
      ': Percentages add up to 90%, not 100%',
    ]);
    expect(messages([pct('A', 150), pct('B', -50)])).toEqual([
      '0: A percentage cannot exceed 100%',
    ]);
    expect(
      messages([
        pct('A', 25, { recipient: null }),
        pct('B', 25, { recipient: 'staff' }),
        pct('C', 25, { recipient: 'payee' }),
        pct('D', 25, { children: [pct('X', 100)] }),
      ]),
    ).toEqual([
      '0: Choose who receives this section',
      '1: Choose a staff member',
      '2: Choose a payee',
      '3: A divided section cannot also have a recipient',
    ]);
    expect(
      messages([
        pct('A', 100, {
          recipient: null,
          children: [pct('B', 100, { recipient: null, children: [pct('C', 100)] })],
        }),
      ]),
    ).toEqual(['0.children.0: Only two levels are allowed']);
    expect(messages([pct('A', 100, { recipient: null, children: [] }), ...[]])).toEqual([
      '0: Choose who receives this section',
    ]);
    const many = Array.from({ length: 13 }, (_, i) =>
      pct(`S${i}`, i === 0 ? 100 - 12 * 0.01 : 0.01),
    );
    expect(messages(many)[0]).toBe(': At most 12 sections');
  });
});
