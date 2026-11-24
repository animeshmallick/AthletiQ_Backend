/**
 * Certificate of a finished cycle: a branded landscape A4 PDF with attendance and skills, shared
 * by a signed link that opens after the student's registration number is entered.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  batchCycles,
  batches,
  skillAssessments,
  sports,
  students,
  users,
} from '../../db/schema/index.js';
import { hmac, safeEqual } from '../../lib/crypto.js';
import { addDays, formatDisplayDate, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { BRAND_ICON_PNG } from '../reports/brand-icon.js';
import { getAcademySettings, type AcademySettings } from '../settings/settings.js';
import { cycleProgress } from './progress.js';

interface Level {
  text: string;
  average: number;
}

export interface CertificateData {
  number: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  batchName: string;
  sportName: string;
  coachName: string;
  roundNo: number;
  months: number;
  startsOn: IsoDate;
  endsOn: IsoDate;
  conducted: number;
  attended: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  rate: number | null;
  /** Attendance by calendar month. */
  trend: { month: string; attended: number; conducted: number }[];
  level: { start: Level | null; end: Level | null };
}

export async function certificateData(cycleId: string): Promise<CertificateData> {
  const [row] = await db
    .select({
      c: batchCycles,
      student: { fullName: students.fullName, code: students.code },
      batch: { name: batches.name, sportId: batches.sportId },
      sport: sports.name,
      coach: users.name,
    })
    .from(batchCycles)
    .innerJoin(students, eq(students.id, batchCycles.studentId))
    .innerJoin(batches, eq(batches.id, batchCycles.batchId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(eq(batchCycles.id, cycleId));
  if (!row) throw AppError.notFound('Cycle');
  const { c } = row;
  if (c.status !== 'completed')
    throw AppError.unprocessable('A certificate is available once the cycle is finished.');
  const p = (await cycleProgress([c])).get(c.id)!;
  const held = p.sessions.filter((s) => s.state === 'held');
  const months = new Map<string, { attended: number; conducted: number }>();
  for (const s of held) {
    const m = (s.originalDate ?? s.date).slice(0, 7);
    const t = months.get(m) ?? { attended: 0, conducted: 0 };
    t.conducted++;
    if (s.mark === 'present' || s.mark === 'late') t.attended++;
    months.set(m, t);
  }
  // Skills before (up to 3 months earlier) and at the end of the cycle.
  const levels = await db
    .select({
      month: skillAssessments.month,
      average: skillAssessments.average,
      code: skillAssessments.levelCode,
      name: skillAssessments.levelName,
    })
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.studentId, c.studentId),
        eq(skillAssessments.sportId, row.batch.sportId),
        gte(skillAssessments.month, addDays(c.startsOn, -92)),
        lte(skillAssessments.month, c.endsOn),
      ),
    )
    .orderBy(asc(skillAssessments.month));
  const level = (l: (typeof levels)[number] | undefined): Level | null =>
    l
      ? {
          text: [l.code, l.name].filter(Boolean).join(' · ') || 'Assessed',
          average: l.average / 100,
        }
      : null;
  const first = [...levels].reverse().find((l) => l.month <= c.startsOn) ?? levels[0];
  const last = levels.at(-1);
  return {
    number: `${row.student.code}-R${c.roundNo}-${c.endsOn.replaceAll('-', '')}-${c.id.slice(0, 4).toUpperCase()}`,
    studentId: c.studentId,
    studentName: row.student.fullName,
    studentCode: row.student.code,
    batchName: row.batch.name,
    sportName: row.sport,
    coachName: row.coach,
    roundNo: c.roundNo,
    months: c.months,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    conducted: p.conducted,
    attended: p.attended,
    present: p.present,
    late: p.late,
    absent: p.absent,
    excused: p.excused,
    rate: p.rate,
    trend: [...months]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, t]) => ({ month, ...t })),
    level: { start: first === last ? null : level(first), end: level(last) },
  };
}

