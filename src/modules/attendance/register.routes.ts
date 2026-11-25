/**
 * Monthly attendance registers (mounted at /attendance/registers).
 *  GET /                 a tile per batch: admins every batch, coaches their own
 *  GET /:batchId         one batch's register and insights for a month
 *  GET /:batchId/pdf     the same as a PDF
 */
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { batches } from '../../db/schema/index.js';
import { todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIsoDate } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import type { AuthUser } from '../auth/auth.types.js';
import { slug } from '../reports/reports.routes.js';
import { getAcademySettings } from '../settings/settings.js';
import { monthlyRegister, monthOf, registerBatches, registerTiles } from './monthly-register.js';
import { renderRegisterPdf } from './register-pdf.js';

export const registersRouter = Router();

const Query = z.object({ month: zIsoDate.optional() });
const Params = z.object({ batchId: zId });

/** The month asked for (any day of it), this month at the latest. */
function monthFrom(query: unknown): IsoDate {
  const today = todayInAppTz();
  const month = monthOf(parse(Query, query).month ?? today);
  if (month > today) throw AppError.badRequest('Choose a month up to this one.');
  return month;
}

/** The whole register is the batch's history: its own coach and admins only. */
async function batchFor(user: AuthUser, id: string) {
  await assertBatchAccess(user, id, { mainOnly: true });
  const [b] = await registerBatches(eq(batches.id, id));
  if (!b) throw AppError.notFound('Batch');
  return b;
}

registersRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const month = monthFrom(req.query);
  const list = await registerBatches(isAdmin(user) ? undefined : eq(batches.coachId, user.id));
  ok(res, { month, batches: await registerTiles(list, month) });
});

registersRouter.get('/:batchId', async (req, res) => {
  const { batchId } = parse(Params, req.params);
  const month = monthFrom(req.query);
  ok(res, await monthlyRegister(await batchFor(currentUser(req), batchId), month));
});

registersRouter.get('/:batchId/pdf', async (req, res) => {
  const { batchId } = parse(Params, req.params);
  const month = monthFrom(req.query);
  const b = await batchFor(currentUser(req), batchId);
  const pdf = await renderRegisterPdf(await monthlyRegister(b, month), await getAcademySettings());
  res
    .type('application/pdf')
    .setHeader(
      'Content-Disposition',
      `attachment; filename="${slug(b.name)}-attendance-${month.slice(0, 7)}.pdf"`,
    )
    .setHeader('Cache-Control', 'private, no-store')
    .send(pdf);
});
