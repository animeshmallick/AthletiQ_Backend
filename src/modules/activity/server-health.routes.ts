/** GET /activity/server (admins): the server's health now and over a period. */
import { and, gte, lt, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { serverHealth } from '../../db/schema/index.js';
import { buildInfo } from '../../lib/build-info.js';
import { addDays, diffDays } from '../../lib/dates.js';
import { ok } from '../../lib/http.js';
import { parse, zIsoDate } from '../../lib/validation.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  flushHealth,
  healthProblems,
  healthScore,
  readHealth,
  recentReadings,
} from './server-health.js';

export const serverHealthRouter = Router();

const Query = z
  .object({ from: zIsoDate, to: zIsoDate, since: z.iso.datetime({ offset: true }).optional() })
  .refine((r) => r.to >= r.from && diffDays(r.from, r.to) <= 400, {
    message: 'Choose a range of up to about a year',
  });

const TZ = sql.raw(`'Asia/Kolkata'`);
const startOf = (d: string) => sql`(${d}::date)::timestamp at time zone ${TZ}`;
const num = (col: keyof typeof serverHealth.$inferSelect, f: 'avg' | 'max' | 'min') =>
  sql<number>`round(${sql.raw(f)}(${serverHealth[col]})::numeric, 1)::float8`;

/** Readings a minute apart are grouped so a chart has about 60 bars at most. */
function step(from: Date, to: Date) {
  const minutes = Math.max(1, (to.getTime() - from.getTime()) / 60_000);
  return [1, 2, 5, 15, 30, 60, 120, 360, 720, 1440].find((s) => minutes / s <= 62) ?? 1440;
}

serverHealthRouter.get('/', requireAdmin, async (req, res) => {
  const r = parse(Query, req.query);
  const from = r.since ? new Date(r.since) : new Date(`${r.from}T00:00:00+05:30`);
  const end = new Date(Math.min(Date.now(), Date.parse(`${addDays(r.to, 1)}T00:00:00+05:30`)));
  // Readings are kept 30 days.
  const start = new Date(Math.max(from.getTime(), Date.now() - 30 * 864e5));
  const every = step(start, end);
  // Readings still waiting in memory belong in the charts.
  await flushHealth();
  const where = and(gte(serverHealth.at, start), lt(serverHealth.at, startOf(addDays(r.to, 1))));
  const slot = sql<number>`(floor(extract(epoch from ${serverHealth.at}) / ${sql.raw(String(every * 60))}) * ${sql.raw(String(every * 60))})::float8`;
  const [[sum], series, [dayAgo], hours, gaps, now] = await Promise.all([
    db
      .select({
        readings: sql<number>`count(*)::int`,
        cpuAvg: num('cpu', 'avg'),
        cpuMax: num('cpu', 'max'),
        cpuP95: sql<number>`round(percentile_cont(0.95) within group (order by ${serverHealth.cpu})::numeric, 1)::float8`,
        firstAt: sql<string | null>`min(${serverHealth.at})`,
        stealMax: num('steal', 'max'),
        memMax: num('memUsed', 'max'),
        swapMax: num('swapUsed', 'max'),
        appMax: num('appMem', 'max'),
        lagMax: num('lagMs', 'max'),
        dbAvg: num('dbMs', 'avg'),
        dbMax: num('dbMs', 'max'),
        dbDown: sql<number>`count(*) filter (where ${serverHealth.dbMs} is null)::int`,
        waitingMax: num('dbWaiting', 'max'),
      })
      .from(serverHealth)
      .where(where),
    db
      .select({
        slot,
        cpu: num('cpu', 'avg'),
        cpuMax: num('cpu', 'max'),
        steal: num('steal', 'avg'),
        mem: num('memUsed', 'avg'),
        app: num('appMem', 'avg'),
        disk: num('diskUsed', 'avg'),
        dbMs: num('dbMs', 'avg'),
        lag: num('lagMs', 'max'),
      })
      .from(serverHealth)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    // How fast the disk fills: a week ago (or the oldest reading since) against now.
    db
      .select({ at: serverHealth.at, diskFree: serverHealth.diskFree })
      .from(serverHealth)
      .where(gte(serverHealth.at, sql`now() - interval '7 days'`))
      .orderBy(serverHealth.at)
      .limit(1),
    db
      .select({
        hour: sql<number>`extract(hour from ${serverHealth.at} at time zone ${TZ})::int`,
        cpu: num('cpu', 'avg'),
      })
      .from(serverHealth)
      .where(where)
      .groupBy(sql`1`),
    // Minutes without a reading: a deploy, a restart, or the server was down.
    db.execute<{ from: string | Date; to: string | Date }>(sql`
      select * from (
        select at as "to", lag(at) over (order by at) as "from"
        from ${serverHealth} where ${where}
      ) g
      where "to" - "from" > interval '3 minutes'
      order by "to" desc limit 20`),
    readHealth(),
  ]);
  const days = dayAgo ? (Date.now() - dayAgo.at.getTime()) / 864e5 : 0;
  const perDay = dayAgo && days >= 1 ? (dayAgo.diskFree - now.diskFree) / days : 0;
  const outages = gaps.rows.map((g) => {
    const a = new Date(g.from);
    const b = new Date(g.to);
    return {
      from: a.toISOString(),
      to: b.toISOString(),
      minutes: Math.round((b.getTime() - a.getTime()) / 60_000),
    };
  });
  // Readings had, of those due since the first one in the period.
  const firstAt = sum?.firstAt ? new Date(sum.firstAt) : null;
  const due = firstAt ? Math.floor((end.getTime() - firstAt.getTime()) / 60_000) : 0;
  const samples = recentReadings();
  // CPU "now" is the last full minute, not the instant since the previous page load.
  const latest = samples.at(-1);
  const problems = healthProblems([...samples, now]);
  ok(res, {
    score: healthScore({ ...now, cpu: latest?.cpu ?? now.cpu, steal: latest?.steal ?? now.steal }),
    availability:
      due >= 10 ? Math.min(100, Math.round(((sum?.readings ?? 0) * 1000) / due) / 10) : null,
    outages,
    byHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      cpu: hours.find((h) => h.hour === hour)?.cpu ?? null,
    })),
    now: { ...now, cpu: latest?.cpu ?? now.cpu, steal: latest?.steal ?? now.steal },
    problems,
    /** Days until the disk is full at this week's pace; null when it isn't filling. */
    diskDaysLeft: perDay > 5 ? Math.floor(now.diskFree / perDay) : null,
    summary: sum,
    everyMinutes: every,
    series: series.map(({ slot: s, ...x }) => ({ at: new Date(s * 1000).toISOString(), ...x })),
    build: buildInfo(),
  });
});
