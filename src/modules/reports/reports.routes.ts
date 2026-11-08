/**
 * PDF reports.
 *  - GET /reports/students/:id/pdf?batchId=all|<id>  one student (coach of the student, or admin).
 *    "all" = everything since joining; a batch = only that batch, from when they joined it.
 *  - GET /reports/batches/pdf?batchId=all|<id>       every student in a batch, or all batches
 *    combined (admins only): summary, rankings, who needs attention, then a section per student.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, students } from '../../db/schema/index.js';
import { formatDisplayDate, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { parse, zId, zIdParam } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertStudentAccess } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { getAcademySettings } from '../settings/settings.js';
import { loadStudentReports } from './report-data.js';
import { renderGroupReportPdf, renderStudentReportPdf } from './report-pdf.js';

export const reportsRouter = Router();

const Scope = z.object({ batchId: z.union([z.literal('all'), zId]).default('all') });

const slug = (s: string) =>
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

reportsRouter.get('/students/:id/pdf', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { batchId } = parse(Scope, req.query);
  const user = currentUser(req);
  await assertStudentAccess(user, id);
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
    if (user.role === 'coach' && first.coachId !== user.id) {
      throw AppError.forbidden('You can only report on your own batches');
    }
    scope = `${first.name}, since ${formatDisplayDate(first.from)}`;
  }

  const [report] = await loadStudentReports([id], batchId === 'all' ? null : [batchId], today);
  if (!report) throw AppError.notFound('Student');
  const pdf = await renderStudentReportPdf(report, await getAcademySettings(), {
    scope,
    generated: formatDisplayDate(today),
  });
  await audit({
    ...auditCtx(req),
    action: 'report.student_generated',
    entityType: 'student',
    entityId: id,
    metadata: { batchId },
  });
  sendPdf(res, pdf, `${slug(report.student.fullName)}-${report.student.code}-report.pdf`);
});

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
