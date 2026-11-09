/**
 * PDF reports.
 *  - GET /reports/students/:id/pdf?batchId=all|<id>  one student (coach of the student, or admin).
 *    "all" = everything since joining; a batch = only that batch, from when they joined it.
 *  - GET /reports/batches/pdf?batchId=all|<id>       every student in a batch, or all batches
 *    combined (admins only): summary, rankings, who needs attention, then a section per student.
 *  - POST/GET /reports/students/:id/links, DELETE /reports/links/:id
 *    private links that open the student's latest report without signing in (for parents);
 *    they expire after SHARE_LINK_TTL_DAYS and can be revoked.
 */
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  reportLinks,
  studentPhotos,
  students,
  users,
} from '../../db/schema/index.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { parse, zId, zIdParam } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertStudentAccess, isAdmin } from '../access/access.js';
import { checkRegistrationNo } from '../billing/share-gate.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { getAcademySettings } from '../settings/settings.js';
import { loadStudentReports } from './report-data.js';
import { renderParentReportPdf } from './parent-report-pdf.js';
import { renderGroupReportPdf } from './report-pdf.js';

export const reportsRouter = Router();

const Scope = z.object({ batchId: z.union([z.literal('all'), zId]).default('all') });

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'report';

function sendPdf(res: Response, pdf: Buffer, filename: string) {
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
}

/**
 * Builds one student's report. `user` (when signed in) limits a coach to their own batches;
 * share links pass null and always get the full report.
 */
export async function buildStudentPdf(
  id: string,
  batchId: string, // 'all' or a batch id
  user: AuthUser | null,
): Promise<{ pdf: Buffer; filename: string }> {
  const today = todayInAppTz();
  let scope = 'All batches, since joining';
  if (batchId !== 'all') {
    const [first] = await db
      .select({ from: enrollments.effectiveFrom, name: batches.name, coachId: batches.coachId })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .where(and(eq(enrollments.studentId, id), eq(enrollments.batchId, batchId)))
      .orderBy(asc(enrollments.effectiveFrom))
      .limit(1);
    if (!first) throw AppError.unprocessable('This student has never been in that batch');
    if (user && user.role === 'coach' && first.coachId !== user.id) {
      throw AppError.forbidden('You can only report on your own batches');
    }
    scope = `${first.name}, since ${formatDisplayDate(first.from)}`;
  }
  const [report] = await loadStudentReports([id], batchId === 'all' ? null : [batchId], today);
  if (!report) throw AppError.notFound('Student');
  const photo = await db.query.studentPhotos.findFirst({
    columns: { data: true },
    where: eq(studentPhotos.studentId, id),
  });
  const pdf = await renderParentReportPdf(report, await getAcademySettings(), {
    scope,
    generated: formatDisplayDate(today),
    photo: photo ?? null,
  });
  return { pdf, filename: `${slug(report.student.fullName)}-${report.student.code}-report.pdf` };
}

reportsRouter.get('/students/:id/pdf', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { batchId } = parse(Scope, req.query);
  const user = currentUser(req);
  await assertStudentAccess(user, id);
  const { pdf, filename } = await buildStudentPdf(id, batchId, user);
  await audit({
    ...auditCtx(req),
    action: 'report.student_generated',
    entityType: 'student',
    entityId: id,
    metadata: { batchId },
  });
  sendPdf(res, pdf, filename);
});

// ─── Share links ─────────────────────────────────────────────────────────────

const linkUrl = (token: string) => `${env.APP_URL}/share/report/${token}`;

reportsRouter.post('/students/:id/links', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  await assertStudentAccess(user, id);
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + env.SHARE_LINK_TTL_DAYS * 86_400_000);
  const [link] = await db
    .insert(reportLinks)
    .values({ studentId: id, tokenHash: sha256(token), createdById: user.id, expiresAt })
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'report.link_created',
    entityType: 'student',
    entityId: id,
    metadata: { linkId: link!.id, expiresAt: expiresAt.toISOString() },
  });
  // The token is only ever returned here.
  created(res, { id: link!.id, url: linkUrl(token), expiresAt, createdAt: link!.createdAt });
});

