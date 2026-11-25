/** A month's attendance register as a landscape A4 PDF (built-in Helvetica only). */
import PDFDocument from 'pdfkit';
import { formatDisplayDate, isoWeekday, type IsoDate } from '../../lib/dates.js';
import { BRAND_ICON_PNG } from '../reports/brand-icon.js';
import type { AcademySettings } from '../settings/settings.js';
import type { Mark, MonthlyRegister } from './monthly-register.js';

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  faint: '#cbd5e1',
  line: '#e2e8f0',
  soft: '#f8fafc',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
  good: '#15803d',
  goodSoft: '#dcfce7',
  warn: '#b45309',
  warnSoft: '#fef3c7',
  bad: '#b91c1c',
  badSoft: '#fee2e2',
  info: '#0369a1',
  infoSoft: '#e0f2fe',
};
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY = ['', 'M', 'T', 'W', 'T', 'F', 'S', 'S'];
const CELL: Record<Mark, { text: string; color: string; fill: string }> = {
  present: { text: 'P', color: C.good, fill: C.goodSoft },
  late: { text: 'L', color: C.warn, fill: C.warnSoft },
  absent: { text: 'A', color: C.bad, fill: C.badSoft },
  excused: { text: 'E', color: C.info, fill: C.infoSoft },
};
const M = 24;
const ROW = 17;
const NAME_W = 138;
const TOTAL_W = [22, 22, 22, 22, 34] as const;

export const monthTitle = (month: IsoDate) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const tone = (r: number | null) =>
  r === null ? C.muted : r >= 80 ? C.good : r >= 60 ? C.warn : C.bad;
const pctText = (r: number | null) => (r === null ? '-' : `${r}%`);

