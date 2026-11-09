/**
 * Unauthenticated routes reachable via shared links (sent to parents over WhatsApp). Every link
 * opens a page in the app that asks for the student's registration number first:
 *  - GET  /public/invoices/:id?e&s           what the link is (for that page).
 *  - POST /public/invoices/:id/pdf           { e, s, registrationNo } → the invoice PDF.
 *  - GET  /public/reports/:token             what the link is.
 *  - POST /public/reports/:token/pdf         { registrationNo } → the student's latest report.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parse, zIdParam } from '../../lib/validation.js';
import { describeReportLink, openReportLink } from '../reports/reports.routes.js';
import { getAcademySettings } from '../settings/settings.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { getInvoiceForUser, invoicePdfData } from './invoices.service.js';
import { checkRegistrationNo } from './share-gate.js';
import { verifyInvoiceLink } from './share-links.js';

export const publicRouter = Router();

const Signed = z.object({ e: z.string().max(20), s: z.string().max(100) });
const RegNo = z.object({
  registrationNo: z
    .string()
    .trim()
    .regex(/^\d{4,6}$/, 'Enter the registration number'),
});

/** System principal used only to load an invoice after the signature has been verified. */
const SYSTEM = {
  id: '00000000-0000-0000-0000-000000000000',
  role: 'admin' as const,
  name: 'system',
  email: '',
};

const EXPIRED = 'This link is invalid or has expired. Please ask the academy for a new one.';

/** First name only: enough for a parent to recognise, without exposing the full name. */
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? '';

function sendInline(res: Response, pdf: Buffer, filename: string) {
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="${filename}"`)
    .setHeader('Cache-Control', 'private, no-store')
    .setHeader('X-Robots-Tag', 'noindex, nofollow')
    .send(pdf);
}

async function signedInvoice(id: string, e: string, s: string) {
  if (!verifyInvoiceLink(id, e, s)) throw new AppError('FORBIDDEN', EXPIRED);
  const inv = await getInvoiceForUser(SYSTEM, id);
  if (inv.status === 'cancelled') throw AppError.notFound('Invoice');
  return inv;
}

publicRouter.get('/invoices/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { e, s } = parse(Signed, req.query);
  const inv = await signedInvoice(id, e, s);
  const academy = await getAcademySettings();
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.json({
    data: {
      kind: 'invoice',
      academy: academy.name,
      title: inv.status === 'paid' ? `Receipt ${inv.number}` : `Invoice ${inv.number}`,
      student: firstName(inv.student.fullName),
      expiresAt: new Date(Number(e) * 1000).toISOString(),
    },
  });
});

publicRouter.post('/invoices/:id/pdf', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { e, s, registrationNo } = parse(Signed.extend(RegNo.shape), req.body);
  const inv = await signedInvoice(id, e, s);
  await checkRegistrationNo(`invoice:${id}`, inv.student.id, registrationNo);
  const pdf = await renderInvoicePdf(await invoicePdfData(inv), await getAcademySettings());
  sendInline(res, pdf, `${inv.number.replaceAll('/', '-')}.pdf`);
});

const TokenParam = z.object({ token: z.string().min(20).max(80) });

publicRouter.get('/reports/:token', async (req, res) => {
  const { token } = parse(TokenParam, req.params);
  const link = await describeReportLink(token);
  const academy = await getAcademySettings();
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.json({
    data: {
      kind: 'report',
      academy: academy.name,
      title: 'Progress report',
      student: firstName(link.studentName),
      expiresAt: link.expiresAt.toISOString(),
    },
  });
});

publicRouter.post('/reports/:token/pdf', async (req, res) => {
  const { token } = parse(TokenParam, req.params);
  const { registrationNo } = parse(RegNo, req.body);
  const { pdf, filename } = await openReportLink(token, registrationNo);
  sendInline(res, pdf, filename);
});
