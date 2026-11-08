import { describe, expect, it, jest } from '@jest/globals';
import {
  signInvoiceLink,
  verifyInvoiceLink,
  whatsappLink,
} from '../../src/modules/billing/share-links';
import { renderInvoicePdf, type InvoicePdfData } from '../../src/modules/billing/invoice-pdf';
import { getDummyHash, hashPassword, verifyPassword } from '../../src/modules/auth/password';
import { signAccessToken, verifyAccessToken } from '../../src/modules/auth/tokens';
import {
  answersSchema,
  CURRENT_WEEKLY_TEMPLATE,
  getTemplate,
} from '../../src/modules/feedback/templates';
import { effectiveMonthlyFee } from '../../src/modules/students/students.service';
import { displayStatus } from '../../src/modules/billing/invoices.service';
import { SignJWT } from 'jose';

describe('effectiveMonthlyFee', () => {
  it('uses the plan fee unless overridden, then applies the discount', () => {
    expect(effectiveMonthlyFee(300_000, null, 0)).toEqual({
      base: 300_000,
      discount: 0,
      total: 300_000,
    });
    expect(effectiveMonthlyFee(300_000, 250_000, 50_000)).toEqual({
      base: 250_000,
      discount: 50_000,
      total: 200_000,
    });
    expect(effectiveMonthlyFee(300_000, 0, 0).total).toBe(0);
  });

  it('never goes negative', () => {
    expect(effectiveMonthlyFee(100_000, null, 500_000)).toEqual({
      base: 100_000,
      discount: 100_000,
      total: 0,
    });
  });
});

describe('displayStatus', () => {
  it('derives overdue from due date', () => {
    expect(displayStatus('due', '2026-03-01', '2026-03-02')).toBe('overdue');
    expect(displayStatus('due', '2026-03-02', '2026-03-02')).toBe('due');
    expect(displayStatus('paid', '2026-01-01', '2026-03-02')).toBe('paid');
  });
});

describe('share links', () => {
  const id = '6f1c2f7a-9b9e-4d0c-9a58-1d2f3e4a5b6c';

  it('signs links that verify until expiry', () => {
    const now = Date.UTC(2026, 0, 1);
    const { url, expiresAt } = signInvoiceLink(id, now);
    expect(url).toMatch(
      new RegExp(`^https://api.test/api/v1/public/invoices/${id}/pdf\\?e=\\d+&s=[\\w-]+$`),
    );
    const params = new URL(url).searchParams;
    expect(verifyInvoiceLink(id, params.get('e')!, params.get('s')!, now)).toBe(true);
    expect(
      verifyInvoiceLink(id, params.get('e')!, params.get('s')!, expiresAt.getTime() + 1000),
    ).toBe(false);
  });

  it('rejects tampering', () => {
    const { url } = signInvoiceLink(id);
    const p = new URL(url).searchParams;
    expect(
      verifyInvoiceLink('00000000-0000-4000-8000-000000000000', p.get('e')!, p.get('s')!),
    ).toBe(false);
    expect(verifyInvoiceLink(id, String(Number(p.get('e')) + 1), p.get('s')!)).toBe(false);
    expect(verifyInvoiceLink(id, 'abc', p.get('s')!)).toBe(false);
  });

  it('builds wa.me links', () => {
    expect(whatsappLink('+91 98765 43210', 'Hi there')).toBe(
      'https://wa.me/919876543210?text=Hi%20there',
    );
    expect(whatsappLink(null, 'x')).toBe('https://wa.me/?text=x');
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('Secret123');
    expect(h).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(h, 'Secret123')).resolves.toBe(true);
    await expect(verifyPassword(h, 'Wrong123')).resolves.toBe(false);
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
    expect(await getDummyHash()).toBe(await getDummyHash());
  });
});

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const { token, expiresIn } = await signAccessToken({ sub: 'user-1', role: 'coach', tv: 3 });
    expect(expiresIn).toBe(15 * 60);
    await expect(verifyAccessToken(token)).resolves.toEqual({
      sub: 'user-1',
      role: 'coach',
      tv: 3,
    });
  });

  it('rejects garbage, wrong secrets and malformed claims', async () => {
    await expect(verifyAccessToken('garbage')).resolves.toBeNull();
    const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
    const base = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('athletiq-api')
        .setAudience('athletiq-clients')
        .setExpirationTime('5m');
    const wrongRole = await base().setSubject('u').sign(secret);
    const withRoleOnly = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('athletiq-api')
      .setAudience('athletiq-clients')
      .setSubject('u')
      .setExpirationTime('5m')
      .sign(secret);
    const noSub = await new SignJWT({ role: 'admin', tv: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('athletiq-api')
      .setAudience('athletiq-clients')
      .setExpirationTime('5m')
      .sign(secret);
    const otherSecret = await new SignJWT({ role: 'admin', tv: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('athletiq-api')
      .setAudience('athletiq-clients')
      .setSubject('u')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(40)));
    await expect(verifyAccessToken(wrongRole)).resolves.toBeNull();
    await expect(verifyAccessToken(withRoleOnly)).resolves.toBeNull();
    await expect(verifyAccessToken(noSub)).resolves.toBeNull();
    await expect(verifyAccessToken(otherSecret)).resolves.toBeNull();
  });
});

