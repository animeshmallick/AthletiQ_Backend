/**
 * Creates the first admin account and default academy settings. Idempotent.
 * Usage: set SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PASSWORD and run `npm run db:seed`.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { zPassword } from '../lib/validation.js';
import { hashPassword } from '../modules/auth/password.js';
import { getAcademySettings } from '../modules/settings/settings.js';
import { closeDatabase, db } from './client.js';
import { users } from './schema/index.js';

const SeedEnv = z.object({
  SEED_ADMIN_EMAIL: z.email().toLowerCase(),
  SEED_ADMIN_NAME: z.string().min(1).default('Academy Admin'),
  SEED_ADMIN_PASSWORD: zPassword,
});

try {
  const cfg = SeedEnv.parse(process.env);
  await getAcademySettings();

  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${cfg.SEED_ADMIN_EMAIL}`,
  });
  if (existing) {
    logger.info({ email: cfg.SEED_ADMIN_EMAIL }, 'Admin already exists; nothing to do');
  } else {
    await db.insert(users).values({
      email: cfg.SEED_ADMIN_EMAIL,
      name: cfg.SEED_ADMIN_NAME,
      role: 'admin',
      roles: ['admin'],
      status: 'active',
      passwordHash: await hashPassword(cfg.SEED_ADMIN_PASSWORD),
    });
    logger.info(
      { email: cfg.SEED_ADMIN_EMAIL },
      'Admin created. Change the password after first sign-in.',
    );
  }
} catch (err) {
  logger.error({ err }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
