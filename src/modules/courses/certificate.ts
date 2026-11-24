/**
 * Course completion certificates: a branded, landscape A4 PDF (round, dates, sessions attended,
 * level from the latest skill assessment), and signed share links that open it after the
 * student's registration number is entered (same gate as invoices and reports).
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  batches,
  courseRounds,
  skillAssessments,
  sports,
  students,
  users,
} from '../../db/schema/index.js';
import { hmac, safeEqual } from '../../lib/crypto.js';
import { formatDisplayDate, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { BRAND_ICON_PNG } from '../reports/brand-icon.js';
import { getAcademySettings, type AcademySettings } from '../settings/settings.js';

export interface CertificateData {
  number: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  batchName: string;
  sportName: string;
  coachName: string;
  roundNo: number;
  startedOn: IsoDate;
  completedOn: IsoDate;
  attended: number;
  target: number;
  courseMonths: number | null;
  level: { code: string | null; name: string } | null;
}

/** Only a round that reached its target earns a certificate (not one left mid-course). */
export async function certificateData(roundId: string): Promise<CertificateData> {
  const [row] = await db
    .select({
      round: courseRounds,
      student: { id: students.id, fullName: students.fullName, code: students.code },
      batch: { name: batches.name, courseMonths: batches.courseMonths, sportId: batches.sportId },
      sport: sports.name,
      coach: users.name,
    })
    .from(courseRounds)
    .innerJoin(students, eq(students.id, courseRounds.studentId))
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(eq(courseRounds.id, roundId));
  if (!row) throw AppError.notFound('Course round');
  const r = row.round;
  if (!r.completedOn || r.attended === null || r.target === null || r.attended < r.target)
    throw AppError.unprocessable('A certificate is available once the course is completed.');
  // The latest assessment in this sport up to completion.
  const [level] = await db
    .select({ code: skillAssessments.levelCode, name: skillAssessments.levelName })
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.studentId, r.studentId),
        eq(skillAssessments.sportId, row.batch.sportId),
        lte(skillAssessments.month, r.completedOn),
      ),
    )
    .orderBy(desc(skillAssessments.month))
    .limit(1);
  return {
    number: `${row.student.code}-R${r.roundNo}-${r.completedOn.replaceAll('-', '')}`,
    studentId: row.student.id,
    studentName: row.student.fullName,
    studentCode: row.student.code,
    batchName: row.batch.name,
    sportName: row.sport,
    coachName: row.coach,
    roundNo: r.roundNo,
    startedOn: r.startedOn,
    completedOn: r.completedOn,
    attended: r.attended,
    target: r.target,
    courseMonths: row.batch.courseMonths,
    level: level?.name ? { code: level.code, name: level.name } : null,
  };
}

const C = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  line: '#e2e8f0',
  brand: '#4f46e5',
  brandDeep: '#3730a3',
  brandSoft: '#eef2ff',
  gold: '#b45309',
};

export function renderCertificatePdf(
  c: CertificateData,
  academy: AcademySettings,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      info: {
        Title: `Certificate · ${c.studentName}`,
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
    const center = (text: string, y: number, size: number, color: string, font = 'Helvetica') => {
      doc
        .fillColor(color)
        .font(font)
        .fontSize(size)
        .text(text, 60, y, { width: W - 120, align: 'center' });
    };

    // Frame.
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

    // Brand.
    doc.save();
    doc.roundedRect(W / 2 - 26, 58, 52, 52, 12).clip();
    doc.image(BRAND_ICON_PNG, W / 2 - 26, 58, { width: 52, height: 52 });
    doc.restore();
    center(academy.name.toUpperCase(), 120, 13, C.brandDeep, 'Helvetica-Bold');

    center('CERTIFICATE OF COMPLETION', 158, 30, C.ink, 'Helvetica-Bold');
    center('This is to certify that', 210, 13, C.muted);
    center(c.studentName, 236, 34, C.brand, 'Helvetica-Bold');
    doc
      .moveTo(W / 2 - 180, 282)
      .lineTo(W / 2 + 180, 282)
      .lineWidth(1)
      .strokeColor(C.line)
      .stroke();
    const months = c.courseMonths ? `${c.courseMonths}-month ` : '';
    center(
      `has completed the ${months}${c.sportName} course in ${c.batchName}` +
        (c.roundNo > 1 ? ` (round ${c.roundNo})` : ''),
      296,
      15,
      C.body,
    );
    center(
      `${formatDisplayDate(c.startedOn)} – ${formatDisplayDate(c.completedOn)}  ·  ${c.attended} sessions attended`,
      322,
      12,
      C.muted,
    );
    if (c.level)
      center(
        `Level reached: ${c.level.code ? `${c.level.code} · ` : ''}${c.level.name}`,
        350,
        14,
        C.gold,
        'Helvetica-Bold',
      );

    // Signatures.
    const sigY = H - 150;
    const col = (x: number, label: string, name: string) => {
      doc
        .moveTo(x, sigY)
        .lineTo(x + 200, sigY)
        .lineWidth(1)
        .strokeColor(C.line)
        .stroke();
      doc
        .fillColor(C.ink)
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(name, x, sigY + 8, { width: 200, align: 'center' });
      doc
        .fillColor(C.muted)
        .font('Helvetica')
        .fontSize(9)
        .text(label, x, sigY + 24, { width: 200, align: 'center' });
    };
    col(110, 'Coach', c.coachName);
    col(W - 310, 'For the academy', academy.legalName ?? academy.name);

    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(
        `Certificate ${c.number}  ·  Student ${c.studentCode}  ·  Issued ${formatDisplayDate(c.completedOn)}`,
        60,
        H - 72,
        { width: W - 120, align: 'center' },
      );
    doc.end();
  });
}

export async function buildCertificate(roundId: string) {
  const data = await certificateData(roundId);
  const pdf = await renderCertificatePdf(data, await getAcademySettings());
  const slug = data.studentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return { data, pdf, filename: `${slug || 'student'}-certificate-round-${data.roundNo}.pdf` };
}

// ─── Signed share links ──────────────────────────────────────────────────────

export function signCertificateLink(roundId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + env.SHARE_LINK_TTL_DAYS * 86_400;
  const sig = hmac(env.SHARE_LINK_SECRET, `certificate:${roundId}:${exp}`);
  return {
    url: `${env.APP_URL}/share/certificate/${roundId}?e=${exp}&s=${sig}`,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyCertificateLink(roundId: string, exp: string, sig: string, now = Date.now()) {
  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum * 1000 < now) return false;
  return safeEqual(hmac(env.SHARE_LINK_SECRET, `certificate:${roundId}:${expNum}`), sig);
}
