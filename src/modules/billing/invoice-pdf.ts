/**
 * A4 invoice (or receipt, once paid). Built-in Helvetica only, so amounts use "Rs.".
 * Includes: academy and student details, coaching details, line items, amount in words, payment
 * record or a UPI QR code to pay, the student's other dues, payment history, terms and signature.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
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
  /** Optional extras (loaded for the PDF). */
  coachName?: string | null;
  trainingDays?: number[] | null;
  /** The student's other unpaid invoices. */
  otherDue?: { number: string; dueDate: string; amount: number }[];
  /** Reversed / refunded attempts on this invoice, newest first. */
  history?: {
    paidOn: string;
    amount: number;
    mode: string;
    status: string;
    reason: string | null;
  }[];
}

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#e2e8f0',
  soft: '#f8fafc',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
  paid: '#16a34a',
  paidSoft: '#f0fdf4',
  due: '#d97706',
  overdue: '#dc2626',
  void: '#64748b',
};
const M = 46;

export const MODE_LABELS: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Amount in words (Indian numbering) ─────────────────────────────────────

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}

/** 123456.5 rupees → "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only". */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  const words = parts.length ? parts.join(' ') : 'Zero';
  return `${words} Rupee${rupees === 1 ? '' : 's'}${p ? ` and ${belowThousand(p)} Paise` : ''} Only`;
}

/** UPI deep link (also encoded as the QR code). */
export function upiLink(academy: AcademySettings, inv: InvoicePdfData) {
  const q = new URLSearchParams({
    pa: academy.upiId ?? '',
    pn: academy.name,
    am: (inv.totalAmount / 100).toFixed(2),
    cu: 'INR',
    tn: `${inv.number} ${inv.student.code}`.slice(0, 50),
  });
  return `upi://pay?${q.toString()}`;
}

function drawQr(doc: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  doc.rect(x - 4, y - 4, size + 8, size + 8).fill('#ffffff');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c))
        doc.rect(x + c * cell, y + r * cell, cell + 0.05, cell + 0.05).fill(C.ink);
    }
  }
}

