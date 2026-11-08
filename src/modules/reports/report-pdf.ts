/**
 * A4 PDFs for student reports: one student, or a batch / the whole academy (summary first, then a
 * section per student). Built-in Helvetica only (no font files), so amounts use "Rs.".
 */
import PDFDocument from 'pdfkit';
import { formatDisplayDate } from '../../lib/dates.js';
import type { AcademySettings } from '../settings/settings.js';
import type { StudentReport } from './report-data.js';

type Doc = PDFKit.PDFDocument;

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#e2e8f0',
  soft: '#f1f5f9',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
  good: '#16a34a',
  warn: '#d97706',
  bad: '#dc2626',
};
const M = 40; // page margin
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const rupees = (paise: number) =>
  `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(paise / 100))}`;
const date = (iso: string | null | undefined) => (iso ? formatDisplayDate(iso.slice(0, 10)) : '-');
const month = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const pctText = (r: number | null) => (r === null ? '-' : `${r}%`);
const tone = (r: number | null) =>
  r === null ? C.muted : r >= 80 ? C.good : r >= 60 ? C.warn : C.bad;
const days = (d: number[]) =>
  [...d]
    .sort((a, b) => a - b)
    .map((x) => DAY[x])
    .join(', ');

// ─── Layout helpers ─────────────────────────────────────────────────────────

const W = (doc: Doc) => doc.page.width - M * 2;
const bottom = (doc: Doc) => doc.page.height - M - 20;

function ensure(doc: Doc, space: number) {
  if (doc.y + space > bottom(doc)) {
    doc.addPage();
    doc.y = M;
  }
}

function section(doc: Doc, title: string, subtitle?: string) {
  ensure(doc, 60);
  doc.moveDown(0.6);
  const y = doc.y;
  doc.rect(M, y + 2, 3, 12).fill(C.brand);
  doc
    .fillColor(C.ink)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(title, M + 10, y, { width: W(doc) - 10 });
  if (subtitle)
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(C.muted)
      .text(subtitle, M + 10);
  doc.moveDown(0.4);
  doc.x = M;
}