describe('feedback templates', () => {
  const t = CURRENT_WEEKLY_TEMPLATE;
  const fields = t.sections.flatMap((s) => s.fields);

  it('has unique field ids and is registered', () => {
    const ids = fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getTemplate(t.key, t.version)).toBe(t);
    expect(getTemplate(t.key, 999)).toBeUndefined();
  });

  const complete = {
    technique: 4,
    fitness: 3,
    game_sense: 5,
    discipline: 4,
    effort: 5,
    teamwork: 4,
    overall: 'improving',
    highlights: 'Great footwork',
    improvements: 'Follow-through',
    home_practice: '',
    injury_concern: false,
  };

  it('accepts partial drafts but strips unknown keys', () => {
    const draft = answersSchema(t, false).parse({ technique: 3, extra: 'x' });
    expect(draft).toEqual({ technique: 3 });
  });

  it('enforces required fields and ranges on submit', () => {
    expect(answersSchema(t, true).parse(complete)).toMatchObject({
      technique: 4,
      overall: 'improving',
    });
    expect(answersSchema(t, true).safeParse({ ...complete, highlights: '  ' }).success).toBe(false);
    expect(answersSchema(t, true).safeParse({ ...complete, technique: 6 }).success).toBe(false);
    expect(answersSchema(t, true).safeParse({ ...complete, overall: 'meh' }).success).toBe(false);
    const { fitness: _omit, ...missing } = complete;
    expect(answersSchema(t, true).safeParse(missing).success).toBe(false);
  });

  it('supports every field type', () => {
    const custom = {
      key: 'custom',
      version: 1,
      title: 'Custom',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            {
              id: 'tags',
              type: 'multiselect' as const,
              label: 'Tags',
              required: true,
              options: [{ value: 'a', label: 'A' }],
            },
            {
              id: 'opt_tags',
              type: 'multiselect' as const,
              label: 'Opt',
              options: [{ value: 'a', label: 'A' }],
            },
            { id: 'name', type: 'text' as const, label: 'Name' },
            { id: 'flag', type: 'boolean' as const, label: 'Flag', required: true },
          ],
        },
      ],
    };
    expect(answersSchema(custom, true).parse({ tags: ['a'], flag: true })).toEqual({
      tags: ['a'],
      flag: true,
    });
    expect(answersSchema(custom, true).safeParse({ tags: [], flag: true }).success).toBe(false);
    expect(answersSchema(custom, false).parse({ tags: [], name: null })).toEqual({
      tags: [],
      name: null,
    });
  });
});

describe('invoice PDF', () => {
  const academy = {
    id: 1,
    name: 'AthletiQ Academy',
    legalName: 'AthletiQ Sports Pvt Ltd',
    address: '1 MG Road, Bengaluru',
    phone: '+919876543210',
    email: 'hello@athletiq.test',
    website: 'athletiq.test',
    gstin: '29ABCDE1234F1Z5',
    upiId: 'academy@okhdfc',
    invoiceFooter: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const base: InvoicePdfData = {
    number: 'ATQ/2026-27/00001',
    issueDate: '2026-04-10',
    dueDate: '2026-04-17',
    periodStart: '2026-03-10',
    periodEnd: '2026-04-09',
    status: 'due',
    feePlanName: '3 days / week',
    batchName: 'Morning U-12',
    baseAmount: 300_000,
    discountAmount: 50_000,
    totalAmount: 250_000,
    student: {
      fullName: 'Aarav Sharma',
      code: 'ATQ-0001',
      guardianName: 'Rohit Sharma',
      phone: '+919876543210',
      address: 'Indiranagar',
    },
    payment: null,
  };

  it.each([
    ['due (future)', { dueDate: '2999-01-01' }],
    ['overdue', { dueDate: '2000-01-01' }],
    [
      'paid',
      {
        status: 'paid' as const,
        payment: { paidOn: '2026-04-12', mode: 'upi', reference: 'UTR123' },
      },
    ],
    [
      'paid unknown mode',
      {
        status: 'paid' as const,
        payment: { paidOn: '2026-04-12', mode: 'barter', reference: null },
      },
    ],
    ['refunded', { status: 'refunded' as const }],
    ['cancelled', { status: 'cancelled' as const, batchName: null, discountAmount: 0 }],
  ])('renders a valid PDF when %s', async (_label, overrides) => {
    const pdf = await renderInvoicePdf({ ...base, ...overrides }, academy);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('renders without optional academy details', async () => {
    const pdf = await renderInvoicePdf(
      { ...base, student: { ...base.student, guardianName: null, address: null } },
      {
        ...academy,
        legalName: null,
        address: null,
        phone: null,
        email: null,
        website: null,
        gstin: null,
        upiId: null,
        invoiceFooter: 'Thanks!',
      },
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('env validation', () => {
  it('exits with a readable error when configuration is invalid', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const original = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'short';
    try {
      jest.isolateModules(() => {
        expect(() => require('../../src/config/env')).toThrow('exit');
      });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('JWT_ACCESS_SECRET: must be at least 32 characters'),
      );
    } finally {
      process.env.JWT_ACCESS_SECRET = original;
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it('parses flags and lists', () => {
    jest.isolateModules(() => {
      const { env, isTest, isProd } =
        require('../../src/config/env') as typeof import('../../src/config/env');
      expect(isTest).toBe(true);
      expect(isProd).toBe(false);
      expect(env.CORS_ORIGINS).toEqual(['https://app.test']);
      expect(env.SCHEDULER_ENABLED).toBe(false);
      expect(env.COOKIE_SECURE).toBe(false);
      expect(env.COOKIE_DOMAIN).toBeUndefined();
    });
  });
});
