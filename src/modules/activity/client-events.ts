/**
 * Client-side logs: what went wrong on people's devices.
 *
 *  POST /client-events            the app reports a batch (signed in or not); always 202
 *  GET  /client-events/insights   grouped problems, totals and recent events for a period
 *                                 (admins: everyone; coaches: their own devices)
 *
 * Reports are best-effort: bad or oversized fields are trimmed rather than rejected, so a broken
 * device can't lose the report it is trying to send. Kept 30 days.
 */
import { createHash } from 'node:crypto';
import { and, countDistinct, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { APP_TIMEZONE } from '../../config/constants.js';
import { db } from '../../db/client.js';
import { clientEvents, users } from '../../db/schema/index.js';
import { addDays, diffDays } from '../../lib/dates.js';
import { ok } from '../../lib/http.js';
import { parse, zIsoDate } from '../../lib/validation.js';
import { currentUser, optionalAuth, requireAuth } from '../../middleware/auth.js';
import { rateLimitHandler } from '../../middleware/rate-limit.js';

export const clientEventsRouter = Router();

/**
 * crash: a screen failed to render · error: an uncaught script error · update: an old version
 * missing code after a deploy · freeze / stuck: an unresponsive app or a screen that never loads ·
 * api: a call to our API failed on the device · network: any other request failed · console: an
 * error the app logged · reload: the app reloaded itself or sent the person home (with why) ·
 * slow: an API call took over 8s · offline: the device lost its connection (and for how long) ·
 * shown: an error message the app showed · device: location, camera or notification trouble.
 */
export const CLIENT_EVENT_KINDS = [
  'crash',
  'error',
  'update',
  'freeze',
  'stuck',
  'api',
  'network',
  'console',
  'reload',
  'slow',
  'offline',
  'shown',
  'device',
] as const;
const KEEP_DAYS = 30;

const trim = (max: number) =>
  z
    .string()
    .transform((s) => s.slice(0, max))
    .nullish();

const Event = z.object({
  kind: z.enum(CLIENT_EVENT_KINDS),
  message: z.string().transform((s) => s.slice(0, 500) || 'Unknown error'),
  stack: trim(4000),
  screen: trim(200),
  appVersion: trim(40),
  platform: z.enum(['web', 'pwa', 'android', 'ios']).catch('web'),
  online: z.boolean().nullish(),
  count: z.number().int().min(1).max(10_000).catch(1),
  at: z.string().datetime({ offset: true }).nullish(),
  details: z
    .record(z.string(), z.unknown())
    .nullish()
    // Small facts only (API route, status, timings); drop anything bulky.
    .transform((d) => (d && JSON.stringify(d).length <= 2000 ? d : null)),
});
const Batch = z.object({ events: z.array(Event).min(1).max(25) });

/**
 * The same problem groups together however its details vary: numbers and ids are blanked out,
 * and the first app frame of the stack (file and function, no line numbers) says where.
 */
export function fingerprintOf(e: {
  kind: string;
  message: string;
  stack?: string | null;
  details?: Record<string, unknown> | null;
}) {
  const message = e.message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\d+/g, '#')
    .slice(0, 200);
  const frame =
    (e.stack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /\/assets\/|\/src\//.test(l))
      ?.replace(/[-.][\w]{8}\.js/, '.js')
      .replace(/:\d+:\d+\)?$/, '') ?? '';
  const where =
    e.kind === 'api' || e.kind === 'network'
      ? `${str(e.details?.method)} ${str(e.details?.route)}`
      : frame;
  return createHash('sha1').update(`${e.kind}|${message}|${where}`).digest('hex').slice(0, 16);
}

function str(v: unknown) {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

// Generous per device, but a runaway loop can't flood the table.
const reportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: rateLimitHandler,
});

clientEventsRouter.post('/', reportLimiter, optionalAuth, async (req, res) => {
  const { events } = parse(Batch, req.body);
  const now = Date.now();
  const userAgent = req.get('user-agent')?.slice(0, 300) ?? null;
  await db.insert(clientEvents).values(
    events.map((e) => {
      const at = e.at ? Date.parse(e.at) : now;
      return {
        kind: e.kind,
        fingerprint: fingerprintOf(e),
        message: e.message,
        stack: e.stack ?? null,
        screen: e.screen ?? null,
        appVersion: e.appVersion ?? null,
        platform: e.platform,
        userAgent,
        online: e.online ?? null,
        count: e.count,
        details: e.details ?? null,
        userId: req.user?.id ?? null,
        role: req.user?.role ?? null,
        // A device clock far off is not trusted.
        occurredAt: new Date(Math.abs(at - now) > 2 * 864e5 ? now : at),
      };
    }),
  );
  // Now and then, drop what's past keeping.
  if (Math.random() < 0.02)
    await db
      .delete(clientEvents)
      .where(lt(clientEvents.createdAt, sql`now() - make_interval(days => ${KEEP_DAYS})`));
  res.status(202).json({ data: { received: events.length } });
});