interface Tile {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

function tiles(doc: Doc, items: Tile[], cols = 4) {
  const gap = 8;
  const w = (W(doc) - gap * (cols - 1)) / cols;
  const h = 50;
  for (let i = 0; i < items.length; i += cols) {
    ensure(doc, h + gap);
    const y = doc.y;
    items.slice(i, i + cols).forEach((t, j) => {
      const x = M + j * (w + gap);
      doc.roundedRect(x, y, w, h, 6).fillAndStroke(C.soft, C.line);
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(t.label.toUpperCase(), x + 8, y + 7, {
          width: w - 16,
          lineBreak: false,
          ellipsis: true,
        });
      doc
        .fillColor(t.color ?? C.ink)
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(t.value, x + 8, y + 18, { width: w - 16, lineBreak: false, ellipsis: true });
      if (t.sub) {
        doc
          .fillColor(C.muted)
          .font('Helvetica')
          .fontSize(7)
          .text(t.sub, x + 8, y + 36, { width: w - 16, lineBreak: false, ellipsis: true });
      }
    });
    doc.y = y + h + gap;
  }
  doc.x = M;
}

interface Col {
  header: string;
  width: number; // fraction of the full width
  align?: 'left' | 'right' | 'center';
  /** Draws a rate bar (0-100) in this column instead of text. */
  bar?: boolean;
}

function table(
  doc: Doc,
  cols: Col[],
  rows: (string | number | null)[][],
  colors?: (string | undefined)[][],
) {
  const total = W(doc);
  const widths = cols.map((c) => c.width * total);
  const pad = 5;
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(M, y, total, 18).fill(C.brandSoft);
    let x = M;
    cols.forEach((c, i) => {
      doc
        .fillColor(C.brand)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(c.header.toUpperCase(), x + pad, y + 5, {
          width: widths[i]! - pad * 2,
          align: c.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
      x += widths[i]!;
    });
    doc.y = y + 18;
  };
  ensure(doc, 40);
  drawHeader();
  rows.forEach((row, r) => {
    doc.font('Helvetica').fontSize(8.5);
    const heights = row.map((cell, i) =>
      cols[i]!.bar ? 10 : doc.heightOfString(String(cell ?? '-'), { width: widths[i]! - pad * 2 }),
    );
    const h = Math.max(...heights) + 8;
    if (doc.y + h > bottom(doc)) {
      doc.addPage();
      doc.y = M;
      drawHeader();
    }
    const y = doc.y;
    if (r % 2 === 1) doc.rect(M, y, total, h).fill('#f8fafc');
    let x = M;
    row.forEach((cell, i) => {
      const col = cols[i]!;
      if (col.bar) {
        const v = typeof cell === 'number' ? cell : null;
        const bw = widths[i]! - pad * 2;
        doc.roundedRect(x + pad, y + h / 2 - 3, bw, 6, 3).fill(C.line);
        if (v !== null && v > 0)
          doc.roundedRect(x + pad, y + h / 2 - 3, Math.max(6, (bw * v) / 100), 6, 3).fill(tone(v));
      } else {
        doc
          .fillColor(colors?.[r]?.[i] ?? C.ink)
          .font('Helvetica')
          .fontSize(8.5)
          .text(String(cell ?? '-'), x + pad, y + 4, {
            width: widths[i]! - pad * 2,
            align: col.align ?? 'left',
          });
      }
      x += widths[i]!;
    });
    doc
      .moveTo(M, y + h)
      .lineTo(M + total, y + h)
      .lineWidth(0.5)
      .strokeColor(C.line)
      .stroke();
    doc.y = y + h;
  });
  doc.x = M;
  doc.moveDown(0.3);
}

function keyValues(doc: Doc, pairs: [string, string | null | undefined][]) {
  const shown = pairs.filter(([, v]) => v) as [string, string][];
  const colW = (W(doc) - 12) / 2;
  for (let i = 0; i < shown.length; i += 2) {
    ensure(doc, 26);
    const y = doc.y;
    let h = 0;
    shown.slice(i, i + 2).forEach(([k, v], j) => {
      const x = M + j * (colW + 12);
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(k.toUpperCase(), x, y, { width: colW });
      doc
        .fillColor(C.ink)
        .font('Helvetica')
        .fontSize(9.5)
        .text(v, x, y + 10, { width: colW });
      h = Math.max(h, doc.y - y);
    });
    doc.y = y + h + 5;
  }
  doc.x = M;
}

function bullets(doc: Doc, lines: string[]) {
  if (!lines.length) return;
  doc.font('Helvetica').fontSize(9);
  const textW = W(doc) - 28;
  const h = lines.reduce((n, l) => n + doc.heightOfString(l, { width: textW }) + 3, 0) + 18;
  ensure(doc, Math.min(h, 200));
  const y = doc.y;
  doc.roundedRect(M, y, W(doc), h, 6).fill(C.brandSoft);
  doc
    .fillColor(C.brand)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('KEY INSIGHTS', M + 12, y + 7);
  let ly = y + 19;
  for (const l of lines) {
    doc.circle(M + 15, ly + 4, 1.6).fill(C.brand);
    doc
      .fillColor(C.ink)
      .font('Helvetica')
      .fontSize(9)
      .text(l, M + 22, ly, { width: textW });
    ly = doc.y + 3;
  }
  doc.y = y + h + 4;
  doc.x = M;
}

const KIND_COLOR: Record<string, string> = {
  joined: C.good,
  rejoined: C.good,
  batch: C.brand,
  left: C.bad,
  makeup: '#0891b2',
  invoice: C.muted,
  payment: C.good,
  feedback: '#7c3aed',
  note: C.faint,
};

function timeline(doc: Doc, events: StudentReport['timeline']) {
  for (const e of events) {
    doc.font('Helvetica').fontSize(8.5);
    const textW = W(doc) - 110;
    const h = doc.heightOfString(e.title, { width: textW }) + (e.detail ? 11 : 0) + 8;
    ensure(doc, h);
    const y = doc.y;
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(date(e.date), M, y + 1, { width: 72 });
    doc
      .moveTo(M + 84, y)
      .lineTo(M + 84, y + h)
      .lineWidth(1)
      .strokeColor(C.line)
      .stroke();
    doc.circle(M + 84, y + 5, 3.2).fill(KIND_COLOR[e.kind] ?? C.faint);
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text(e.title, M + 96, y, { width: textW });
    if (e.detail)
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(8)
        .text(e.detail, M + 96, doc.y + 1, { width: textW });
    doc.y = y + h;
  }
  doc.x = M;
}

// ─── Document frame ─────────────────────────────────────────────────────────

function newDoc(title: string, academy: AcademySettings) {
  return new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: { Title: title, Author: academy.name, Creator: 'AthletiQ' },
  });
}

