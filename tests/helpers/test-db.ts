/**
 * In-memory Postgres (PGlite, real Postgres compiled to WASM) standing in for `src/db/client.ts`
 * in API tests. Each test file gets a fresh instance migrated with the production migrations.
 */
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/db/schema';

const DATE_OID = 1082;

// Return `date` columns as 'YYYY-MM-DD' strings — the same contract as production (pg type parser).
const client = new PGlite({ parsers: { [DATE_OID]: (v: string) => v } });

export const db = drizzle({ client, schema, casing: 'snake_case' });

export const pool = {
  query: (text: string) => client.query(text),
  end: async () => undefined,
};

export async function checkDatabase(): Promise<boolean> {
  try {
    await client.query('select 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  // The PGlite instance lives for the whole test file.
}

/** Called once after each test file. */
export async function shutdownTestDb(): Promise<void> {
  if (!client.closed) await client.close();
}

let migrated: Promise<void> | undefined;
export function migrateTestDb(): Promise<void> {
  migrated ??= migrate(db, { migrationsFolder: path.join(__dirname, '../../drizzle') });
  return migrated;
}

/** Empties every application table between tests. */
export async function resetTestDb(): Promise<void> {
  const res = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  if (!res.rows.length) return;
  const tables = res.rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
}
