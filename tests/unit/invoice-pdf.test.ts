import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import {
  amountInWords,
  renderInvoicePdf,
  upiLink,
  type InvoicePdfData,
} from '../../src/modules/billing/invoice-pdf';
import type { AcademySettings } from '../../src/modules/settings/settings';

const academy = {
  id: 1,
  name: 'Smash Point Academy',
  legalName: 'Smash Point Sports LLP',
  address: '12 MG Road, Bengaluru 560001',
  phone: '+91 98765 43210',
  email: 'hello@smashpoint.in',
  website: 'smashpoint.in',
  gstin: '29ABCDE1234F1Z5',
  upiId: 'smashpoint@upi',
  invoiceFooter: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as AcademySettings;

const base: InvoicePdfData = {
  number: 'ATQ/2025-26/00042',
  issueDate: '2026-03-05',
  dueDate: '2099-03-12',
  periodStart: '2026-03-05',
  periodEnd: '2026-04-04',
  status: 'due',
  feePlanName: '3 days a week',
  batchName: 'Morning U-12',
  baseAmount: 300_000,
  discountAmount: 50_000,
  totalAmount: 250_000,
  student: {
    fullName: 'Riya Sharma',
    code: 'ATQ-0001',
    guardianName: 'Anil Sharma',
    phone: '+919876543210',
    address: '45 Residency Road, Bengaluru',
  },
  payment: null,
  coachName: 'Kavya Iyer',
  trainingDays: [5, 1, 3],
};

const keep = (name: string, pdf: Buffer) => {
  const dir = process.env.REPORT_SAMPLES;
  if (dir) fs.writeFileSync(`${dir}/${name}`, pdf);
};

describe('amount in words', () => {
  it('uses Indian numbering', () => {
    expect(amountInWords(250_000)).toBe('Two Thousand Five Hundred Rupees Only');
    expect(amountInWords(100)).toBe('One Rupee Only');
    expect(amountInWords(0)).toBe('Zero Rupees Only');
    expect(amountInWords(12_345_678_950)).toBe(
      'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Rupees and Fifty Paise Only',
    );
    expect(amountInWords(1_100_00)).toBe('One Thousand One Hundred Rupees Only');
  });

  it('builds a UPI link with the amount filled in', () => {
    const link = upiLink(academy, base);
    expect(link).toMatch(/^upi:\/\/pay\?/);
    expect(link).toContain('pa=smashpoint%40upi');
    expect(link).toContain('am=2500.00');
  });
});

describe('invoice PDF', () => {
  it('renders a due invoice with a UPI QR code and other dues', async () => {
    const pdf = await renderInvoicePdf(
      {
        ...base,
        otherDue: [
          { number: 'ATQ/2025-26/00031', dueDate: '2026-02-12', amount: 250_000 },
          { number: 'ATQ/2025-26/00050', dueDate: '2099-04-12', amount: 250_000 },
        ],
      },
      academy,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    keep('invoice-due.pdf', pdf);
  });

  it('renders overdue, paid (receipt), refunded and cancelled variants', async () => {
    const overdue = await renderInvoicePdf(
      { ...base, dueDate: '2026-01-01', discountAmount: 0, totalAmount: 300_000 },
      {
        ...academy,
        upiId: null,
        phone: null,
        legalName: null,
        invoiceFooter: 'See you on court!',
      },
    );
    keep('invoice-overdue.pdf', overdue);
    const paid = await renderInvoicePdf(
      {
        ...base,
        status: 'paid',
        payment: { paidOn: '2026-03-08', mode: 'upi', reference: 'UTR 4412' },
        history: [
          {
            paidOn: '2026-03-06',
            amount: 250_000,
            mode: 'cash',
            status: 'reverted',
            reason: 'Wrong student',
          },
          {
            paidOn: '2026-03-07',
            amount: 250_000,
            mode: 'mystery',
            status: 'refunded',
            reason: null,
          },
        ],
      },
      academy,
    );
    keep('invoice-paid.pdf', paid);
    const minimal = {
      ...base,
      batchName: null,
      coachName: null,
      trainingDays: null,
      student: { ...base.student, guardianName: null, address: null },
    };
    for (const status of ['refunded', 'cancelled'] as const) {
      const pdf = await renderInvoicePdf({ ...minimal, status }, { ...academy, gstin: null });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(paid.length).toBeGreaterThan(3000);
    expect(overdue.length).toBeGreaterThan(3000);
  });
});