function finish(
  doc: Doc,
  academy: AcademySettings,
  title: string,
  generated: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing below the bottom margin would make pdfkit start a new page.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.rect(0, 0, doc.page.width, 4).fill(C.brand);
      const y = doc.page.height - M + 6;
      doc
        .moveTo(M, y - 6)
        .lineTo(doc.page.width - M, y - 6)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();
      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5);
      doc.text(`${academy.name} · ${title} · Generated ${generated}`, M, y, {
        width: W(doc) - 60,
        lineBreak: false,
        ellipsis: true,
      });
      doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - M - 60, y, {
        width: 60,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = margin;
    }
    doc.end();
  });
}

function masthead(doc: Doc, academy: AcademySettings, kicker: string, title: string, sub: string) {
  const top = M;
  const initials = academy.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  doc.roundedRect(M, top, 34, 34, 8).fill(C.brand);
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(initials, M, top + 11, { width: 34, align: 'center' });
  const x = M + 46;
  const w = W(doc) - 46;
  doc
    .fillColor(C.brand)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(`${academy.name.toUpperCase()} · ${kicker.toUpperCase()}`, x, top, { width: w });
  doc
    .fillColor(C.ink)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(title, x, doc.y + 3, { width: w });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(9.5)
    .text(sub, x, doc.y + 2, { width: w });
  doc.y = Math.max(doc.y, top + 34);
  doc.moveDown(0.8);
  doc.x = M;
}

// ─── One student ────────────────────────────────────────────────────────────