/** Renders a clean A4 invoice/receipt and resolves with the PDF bytes. */
export function renderInvoicePdf(inv: InvoicePdfData, academy: AcademySettings): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const today = todayInAppTz();
    const overdue = inv.status === 'due' && inv.dueDate < today;
    const isReceipt = inv.status === 'paid';
    const docTitle = isReceipt ? 'RECEIPT' : 'INVOICE';
    const doc = new PDFDocument({
      size: 'A4',
      margin: M,
      info: {
        Title: `${isReceipt ? 'Receipt' : 'Invoice'} ${inv.number}`,
        Author: academy.name,
        Creator: 'AthletiQ',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = M;
    const right = doc.page.width - M;
    const width = right - left;
    const half = width / 2;
    const money = formatInrAscii;

    // Diagonal watermark for settled / void documents.
    const watermark =
      inv.status === 'paid'
        ? { t: 'PAID', c: C.paid }
        : inv.status === 'cancelled'
          ? { t: 'CANCELLED', c: C.void }
          : inv.status === 'refunded'
            ? { t: 'REFUNDED', c: C.void }
            : null;
    if (watermark) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fillColor(watermark.c).fillOpacity(0.06).font('Helvetica-Bold').fontSize(110);
      doc.text(watermark.t, 0, doc.page.height / 2 - 60, {
        width: doc.page.width,
        align: 'center',
      });
      doc.restore();
      doc.fillOpacity(1);
    }

    // ── Header band ──
    doc.rect(0, 0, doc.page.width, 8).fill(C.brand);
    const initials = academy.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
    doc.roundedRect(left, 36, 40, 40, 9).fill(C.brand);
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(15)
      .text(initials, left, 49, { width: 40, align: 'center' });
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(academy.name, left + 52, 37, { width: half - 52 });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted);
    const academyLines = [
      academy.legalName && academy.legalName !== academy.name ? academy.legalName : null,
      academy.address,
      [academy.phone, academy.email].filter(Boolean).join('  ·  ') || null,
      academy.website,
      academy.gstin ? `GSTIN: ${academy.gstin}` : null,
    ].filter(Boolean) as string[];
    doc.text(academyLines.join('\n'), left + 52, doc.y + 2, { width: half - 52, lineGap: 1 });
    const headerBottom = Math.max(doc.y, 80);

    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(26)
      .text(docTitle, left + half, 34, { width: half, align: 'right', characterSpacing: 1 });
    const badge = isReceipt
      ? { text: 'PAID', color: C.paid }
      : inv.status === 'refunded'
        ? { text: 'REFUNDED', color: C.void }
        : inv.status === 'cancelled'
          ? { text: 'CANCELLED', color: C.void }
          : overdue
            ? { text: 'OVERDUE', color: C.overdue }
            : { text: 'PAYMENT DUE', color: C.due };
    doc.font('Helvetica-Bold').fontSize(8.5);
    const bw = doc.widthOfString(badge.text) + 18;
    doc.roundedRect(right - bw, 68, bw, 17, 8.5).fill(badge.color);
    doc.fillColor('#ffffff').text(badge.text, right - bw, 72.5, { width: bw, align: 'center' });

    // ── Meta strip ──
    let y = Math.max(headerBottom, 92) + 16;
    const meta: [string, string][] = [
      [isReceipt ? 'Receipt no.' : 'Invoice no.', inv.number],
      ['Issue date', formatDisplayDate(inv.issueDate)],
      [
        isReceipt ? 'Paid on' : 'Due date',
        isReceipt && inv.payment
          ? formatDisplayDate(inv.payment.paidOn)
          : formatDisplayDate(inv.dueDate),
      ],
      ['Amount', money(inv.totalAmount)],
    ];
    doc.roundedRect(left, y, width, 44, 6).fill(C.soft);
    const cw = width / meta.length;
    meta.forEach(([k, v], i) => {
      const x = left + i * cw + 12;
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(k.toUpperCase(), x, y + 9, { width: cw - 20 });
      doc
        .fillColor(i === 3 ? C.brand : C.ink)
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .text(v, x, y + 21, { width: cw - 20, lineBreak: false, ellipsis: true });
      if (i > 0)
        doc
          .moveTo(left + i * cw, y + 9)
          .lineTo(left + i * cw, y + 35)
          .lineWidth(0.6)
          .strokeColor(C.line)
          .stroke();
    });
    y += 62;

    // ── Bill to / Coaching ──
    const block = (
      x: number,
      title: string,
      head: string,
      lines: (string | null | undefined)[],
    ) => {
      doc
        .fillColor(C.muted)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(title, x, y, { width: half - 12, characterSpacing: 0.5 });
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(11.5)
        .text(head, x, y + 12, { width: half - 12 });
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(9)
        .text((lines.filter(Boolean) as string[]).join('\n'), x, doc.y + 2, {
          width: half - 12,
          lineGap: 1.5,
        });
      return doc.y;
    };
    const b1 = block(left, 'BILLED TO', inv.student.fullName, [
      `Student ID: ${inv.student.code}`,
      inv.student.guardianName ? `Parent / guardian: ${inv.student.guardianName}` : null,
      `Phone: ${inv.student.phone}`,
      inv.student.address,
    ]);
    const b2 = block(left + half + 12, 'COACHING DETAILS', inv.feePlanName, [
      inv.batchName ? `Batch: ${inv.batchName}` : null,
      inv.coachName ? `Coach: ${inv.coachName}` : null,
      inv.trainingDays?.length
        ? `Training days: ${[...inv.trainingDays]
            .sort((a, b) => a - b)
            .map((d) => DAY[d])
            .join(', ')}`
        : null,
      `Period: ${formatDisplayDate(inv.periodStart)} - ${formatDisplayDate(inv.periodEnd)}`,
    ]);
    y = Math.max(b1, b2) + 20;

    // ── Line items ──
    const cols = { desc: left + 12, period: left + width * 0.44, amt: right - 132 };
    doc.rect(left, y, width, 24).fill(C.brandSoft);
    doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(8);
    doc.text('DESCRIPTION', cols.desc, y + 8.5);
    doc.text('PERIOD', cols.period, y + 8.5);
    doc.text('AMOUNT', cols.amt, y + 8.5, { width: 120, align: 'right' });
    y += 32;
    const line = (
      desc: string,
      sub: string | null,
      period: string,
      amount: string,
      color = C.ink,
    ) => {
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(desc, cols.desc, y, { width: width * 0.44 - 24 });
      if (sub)
        doc
          .fillColor(C.muted)
          .font('Helvetica')
          .fontSize(8.5)
          .text(sub, cols.desc, doc.y + 1, { width: width * 0.44 - 24 });
      const endY = doc.y;
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(9)
        .text(period, cols.period, y + 1, { width: cols.amt - cols.period - 8 });
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(amount, cols.amt, y, { width: 120, align: 'right' });
      y = Math.max(endY, doc.y) + 10;
      doc
        .moveTo(left, y - 4)
        .lineTo(right, y - 4)
        .lineWidth(0.6)
        .strokeColor(C.line)
        .stroke();
      y += 6;
    };
    const period = `${formatDisplayDate(inv.periodStart)} - ${formatDisplayDate(inv.periodEnd)}`;
    line(
      'Monthly coaching fee',
      `${inv.feePlanName}${inv.batchName ? ` · ${inv.batchName}` : ''}`,
      period,
      money(inv.baseAmount),
    );
    if (inv.discountAmount > 0)
      line('Discount', 'Applied to this month', '', `- ${money(inv.discountAmount)}`, C.paid);

    // Totals
    const tx = right - 250;
    const totalRow = (label: string, value: string, bold = false, color = C.ink) => {
      doc
        .fillColor(bold ? color : C.muted)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 12.5 : 9.5)
        .text(label, tx, y, { width: 118 });
      doc
        .fillColor(color)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 12.5 : 9.5)
        .text(value, right - 132, y, { width: 120, align: 'right' });
      y = doc.y + 6;
    };
    totalRow('Subtotal', money(inv.baseAmount));
    if (inv.discountAmount > 0)
      totalRow('Discount', `- ${money(inv.discountAmount)}`, false, C.paid);
    doc.roundedRect(tx - 10, y - 2, right - tx + 10, 28, 5).fill(C.brandSoft);
    y += 6;
    totalRow(isReceipt ? 'Amount paid' : 'Total due', money(inv.totalAmount), true, C.brand);
    y += 6;
    doc
      .fillColor(C.muted)
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .text(`In words: ${amountInWords(inv.totalAmount)}`, left, y, { width });
    y = doc.y + 14;

    // ── Payment ──
    if (isReceipt && inv.payment) {
      doc.roundedRect(left, y, width, 54, 6).fill(C.paidSoft);
      doc
        .fillColor(C.paid)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Payment received - thank you!', left + 14, y + 10);
      doc
        .fillColor(C.ink)
        .font('Helvetica')
        .fontSize(9.5)
        .text(
          `${money(inv.totalAmount)} received on ${formatDisplayDate(inv.payment.paidOn)} via ${MODE_LABELS[inv.payment.mode] ?? inv.payment.mode}${inv.payment.reference ? `  ·  Ref: ${inv.payment.reference}` : ''}`,
          left + 14,
          y + 27,
          { width: width - 28 },
        );
      y += 70;
    } else if (inv.status === 'due') {
      const qrSize = academy.upiId ? 86 : 0;
      const h = academy.upiId ? 112 : 58;
      doc.roundedRect(left, y, width, h, 6).fill(overdue ? '#fef2f2' : C.brandSoft);
      const textW = width - 28 - (qrSize ? qrSize + 20 : 0);
      doc
        .fillColor(overdue ? C.overdue : C.brand)
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .text(
          overdue
            ? `Overdue since ${formatDisplayDate(inv.dueDate)} - please pay at the earliest`
            : `Please pay by ${formatDisplayDate(inv.dueDate)}`,
          left + 14,
          y + 12,
          { width: textW },
        );
      doc.fillColor(C.ink).font('Helvetica').fontSize(9.5);
      if (academy.upiId) {
        doc.text(
          `Scan the QR code with any UPI app (GPay, PhonePe, Paytm, BHIM) - the amount is filled in for you.`,
          left + 14,
          doc.y + 6,
          { width: textW },
        );
        doc.text(`UPI ID: ${academy.upiId}`, left + 14, doc.y + 6, { width: textW });
        doc
          .fillColor(C.muted)
          .fontSize(8.5)
          .text(`Mention ${inv.number} in the payment note.`, left + 14, doc.y + 3, {
            width: textW,
          });
        drawQr(doc, upiLink(academy, inv), right - 14 - qrSize, y + (h - qrSize) / 2, qrSize);
      } else {
        doc.text(
          `Pay at the academy front desk and mention invoice no. ${inv.number}.`,
          left + 14,
          doc.y + 6,
          { width: textW },
        );
      }
      y += h + 14;
    }

    // ── Other dues / history ──
    if (inv.otherDue?.length) {
      const total = inv.otherDue.reduce((n, d) => n + d.amount, 0);
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .text(`Other unpaid invoices for ${inv.student.fullName}: ${money(total)}`, left, y, {
          width,
        });
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(8.5)
        .text(
          inv.otherDue
            .map(
              (d) =>
                `${d.number} (${money(d.amount)}, due ${formatDisplayDate(d.dueDate)}${d.dueDate < today ? ', overdue' : ''})`,
            )
            .join('   ·   '),
          left,
          doc.y + 3,
          { width },
        );
      y = doc.y + 12;
    }
    if (inv.history?.length) {
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text('Payment history', left, y);
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.5);
      for (const h of inv.history) {
        doc.text(
          `${formatDisplayDate(h.paidOn)} · ${money(h.amount)} via ${MODE_LABELS[h.mode] ?? h.mode} · ${h.status}${h.reason ? ` (${h.reason})` : ''}`,
          left,
          doc.y + 2,
          { width },
        );
      }
      y = doc.y + 12;
    }

    // ── Terms + signature (pinned above the footer) ──
    const sigY = doc.page.height - 168;
    if (y < sigY) {
      doc
        .fillColor(C.muted)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text('NOTES', left, sigY, { width: half });
      doc
        .font('Helvetica')
        .fontSize(8)
        .text(
          [
            'Fees are charged per monthly cycle from the joining date.',
            'Please keep this document for your records.',
            academy.phone ? `Questions? Call or WhatsApp ${academy.phone}.` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          left,
          doc.y + 3,
          { width: half, lineGap: 1.5 },
        );
      doc
        .moveTo(right - 170, sigY + 40)
        .lineTo(right, sigY + 40)
        .lineWidth(0.8)
        .strokeColor(C.faint)
        .stroke();
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(8)
        .text(`For ${academy.name}`, right - 170, sigY + 46, { width: 170, align: 'right' });
      doc.text('Authorised signatory', right - 170, doc.y + 1, { width: 170, align: 'right' });
    }

    // ── Footer ──
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 70;
    doc.moveTo(left, fy).lineTo(right, fy).lineWidth(0.6).strokeColor(C.line).stroke();
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(academy.invoiceFooter ?? 'Thank you for training with us!', left, fy + 10, {
        width,
        align: 'center',
      });
    doc
      .fillColor(C.faint)
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        `This is a computer-generated ${isReceipt ? 'receipt' : 'invoice'} and does not require a signature.  ·  Generated ${formatDisplayDate(today)}`,
        left,
        fy + 25,
        { width, align: 'center' },
      );

    doc.end();
  });
}
