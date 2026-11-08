import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema/index.js';

// Return Postgres `date` columns as plain 'YYYY-MM-DD' strings (never shifted by timezone).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Long-lived pool against Neon's pooled endpoint. Suited to an always-on EC2 process; Neon
 * terminates idle connections, so keep idle timeout short and let the pool reconnect.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: isProd },
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

export const db = drizzle({ client: pool, schema, casing: 'snake_case' });

export type Database = NodePgDatabase<typeof schema>;
/** Either the root db or a transaction handle; services accept both. */
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
