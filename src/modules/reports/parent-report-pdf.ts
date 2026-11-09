/**
 * The parent-facing progress report (one student, A4). Designed to be read on a phone or
 * printed: a branded summary first, then skills in detail, then attendance and fees.
 * Built-in Helvetica only (no font files), so amounts use "Rs." and arrows are drawn shapes.
 */
import PDFDocument from 'pdfkit';
import { formatDisplayDate } from '../../lib/dates.js';
import type { AcademySettings } from '../settings/settings.js';
import { RATING_LABELS, type Framework } from '../skills/framework.js';
import { areaAverage, type AssessmentView, type SportProgress } from '../skills/progress.js';
import { BRAND_ICON_PNG } from './brand-icon.js';
import type { StudentReport } from './report-data.js';

type Doc = PDFKit.PDFDocument;

const C = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#e2e8f0',
  soft: '#f8fafc',
  panel: '#f1f5f9',
  brand: '#4f46e5',
  brandDeep: '#3730a3',
  brandSoft: '#eef2ff',
  good: '#16a34a',
  goodSoft: '#dcfce7',
  warn: '#d97706',
  warnSoft: '#fef3c7',
  bad: '#dc2626',
  badSoft: '#fee2e2',
  prev: '#94a3b8',
};
const M = 40;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - M - 24;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
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
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const rupees = (paise: number) =>
  `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(paise / 100))}`;