reportsRouter.get('/students/:id/links', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(currentUser(req), id);
  const rows = await db
    .select({
      id: reportLinks.id,
      expiresAt: reportLinks.expiresAt,
      createdAt: reportLinks.createdAt,
      views: reportLinks.views,
      lastViewedAt: reportLinks.lastViewedAt,
      createdBy: users.name,
    })
    .from(reportLinks)
    .leftJoin(users, eq(users.id, reportLinks.createdById))
    .where(
      and(
        eq(reportLinks.studentId, id),
        isNull(reportLinks.revokedAt),
        gt(reportLinks.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(reportLinks.createdAt));
  ok(res, rows);
});

reportsRouter.delete('/links/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const link = await db.query.reportLinks.findFirst({ where: eq(reportLinks.id, id) });
  if (!link) throw AppError.notFound('Link');
  await assertStudentAccess(user, link.studentId);
  if (!isAdmin(user) && link.createdById !== user.id)
    throw AppError.forbidden('Only an admin or whoever made the link can revoke it');
  await db.update(reportLinks).set({ revokedAt: new Date() }).where(eq(reportLinks.id, id));
  await audit({
    ...auditCtx(req),
    action: 'report.link_revoked',
    entityType: 'student',
    entityId: link.studentId,
    metadata: { linkId: id },
  });
  ok(res, { revoked: true });
});

/** A live (not revoked, not expired) share link, with whose report it is. */
async function liveLink(token: string) {
  const link = await db.query.reportLinks.findFirst({
    where: eq(reportLinks.tokenHash, sha256(token)),
  });
  if (!link || link.revokedAt || link.expiresAt < new Date())
    throw new AppError(
      'FORBIDDEN',
      'This link is invalid or has expired. Please ask the academy for a new one.',
    );
  const student = await db.query.students.findFirst({
    columns: { fullName: true },
    where: eq(students.id, link.studentId),
  });
  if (!student) throw AppError.notFound('Report');
  return { link, studentName: student.fullName };
}

/** Public: what a share link opens (for the page that asks for the registration number). */
export async function describeReportLink(token: string) {
  const { link, studentName } = await liveLink(token);
  return { studentName, expiresAt: link.expiresAt };
}

/** Public: the report behind a share link, once the registration number matches. */
export async function openReportLink(token: string, registrationNo: string) {
  const { link } = await liveLink(token);
  await checkRegistrationNo(`report:${link.id}`, link.studentId, registrationNo);
  const built = await buildStudentPdf(link.studentId, 'all', null);
  await db
    .update(reportLinks)
    .set({ views: link.views + 1, lastViewedAt: new Date() })
    .where(eq(reportLinks.id, link.id));
  return built;
}

// ─── Group report ────────────────────────────────────────────────────────────

reportsRouter.get('/batches/pdf', requireAdmin, async (req, res) => {
  const { batchId } = parse(Scope, req.query);
  const today = todayInAppTz();
  let title = 'All batches';
  if (batchId !== 'all') {
    const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw AppError.notFound('Batch');
    title = batch.name;
  }

  // Current members (one batch) or every active student (all batches), by name.
  const rows = await db
    .selectDistinct({ id: students.id, name: students.fullName })
    .from(students)
    .innerJoin(
      enrollments,
      and(eq(enrollments.studentId, students.id), isNull(enrollments.effectiveTo)),
    )
    .where(
      and(
        eq(students.status, 'active'),
        batchId === 'all' ? undefined : inArray(enrollments.batchId, [batchId]),
      ),
    )
    .orderBy(asc(students.fullName));
  if (rows.length === 0) throw AppError.unprocessable('There are no active students to report on');
  if (rows.length > 400) {
    throw AppError.unprocessable('Too many students for one report. Generate it per batch.');
  }

  const reports = await loadStudentReports(
    rows.map((r) => r.id),
    batchId === 'all' ? null : [batchId],
    today,
  );
  const pdf = await renderGroupReportPdf(reports, await getAcademySettings(), {
    title: batchId === 'all' ? 'All batches' : title,
    scope:
      batchId === 'all'
        ? 'All batches combined, each student since joining'
        : `${title}, each student since joining this batch`,
    generated: formatDisplayDate(today),
  });
  await audit({
    ...auditCtx(req),
    action: 'report.batch_generated',
    entityType: 'batch',
    entityId: batchId === 'all' ? null : batchId,
    metadata: { batchId, students: rows.length },
  });
  sendPdf(res, pdf, `${slug(title)}-report-${today}.pdf`);
});
