import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { requestStats, trackQuery } from '../lib/request-context.js';
import * as schema from './schema/index.js';

// Return Postgres `date` columns as plain 'YYYY-MM-DD' strings (never shifted by timezone).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Long-lived pool against Neon's pooled endpoint. The database is far away, so opening a connection
 * costs several round trips: idle ones are kept for two minutes rather than reopened (not longer:
 * open connections can keep Neon from pausing an idle database).
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 2 * 60_000,
  keepAlive: true,
  connectionTimeoutMillis: 10_000,
  // A stuck query must not hold a request (and a pooled connection) forever. Client-side, so it
  // also works through Neon's PgBouncer pooler, which ignores server-side statement_timeout.
  query_timeout: 20_000,
  ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: isProd },
});

/** Counts and times every database trip of the request it belongs to (pooled and in transactions). */
type AnyQuery = (...args: unknown[]) => unknown;
const isCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
const poolQuery = pool.query.bind(pool) as AnyQuery;
(pool as { query: AnyQuery }).query = (...args) =>
  isCallback(args) ? poolQuery(...args) : trackQuery(() => poolQuery(...args) as Promise<unknown>);
const clientProto = pg.Client.prototype as unknown as { query: AnyQuery };
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the client below
const clientQuery = clientProto.query;
clientProto.query = function (this: unknown, ...args) {
  const out = () => clientQuery.apply(this, args);
  // The pool's own calls use callbacks and are counted above.
  return isCallback(args) || !requestStats.getStore()
    ? out()
    : trackQuery(() => Promise.resolve(out()));
};

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
