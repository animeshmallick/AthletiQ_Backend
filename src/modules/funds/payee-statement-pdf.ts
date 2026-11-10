/**
 * A payee's statement for a period: opening balance, every fee share and payout with a running
 * balance, and the closing balance. Styled like the invoice PDF.
 */
import PDFDocument from 'pdfkit';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { formatInrAscii } from '../../lib/money.js';
import type { AcademySettings } from '../settings/settings.js';
import type { PayeeInsights } from './payee-insights.js';

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#e2e8f0',
  soft: '#f8fafc',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
  paid: '#16a34a',
  owed: '#d97706',
};
const M = 46;

export function renderPayeeStatement(
  data: PayeeInsights,
  academy: AcademySettings,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: M,
      bufferPages: true,
      info: { Title: `Statement · ${data.payee.name}`, Author: academy.name, Creator: 'AthletiQ' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = M;
    const right = doc.page.width - M;
    const width = right - left;
    const money = formatInrAscii;
    const s = data.summary;
    const range =
      data.period.from || data.period.to
        ? `${data.period.from ? formatDisplayDate(data.period.from) : 'Start'} – ${formatDisplayDate(data.period.to ?? todayInAppTz())}`
        : `All time to ${formatDisplayDate(todayInAppTz())}`;

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 8).fill(C.brand);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(16).text(academy.name, left, 36);
    const contact = [academy.phone, academy.email].filter(Boolean).join('  ·  ');
    if (contact) doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(contact);
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(C.brand)
      .text('STATEMENT', left, 36, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(C.muted)
      .text(`Issued ${formatDisplayDate(todayInAppTz())}`, left, 62, { width, align: 'right' });

    let y = 100;
    doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('PAYEE', left, y);
    doc.text('PERIOD', left + width / 2, y);
    y += 12;
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(C.ink)
      .text(data.payee.name, left, y, {
        width: width / 2 - 10,
      });
    doc.text(range, left + width / 2, y, { width: width / 2 });
    y += 30;

    // ── Summary boxes ──
    const boxes = [
      { label: 'Opening balance', value: money(s.opening), color: C.ink },
      { label: 'Shares earned', value: money(s.earned), color: C.ink },
      { label: 'Paid out', value: money(s.paid), color: C.paid },
      { label: 'Closing balance', value: money(s.closing), color: s.closing > 0 ? C.owed : C.ink },
    ];
    const bw = (width - 3 * 8) / 4;
    boxes.forEach((b, i) => {
      const x = left + i * (bw + 8);
      doc.roundedRect(x, y, bw, 50, 6).fill(i === 3 ? C.brandSoft : C.soft);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(C.muted)
        .text(b.label, x + 10, y + 10, { width: bw - 20 });
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(b.color)
        .text(b.value, x + 10, y + 26, { width: bw - 20 });
    });
    y += 70;

    // ── Ledger table ──
    const cols = [
      { key: 'date', label: 'Date', w: 70, align: 'left' as const },
      { key: 'desc', label: 'Details', w: width - 70 - 3 * 72, align: 'left' as const },
      { key: 'in', label: 'Earned', w: 72, align: 'right' as const },
      { key: 'out', label: 'Paid', w: 72, align: 'right' as const },
      { key: 'bal', label: 'Balance', w: 72, align: 'right' as const },
    ];
    const header = () => {
      doc.rect(left, y, width, 22).fill(C.brandSoft);
      let x = left;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.brand);
      for (const c of cols) {
        doc.text(c.label.toUpperCase(), x + 6, y + 7, { width: c.w - 12, align: c.align });
        x += c.w;
      }
      y += 26;
    };
    header();
    const rows = [...data.history].reverse(); // oldest first
    const row = (cells: Record<string, string>, opts: { muted?: boolean; bold?: boolean } = {}) => {
      const descH = doc
        .font('Helvetica')
        .fontSize(9)
        .heightOfString(cells.desc ?? '', { width: cols[1]!.w - 12 });
      const h = Math.max(18, descH + 8);
      if (y + h > doc.page.height - M - 30) {
        doc.addPage();
        y = M;
        header();
      }
      let x = left;
      for (const c of cols) {
        doc
          .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(9)
          .fillColor(opts.muted ? C.faint : C.ink)
          .text(cells[c.key] ?? '', x + 6, y + 4, { width: c.w - 12, align: c.align });
        x += c.w;
      }
      y += h;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(C.line).stroke();
    };
    row(
      {
        date: data.period.from ? formatDisplayDate(data.period.from) : '',
        desc: 'Opening balance',
        bal: money(s.opening),
      },
      { bold: true },
    );
    for (const r of rows) {
      const desc = [
        r.title,
        r.detail,
        r.reversed ? `Reversed${r.reversalReason ? `: ${r.reversalReason}` : ''}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      row(
        {
          date: formatDisplayDate(r.date),
          desc,
          in: r.amount > 0 ? money(r.amount) : '',
          out: r.amount < 0 ? money(-r.amount) : '',
          bal: r.reversed ? '' : money(r.balance),
        },
        { muted: r.reversed },
      );
    }
    if (!rows.length) row({ desc: 'No activity in this period.' }, { muted: true });
    row({ date: '', desc: 'Closing balance', bal: money(s.closing) }, { bold: true });

    y += 14;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C.muted)
      .text(
        'Shares are credited when a student’s fee is received, using the fee plan’s split. Reversed entries are shown for reference and are not counted.',
        left,
        y,
        { width },
      );

    // Page numbers.
    const range2 = doc.bufferedPageRange();
    for (let i = 0; i < range2.count; i++) {
      doc.switchToPage(range2.start + i);
      // Writing in the bottom margin would otherwise start a new (blank) page.
      doc.page.margins.bottom = 0;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(C.faint)
        .text(`Page ${i + 1} of ${range2.count}`, left, doc.page.height - M + 10, {
          width,
          align: 'right',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