function studentSection(
  doc: Doc,
  r: StudentReport,
  academy: AcademySettings,
  scope: string,
  kicker = 'Student report',
) {
  const s = r.student;
  const a = r.attendance;
  const f = r.fees;
  masthead(
    doc,
    academy,
    kicker,
    s.fullName,
    [
      s.code,
      s.status === 'left' ? `Left on ${date(s.leftOn)}` : 'Active',
      r.current ? `${r.current.batchName} · Coach ${r.current.coachName}` : null,
      scope,
    ]
      .filter(Boolean)
      .join('   ·   '),
  );

  bullets(doc, r.insights);

  tiles(doc, [
    {
      label: 'Attendance',
      value: pctText(a.rate),
      sub: `${a.present + a.late} of ${a.counted} sessions`,
      color: tone(a.rate),
    },
    {
      label: 'Last 30 days',
      value: pctText(a.rate30),
      sub: `Last 90 days: ${pctText(a.rate90)}`,
      color: tone(a.rate30),
    },
    {
      label: 'Streak',
      value: `${a.currentStreak}`,
      sub: `Longest ${a.longestStreak} · last ${date(a.lastAttended)}`,
    },
    {
      label: 'With us',
      value: `${Math.floor(s.tenureDays / 30)} mo`,
      sub: `Since ${date(s.joiningDate)}`,
    },
    {
      label: 'Fees paid',
      value: rupees(f.paid),
      sub: `of ${rupees(f.billed)} billed`,
      color: f.paid ? C.good : C.ink,
    },
    {
      label: 'Outstanding',
      value: rupees(f.outstanding),
      sub: f.overdueCount ? `${rupees(f.overdue)} overdue` : 'Nothing overdue',
      color: f.overdueCount ? C.bad : C.ink,
    },
    {
      label: 'Weekly reports',
      value: `${r.feedback.count}`,
      sub: r.feedback.overall !== null ? `Average rating ${r.feedback.overall}/5` : 'None yet',
    },
    { label: 'Makeups', value: `${r.makeups.length}`, sub: `${a.makeupsAttended} attended` },
  ]);

  section(doc, 'Profile');
  keyValues(doc, [
    ['Student code', s.code],
    [
      'Date of birth',
      s.dateOfBirth ? `${date(s.dateOfBirth)}${s.age !== null ? ` (${s.age} yrs)` : ''}` : null,
    ],
    ['Gender', s.gender ? s.gender[0]!.toUpperCase() + s.gender.slice(1) : null],
    ['Guardian', s.guardianName],
    ['Phone', [s.phone, s.alternatePhone].filter(Boolean).join(' / ')],
    ['Email', s.email],
    ['Address', s.address],
    ['Joined', date(s.joiningDate)],
    [
      'Current batch',
      r.current ? `${r.current.batchName} (since ${date(r.current.since)})` : 'None',
    ],
    ['Training days', r.current ? days(r.current.trainingDays) : null],
    ['Coach', r.current?.coachName],
    [
      'Fee plan',
      `${s.feePlan} · ${rupees(s.monthlyFee)}/month${s.monthlyDiscount ? ` (discount ${rupees(s.monthlyDiscount)})` : ''}`,
    ],
    ['Medical notes', s.medicalNotes],
    ['Left', s.leftOn ? `${date(s.leftOn)}${s.leftReason ? ` · ${s.leftReason}` : ''}` : null],
  ]);

  section(
    doc,
    'Attendance by month',
    'Rate = present + late out of sessions marked (excused days are not counted).',
  );
  if (a.byMonth.length) {
    table(
      doc,
      [
        { header: 'Month', width: 0.18 },
        { header: 'Present', width: 0.11, align: 'right' },
        { header: 'Late', width: 0.09, align: 'right' },
        { header: 'Absent', width: 0.1, align: 'right' },
        { header: 'Excused', width: 0.11, align: 'right' },
        { header: 'Rate', width: 0.1, align: 'right' },
        { header: '', width: 0.31, bar: true },
      ],
      a.byMonth.map((m) => [
        month(m.month),
        m.present,
        m.late,
        m.absent,
        m.excused,
        pctText(m.rate),
        m.rate,
      ]),
      a.byMonth.map((m) => [
        undefined,
        undefined,
        undefined,
        m.absent ? C.bad : undefined,
        undefined,
        tone(m.rate),
        undefined,
      ]),
    );
  } else empty(doc, 'No attendance recorded yet.');

  if (a.byWeekday.length) {
    section(doc, 'Attendance by day of the week');
    table(
      doc,
      [
        { header: 'Day', width: 0.2 },
        { header: 'Sessions', width: 0.15, align: 'right' },
        { header: 'Rate', width: 0.15, align: 'right' },
        { header: '', width: 0.5, bar: true },
      ],
      a.byWeekday.map((w) => [DAY[w.weekday]!, w.counted, pctText(w.rate), w.rate]),
    );
  }

  section(
    doc,
    'Skills and progress',
    'Averages from weekly coach reports (1-5), first report vs latest.',
  );
  if (r.feedback.skills.length) {
    table(
      doc,
      [
        { header: 'Area', width: 0.4 },
        { header: 'Average', width: 0.15, align: 'right' },
        { header: 'First', width: 0.15, align: 'right' },
        { header: 'Latest', width: 0.15, align: 'right' },
        { header: 'Change', width: 0.15, align: 'right' },
      ],
      r.feedback.skills.map((k) => {
        const d = k.latest - k.first;
        return [
          k.label,
          `${k.average}/${k.max}`,
          k.first,
          k.latest,
          d > 0 ? `+${d}` : d < 0 ? `${d}` : '=',
        ];
      }),
      r.feedback.skills.map((k) => [
        undefined,
        undefined,
        undefined,
        undefined,
        k.latest > k.first ? C.good : k.latest < k.first ? C.bad : C.muted,
      ]),
    );
  } else empty(doc, 'No weekly reports yet.');

  const recent = r.feedback.weeks.slice(-6).reverse();
  if (recent.length) {
    section(doc, 'Recent coach reports', `Latest ${recent.length} of ${r.feedback.count}`);
    for (const w of recent) {
      ensure(doc, 50);
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(`Week of ${date(w.weekStart)}`, M, doc.y, { continued: true });
      doc.fillColor(C.muted).font('Helvetica').text(`   by ${w.coachName}`);
      if (w.ratings.length) {
        doc
          .fillColor(C.ink)
          .font('Helvetica')
          .fontSize(8.5)
          .text(w.ratings.map((x) => `${x.label}: ${x.value}/${x.max}`).join('   ·   '), {
            width: W(doc),
          });
      }
      for (const n of w.notes) {
        doc
          .fillColor(C.muted)
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .text(`${n.label}: `, { continued: true, width: W(doc) });
        doc.fillColor(C.ink).font('Helvetica').text(n.value);
      }
      doc.moveDown(0.5);
    }
  }

  section(doc, 'Batch history');
  if (r.enrollments.length) {
    table(
      doc,
      [
        { header: 'Batch', width: 0.25 },
        { header: 'Coach', width: 0.2 },
        { header: 'Days', width: 0.2 },
        { header: 'From', width: 0.12 },
        { header: 'To', width: 0.12 },
        { header: 'Note', width: 0.11 },
      ],
      r.enrollments.map((e) => [
        e.batchName,
        e.coachName,
        days(e.trainingDays),
        date(e.from),
        e.to ? date(e.to) : 'Current',
        e.reason,
      ]),
    );
  } else empty(doc, 'Not in any batch.');

  section(
    doc,
    'Fees',
    f.invoicesCount
      ? `On-time payments: ${pctText(f.onTimeRate)}${f.avgDaysToPay !== null ? ` · paid ${f.avgDaysToPay} days after the invoice on average` : ''}`
      : undefined,
  );
  if (f.invoices.length) {
    table(
      doc,
      [
        { header: 'Invoice', width: 0.17 },
        { header: 'Period', width: 0.25 },
        { header: 'Due', width: 0.13 },
        { header: 'Amount', width: 0.13, align: 'right' },
        { header: 'Status', width: 0.11 },
        { header: 'Paid', width: 0.21 },
      ],
      f.invoices.map((i) => [
        i.number,
        i.period
          .split(' to ')
          .map((x) => date(x))
          .join(' - '),
        date(i.dueDate),
        rupees(i.amount),
        i.status[0]!.toUpperCase() + i.status.slice(1),
        i.paidOn ? `${date(i.paidOn)}${i.mode ? ` · ${i.mode}` : ''}` : '-',
      ]),
      f.invoices.map((i) => [
        undefined,
        undefined,
        undefined,
        undefined,
        i.status === 'paid'
          ? C.good
          : i.status === 'overdue'
            ? C.bad
            : i.status === 'due'
              ? C.warn
              : C.muted,
        undefined,
      ]),
    );
  } else empty(doc, 'No invoices yet.');

  if (r.makeups.length) {
    section(doc, 'Makeup sessions');
    table(
      doc,
      [
        { header: 'Date', width: 0.18 },
        { header: 'Batch', width: 0.3 },
        { header: 'Instead of', width: 0.18 },
        { header: 'Reason', width: 0.34 },
      ],
      r.makeups.map((m) => [date(m.date), m.batchName, date(m.missedDate), m.reason]),
    );
  }

  section(doc, 'Timeline', 'Everything that happened, oldest first.');
  timeline(doc, r.timeline);
}