const date = (iso: string | null | undefined) => (iso ? formatDisplayDate(iso.slice(0, 10)) : '-');
const monthShort = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const monthLong = (ym: string) => `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** 345 → "3.45"; trims to one decimal where exact. */
const score = (x100: number) => (x100 / 100).toFixed(x100 % 10 === 0 ? 1 : 2);
const ratingLabel = (avg100: number) =>
  RATING_LABELS[Math.min(4, Math.max(0, Math.round(avg100 / 100) - 1))]!;
const attTone = (r: number | null) =>
  r === null ? C.muted : r >= 80 ? C.good : r >= 60 ? C.warn : C.bad;

/** Colours for well-known level names; others use the brand. */
function levelColor(name: string | null | undefined): string {
  const n = (name ?? '').toLowerCase();
  if (n.includes('bronze')) return '#b45309';
  if (n.includes('silver')) return '#64748b';
  if (n.includes('gold')) return '#ca8a04';
  if (n.includes('platinum') || n.includes('elite')) return '#7c3aed';
  if (n.includes('foundation') || n.includes('starter')) return '#0891b2';
  return C.brand;
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

function ensure(doc: Doc, space: number) {
  if (doc.y + space > BOTTOM) {
    doc.addPage();
    doc.y = M + 6;
  }
}

function heading(doc: Doc, title: string, sub?: string, follow = 40) {
  // Keep room for what follows, so a heading never ends a page on its own.
  ensure(doc, 50 + follow);
  doc.moveDown(0.5);
  const y = doc.y;
  doc.roundedRect(M, y + 1, 4, 16, 2).fill(C.brand);
  doc
    .fillColor(C.ink)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(title, M + 12, y, { width: W - 12 });
  if (sub)
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(sub, M + 12, doc.y + 1, { width: W - 12 });
  doc.y += 8;
  doc.x = M;
}

/** A small up / down triangle with the change, coloured by direction. */
function change(
  doc: Doc,
  x: number,
  y: number,
  delta100: number | null,
  opts: { size?: number } = {},
) {
  const size = opts.size ?? 8.5;
  if (delta100 === null) return;
  if (delta100 === 0) {
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(size)
      .text('no change', x, y, { lineBreak: false });
    return;
  }
  const up = delta100 > 0;
  const color = up ? C.good : C.bad;
  const t = size * 0.55;
  const cy = y + size * 0.55;
  if (up) doc.polygon([x, cy + t / 2], [x + t, cy + t / 2], [x + t / 2, cy - t / 2]).fill(color);
  else doc.polygon([x, cy - t / 2], [x + t, cy - t / 2], [x + t / 2, cy + t / 2]).fill(color);
  doc
    .fillColor(color)
    .font('Helvetica-Bold')
    .fontSize(size)
    .text(`${up ? '+' : '-'}${score(Math.abs(delta100))}`, x + t + 3, y, { lineBreak: false });
}

interface Stat {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  delta?: number | null;
}

function stats(doc: Doc, items: Stat[]) {
  const gap = 10;
  const cols = items.length;
  const w = (W - gap * (cols - 1)) / cols;
  const h = 64;
  ensure(doc, h + 10);
  const y = doc.y;
  items.forEach((t, i) => {
    const x = M + i * (w + gap);
    doc.roundedRect(x, y, w, h, 10).fillAndStroke('#ffffff', C.line);
    doc
      .fillColor(C.muted)
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(t.label.toUpperCase(), x + 11, y + 10, {
        width: w - 22,
        characterSpacing: 0.4,
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .fillColor(t.color ?? C.ink)
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(t.value, x + 11, y + 22, { width: w - 22, lineBreak: false, ellipsis: true });
    if (t.delta !== undefined && t.delta !== null)
      change(doc, x + 11, y + 46, t.delta, { size: 7.5 });
    else if (t.sub)
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(t.sub, x + 11, y + 46, { width: w - 22, lineBreak: false, ellipsis: true });
  });
  doc.y = y + h + 12;
  doc.x = M;
}

/** 1–5 rating dots. */
function dots(doc: Doc, x: number, y: number, rating: number, color = C.brand) {
  for (let i = 1; i <= 5; i++) {
    const cx = x + (i - 1) * 11 + 4;
    if (i <= rating) doc.circle(cx, y, 3.8).fill(color);
    else doc.circle(cx, y, 3.6).lineWidth(0.8).strokeColor(C.line).stroke();
  }
}

// ─── Skill helpers ──────────────────────────────────────────────────────────

/** The sport with the most recent assessment. */
function mainSport(r: StudentReport): SportProgress | null {
  return (
    [...r.skills].sort((a, b) =>
      (b.assessments.at(-1)?.month ?? '').localeCompare(a.assessments.at(-1)?.month ?? ''),
    )[0] ?? null
  );
}

interface AreaRow {
  name: string;
  now: number;
  before: number | null;
}

function areaRows(f: Framework, latest: AssessmentView, prev: AssessmentView | null): AreaRow[] {
  return f.areas
    .map((a) => ({
      name: a.name,
      now: areaAverage(a, latest.ratings),
      before: prev ? areaAverage(a, prev.ratings) : null,
    }))
    .filter((a): a is AreaRow => a.now !== null);
}

/** Radar ("skill wheel") of area averages: this assessment over the previous one. */
function radar(doc: Doc, cx: number, cy: number, r: number, rows: AreaRow[]) {
  const n = rows.length;
  if (n < 3) return false;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, v: number): [number, number] => [
    cx + Math.cos(angle(i)) * r * (v / 500),
    cy + Math.sin(angle(i)) * r * (v / 500),
  ];
  // Grid rings at 1–5.
  for (let ring = 1; ring <= 5; ring++) {
    const pts = rows.map((_, i) => pt(i, ring * 100));
    doc
      .polygon(...pts)
      .lineWidth(0.6)
      .strokeColor(ring === 5 ? '#cbd5e1' : C.line)
      .stroke();
  }
  rows.forEach((_, i) => {
    const [x, y] = pt(i, 500);
    doc.moveTo(cx, cy).lineTo(x, y).lineWidth(0.5).strokeColor(C.line).stroke();
  });
  const prev = rows.every((a) => a.before !== null);
  if (prev) {
    const pts = rows.map((a, i) => pt(i, a.before!));
    doc.save();
    doc
      .polygon(...pts)
      .lineWidth(1.2)
      .dash(3, { space: 2 })
      .strokeColor(C.prev)
      .stroke();
    doc.restore();
  }
  const now = rows.map((a, i) => pt(i, a.now));
  doc.save();
  doc
    .fillOpacity(0.18)
    .polygon(...now)
    .fill(C.brand);
  doc.restore();
  doc
    .polygon(...now)
    .lineWidth(1.8)
    .strokeColor(C.brand)
    .stroke();
  now.forEach(([x, y]) => doc.circle(x, y, 2.6).fill(C.brand));
  // Labels.
  rows.forEach((a, i) => {
    const [x, y] = pt(i, 590);
    const cos = Math.cos(angle(i));
    const w = 76;
    const align = Math.abs(cos) < 0.2 ? 'center' : cos > 0 ? 'left' : 'right';
    const lx = align === 'center' ? x - w / 2 : align === 'left' ? x - 2 : x - w + 2;
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(a.name, lx, y - 7, { width: w, align, lineBreak: false, ellipsis: true });
    doc
      .fillColor(C.brand)
      .font('Helvetica')
      .fontSize(7.5)
      .text(score(a.now), lx, y + 2, { width: w, align, lineBreak: false });
  });
  // Legend.
  const ly = cy + r + 26;
  doc.circle(cx - 62, ly + 3, 3.5).fill(C.brand);
  doc
    .fillColor(C.body)
    .font('Helvetica')
    .fontSize(7.5)
    .text('This month', cx - 55, ly, { lineBreak: false });
  if (prev) {
    doc.save();
    doc
      .moveTo(cx + 8, ly + 3)
      .lineTo(cx + 20, ly + 3)
      .lineWidth(1.2)
      .dash(3, { space: 2 })
      .strokeColor(C.prev)
      .stroke();
    doc.restore();
    doc.fillColor(C.body).text('Last time', cx + 24, ly, { lineBreak: false });
  }
  return true;
}

// ─── Highlights ─────────────────────────────────────────────────────────────

function highlights(r: StudentReport, sp: SportProgress | null): string[] {
  const out: string[] = [];
  if (sp) {
    const latest = sp.assessments.at(-1)!;
    const prev = sp.assessments.at(-2) ?? null;
    const rows = areaRows(sp.framework, latest, prev);
    out.push(
      `Overall skill score ${score(latest.average)} out of 5 (${ratingLabel(latest.average)})${
        prev
          ? latest.average === prev.average
            ? ', steady since last month'
            : `, ${latest.average > prev.average ? 'up' : 'down'} ${score(Math.abs(latest.average - prev.average))} since ${MONTHS_LONG[Number(prev.month.slice(5, 7)) - 1]}`
          : ''
      }.`,
    );
    if (prev && latest.levelName && (latest.levelPosition ?? 0) > (prev.levelPosition ?? 0))
      out.push(`Moved up to ${latest.levelName} level - well done!`);
    else if (latest.levelName) out.push(`Current level: ${latest.levelName}.`);
    if (rows.length >= 2) {
      const best = rows.reduce((x, y) => (y.now > x.now ? y : x));
      const low = rows.reduce((x, y) => (y.now < x.now ? y : x));
      out.push(`Strongest area: ${best.name} (${score(best.now)}).`);
      if (low.name !== best.name) out.push(`Working on: ${low.name} (${score(low.now)}).`);
    }
    if (prev) {
      const skills = sp.framework.areas.flatMap((a) => a.skills);
      const gains = skills
        .map((k) => ({
          name: k.name,
          d: (latest.ratings[k.id] ?? 0) - (prev.ratings[k.id] ?? latest.ratings[k.id] ?? 0),
        }))
        .filter((x) => x.d > 0)
        .sort((a, b) => b.d - a.d);
      if (gains.length)
        out.push(
          `Most improved: ${gains
            .slice(0, 3)
            .map((g) => g.name)
            .join(', ')}.`,
        );
    }
  }
  const a = r.attendance;
  if (a.rate !== null) {
    out.push(`Attended ${a.present + a.late} of ${a.counted} sessions (${a.rate}%).`);
    if (a.rate30 !== null && Math.abs(a.rate30 - a.rate) >= 10)
      out.push(`Attendance in the last 30 days: ${a.rate30}%.`);
    if (a.currentStreak >= 5)
      out.push(`On a run of ${a.currentStreak} sessions without missing one.`);
  }
  return out.slice(0, 7);
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function cover(
  doc: Doc,
  r: StudentReport,
  academy: AcademySettings,
  sp: SportProgress | null,
  opts: { scope: string; generated: string; photo?: { data: Buffer } | null },
) {
  const s = r.student;
  // Header band with soft decoration.
  doc.rect(0, 0, PAGE_W, 168).fill(C.brandDeep);
  doc.save();
  doc
    .fillOpacity(0.12)
    .circle(PAGE_W - 40, 10, 120)
    .fill('#ffffff');
  doc
    .fillOpacity(0.08)
    .circle(PAGE_W - 150, 160, 70)
    .fill('#ffffff');
  doc.restore();
  doc.save();
  doc.roundedRect(M, 34, 42, 42, 10).clip();
  doc.image(BRAND_ICON_PNG, M, 34, { width: 42, height: 42 });
  doc.restore();
  doc
    .fillColor('#c7d2fe')
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('STUDENT PROGRESS REPORT', M + 54, 38, { characterSpacing: 1.2 });
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(academy.name, M + 54, 50, { width: W - 230, lineBreak: false, ellipsis: true });
  doc
    .fillColor('#e0e7ff')
    .font('Helvetica')
    .fontSize(8.5)
    .text(`Report date  ${opts.generated}`, PAGE_W - M - 170, 40, { width: 170, align: 'right' })
    .text(opts.scope, PAGE_W - M - 170, 54, { width: 170, align: 'right' });

  // Student card overlapping the band.
  const cy = 104;
  const ch = 118;
  doc.save();
  doc
    .fillOpacity(0.07)
    .roundedRect(M + 2, cy + 4, W, ch, 14)
    .fill('#000000');
  doc.restore();
  doc.roundedRect(M, cy, W, ch, 14).fillAndStroke('#ffffff', C.line);
  const px = M + 20;
  const pr = 41;
  const pcx = px + pr;
  const pcy = cy + ch / 2;
  doc.circle(pcx, pcy, pr + 3).fill(C.brandSoft);
  if (opts.photo) {
    doc.save();
    doc.circle(pcx, pcy, pr).clip();
    try {
      doc.image(opts.photo.data, pcx - pr, pcy - pr, {
        cover: [pr * 2, pr * 2],
        align: 'center',
        valign: 'center',
      });
    } catch {
      doc.rect(pcx - pr, pcy - pr, pr * 2, pr * 2).fill(C.brand);
    }
    doc.restore();
  } else {
    doc.circle(pcx, pcy, pr).fill(C.brand);
    const initials = s.fullName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(26)
      .text(initials, pcx - pr, pcy - 13, { width: pr * 2, align: 'center' });
  }
  const tx = px + pr * 2 + 20;
  const latest = sp?.assessments.at(-1) ?? null;
  const badgeW = latest?.levelName ? 118 : 0;
  const tw = W - (tx - M) - badgeW - 16;
  doc
    .fillColor(C.ink)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(s.fullName, tx, cy + 22, { width: tw, lineBreak: false, ellipsis: true });
  const facts = [
    s.code,
    s.age !== null ? `${s.age} years` : null,
    sp?.framework.sport.name ?? null,
  ].filter(Boolean);
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(9)
    .text(facts.join('   ·   '), tx, cy + 48, { width: tw });
  if (r.current)
    doc
      .fillColor(C.body)
      .font('Helvetica')
      .fontSize(9)
      .text(`${r.current.batchName}   ·   Coach ${r.current.coachName}`, tx, cy + 64, {
        width: tw,
        lineBreak: false,
        ellipsis: true,
      });
  const months = Math.max(1, Math.floor(s.tenureDays / 30));
  doc
    .fillColor(C.muted)
    .fontSize(8.5)
    .text(
      `With us for ${months} month${months === 1 ? '' : 's'} (since ${date(s.joiningDate)})`,
      tx,
      cy + 80,
      {
        width: tw,
      },
    );
  if (latest?.levelName) {
    const bx = M + W - badgeW - 16;
    const by = cy + 22;
    const col = levelColor(latest.levelName);
    doc.roundedRect(bx, by, badgeW, 74, 12).fill(col);
    doc.save();
    doc
      .fillOpacity(0.18)
      .circle(bx + badgeW - 12, by + 10, 26)
      .fill('#ffffff');
    doc.restore();
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(7)
      .text('CURRENT LEVEL', bx, by + 12, { width: badgeW, align: 'center', characterSpacing: 1 });
    doc
      .font('Helvetica-Bold')
      .fontSize(17)
      .text(latest.levelName, bx + 6, by + 26, {
        width: badgeW - 12,
        align: 'center',
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .text(monthLong(latest.month), bx, by + 52, { width: badgeW, align: 'center' });
  }
  doc.y = cy + ch + 18;
  doc.x = M;

  // Headline numbers.
  const prev = sp?.assessments.at(-2) ?? null;
  const a = r.attendance;
  const next = sp && latest ? nextLevel(sp.framework, latest.average) : null;
  stats(doc, [
    latest
      ? {
          label: 'Skill score',
          value: `${score(latest.average)} / 5`,
          delta: prev ? latest.average - prev.average : null,
          sub: ratingLabel(latest.average),
        }
      : { label: 'Skill score', value: '-', sub: 'First assessment soon' },
    {
      label: 'Level',
      value: latest?.levelName ?? '-',
      color: latest?.levelName ? levelColor(latest.levelName) : C.ink,
      sub: next
        ? `${score(next.gap)} to ${next.name}`
        : latest?.levelName
          ? 'Top level'
          : 'Not yet rated',
    },
    {
      label: 'Attendance',
      value: a.rate30 !== null ? `${a.rate30}%` : a.rate !== null ? `${a.rate}%` : '-',
      color: attTone(a.rate30 ?? a.rate),
      sub: a.rate30 !== null ? 'Last 30 days' : 'Overall',
    },
    {
      label: 'Sessions attended',
      value: `${a.present + a.late}`,
      sub: a.counted ? `of ${a.counted} · best run ${a.longestStreak}` : 'None yet',
    },
  ]);

  // Highlights.
  const lines = highlights(r, sp);
  if (lines.length) {
    doc.font('Helvetica').fontSize(9.5);
    const textW = W - 40;
    const h = lines.reduce((n, l) => n + doc.heightOfString(l, { width: textW }) + 5, 0) + 30;
    ensure(doc, h);
    const y = doc.y;
    doc.roundedRect(M, y, W, h, 12).fill(C.brandSoft);
    doc
      .fillColor(C.brand)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('HIGHLIGHTS', M + 16, y + 11, { characterSpacing: 1 });
    let ly = y + 26;
    for (const l of lines) {
      doc.circle(M + 20, ly + 5, 2.2).fill(C.brand);
      doc
        .fillColor(C.ink)
        .font('Helvetica')
        .fontSize(9.5)
        .text(l, M + 30, ly, { width: textW });
      ly = doc.y + 5;
    }
    doc.y = y + h + 14;
    doc.x = M;
  }

  // Skill wheel and areas.
  if (sp && latest) {
    const rows = areaRows(sp.framework, latest, prev);
    heading(
      doc,
      'Skill wheel',
      `${sp.framework.sport.name} · assessed by ${latest.coachName} in ${monthLong(latest.month)} · 1 = Beginner, 5 = Excellent`,
    );
    const top = doc.y;
    const radarH = 230;
    ensure(doc, radarH);
    const drew = radar(doc, M + 125, doc.y + 100, 82, rows);
    // Area bars on the right (or full width without a radar).
    const bx = drew ? M + 270 : M;
    const bw = drew ? W - 270 : W;
    let y = drew ? top + 10 : doc.y;
    for (const a of rows) {
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(a.name, bx, y, { width: bw - 90, lineBreak: false, ellipsis: true });
      doc
        .fillColor(C.brand)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(score(a.now), bx + bw - 86, y, { width: 30, align: 'right', lineBreak: false });
      if (a.before !== null) change(doc, bx + bw - 50, y + 0.5, a.now - a.before, { size: 7.5 });
      doc.roundedRect(bx, y + 14, bw, 6, 3).fill(C.panel);
      doc.roundedRect(bx, y + 14, Math.max(6, (bw * a.now) / 500), 6, 3).fill(C.brand);
      if (a.before !== null) {
        const mx = bx + (bw * a.before) / 500;
        doc.rect(mx - 0.75, y + 12, 1.5, 10).fill(C.ink);
      }
      y += 32;
    }
    if (rows.some((a) => a.before !== null))
      doc
        .fillColor(C.faint)
        .font('Helvetica')
        .fontSize(7)
        .text('Bar = this month · tick = last time', bx, y - 4, { width: bw });
    doc.y = Math.max(y, top + (drew ? radarH : 0)) + 4;
    doc.x = M;
  } else {
    heading(doc, 'Skills');
    const y = doc.y;
    doc.roundedRect(M, y, W, 54, 10).fill(C.panel);
    doc
      .fillColor(C.body)
      .font('Helvetica')
      .fontSize(9.5)
      .text(
        'Monthly skill assessments start soon. The coach will rate each skill from 1 (Beginner) to 5 (Excellent), and this report will show progress and level.',
        M + 16,
        y + 13,
        { width: W - 32 },
      );
    doc.y = y + 66;
  }
}

function nextLevel(f: Framework, average: number) {
  const n = [...f.levels].sort((a, b) => a.minScore - b.minScore).find((l) => l.minScore > average);
  return n ? { name: n.name, gap: n.minScore - average } : null;
}

function skillsDetail(doc: Doc, sp: SportProgress) {
  const latest = sp.assessments.at(-1)!;
  const prev = sp.assessments.at(-2) ?? null;
  doc.addPage();
  doc.y = M + 6;
  heading(
    doc,
    'Skills in detail',
    `${monthLong(latest.month)}${prev ? ` compared with ${monthLong(prev.month)}` : ''} · each skill rated 1 to 5`,
  );
  for (const area of sp.framework.areas) {
    const rated = area.skills.filter((k) => latest.ratings[k.id] !== undefined);
    if (!rated.length) continue;
    const avg = areaAverage(area, latest.ratings)!;
    const before = prev ? areaAverage(area, prev.ratings) : null;
    ensure(doc, 30 + rated.length * 17);
    const y = doc.y;
    doc.roundedRect(M, y, W, 22, 6).fill(C.panel);
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(area.name, M + 10, y + 6, { lineBreak: false });
    doc
      .fillColor(C.brand)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(`${score(avg)} · ${ratingLabel(avg)}`, M + W - 200, y + 6, {
        width: 140,
        align: 'right',
        lineBreak: false,
      });
    if (before !== null) change(doc, M + W - 52, y + 7, avg - before, { size: 8 });
    let ry = y + 28;
    for (const k of rated) {
      const v = latest.ratings[k.id]!;
      const p = prev?.ratings[k.id];
      doc
        .fillColor(C.body)
        .font('Helvetica')
        .fontSize(9)
        .text(k.name, M + 10, ry, { width: 230, lineBreak: false, ellipsis: true });
      dots(doc, M + 260, ry + 4.5, v);
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(8.5)
        .text(RATING_LABELS[v - 1]!, M + 330, ry, { width: 80, lineBreak: false });
      if (p !== undefined) change(doc, M + W - 52, ry, (v - p) * 100, { size: 8 });
      ry += 17;
    }
    doc.y = ry + 6;
  }

  // Level ladder.
  const levels = [...sp.framework.levels].sort((a, b) => a.minScore - b.minScore);
  if (levels.length) {
    heading(doc, 'Level journey', 'Levels follow the latest assessment score.', 80);
    ensure(doc, 80);
    const y = doc.y;
    const gap = 4;
    const w = (W - gap * (levels.length - 1)) / levels.length;
    const cur = levels.filter((l) => latest.average >= l.minScore).at(-1);
    levels.forEach((l, i) => {
      const x = M + i * (w + gap);
      const reached = latest.average >= l.minScore;
      const isCur = cur?.name === l.name;
      const col = levelColor(l.name);
      doc.roundedRect(x, y, w, 40, 8).fill(isCur ? col : reached ? C.brandSoft : C.panel);
      doc
        .fillColor(isCur ? '#ffffff' : reached ? C.brandDeep : C.faint)
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .text(l.name, x + 4, y + 9, {
          width: w - 8,
          align: 'center',
          lineBreak: false,
          ellipsis: true,
        });
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .text(`from ${score(l.minScore)}`, x + 4, y + 23, {
          width: w - 8,
          align: 'center',
          lineBreak: false,
        });
    });
    const next = nextLevel(sp.framework, latest.average);
    doc
      .fillColor(C.body)
      .font('Helvetica')
      .fontSize(9)
      .text(
        next
          ? `Score now ${score(latest.average)}. ${score(next.gap)} more to reach ${next.name}.`
          : `Score now ${score(latest.average)}. The top level - outstanding!`,
        M,
        y + 50,
        { width: W },
      );
    doc.y = y + 70;
  }

  // Score over time.
  const series = sp.assessments.slice(-12);
  if (series.length >= 2) {
    heading(
      doc,
      'Progress over time',
      'Monthly skill score (1 to 5). Dashed lines mark the levels.',
      170,
    );
    ensure(doc, 170);
    const top = doc.y;
    const h = 130;
    const left = M + 26;
    const cw = W - 36;
    const yOf = (v: number) => top + h - ((v - 100) / 400) * h;
    for (let v = 1; v <= 5; v++) {
      doc
        .moveTo(left, yOf(v * 100))
        .lineTo(left + cw, yOf(v * 100))
        .lineWidth(0.4)
        .strokeColor(C.line)
        .stroke();
      doc
        .fillColor(C.faint)
        .font('Helvetica')
        .fontSize(7)
        .text(String(v), M, yOf(v * 100) - 3.5, { width: 18, align: 'right' });
    }
    for (const l of levels) {
      doc.save();
      doc
        .moveTo(left, yOf(l.minScore))
        .lineTo(left + cw, yOf(l.minScore))
        .lineWidth(0.6)
        .dash(2, { space: 3 })
        .strokeColor(levelColor(l.name))
        .stroke();
      doc.restore();
      doc
        .fillColor(levelColor(l.name))
        .font('Helvetica')
        .fontSize(6.5)
        .text(l.name, left + cw - 60, yOf(l.minScore) - 8, {
          width: 60,
          align: 'right',
          lineBreak: false,
        });
    }
    const step = cw / Math.max(1, series.length - 1);
    const pts = series.map((a, i) => [left + i * step, yOf(a.average)] as [number, number]);
    doc.moveTo(...pts[0]!);
    for (const p of pts.slice(1)) doc.lineTo(...p);
    doc.lineWidth(2).strokeColor(C.brand).stroke();
    pts.forEach(([x, y], i) => {
      doc.circle(x, y, 3.2).fill('#ffffff');
      doc.circle(x, y, 3.2).lineWidth(1.5).strokeColor(C.brand).stroke();
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text(score(series[i]!.average), x - 15, y - 13, {
          width: 30,
          align: 'center',
          lineBreak: false,
        });
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7)
        .text(monthShort(series[i]!.month), x - 18, top + h + 5, {
          width: 36,
          align: 'center',
          lineBreak: false,
        });
    });
    doc.y = top + h + 22;
    doc.x = M;
  }

  // Coach's remarks.
  if (latest.comment || latest.goals) {
    heading(doc, 'From the coach', undefined, 110);
    doc.font('Helvetica').fontSize(10);
    const blocks: [string, string][] = [];
    if (latest.comment) blocks.push(['How it is going', latest.comment]);
    if (latest.goals) blocks.push(['Goals for next month', latest.goals]);
    const textW = W - 40;
    const h = blocks.reduce((n, [, t]) => n + doc.heightOfString(t, { width: textW }) + 26, 0) + 30;
    ensure(doc, h);
    const y = doc.y;
    doc.roundedRect(M, y, W, h, 12).fillAndStroke('#ffffff', C.line);
    doc.rect(M, y + 12, 3, h - 24).fill(C.brand);
    let ty = y + 14;
    for (const [label, text] of blocks) {
      doc
        .fillColor(C.brand)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(label.toUpperCase(), M + 20, ty, { characterSpacing: 0.8 });
      doc
        .fillColor(C.ink)
        .font('Helvetica')
        .fontSize(10)
        .text(text, M + 20, doc.y + 3, { width: textW });
      ty = doc.y + 10;
    }
    doc
      .fillColor(C.muted)
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .text(`- ${latest.coachName}, ${monthLong(latest.month)}`, M + 20, ty, {
        width: textW,
        align: 'right',
      });
    doc.y = y + h + 10;
  }
}

function attendanceAndFees(doc: Doc, r: StudentReport, academy: AcademySettings) {
  const a = r.attendance;
  heading(
    doc,
    'Attendance',
    'Present or late, out of sessions marked. Excused days are not counted.',
    90,
  );
  stats(doc, [
    {
      label: 'Overall',
      value: a.rate !== null ? `${a.rate}%` : '-',
      color: attTone(a.rate),
      sub: `${a.present + a.late} of ${a.counted} sessions`,
    },
    {
      label: 'Last 30 days',
      value: a.rate30 !== null ? `${a.rate30}%` : '-',
      color: attTone(a.rate30),
      sub: `Last 90 days: ${a.rate90 ?? '-'}${a.rate90 !== null ? '%' : ''}`,
    },
    { label: 'Current run', value: `${a.currentStreak}`, sub: `Best run: ${a.longestStreak}` },
    {
      label: 'Last attended',
      value: a.lastAttended ? date(a.lastAttended).replace(/ \d{4}$/, '') : '-',
      sub: a.late ? `${a.late} late arrivals` : 'Always on time',
    },
  ]);

  const months = a.byMonth.slice(-12);
  if (months.length) {
    ensure(doc, 150);
    const top = doc.y;
    const h = 96;
    const left = M + 26;
    const cw = W - 30;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text('By month', M, top);
    const base = top + 18;
    for (const v of [0, 50, 100]) {
      const y = base + h - (v / 100) * h;
      doc
        .moveTo(left, y)
        .lineTo(left + cw, y)
        .lineWidth(0.4)
        .strokeColor(C.line)
        .stroke();
      doc
        .fillColor(C.faint)
        .font('Helvetica')
        .fontSize(7)
        .text(`${v}%`, M - 4, y - 3.5, { width: 26, align: 'right' });
    }
    const slot = cw / months.length;
    const bw = Math.min(28, slot * 0.6);
    months.forEach((m, i) => {
      const x = left + i * slot + (slot - bw) / 2;
      const v = m.rate ?? 0;
      const bh = Math.max(2, (v / 100) * h);
      doc.roundedRect(x, base + h - bh, bw, bh, 3).fill(attTone(m.rate));
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text(m.rate !== null ? `${m.rate}%` : '-', x - 6, base + h - bh - 10, {
          width: bw + 12,
          align: 'center',
          lineBreak: false,
        });
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(7)
        .text(monthShort(m.month), x - 8, base + h + 4, {
          width: bw + 16,
          align: 'center',
          lineBreak: false,
        });
    });
    doc.y = base + h + 20;
  }

  const wd = a.byWeekday;
  if (wd.length >= 2) {
    ensure(doc, 30 + wd.length * 16);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text('By day of the week', M, doc.y);
    let y = doc.y + 6;
    for (const w of wd) {
      doc
        .fillColor(C.body)
        .font('Helvetica')
        .fontSize(8.5)
        .text(DAY[w.weekday]!, M, y, { width: 40 });
      doc.roundedRect(M + 44, y + 2, W - 110, 7, 3.5).fill(C.panel);
      if (w.rate)
        doc
          .roundedRect(M + 44, y + 2, Math.max(7, ((W - 110) * w.rate) / 100), 7, 3.5)
          .fill(attTone(w.rate));
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text(w.rate !== null ? `${w.rate}%` : '-', M + W - 58, y, { width: 56, align: 'right' });
      y += 16;
    }
    doc.y = y + 4;
  }

  // Recent weekly notes from the coach.
  const notes = r.feedback.weeks
    .slice(-3)
    .reverse()
    .filter((w) => w.notes.length);
  if (notes.length) {
    heading(doc, 'Recent weekly notes', undefined, 60);
    for (const w of notes) {
      const text = w.notes.map((n) => `${n.label}: ${n.value}`).join('\n');
      doc.font('Helvetica').fontSize(9);
      const h = doc.heightOfString(text, { width: W - 24 }) + 30;
      ensure(doc, h);
      const y = doc.y;
      doc.roundedRect(M, y, W, h, 8).fill(C.soft);
      doc
        .fillColor(C.muted)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(
          `WEEK OF ${date(w.weekStart).toUpperCase()} · ${w.coachName.toUpperCase()}`,
          M + 12,
          y + 9,
        );
      doc
        .fillColor(C.body)
        .font('Helvetica')
        .fontSize(9)
        .text(text, M + 12, y + 21, { width: W - 24 });
      doc.y = y + h + 6;
    }
  }

  // Fees, in one line.
  const f = r.fees;
  heading(doc, 'Fees', undefined, 50);
  const y = doc.y;
  const overdue = f.overdueCount > 0;
  const due = f.outstanding > 0;
  const nextDue = f.invoices.find((i) => i.status === 'due' || i.status === 'overdue');
  doc.roundedRect(M, y, W, 40, 10).fill(overdue ? C.badSoft : due ? C.warnSoft : C.goodSoft);
  doc
    .fillColor(overdue ? C.bad : due ? C.warn : C.good)
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .text(
      overdue
        ? `${rupees(f.overdue)} overdue - please clear it at the earliest.`
        : due
          ? `${rupees(f.outstanding)} due${nextDue ? ` by ${date(nextDue.dueDate)}` : ''}.`
          : f.invoicesCount
            ? 'All fees are paid. Thank you!'
            : 'No fees billed yet.',
      M + 16,
      y + 14,
      { width: W - 32 },
    );
  doc.y = y + 52;

  // Closing.
  ensure(doc, 60);
  const contact = [academy.phone, academy.email, academy.website].filter(Boolean).join('   ·   ');
  doc
    .fillColor(C.ink)
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(`Thank you for being part of ${academy.name}.`, M, doc.y + 6, {
      width: W,
      align: 'center',
    });
  if (contact)
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8.5)
      .text(`Questions? ${contact}`, M, doc.y + 3, { width: W, align: 'center' });
  if (academy.address)
    doc
      .fillColor(C.faint)
      .font('Helvetica')
      .fontSize(8)
      .text(academy.address, M, doc.y + 2, { width: W, align: 'center' });
}

function frame(doc: Doc, academy: AcademySettings, studentName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      if (i > range.start) doc.rect(0, 0, PAGE_W, 5).fill(C.brandDeep);
      const y = PAGE_H - M + 4;
      doc
        .moveTo(M, y - 8)
        .lineTo(PAGE_W - M, y - 8)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();
      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5);
      doc.text(`${academy.name}  ·  Progress report  ·  ${studentName}`, M, y, {
        width: W - 140,
        lineBreak: false,
        ellipsis: true,
      });
      doc.text(`Page ${i + 1} of ${range.count}  ·  AthletiQ`, PAGE_W - M - 140, y, {
        width: 140,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = margin;
    }
    doc.end();
  });
}

export async function renderParentReportPdf(
  r: StudentReport,
  academy: AcademySettings,
  opts: { scope: string; generated: string; photo?: { data: Buffer } | null },
) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: {
      Title: `Progress report - ${r.student.fullName}`,
      Author: academy.name,
      Creator: 'AthletiQ',
    },
  });
  const sp = mainSport(r);
  cover(doc, r, academy, sp, opts);
  if (sp) skillsDetail(doc, sp);
  attendanceAndFees(doc, r, academy);
  return frame(doc, academy, r.student.fullName);
}
