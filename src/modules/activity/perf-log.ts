/**
 * App speed: for every API call, how long it took, how many database trips it made and whether
 * memory answered it. Added up in memory per hour and route and saved once a minute, so it costs
 * requests nothing; kept 90 days.
 */
import { lt, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { apiPerf } from '../../db/schema/index.js';
import { logger } from '../../lib/logger.js';
import { requestStats, type RequestStats } from '../../lib/request-context.js';
import { routeOf } from './request-log.js';

/** Upper edges (ms) of the duration buckets; the last bucket is everything slower. */
export const EDGES = [50, 100, 200, 400, 800, 1600, 3200] as const;
export const BUCKETS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const;
/** The start of the clock hour in India (which is half past in UTC). */
const IST = 5.5 * 3_600_000;
export const hourOf = (ms: number) =>
  new Date(Math.floor((ms + IST) / 3_600_000) * 3_600_000 - IST);

const FLUSH_MS = 60_000;
const KEEP_DAYS = 90;
const MAX_ROWS = 1000;

type Row = typeof apiPerf.$inferSelect;
let rows = new Map<string, Row>();
let timer: NodeJS.Timeout | null = null;

export function recordPerf(
  method: string,
  route: string,
  status: number,
  ms: number,
  s: RequestStats,
  now: Date = new Date(),
) {
  const hour = hourOf(now.getTime());
  const key = `${hour.toISOString()}|${method}|${route}`;
  let r = rows.get(key);
  if (!r) {
    // Never let odd addresses or a stuck database grow memory.
    if (rows.size >= MAX_ROWS) return;
    r = {
      hour,
      method,
      route,
      n: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      queries: 0,
      dbMs: 0,
      cacheable: 0,
      cacheHits: 0,
      b0: 0,
      b1: 0,
      b2: 0,
      b3: 0,
      b4: 0,
      b5: 0,
      b6: 0,
      b7: 0,
    };
    rows.set(key, r);
  }
  const whole = Math.round(ms);
  r.n++;
  if (status >= 500) r.errors++;
  r.totalMs += whole;
  r.maxMs = Math.max(r.maxMs, whole);
  r.queries += s.queries;
  r.dbMs += Math.round(s.dbMs);
  if (s.cacheable) r.cacheable++;
  if (s.cacheHit) r.cacheHits++;
  const i = EDGES.findIndex((e) => whole <= e);
  r[BUCKETS[i === -1 ? 7 : i]!]++;
}

/** Saves what's collected, adding to what the hour already has. */
export async function flushPerf(): Promise<void> {
  if (!rows.size) return;
  const batch = [...rows.values()];
  rows = new Map();
  const add = (name: string) =>
    sql`${sql.identifier('api_perf')}.${sql.identifier(name)} + excluded.${sql.identifier(name)}`;
  try {
    await db
      .insert(apiPerf)
      .values(batch)
      .onConflictDoUpdate({
        target: [apiPerf.hour, apiPerf.method, apiPerf.route],
        set: {
          n: add('n'),
          errors: add('errors'),
          totalMs: add('total_ms'),
          maxMs: sql`greatest(${sql.identifier('api_perf')}.${sql.identifier('max_ms')}, excluded.max_ms)`,
          queries: add('queries'),
          dbMs: add('db_ms'),
          cacheable: add('cacheable'),
          cacheHits: add('cache_hits'),
          ...Object.fromEntries(BUCKETS.map((b) => [b, add(b)])),
        },
      });
    if (Math.random() < 0.002)
      await db
        .delete(apiPerf)
        .where(lt(apiPerf.hour, sql`now() - make_interval(days => ${KEEP_DAYS})`));
  } catch (err) {
    // Speed figures are a nicety: never worth retrying into a struggling database.
    logger.warn({ err }, 'App speed figures were not saved');
  }
}

export const perfLog: RequestHandler = (req, res, next) => {
  const stats: RequestStats = { queries: 0, dbMs: 0, cacheable: false, cacheHit: false };
  const started = performance.now();
  // A developer's local server may point at the shared database: not counted.
  if (env.NODE_ENV !== 'development')
    res.on('finish', () => {
      const status = res.statusCode;
      // Not calls the app makes: strangers probing addresses, signed-out and preflight calls.
      if (req.method === 'OPTIONS' || status === 404 || status === 401) return;
      recordPerf(req.method, routeOf(req.originalUrl), status, performance.now() - started, stats);
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void flushPerf();
      }, FLUSH_MS);
      timer.unref();
    });
  requestStats.run(stats, next);
};