function empty(doc: Doc, text: string) {
  ensure(doc, 20);
  doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(9).text(text, M, doc.y);
  doc.moveDown(0.3);
}

export async function renderStudentReportPdf(
  r: StudentReport,
  academy: AcademySettings,
  opts: { scope: string; generated: string },
) {
  const title = `Student report - ${r.student.fullName}`;
  const doc = newDoc(title, academy);
  studentSection(doc, r, academy, opts.scope);
  return finish(doc, academy, `${r.student.fullName} (${r.student.code})`, opts.generated);
}

// ─── A batch / the whole academy ────────────────────────────────────────────

export async function renderGroupReportPdf(
  reports: StudentReport[],
  academy: AcademySettings,
  opts: { title: string; scope: string; generated: string },
) {
  const doc = newDoc(opts.title, academy);
  const att = reports.reduce(
    (n, r) => ({
      a: n.a + r.attendance.present + r.attendance.late,
      c: n.c + r.attendance.counted,
    }),
    { a: 0, c: 0 },
  );
  const rate = att.c ? Math.round((att.a / att.c) * 100) : null;
  const r30 = reports.map((r) => r.attendance.rate30).filter((x): x is number => x !== null);
  const avg30 = r30.length ? Math.round(r30.reduce((a, b) => a + b, 0) / r30.length) : null;
  const sum = (fn: (r: StudentReport) => number) => reports.reduce((n, r) => n + fn(r), 0);
  const overdueStudents = reports.filter((r) => r.fees.overdueCount > 0);
  const lowAttendance = reports.filter(
    (r) => r.attendance.rate !== null && r.attendance.counted >= 3 && r.attendance.rate < 60,
  );
  const skillsAvg = reports.map((r) => r.feedback.overall).filter((x): x is number => x !== null);

  masthead(
    doc,
    academy,
    'Batch report',
    opts.title,
    `${reports.length} student${reports.length === 1 ? '' : 's'}   ·   ${opts.scope}`,
  );
  tiles(doc, [
    {
      label: 'Students',
      value: `${reports.length}`,
      sub: `${reports.filter((r) => r.student.status === 'active').length} active`,
    },
    {
      label: 'Attendance',
      value: pctText(rate),
      sub: `${att.a} of ${att.c} sessions`,
      color: tone(rate),
    },
    {
      label: 'Last 30 days',
      value: pctText(avg30),
      sub: 'Average per student',
      color: tone(avg30),
    },
    {
      label: 'Avg rating',
      value: skillsAvg.length
        ? `${(skillsAvg.reduce((a, b) => a + b, 0) / skillsAvg.length).toFixed(1)}/5`
        : '-',
      sub: `${sum((r) => r.feedback.count)} weekly reports`,
    },
    {
      label: 'Fees paid',
      value: rupees(sum((r) => r.fees.paid)),
      sub: `of ${rupees(sum((r) => r.fees.billed))} billed`,
      color: sum((r) => r.fees.paid) ? C.good : C.ink,
    },
    {
      label: 'Outstanding',
      value: rupees(sum((r) => r.fees.outstanding)),
      sub: `${rupees(sum((r) => r.fees.overdue))} overdue`,
      color: overdueStudents.length ? C.bad : C.ink,
    },
    {
      label: 'Fees overdue',
      value: `${overdueStudents.length}`,
      sub: 'students',
      color: overdueStudents.length ? C.bad : C.good,
    },
    {
      label: 'Low attendance',
      value: `${lowAttendance.length}`,
      sub: 'students under 60%',
      color: lowAttendance.length ? C.warn : C.good,
    },
  ]);

  section(
    doc,
    'All students',
    'Sorted by name. Details for each student follow on the next pages.',
  );
  table(
    doc,
    [
      { header: 'Student', width: 0.24 },
      { header: 'Batch', width: 0.2 },
      { header: 'Joined', width: 0.12 },
      { header: 'Attend.', width: 0.1, align: 'right' },
      { header: '30 days', width: 0.1, align: 'right' },
      { header: 'Rating', width: 0.09, align: 'right' },
      { header: 'Due', width: 0.15, align: 'right' },
    ],
    reports.map((r) => [
      `${r.student.fullName}${r.student.status === 'left' ? ' (left)' : ''}`,
      r.current?.batchName ?? '-',
      date(r.student.joiningDate),
      pctText(r.attendance.rate),
      pctText(r.attendance.rate30),
      r.feedback.overall !== null ? `${r.feedback.overall}` : '-',
      r.fees.outstanding ? rupees(r.fees.outstanding) : '-',
    ]),
    reports.map((r) => [
      undefined,
      undefined,
      undefined,
      tone(r.attendance.rate),
      tone(r.attendance.rate30),
      undefined,
      r.fees.overdueCount ? C.bad : undefined,
    ]),
  );

  if (lowAttendance.length || overdueStudents.length) {
    section(doc, 'Needs attention');
    bulletsPlain(doc, [
      ...lowAttendance.map(
        (r) =>
          `${r.student.fullName}: attendance ${r.attendance.rate}% (${r.attendance.present + r.attendance.late}/${r.attendance.counted})`,
      ),
      ...overdueStudents.map(
        (r) =>
          `${r.student.fullName}: ${rupees(r.fees.overdue)} overdue (${r.fees.overdueCount} invoice${r.fees.overdueCount === 1 ? '' : 's'})`,
      ),
    ]);
  }

  for (const r of reports) {
    doc.addPage();
    studentSection(doc, r, academy, opts.scope, opts.title);
  }
  return finish(doc, academy, opts.title, opts.generated);
}

function bulletsPlain(doc: Doc, lines: string[]) {
  for (const l of lines) {
    ensure(doc, 14);
    const y = doc.y;
    doc.circle(M + 4, y + 4.5, 1.6).fill(C.warn);
    doc
      .fillColor(C.ink)
      .font('Helvetica')
      .fontSize(9)
      .text(l, M + 12, y, { width: W(doc) - 12 });
    doc.moveDown(0.15);
  }
  doc.x = M;
}
