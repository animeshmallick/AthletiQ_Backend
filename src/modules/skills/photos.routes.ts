/**
 * Optional student photo, shown in the app and on the parent report.
 *  - GET    /students/:id/photo   the image (anyone who can see the student).
 *  - PUT    /students/:id/photo   { mime, data (base64) } — a small JPEG or PNG; the app resizes
 *    it on the device first.
 *  - DELETE /students/:id/photo
 */
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { studentPhotos } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zIdParam } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertStudentAccess } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';

export const photosRouter = Router();

/** 400 KB is plenty for a 512 px portrait. */
const MAX_BYTES = 400 * 1024;

/** Checks the file really is what it claims (magic bytes), not just the declared type. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length > 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  return null;
}

photosRouter.get('/:id/photo', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(currentUser(req), id);
  const photo = await db.query.studentPhotos.findFirst({ where: eq(studentPhotos.studentId, id) });
  if (!photo) throw AppError.notFound('Photo');
  res
    .type(photo.mime)
    .setHeader('Cache-Control', 'private, max-age=300')
    .setHeader('Last-Modified', photo.updatedAt.toUTCString())
    .send(photo.data);
});

photosRouter.put('/:id/photo', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(currentUser(req), id);
  const body = parse(
    z.object({
      data: z
        .string()
        .min(10)
        .max(Math.ceil((MAX_BYTES * 4) / 3) + 8),
    }),
    req.body,
  );
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_BYTES) throw AppError.unprocessable('Photo is too large');
  const mime = sniffImage(buf);
  if (!mime) throw AppError.unprocessable('Use a JPEG or PNG photo');
  await db
    .insert(studentPhotos)
    .values({ studentId: id, mime, data: buf })
    .onConflictDoUpdate({
      target: studentPhotos.studentId,
      set: { mime, data: buf, updatedAt: new Date() },
    });
  await audit({
    ...auditCtx(req),
    action: 'student.photo_updated',
    entityType: 'student',
    entityId: id,
  });
  ok(res, { hasPhoto: true });
});

photosRouter.delete('/:id/photo', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(currentUser(req), id);
  await db.delete(studentPhotos).where(eq(studentPhotos.studentId, id));
  await audit({
    ...auditCtx(req),
    action: 'student.photo_removed',
    entityType: 'student',
    entityId: id,
  });
  ok(res, { hasPhoto: false });
});