export function renderRegisterPdf(r: MonthlyRegister, academy: AcademySettings): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      bufferPages: true,
      info: {
        Title: `Attendance register · ${r.batch.name} · ${monthTitle(r.month)}`,
        Author: academy.name,
        Creator: 'AthletiQ',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    const H = doc.page.height;

    /** One line that never wraps: shrunk, then cut. */
    const line = (
      text: string,
      x: number,
      y: number,
      width: number,
      size: number,
      color: string,
      {
        bold = false,
        align = 'left',
        min = 5.5,
      }: { bold?: boolean; align?: 'left' | 'center' | 'right'; min?: number } = {},
    ) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      let s = size;
      while (s > min && doc.widthOfString(text) > width) doc.fontSize((s -= 0.5));
      let t = text;
      while (t.length > 1 && doc.widthOfString(t) > width) t = `${t.slice(0, -2).trimEnd()}.`;
      doc.fillColor(color).text(t, x, y, { width, align, lineBreak: false });
    };

    const days = r.sessions;
    const totalsW = TOTAL_W.reduce<number>((a, b) => a + b, 0);
    const cw = Math.min(24, (W - 2 * M - NAME_W - totalsW) / Math.max(1, days.length));
    const tx = M + NAME_W + cw * days.length;

    const header = (first: boolean) => {
      doc.rect(0, 0, W, 4).fill(C.brand);
      doc.save();
      doc.roundedRect(M, 16, 28, 28, 6).clip();
      doc.image(BRAND_ICON_PNG, M, 16, { width: 28, height: 28 });
      doc.restore();
      line(academy.name, M + 36, 16, 360, 9, C.muted);
      line(`${r.batch.name}`, M + 36, 27, 470, 15, C.ink, { bold: true });
      line(monthTitle(r.month), W - M - 220, 15, 220, 15, C.brand, { bold: true, align: 'right' });
      line('Attendance register', W - M - 220, 34, 220, 9, C.muted, { align: 'right' });
      if (!first) return 56;
      line(
        `${r.batch.sport}  ·  Coach ${r.batch.coach.name}  ·  ${r.batch.location}`,
        M,
        52,
        W - 2 * M,
        9,
        C.muted,
      );
      const s = r.summary;
      const tiles: [string, string, string][] = [
        ['Attendance', pctText(s.rate), tone(s.rate)],
        ['Last month', pctText(s.previousRate), C.ink],
        ['Students', String(s.students), C.ink],
        ['Sessions held', `${s.held}`, C.ink],
        ['Cancelled', String(s.cancelled), C.ink],
        ['Average present', s.averagePresent === null ? '-' : String(s.averagePresent), C.ink],
        ['Present', String(s.present), C.good],
        ['Late', String(s.late), C.warn],
        ['Absent', String(s.absent), C.bad],
        ['Excused', String(s.excused), C.info],
      ];
      const gap = 5;
      const w = (W - 2 * M - gap * (tiles.length - 1)) / tiles.length;
      tiles.forEach(([label, value, color], i) => {
        const x = M + i * (w + gap);
        doc.roundedRect(x, 68, w, 34, 5).fillAndStroke(C.soft, C.line);
        line(value, x + 2, 74, w - 4, 13, color, { bold: true, align: 'center' });
        line(label, x + 2, 90, w - 4, 7, C.muted, { align: 'center' });
      });
      return 110;
    };

    const tableHead = (y: number) => {
      doc.rect(M, y, NAME_W + cw * days.length + totalsW, 24).fill(C.brandSoft);
      line('Student', M + 4, y + 8, NAME_W - 8, 8, C.brand, { bold: true });
      days.forEach((d, i) => {
        const x = M + NAME_W + i * cw;
        const off = d.state === 'cancelled';
        line(DAY[isoWeekday(d.date)]!, x, y + 4, cw, 6.5, off ? C.faint : C.muted, {
          align: 'center',
        });
        line(String(Number(d.date.slice(8))), x, y + 12, cw, 8, off ? C.faint : C.ink, {
          bold: true,
          align: 'center',
        });
      });
      ['P', 'L', 'A', 'E', '%'].forEach((t, i) => {
        const x = tx + TOTAL_W.slice(0, i).reduce<number>((a, b) => a + b, 0);
        line(t, x, y + 8, TOTAL_W[i]!, 8, C.brand, { bold: true, align: 'center' });
      });
      return y + 24;
    };
    const rule = (y: number) =>
      doc
        .moveTo(M, y)
        .lineTo(tx + totalsW, y)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();

    const FOOT = 40;
    let y = tableHead(header(true));
    const newPage = () => {
      doc.addPage();
      y = tableHead(header(false));
    };
    const room = (h: number) => {
      if (y + h > H - FOOT) newPage();
    };

    if (!r.students.length)
      line('No students were in this batch this month.', M, y + 10, 400, 10, C.muted);
    r.students.forEach((s, n) => {
      room(ROW);
      if (n % 2) doc.rect(M, y, NAME_W + cw * days.length + totalsW, ROW).fill(C.soft);
      line(`${n + 1}.`, M + 3, y + 5, 16, 7, C.muted);
      line(s.fullName, M + 19, y + 4.5, NAME_W - 22, 8.5, C.ink, { bold: true });
      days.forEach((d, i) => {
        const x = M + NAME_W + i * cw;
        const c = s.cells[d.date];
        if (c?.mark) {
          const m = CELL[c.mark];
          const size = Math.min(cw - 2, ROW - 4, 13);
          doc.roundedRect(x + (cw - size) / 2, y + (ROW - size) / 2, size, size, 3).fill(m.fill);
          line(c.madeUp ? `${m.text}*` : m.text, x, y + 5, cw, 7.5, m.color, {
            bold: true,
            align: 'center',
          });
        } else if (d.state === 'cancelled')
          line('x', x, y + 5, cw, 7, C.faint, { align: 'center' });
        else if (c && d.state === 'held') line('-', x, y + 5, cw, 8, C.muted, { align: 'center' });
        else if (!c) doc.rect(x + 1, y + 1, cw - 2, ROW - 2).fill('#f1f5f9');
      });
      const totals: [string, string][] = [
        [String(s.present), C.good],
        [String(s.late), C.warn],
        [String(s.absent), C.bad],
        [String(s.excused), C.info],
        [pctText(s.rate), tone(s.rate)],
      ];
      totals.forEach(([t, color], i) => {
        const x = tx + TOTAL_W.slice(0, i).reduce<number>((a, b) => a + b, 0);
        line(t, x, y + 5, TOTAL_W[i]!, 8, color, { bold: i === 4, align: 'center' });
      });
      y += ROW;
      rule(y);
    });

    // Present per session.
    room(ROW);
    line('Present', M + 19, y + 5, NAME_W - 22, 8, C.brand, { bold: true });
    days.forEach((d, i) =>
      line(
        d.state === 'held' && d.marked ? String(d.present + d.late) : '',
        M + NAME_W + i * cw,
        y + 5,
        cw,
        7.5,
        C.brand,
        { bold: true, align: 'center' },
      ),
    );
    line(
      pctText(r.summary.rate),
      tx + totalsW - TOTAL_W[4],
      y + 5,
      TOTAL_W[4],
      8.5,
      tone(r.summary.rate),
      { bold: true, align: 'center' },
    );
    y += ROW + 8;

    // Notes: cancelled days, makeups, who needs attention.
    const notes: string[] = [];
    const off = days.filter((d) => d.state === 'cancelled');
    if (off.length)
      notes.push(
        `Cancelled: ${off.map((d) => `${formatDisplayDate(d.date)} (${d.reason ?? 'no reason'})`).join('; ')}.`,
      );
    if (r.summary.madeUp) notes.push('* Missed session made up in another batch.');
    if (r.insights.perfect.length)
      notes.push(`100% attendance: ${r.insights.perfect.map((p) => p.fullName).join(', ')}.`);
    if (r.insights.low.length)
      notes.push(
        `Below 60%: ${r.insights.low.map((p) => `${p.fullName} (${p.rate}%)`).join(', ')}.`,
      );
    if (r.insights.absentRuns.length)
      notes.push(
        `Absent 3 or more in a row: ${r.insights.absentRuns.map((p) => `${p.fullName} (${p.absentRun})`).join(', ')}.`,
      );
    for (const n of notes) {
      doc.font('Helvetica').fontSize(8);
      const h = doc.heightOfString(n, { width: W - 2 * M });
      if (y + h > H - FOOT) {
        doc.addPage();
        y = header(false) + 8;
      }
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(8)
        .text(n, M, y, { width: W - 2 * M });
      y += h + 4;
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      line(
        'P present   L late   A absent   E excused   - not marked   x cancelled   grey: not a member that day   % = (P + L) of (P + L + A)',
        M,
        H - 26,
        W - 2 * M - 80,
        7,
        C.muted,
      );
      line(`Page ${i + 1} of ${range.count}`, W - M - 80, H - 26, 80, 7, C.muted, {
        align: 'right',
      });
    }
    doc.end();
  });
}
