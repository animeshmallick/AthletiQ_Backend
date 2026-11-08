/**
 * Applies pending SQL migrations from ./drizzle using the direct (unpooled) connection.
 * Run on deploy before starting the new version: `npm run db:migrate`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';

const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: isProd },
});

try {
  await client.connect();
  await migrate(drizzle({ client }), { migrationsFolder: './drizzle' });
  logger.info('Migrations applied');
} catch (err) {
  logger.error({ err }, 'Migration failed');
  process.exitCode = 1;
} finally {
  await client.end();
}
