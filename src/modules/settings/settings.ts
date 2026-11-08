import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { academySettings } from '../../db/schema/index.js';
import { ok } from '../../lib/http.js';
import { parse, zEmail, zName, zOptionalText, zPhone } from '../../lib/validation.js';
import { requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';

export type AcademySettings = typeof academySettings.$inferSelect;

export async function getAcademySettings(): Promise<AcademySettings> {
  const row = await db.query.academySettings.findFirst({ where: eq(academySettings.id, 1) });
  if (row) return row;
  const [created] = await db
    .insert(academySettings)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  return (
    created ?? (await db.query.academySettings.findFirst({ where: eq(academySettings.id, 1) }))!
  );
}

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  ok(res, await getAcademySettings());
});

const SettingsBody = z.object({
  name: zName,
  legalName: zOptionalText(200),
  address: zOptionalText(500),
  phone: zPhone.nullable().optional(),
  email: zEmail.nullable().optional(),
  website: zOptionalText(200),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Must be a valid GSTIN')
    .nullable()
    .optional(),
  upiId: z
    .string()
    .trim()
    .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Must be a valid UPI ID (e.g. academy@okhdfc)')
    .nullable()
    .optional(),
  invoiceFooter: zOptionalText(500),
});

settingsRouter.put('/', requireAdmin, async (req, res) => {
  const body = parse(SettingsBody.partial(), req.body);
  await getAcademySettings();
  const [row] = await db
    .update(academySettings)
    .set(body)
    .where(eq(academySettings.id, 1))
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'settings.updated',
    entityType: 'academy_settings',
    metadata: { fields: Object.keys(body) },
  });
  ok(res, row);
});