const C = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  line: '#e2e8f0',
  soft: '#f8fafc',
  brand: '#4f46e5',
  brandDeep: '#3730a3',
  brandSoft: '#eef2ff',
  good: '#16a34a',
  gold: '#b45309',
};
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function renderCertificatePdf(
  c: CertificateData,
  academy: AcademySettings,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      info: { Title: `Certificate · ${c.studentName}`, Author: academy.name, Creator: 'AthletiQ' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    /** One line, shrunk to fit: long names never wrap over the next line. */
    const line = (
      text: string,
      x: number,
      y: number,
      width: number,
      size: number,
      color: string,
      bold = false,
    ) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      let s = size;
      while (s > 7 && doc.widthOfString(text) > width) doc.fontSize((s -= 0.5));
      doc.fillColor(color).text(text, x, y, { width, align: 'center', lineBreak: false });
    };
    const center = (t: string, y: number, size: number, color: string, bold = false) =>
      line(t, 70, y, W - 140, size, color, bold);

    doc.rect(0, 0, W, H).fill('#ffffff');
    doc
      .lineWidth(10)
      .strokeColor(C.brand)
      .rect(18, 18, W - 36, H - 36)
      .stroke();
    doc
      .lineWidth(1)
      .strokeColor(C.brandSoft)
      .rect(34, 34, W - 68, H - 68)
      .stroke();

    doc.save();
    doc.roundedRect(W / 2 - 22, 50, 44, 44, 10).clip();
    doc.image(BRAND_ICON_PNG, W / 2 - 22, 50, { width: 44, height: 44 });
    doc.restore();
    center(academy.name.toUpperCase(), 101, 12, C.brandDeep, true);
    center('CERTIFICATE OF COMPLETION', 124, 26, C.ink, true);
    center('This is to certify that', 164, 12, C.muted);
    center(c.studentName, 184, 32, C.brand, true);
    doc
      .moveTo(W / 2 - 190, 226)
      .lineTo(W / 2 + 190, 226)
      .lineWidth(1)
      .strokeColor(C.line)
      .stroke();
    center(
      `has completed round ${c.roundNo} of the ${c.months}-month ${c.sportName} course in ${c.batchName}`,
      236,
      14,
      C.body,
    );
    center(`${formatDisplayDate(c.startsOn)} – ${formatDisplayDate(c.endsOn)}`, 258, 11, C.muted);

    // Attendance tiles.
    const tiles: [string, string, string][] = [
      ['Sessions conducted', String(c.conducted), C.ink],
      ['Attended', `${c.attended}`, C.good],
      ['Attendance', c.rate === null ? '–' : `${c.rate}%`, C.brand],
      ['Late', String(c.late), C.gold],
      ['Absent', String(c.absent + c.excused), C.muted],
    ];
    const tw = 112;
    const gap = 12;
    let x = (W - tiles.length * tw - (tiles.length - 1) * gap) / 2;
    for (const [label, value, color] of tiles) {
      doc.roundedRect(x, 282, tw, 56, 8).fill(C.soft);
      line(value, x, 292, tw, 20, color, true);
      line(label, x, 318, tw, 9, C.muted);
      x += tw + gap;
    }

    // Monthly attendance (up to the last 12 months) and skills, side by side.
    const left = 90;
    const top = 354;
    const trend = c.trend.slice(-12);
    line('Attendance by month', left, top, 300, 9.5, C.body, true);
    const bw = Math.min(40, 300 / Math.max(1, trend.length));
    const bx = left + (300 - bw * trend.length) / 2;
    trend.forEach((t, i) => {
      const h = t.conducted ? (t.attended / t.conducted) * 44 : 0;
      doc.rect(bx + i * bw + 5, top + 18, bw - 10, 44).fill(C.brandSoft);
      doc.rect(bx + i * bw + 5, top + 62 - h, bw - 10, h).fill(C.brand);
      line(MONTH[Number(t.month.slice(5)) - 1]!, bx + i * bw, top + 66, bw, 7.5, C.muted);
    });
    if (!trend.length) line('No sessions recorded', left, top + 36, 300, 9, C.muted);
    const sx = W - left - 300;
    line('Skill level', sx, top, 300, 9.5, C.body, true);
    if (c.level.end) {
      line(c.level.end.text, sx, top + 20, 300, 17, C.gold, true);
      const was = c.level.start;
      line(
        was
          ? `Score ${c.level.end.average.toFixed(2)} (started at ${was.text}, ${was.average.toFixed(2)})`
          : `Score ${c.level.end.average.toFixed(2)} of 5`,
        sx,
        top + 46,
        300,
        10,
        C.muted,
      );
    } else line('Not assessed in this round', sx, top + 28, 300, 10, C.muted);

    const sigY = H - 112;
    const sign = (at: number, label: string, name: string) => {
      doc
        .moveTo(at, sigY)
        .lineTo(at + 200, sigY)
        .lineWidth(1)
        .strokeColor(C.line)
        .stroke();
      line(name, at, sigY + 6, 200, 11, C.ink, true);
      line(label, at, sigY + 21, 200, 9, C.muted);
    };
    sign(110, 'Coach', c.coachName);
    sign(W - 310, 'For the academy', academy.legalName ?? academy.name);
    center(
      `Certificate ${c.number}  ·  Student ${c.studentCode}  ·  Issued ${formatDisplayDate(c.endsOn)}`,
      H - 62,
      8,
      C.muted,
    );
    doc.end();
  });
}

export async function buildCertificate(cycleId: string) {
  const data = await certificateData(cycleId);
  const pdf = await renderCertificatePdf(data, await getAcademySettings());
  const slug =
    data.studentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'student';
  return { data, pdf, filename: `${slug}-certificate-round-${data.roundNo}.pdf` };
}

// ─── Signed links ────────────────────────────────────────────────────────────

const sign = (cycleId: string, exp: number) =>
  hmac(env.SHARE_LINK_SECRET, `certificate:${cycleId}:${exp}`);

export function signCertificateLink(cycleId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + env.SHARE_LINK_TTL_DAYS * 86_400;
  return {
    url: `${env.APP_URL}/share/certificate/${cycleId}?e=${exp}&s=${sign(cycleId, exp)}`,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyCertificateLink(cycleId: string, exp: string, sig: string, now = Date.now()) {
  const n = Number(exp);
  return Number.isInteger(n) && n * 1000 >= now && safeEqual(sign(cycleId, n), sig);
}
