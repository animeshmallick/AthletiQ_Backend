/**
 * GET /activity/performance (admins): how fast the app's API has been over a period. Percentiles
 * come from duration buckets, so they are close estimates.
 */
import { and, gte, lt, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { apiPerf } from '../../db/schema/index.js';
import { addDays, diffDays } from '../../lib/dates.js';
import { ok } from '../../lib/http.js';
import { parse, zIsoDate } from '../../lib/validation.js';
import { requireAdmin } from '../../middleware/auth.js';
import { BUCKETS, EDGES, hourOf } from './perf-log.js';

export const perfRouter = Router();

const Query = z
  .object({ from: zIsoDate, to: zIsoDate, since: z.iso.datetime({ offset: true }).optional() })
  .refine((r) => r.to >= r.from && diffDays(r.from, r.to) <= 400, {
    message: 'Choose a range of up to about a year',
  });

/** The duration that `share` of calls beat, from bucket counts (even spread within a bucket). */
export function percentile(counts: number[], share: number, max: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let left = total * share;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i]!;
    if (left <= n && n > 0) {
      const low = i === 0 ? 0 : EDGES[i - 1]!;
      const high = Math.min(EDGES[i] ?? max, Math.max(max, low));
      return Math.round(low + (high - low) * (left / n));
    }
    left -= n;
  }
  return max;
}

const sum = (col: keyof typeof apiPerf.$inferSelect) =>
  sql<number>`coalesce(sum(${apiPerf[col]}), 0)::float8`;
const totals = {
  n: sum('n'),
  errors: sum('errors'),
  totalMs: sum('totalMs'),
  maxMs: sql<number>`coalesce(max(${apiPerf.maxMs}), 0)::int`,
  queries: sum('queries'),
  dbMs: sum('dbMs'),
  cacheable: sum('cacheable'),
  cacheHits: sum('cacheHits'),
  b0: sum('b0'),
  b1: sum('b1'),
  b2: sum('b2'),
  b3: sum('b3'),
  b4: sum('b4'),
  b5: sum('b5'),
  b6: sum('b6'),
  b7: sum('b7'),
};
type Sums = Record<
  | (typeof BUCKETS)[number]
  | 'n'
  | 'errors'
  | 'totalMs'
  | 'maxMs'
  | 'queries'
  | 'dbMs'
  | 'cacheable'
  | 'cacheHits',
  number
>;

function shape(s: Sums) {
  const counts = BUCKETS.map((b) => s[b]);
  const per = (x: number) => (s.n ? x / s.n : 0);
  return {
    n: s.n,
    errors: s.errors,
    avgMs: Math.round(per(s.totalMs)),
    p50Ms: percentile(counts, 0.5, s.maxMs),
    p95Ms: percentile(counts, 0.95, s.maxMs),
    maxMs: s.maxMs,
    /** Database trips per call. */
    queries: Math.round(per(s.queries) * 10) / 10,
    /** Average time of one database trip. */
    queryMs: s.queries ? Math.round(s.dbMs / s.queries) : null,
    /** Calls memory could answer, and the share it did. */
    cacheable: s.cacheable,
    cacheRate: s.cacheable ? Math.round((s.cacheHits * 100) / s.cacheable) : null,
  };
}

const TZ = sql.raw(`'Asia/Kolkata'`);
const startOf = (d: string) => sql`(${d}::date)::timestamp at time zone ${TZ}`;

perfRouter.get('/', requireAdmin, async (req, res) => {
  const r = parse(Query, req.query);
  // Figures are kept by the hour: a shorter window starts at its hour.
  const from = r.since ? hourOf(Date.parse(r.since)) : startOf(r.from);
  const where = and(gte(apiPerf.hour, from), lt(apiPerf.hour, startOf(addDays(r.to, 1))));
  const byDay = diffDays(r.from, r.to) > 2;
  const at = byDay
    ? sql<string>`to_char(${apiPerf.hour} at time zone ${TZ}, 'YYYY-MM-DD')`
    : sql<string>`to_char(${apiPerf.hour} at time zone ${TZ}, 'YYYY-MM-DD HH24:00')`;
  const [[all], routes, series] = await Promise.all([
    db.select(totals).from(apiPerf).where(where),
    db
      .select({ method: apiPerf.method, route: apiPerf.route, ...totals })
      .from(apiPerf)
      .where(where)
      .groupBy(apiPerf.method, apiPerf.route),
    db
      .select({ at, ...totals })
      .from(apiPerf)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);
  const list = routes.map(({ method, route, ...s }) => ({
    method,
    route,
    totalMs: s.totalMs,
    ...shape(s),
  }));
  // One-off calls say little about speed.
  const regular = list.filter((x) => x.n >= 3);
  const top = (by: (x: (typeof list)[number]) => number) =>
    [...(regular.length ? regular : list)].sort((a, b) => by(b) - by(a)).slice(0, 8);
  ok(res, {
    by: byDay ? 'day' : 'hour',
    totals: shape(all!),
    series: series.map(({ at: when, ...s }) => ({ at: when, ...shape(s) })),
    /** Calls by how long they took, with the upper edge of each group (null: slower). */
    spread: BUCKETS.map((b, i) => ({ upTo: EDGES[i] ?? null, n: all![b] })),
    slowest: top((x) => x.p95Ms),
    mostTrips: top((x) => x.queries),
    /** Where the waiting adds up: how often × how long. */
    mostTime: top((x) => x.totalMs),
  });
});
