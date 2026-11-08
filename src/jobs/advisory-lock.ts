import pg from 'pg';
import { env, isProd } from '../config/env.js';

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * Tries to take a Postgres session advisory lock on a dedicated *direct* connection (session
 * locks are not reliable through Neon's transaction-mode pooler). Resolves with a handle when
 * acquired, or null when another process holds it.
 */
export async function tryAdvisoryLock(key: number): Promise<HeldLock | null> {
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: isProd },
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [key],
    );
    if (!rows[0]?.locked) {
      await client.end();
      return null;
    }
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return {
    async release() {
      await client.query('select pg_advisory_unlock($1)', [key]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