const Range = z
  .object({
    from: zIsoDate,
    to: zIsoDate,
    kind: z.enum(CLIENT_EVENT_KINDS).optional(),
    platform: z.enum(['web', 'pwa', 'android', 'ios']).optional(),
  })
  .refine((r) => r.to >= r.from && diffDays(r.from, r.to) <= 31, {
    message: 'Choose a range of up to a month (logs are kept 30 days)',
  });

// Inlined (a constant), so GROUP BY sees the same expression as the select.
const TZ = sql.raw(`'${APP_TIMEZONE}'`);
const startOf = (d: string) => sql`(${d}::date)::timestamp at time zone ${TZ}`;

clientEventsRouter.get('/insights', requireAuth, async (req, res) => {
  const r = parse(Range, req.query);
  const user = currentUser(req);
  const c = clientEvents;
  const where = and(
    gte(c.occurredAt, startOf(r.from)),
    lt(c.occurredAt, startOf(addDays(r.to, 1))),
    // Coaches see what happened on their own devices.
    user.role === 'admin' ? undefined : eq(c.userId, user.id),
    r.kind ? eq(c.kind, r.kind) : undefined,
    r.platform ? eq(c.platform, r.platform) : undefined,
  );
  const n = sql<number>`coalesce(sum(${c.count}), 0)::int`;
  const day = sql<string>`to_char(${c.occurredAt} at time zone ${TZ}, 'YYYY-MM-DD')`;
  const [[totals], byKind, byPlatform, byDay, groups, recent] = await Promise.all([
    db
      .select({
        events: n,
        groups: countDistinct(c.fingerprint),
        users: countDistinct(c.userId),
        crashes: sql<number>`coalesce(sum(${c.count}) filter (where ${c.kind} in ('crash', 'update')), 0)::int`,
        freezes: sql<number>`coalesce(sum(${c.count}) filter (where ${c.kind} in ('freeze', 'stuck')), 0)::int`,
        api: sql<number>`coalesce(sum(${c.count}) filter (where ${c.kind} in ('api', 'network')), 0)::int`,
        console: sql<number>`coalesce(sum(${c.count}) filter (where ${c.kind} = 'console'), 0)::int`,
        reloads: sql<number>`coalesce(sum(${c.count}) filter (where ${c.kind} = 'reload'), 0)::int`,
        offline: sql<number>`coalesce(sum(${c.count}) filter (where ${c.online} = false), 0)::int`,
      })
      .from(c)
      .where(where),
    db.select({ kind: c.kind, n }).from(c).where(where).groupBy(c.kind).orderBy(desc(n)),
    db
      .select({ platform: c.platform, n })
      .from(c)
      .where(where)
      .groupBy(c.platform)
      .orderBy(desc(n)),
    db.select({ date: day, n }).from(c).where(where).groupBy(day).orderBy(day),
    // The same problem, grouped: how often, for how many people, where and since when.
    db
      .select({
        fingerprint: c.fingerprint,
        kind: sql<string>`min(${c.kind})`,
        message: sql<string>`(array_agg(${c.message} order by ${c.occurredAt} desc))[1]`,
        stack: sql<
          string | null
        >`(array_agg(${c.stack} order by ${c.occurredAt} desc) filter (where ${c.stack} is not null))[1]`,
        details: sql<Record<
          string,
          unknown
        > | null>`(array_agg(${c.details} order by ${c.occurredAt} desc))[1]`,
        n,
        users: countDistinct(c.userId),
        firstSeen: sql<string>`min(${c.occurredAt})`,
        lastSeen: sql<string>`max(${c.occurredAt})`,
        screens: sql<
          string[]
        >`(array_agg(distinct ${c.screen}) filter (where ${c.screen} is not null))[1:5]`,
        versions: sql<
          string[]
        >`(array_agg(distinct ${c.appVersion}) filter (where ${c.appVersion} is not null))[1:5]`,
        platforms: sql<string[]>`array_agg(distinct ${c.platform})`,
      })
      .from(c)
      .where(where)
      .groupBy(c.fingerprint)
      .orderBy(desc(n), desc(sql`max(${c.occurredAt})`))
      .limit(50),
    db
      .select({
        id: c.id,
        at: c.occurredAt,
        kind: c.kind,
        message: c.message,
        screen: c.screen,
        platform: c.platform,
        appVersion: c.appVersion,
        online: c.online,
        count: c.count,
        details: c.details,
        fingerprint: c.fingerprint,
        user: { id: users.id, name: users.name },
        role: c.role,
      })
      .from(c)
      .leftJoin(users, eq(users.id, c.userId))
      .where(where)
      .orderBy(desc(c.occurredAt))
      .limit(30),
  ]);
  ok(res, {
    scope: user.role === 'admin' ? 'academy' : 'self',
    totals: totals ?? {
      events: 0,
      groups: 0,
      users: 0,
      crashes: 0,
      freezes: 0,
      api: 0,
      console: 0,
      reloads: 0,
      offline: 0,
    },
    byKind,
    byPlatform,
    byDay,
    groups,
    recent: recent.map((x) => ({ ...x, user: x.user?.id ? x.user : null })),
  });
});
