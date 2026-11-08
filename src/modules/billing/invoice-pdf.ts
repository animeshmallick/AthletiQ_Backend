import PDFDocument from 'pdfkit';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { formatInrAscii } from '../../lib/money.js';
import type { AcademySettings } from '../settings/settings.js';

export interface InvoicePdfData {
  number: string;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  status: 'due' | 'paid' | 'refunded' | 'cancelled';
  feePlanName: string;
  batchName: string | null;
  baseAmount: number;
  discountAmount: number;
  totalAmount: number;
  student: {
    fullName: string;
    code: string;
    guardianName: string | null;
    phone: string;
    address: string | null;
  };
  payment: { paidOn: string; mode: string; reference: string | null } | null;
}

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  brand: '#4f46e5',
  paid: '#16a34a',
  due: '#d97706',
  overdue: '#dc2626',
  void: '#64748b',
};

const MODE_LABELS: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

/** Renders a clean A4 invoice and resolves with the PDF bytes. */
export function renderInvoicePdf(inv: InvoicePdfData, academy: AcademySettings): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `Invoice ${inv.number}`, Author: academy.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 6).fill(COLORS.brand);
    doc
      .fillColor(COLORS.ink)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(academy.name, left, 40, { width: width / 2 });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    const academyLines = [
      academy.legalName,
      academy.address,
      academy.phone,
      academy.email,
      academy.website,
      academy.gstin ? `GSTIN: ${academy.gstin}` : null,
    ].filter(Boolean) as string[];
    doc.text(academyLines.join('\n'), left, doc.y + 4, { width: width / 2 });
    const headerBottom = doc.y;

    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor(COLORS.ink)
      .text('INVOICE', left + width / 2, 40, { width: width / 2, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
    const meta: [string, string][] = [
      ['Invoice no.', inv.number],
      ['Issue date', formatDisplayDate(inv.issueDate)],
      ['Due date', formatDisplayDate(inv.dueDate)],
    ];
    let y = 74;
    for (const [k, v] of meta) {
      doc
        .fillColor(COLORS.muted)
        .text(k, left + width / 2, y, { width: width / 4, align: 'right' });
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica-Bold')
        .text(v, left + (3 * width) / 4, y, { width: width / 4, align: 'right' });
      doc.font('Helvetica');
      y += 16;
    }

    // ── Status badge ──
    const overdue = inv.status === 'due' && inv.dueDate < todayInAppTz();
    const badge =
      inv.status === 'paid'
        ? { text: 'PAID', color: COLORS.paid }
        : inv.status === 'refunded'
          ? { text: 'REFUNDED', color: COLORS.void }
          : inv.status === 'cancelled'
            ? { text: 'CANCELLED', color: COLORS.void }
            : overdue
              ? { text: 'OVERDUE', color: COLORS.overdue }
              : { text: 'PAYMENT DUE', color: COLORS.due };
    doc.font('Helvetica-Bold').fontSize(9);
    const bw = doc.widthOfString(badge.text) + 16;
    doc.roundedRect(right - bw, y + 4, bw, 18, 9).fill(badge.color);
    doc.fillColor('#ffffff').text(badge.text, right - bw, y + 9, { width: bw, align: 'center' });

    // ── Bill to ──
    y = Math.max(headerBottom, y + 30) + 20;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(COLORS.line).lineWidth(1).stroke();
    y += 16;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted).text('BILL TO', left, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(COLORS.ink)
      .text(inv.student.fullName, left, y + 14);
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
    const billTo = [
      `Student ID: ${inv.student.code}`,
      inv.student.guardianName ? `Guardian: ${inv.student.guardianName}` : null,
      inv.student.phone,
      inv.student.address,
    ].filter(Boolean) as string[];
    doc.text(billTo.join('\n'), left, y + 30, { width: width / 2 });

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text('BILLING PERIOD', left + width / 2, y, { width: width / 2, align: 'right' });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(COLORS.ink)
      .text(
        `${formatDisplayDate(inv.periodStart)} - ${formatDisplayDate(inv.periodEnd)}`,
        left + width / 2,
        y + 14,
        { width: width / 2, align: 'right' },
      );
    if (inv.batchName) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLORS.muted)
        .text(`Batch: ${inv.batchName}`, left + width / 2, y + 30, {
          width: width / 2,
          align: 'right',
        });
    }

    // ── Line items ──
    y = Math.max(doc.y, y + 50) + 24;
    doc.rect(left, y, width, 24).fill('#f8fafc');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted);
    doc.text('DESCRIPTION', left + 10, y + 8);
    doc.text('AMOUNT', right - 130, y + 8, { width: 120, align: 'right' });
    y += 34;

    const row = (
      label: string,
      amount: string,
      opts: { bold?: boolean; sub?: string; color?: string } = {},
    ) => {
      doc
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(10)
        .fillColor(opts.color ?? COLORS.ink);
      doc.text(label, left + 10, y, { width: width - 160 });
      doc.text(amount, right - 130, y, { width: 120, align: 'right' });
      if (opts.sub) {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor(COLORS.muted)
          .text(opts.sub, left + 10, y + 14, { width: width - 160 });
        y += 14;
      }
      y += 22;
    };

    row('Monthly coaching fee', formatInrAscii(inv.baseAmount), {
      sub: `Plan: ${inv.feePlanName}`,
    });
    if (inv.discountAmount > 0)
      row('Discount', `- ${formatInrAscii(inv.discountAmount)}`, { color: COLORS.paid });

    doc
      .moveTo(right - 250, y)
      .lineTo(right, y)
      .strokeColor(COLORS.line)
      .stroke();
    y += 12;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.ink);
    doc.text('Total', right - 250, y, { width: 110 });
    doc.text(formatInrAscii(inv.totalAmount), right - 130, y, { width: 120, align: 'right' });
    y += 36;

    // ── Payment details / instructions ──
    if (inv.payment && inv.status === 'paid') {
      doc.roundedRect(left, y, width, 50, 6).fill('#f0fdf4');
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(COLORS.paid)
        .text('Payment received', left + 14, y + 10);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLORS.ink)
        .text(
          `${formatDisplayDate(inv.payment.paidOn)} via ${MODE_LABELS[inv.payment.mode] ?? inv.payment.mode}${inv.payment.reference ? `  (Ref: ${inv.payment.reference})` : ''}`,
          left + 14,
          y + 27,
        );
      y += 66;
    } else if (inv.status === 'due' && academy.upiId) {
      doc.roundedRect(left, y, width, 50, 6).fill('#eef2ff');
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(COLORS.brand)
        .text('How to pay', left + 14, y + 10);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLORS.ink)
        .text(
          `UPI: ${academy.upiId}   ·   Please mention invoice no. ${inv.number}`,
          left + 14,
          y + 27,
        );
      y += 66;
    }

    // ── Footer ──
    const footer = academy.invoiceFooter ?? 'Thank you for training with us!';
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(footer, left, doc.page.height - 90, { width, align: 'center' });
    doc.text(
      'This is a computer-generated invoice and does not require a signature.',
      left,
      doc.page.height - 74,
      {
        width,
        align: 'center',
      },
    );

    doc.end();
  });
}
