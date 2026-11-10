import { describe, expect, it } from '@jest/globals';
import type { PayeeInsights } from '../../src/modules/funds/payee-insights';
import { renderPayeeStatement } from '../../src/modules/funds/payee-statement-pdf';
import type { AcademySettings } from '../../src/modules/settings/settings';

const academy = {
  name: 'AthletiQ Academy',
  phone: null,
  email: 'hi@academy.in',
} as AcademySettings;

function data(
  over: Partial<PayeeInsights> = {},
  history: PayeeInsights['history'] = [],
): PayeeInsights {
  return {
    payee: {
      id: 'p',
      name: 'Society',
      note: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    period: { from: null, to: null },
    summary: {
      owedNow: 0,
      unpaidSince: null,
      unpaidDays: 0,
      earned: 0,
      paid: 0,
      opening: 0,
      closing: 0,
      avgMonthly: 0,
      lifetimeEarned: 0,
      lifetimePaid: 0,
      payouts: 0,
      shares: 0,
      students: 0,
      lastPayout: null,
      expectedMonthly: 0,
      payoutRate: null,
    },
    monthly: [],
    sources: { byBatch: [], byPlan: [], byStudent: [] },
    plans: [],
    history,
    ...over,
  };
}

const row = (i: number, amount: number, reversed = false) => ({
  id: `r${i}`,
  kind: amount > 0 ? ('share' as const) : ('payout' as const),
  date: `2026-0${(i % 9) + 1}-10`,
  amount,
  title: amount > 0 ? `Share of student ${i}’s fee` : 'Paid from academy cash',
  detail: i % 2 ? `ATQ/2026-27/${String(i).padStart(5, '0')} · Morning batch` : null,
  reversed,
  reversalReason: reversed ? 'Bounced cheque' : null,
  balance: 1000 * i,
});

const isPdf = (b: Buffer) => b.subarray(0, 4).toString() === '%PDF';
const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('payee statement PDF', () => {
  it('renders an all-time statement with no activity', async () => {
    const pdf = await renderPayeeStatement(data(), academy);
    expect(isPdf(pdf)).toBe(true);
    expect(pages(pdf)).toBe(1);
  });

  it('renders a period with shares, payouts and a reversal, owed at the end', async () => {
    const pdf = await renderPayeeStatement(
      data(
        {
          period: { from: '2026-01-01', to: '2026-03-31' },
          summary: { ...data().summary, opening: 500, earned: 3000, paid: 1000, closing: 2500 },
        },
        [row(1, 1500), row(2, -1000), row(3, 1500, true)],
      ),
      { ...academy, phone: '+919876543210', email: null },
    );
    expect(isPdf(pdf)).toBe(true);
  });

  it('runs onto more pages for a long history', async () => {
    const many = Array.from({ length: 70 }, (_, i) => row(i + 1, i % 5 ? 1500 : -2000));
    const pdf = await renderPayeeStatement(
      data({ period: { from: '2025-04-01', to: null } }, many),
      academy,
    );
    expect(pages(pdf)).toBeGreaterThan(1);
  });
});
