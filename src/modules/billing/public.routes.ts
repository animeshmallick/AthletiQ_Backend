import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parse, zIdParam } from '../../lib/validation.js';
import { getAcademySettings } from '../settings/settings.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { getInvoiceForUser, invoicePdfData } from './invoices.service.js';
import { verifyInvoiceLink } from './share-links.js';

/** Unauthenticated routes reachable via signed links (shared with parents over WhatsApp). */
export const publicRouter = Router();

const SignedQuery = z.object({ e: z.string().max(20), s: z.string().max(100) });

/** System principal used only to load an invoice after the signature has been verified. */
const SYSTEM = {
  id: '00000000-0000-0000-0000-000000000000',
  role: 'admin' as const,
  name: 'system',
  email: '',
};

publicRouter.get('/invoices/:id/pdf', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { e, s } = parse(SignedQuery, req.query);
  if (!verifyInvoiceLink(id, e, s)) {
    throw new AppError(
      'FORBIDDEN',
      'This link is invalid or has expired. Please ask the academy for a new one.',
    );
  }
  const inv = await getInvoiceForUser(SYSTEM, id);
  if (inv.status === 'cancelled') throw AppError.notFound('Invoice');
  const pdf = await renderInvoicePdf(await invoicePdfData(inv), await getAcademySettings());
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="${inv.number.replaceAll('/', '-')}.pdf"`)
    .setHeader('Cache-Control', 'private, max-age=300')
    .setHeader('X-Robots-Tag', 'noindex, nofollow')
    .send(pdf);
});
