/**
 * Activity: the audit trail and the API's failed requests, with insights.
 *  - Everyone can read activity; coaches only ever see their own actions.
 *  - Errors (failed API requests) are for admins.
 * Period endpoints aggregate in the database (fast); /summary reads the whole history on demand.
 */
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { auditLogs, apiRequests, users } from '../../db/schema/index.js';
import { addDays, diffDays, eachDay, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok, pageMeta } from '../../lib/http.js';
import { parse, zId, zIsoDate, zPagination } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { isAdmin } from '../access/access.js';
import type { AuthUser } from '../auth/auth.types.js';

export const activityRouter = Router();

const TZ = 'Asia/Kolkata';
/** Inlined (not a bind parameter) so grouped expressions match their select. */
const TZS = sql.raw(`'${TZ}'`);
/** Actions that deserve a second look: money reversed, access changed, things removed. */
const SENSITIVE =
  '(refund|revert|revers|cancel|disabl|delete|remov|password|roles_changed|split|discount|waive|reject|token_reuse|locked)';

const localDay = (col: typeof auditLogs.createdAt | typeof apiRequests.createdAt) =>
  sql<string>`to_char(${col} at time zone ${TZS}, 'YYYY-MM-DD')`;
const startOf = (d: IsoDate) => sql`(${d}::date)::timestamp at time zone ${TZS}`;

/** Coaches see only what they did. */
function scopeFor(user: AuthUser): SQL | undefined {
  return isAdmin(user) ? undefined : eq(auditLogs.actorId, user.id);
}

/**
 * Optional exact start (an ISO timestamp) for windows shorter than whole days, e.g. "the last
 * 3 hours". `from` / `to` still give the dates the window covers.
 */
const zSince = z.iso.datetime({ offset: true }).optional();
type Window = { from: IsoDate; to: IsoDate; since?: string };

const Range = z
  .object({ from: zIsoDate, to: zIsoDate, since: zSince })
  .refine((r) => r.to >= r.from && diffDays(r.from, r.to) <= 400, {
    message: 'Choose a range of up to about a year',
  });

function inRange(col: typeof auditLogs.createdAt | typeof apiRequests.createdAt, r: Window) {
  return and(
    gte(col, r.since ? new Date(r.since) : startOf(r.from)),
    lt(col, startOf(addDays(r.to, 1))),
  );
}

/** The window of the same length just before this one (for "vs the period before"). */
function previousRange(col: typeof auditLogs.createdAt | typeof apiRequests.createdAt, r: Window) {
  if (r.since) {
    const since = new Date(r.since);
    const length = Math.max(Date.now() - since.getTime(), 0);
    return and(gte(col, new Date(since.getTime() - length)), lt(col, since));
  }
  const days = diffDays(r.from, r.to) + 1;
  return inRange(col, { from: addDays(r.from, -days), to: addDays(r.from, -1) });
}

// ─── Activity list ───────────────────────────────────────────────────────────

const LogQuery = zPagination.extend({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  since: zSince,
  entityType: z.string().max(60).optional(),
  entityId: zId.optional(),
  actorId: zId.optional(),
  /** Free text over the action, area and details. */
  search: z.string().trim().max(80).optional(),
  sensitive: z.enum(['true']).optional(),
});

activityRouter.get('/logs', async (req, res) => {
  const user = currentUser(req);
  const q = parse(LogQuery, req.query);
  const term = q.search ? `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const where = and(
    scopeFor(user),
    q.since
      ? gte(auditLogs.createdAt, new Date(q.since))
      : q.from
        ? gte(auditLogs.createdAt, startOf(q.from))
        : undefined,
    q.to ? lt(auditLogs.createdAt, startOf(addDays(q.to, 1))) : undefined,
    q.entityType ? eq(auditLogs.entityType, q.entityType) : undefined,
    q.entityId ? eq(auditLogs.entityId, q.entityId) : undefined,
    isAdmin(user) && q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
    q.sensitive ? sql`${auditLogs.action} ~* ${SENSITIVE}` : undefined,
    term
      ? or(
          ilike(auditLogs.action, term),
          ilike(auditLogs.entityType, term),
          sql`${auditLogs.metadata}::text ilike ${term}`,
          ilike(users.name, term),
        )
      : undefined,
  );
  const [rows, [{ n } = { n: 0 }]] = await Promise.all([
    db
      .select({ log: auditLogs, actor: { id: users.id, name: users.name, role: users.lastRole } })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db
      .select({ n: count() })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where),
  ]);
  ok(
    res,
    rows.map((r) => ({ ...r.log, actor: r.actor?.id ? r.actor : null })),
    pageMeta(q.page, q.pageSize, n),
  );
});

// ─── Period insights ─────────────────────────────────────────────────────────

/** What happened in a period: volume, when, where, who, and what needs a second look. */
async function periodInsights(user: AuthUser, r: Window) {
  const where = and(scopeFor(user), inRange(auditLogs.createdAt, r));
  const days = diffDays(r.from, r.to) + 1;
  const admin = isAdmin(user);

  const [[totals], [previous], byDay, byHour, byEntity, byAction, byActor, notable, [sens]] =
    await Promise.all([
      db
        .select({
          events: count(),
          people: countDistinct(auditLogs.actorId),
          records: countDistinct(auditLogs.entityId),
        })
        .from(auditLogs)
        .where(where),
      db
        .select({ events: count() })
        .from(auditLogs)
        .where(and(scopeFor(user), previousRange(auditLogs.createdAt, r))),
      db
        .select({ date: localDay(auditLogs.createdAt), n: count() })
        .from(auditLogs)
        .where(where)
        .groupBy(localDay(auditLogs.createdAt)),
      db
        .select({
          hour: sql<number>`extract(hour from ${auditLogs.createdAt} at time zone ${TZS})::int`,
          n: count(),
        })
        .from(auditLogs)
        .where(where)
        .groupBy(sql`1`),
      db
        .select({ entityType: auditLogs.entityType, n: count() })
        .from(auditLogs)
        .where(where)
        .groupBy(auditLogs.entityType)
        .orderBy(desc(count())),
      db
        .select({ action: auditLogs.action, n: count() })
        .from(auditLogs)
        .where(where)
        .groupBy(auditLogs.action)
        .orderBy(desc(count()))
        .limit(12),
      admin
        ? db
            .select({ id: users.id, name: users.name, role: users.lastRole, n: count() })
            .from(auditLogs)
            .innerJoin(users, eq(users.id, auditLogs.actorId))
            .where(where)
            .groupBy(users.id, users.name, users.lastRole)
            .orderBy(desc(count()))
            .limit(10)
        : [],
      db
        .select({ log: auditLogs, actor: { id: users.id, name: users.name } })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorId))
        .where(and(where, sql`${auditLogs.action} ~* ${SENSITIVE}`))
        .orderBy(desc(auditLogs.createdAt))
        .limit(8),
      db
        .select({ n: count() })
        .from(auditLogs)
        .where(and(where, sql`${auditLogs.action} ~* ${SENSITIVE}`)),
    ]);

  const perDay = new Map(byDay.map((d) => [d.date, d.n]));
  const series = eachDay(r.from, r.to).map((date) => ({ date, n: perDay.get(date) ?? 0 }));
  const busiest = series.reduce((m, d) => (d.n > m.n ? d : m), { date: r.from, n: 0 });
  const hours = Array.from({ length: 24 }, (_, h) => byHour.find((x) => x.hour === h)?.n ?? 0);
  const events = totals?.events ?? 0;
  return {
    from: r.from,
    to: r.to,
    since: r.since ?? null,
    totals: {
      events,
      people: totals?.people ?? 0,
      records: totals?.records ?? 0,
      sensitive: sens?.n ?? 0,
      activeDays: series.filter((d) => d.n > 0).length,
      perDay: Math.round((events / days) * 10) / 10,
      previous: previous?.events ?? 0,
      /** Change vs the previous period of the same length (null when there was nothing). */
      change: previous?.events
        ? Math.round(((events - previous.events) / previous.events) * 100)
        : null,
    },
    busiestDay: busiest.n ? busiest : null,
    busiestHour: hours.some((h) => h) ? hours.indexOf(Math.max(...hours)) : null,
    byDay: series,
    byHour: hours,
    byEntity,
    byAction,
    byActor,
    notable: notable.map((n) => ({ ...n.log, actor: n.actor?.id ? n.actor : null })),
  };
}

activityRouter.get('/insights', async (req, res) => {
  ok(res, await periodInsights(currentUser(req), parse(Range, req.query)));
});

// ─── Whole-history summary (on demand) ───────────────────────────────────────

const SUMMARY_TTL = 5 * 60_000;
const summaryCache = new Map<string, { at: number; data: unknown }>();

/**
 * Reads the entire log (scoped to the caller) and summarises it. Slower than the period views,
 * so it runs only when asked; the result is cached for a few minutes.
 */
activityRouter.post('/summary', async (req, res) => {
  const user = currentUser(req);
  const admin = isAdmin(user);
  const key = admin ? 'academy' : user.id;
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < SUMMARY_TTL) return ok(res, cached.data);

  const scope = scopeFor(user);
  const month = sql<string>`to_char(${auditLogs.createdAt} at time zone ${TZS}, 'YYYY-MM')`;
  const [[span], byMonth, byDay, byHour, topActions, topActors, byEntity, sensitive, errors] =
    await Promise.all([
      db
        .select({
          total: count(),
          first: sql<string | null>`min(${auditLogs.createdAt})`,
          last: sql<string | null>`max(${auditLogs.createdAt})`,
          people: countDistinct(auditLogs.actorId),
          records: countDistinct(auditLogs.entityId),
        })
        .from(auditLogs)
        .where(scope),
      db.select({ month, n: count() }).from(auditLogs).where(scope).groupBy(month).orderBy(month),
      db
        .select({ date: localDay(auditLogs.createdAt), n: count() })
        .from(auditLogs)
        .where(scope)
        .groupBy(localDay(auditLogs.createdAt)),
      db
        .select({
          hour: sql<number>`extract(hour from ${auditLogs.createdAt} at time zone ${TZS})::int`,
          n: count(),
        })
        .from(auditLogs)
        .where(scope)
        .groupBy(sql`1`),
      db
        .select({ action: auditLogs.action, n: count() })
        .from(auditLogs)
        .where(scope)
        .groupBy(auditLogs.action)
        .orderBy(desc(count()))
        .limit(10),
      admin
        ? db
            .select({ id: users.id, name: users.name, role: users.lastRole, n: count() })
            .from(auditLogs)
            .innerJoin(users, eq(users.id, auditLogs.actorId))
            .groupBy(users.id, users.name, users.lastRole)
            .orderBy(desc(count()))
            .limit(10)
        : [],
      db
        .select({ entityType: auditLogs.entityType, n: count() })
        .from(auditLogs)
        .where(scope)
        .groupBy(auditLogs.entityType)
        .orderBy(desc(count())),
      db
        .select({ action: auditLogs.action, n: count() })
        .from(auditLogs)
        .where(and(scope, sql`${auditLogs.action} ~* ${SENSITIVE}`))
        .groupBy(auditLogs.action)
        .orderBy(desc(count())),
      admin
        ? db
            .select({
              total: count(),
              server: sql<number>`count(*) filter (where ${apiRequests.status} >= 500)::int`,
              routes: countDistinct(apiRequests.route),
            })
            .from(apiRequests)
            .where(gte(apiRequests.status, 400))
        : [],
    ]);

  const total = span?.total ?? 0;
  const busiestDay = byDay.reduce<{ date: string; n: number } | null>(
    (m, d) => (!m || d.n > m.n ? d : m),
    null,
  );
  const hours = Array.from({ length: 24 }, (_, h) => byHour.find((x) => x.hour === h)?.n ?? 0);
  const busiestHour = total ? hours.indexOf(Math.max(...hours)) : null;
  const sensitiveTotal = sensitive.reduce((n, s) => n + s.n, 0);
  const err = (errors as { total: number; server: number; routes: number }[])[0];
  const firstDay = span?.first
    ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(span.first))
    : null;
  const spanDays = firstDay ? diffDays(firstDay, todayInAppTz()) + 1 : 0;

  // Plain-language highlights, most useful first.
  const highlights: string[] = [];
  if (total) {
    highlights.push(
      `${total.toLocaleString('en-IN')} actions${admin ? ` by ${span?.people ?? 0} people` : ''} on ${byDay.length} active days since ${firstDay}.`,
    );
    highlights.push(
      `About ${Math.round((total / Math.max(byDay.length, 1)) * 10) / 10} actions on an active day; ${Math.round((byDay.length / Math.max(spanDays, 1)) * 100)}% of days had activity.`,
    );
    if (busiestDay)
      highlights.push(`Busiest day: ${busiestDay.date} with ${busiestDay.n} actions.`);
    if (busiestHour !== null)
      highlights.push(`Most activity happens around ${busiestHour}:00–${busiestHour + 1}:00.`);
    if (topActions[0])
      highlights.push(`Most common action: ${topActions[0].action} (${topActions[0].n}).`);
    if (admin && topActors[0])
      highlights.push(`Most active: ${topActors[0].name} (${topActors[0].n} actions).`);
    highlights.push(
      sensitiveTotal
        ? `${sensitiveTotal} sensitive actions (refunds, reversals, cancellations, access changes) — worth reviewing.`
        : 'No sensitive actions recorded.',
    );
    if (admin && err)
      highlights.push(
        err.total
          ? `${err.total} failed API requests on record (${err.server} server errors) across ${err.routes} endpoints.`
          : 'No failed API requests on record.',
      );
  }

  const data = {
    generatedAt: new Date().toISOString(),
    scope: admin ? 'academy' : 'self',
    totals: {
      events: total,
      people: span?.people ?? 0,
      records: span?.records ?? 0,
      activeDays: byDay.length,
      spanDays,
      sensitive: sensitiveTotal,
      first: span?.first ?? null,
      last: span?.last ?? null,
    },
    busiestDay,
    busiestHour,
    byMonth,
    byHour: hours,
    topActions,
    topActors,
    byEntity,
    sensitive,
    errors: admin ? (err ?? { total: 0, server: 0, routes: 0 }) : null,
    highlights,
  };
  summaryCache.set(key, { at: Date.now(), data });
  ok(res, data);
});

// ─── Failed requests (admin) ─────────────────────────────────────────────────

const ErrorQuery = zPagination.extend({
  from: zIsoDate,
  to: zIsoDate,
  since: zSince,
  kind: z.enum(['client', 'server']).optional(),
  route: z.string().max(200).optional(),
});

function errorWhere(q: z.output<typeof ErrorQuery> | (Window & { kind?: string; route?: string })) {
  return and(
    inRange(apiRequests.createdAt, q),
    gte(apiRequests.status, 400),
    q.kind === 'server' ? gte(apiRequests.status, 500) : undefined,
    q.kind === 'client' ? lt(apiRequests.status, 500) : undefined,
    q.route ? eq(apiRequests.route, q.route) : undefined,
  );
}

activityRouter.get('/errors', requireAdmin, async (req, res) => {
  const q = parse(ErrorQuery, req.query);
  if (q.to < q.from) throw AppError.badRequest('"to" must be on or after "from"');
  const where = errorWhere(q);
  const [rows, [{ n } = { n: 0 }]] = await Promise.all([
    db
      .select({ e: apiRequests, user: { id: users.id, name: users.name } })
      .from(apiRequests)
      .leftJoin(users, eq(users.id, apiRequests.userId))
      .where(where)
      .orderBy(desc(apiRequests.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(apiRequests).where(where),
  ]);
  ok(
    res,
    rows.map((r) => ({ ...r.e, user: r.user?.id ? r.user : null })),
    pageMeta(q.page, q.pageSize, n),
  );
});

activityRouter.get('/errors/insights', requireAdmin, async (req, res) => {
  const r = parse(Range, req.query);
  const where = errorWhere(r);
  const hourOf = sql<number>`extract(hour from ${apiRequests.createdAt} at time zone ${TZS})::int`;
  const [[totals], byDay, byHourRows, byStatus, byCode, byRoute] = await Promise.all([
    db
      .select({
        total: count(),
        server: sql<number>`count(*) filter (where ${apiRequests.status} >= 500)::int`,
        client: sql<number>`count(*) filter (where ${apiRequests.status} < 500)::int`,
        routes: countDistinct(apiRequests.route),
        users: countDistinct(apiRequests.userId),
      })
      .from(apiRequests)
      .where(where),
    db
      .select({
        date: localDay(apiRequests.createdAt),
        n: count(),
        server: sql<number>`count(*) filter (where ${apiRequests.status} >= 500)::int`,
      })
      .from(apiRequests)
      .where(where)
      .groupBy(localDay(apiRequests.createdAt)),
    // Hour of day (IST): the chart for a single day.
    db
      .select({
        hour: hourOf,
        n: count(),
        server: sql<number>`count(*) filter (where ${apiRequests.status} >= 500)::int`,
      })
      .from(apiRequests)
      .where(where)
      .groupBy(hourOf),
    db
      .select({ status: apiRequests.status, n: count() })
      .from(apiRequests)
      .where(where)
      .groupBy(apiRequests.status)
      .orderBy(desc(count())),
    db
      .select({ code: apiRequests.code, n: count() })
      .from(apiRequests)
      .where(where)
      .groupBy(apiRequests.code)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({
        method: apiRequests.method,
        route: apiRequests.route,
        n: count(),
        server: sql<number>`count(*) filter (where ${apiRequests.status} >= 500)::int`,
        last: sql<string>`max(${apiRequests.createdAt})`,
        sample: sql<string>`(array_agg(${apiRequests.message} order by ${apiRequests.createdAt} desc))[1]`,
      })
      .from(apiRequests)
      .where(and(where, isNotNull(apiRequests.route)))
      .groupBy(apiRequests.method, apiRequests.route)
      .orderBy(desc(count()))
      .limit(10),
  ]);
  const perDay = new Map(byDay.map((d) => [d.date, d]));
  ok(res, {
    from: r.from,
    to: r.to,
    since: r.since ?? null,
    totals: totals ?? { total: 0, server: 0, client: 0, routes: 0, users: 0 },
    byDay: eachDay(r.from, r.to).map((date) => ({
      date,
      n: perDay.get(date)?.n ?? 0,
      server: perDay.get(date)?.server ?? 0,
    })),
    byHour: Array.from({ length: 24 }, (_, hour) => {
      const h = byHourRows.find((x) => x.hour === hour);
      return { hour, n: h?.n ?? 0, server: h?.server ?? 0 };
    }),
    byStatus,
    byCode,
    byRoute,
  });
});

// ─── Every write and failure (request log) ───────────────────────────────────

/** Coaches see only their own requests. */
const requestScope = (user: AuthUser) =>
  isAdmin(user) ? undefined : eq(apiRequests.userId, user.id);

/**
 * All tracked requests in a period: how many, how they ended, how fast, which endpoints and
 * (admins) who. Complements the audit trail, which records only meaningful business events.
 */
activityRouter.get('/requests/insights', async (req, res) => {
  const user = currentUser(req);
  const r = parse(Range, req.query);
  const where = and(requestScope(user), inRange(apiRequests.createdAt, r));
  const [[totals], byRoute, byPerson] = await Promise.all([
    db
      .select({
        total: count(),
        writes: sql<number>`count(*) filter (where ${apiRequests.method} <> 'GET')::int`,
        failed: sql<number>`count(*) filter (where ${apiRequests.status} >= 400)::int`,
        avgMs: sql<number>`coalesce(round(avg(${apiRequests.durationMs})), 0)::int`,
        p95Ms: sql<number>`coalesce(round(percentile_cont(0.95) within group (order by ${apiRequests.durationMs})), 0)::int`,
        people: countDistinct(apiRequests.userId),
      })
      .from(apiRequests)
      .where(where),
    db
      .select({
        method: apiRequests.method,
        route: apiRequests.route,
        n: count(),
        failed: sql<number>`count(*) filter (where ${apiRequests.status} >= 400)::int`,
        avgMs: sql<number>`round(avg(${apiRequests.durationMs}))::int`,
        maxMs: sql<number>`max(${apiRequests.durationMs})`,
      })
      .from(apiRequests)
      .where(where)
      .groupBy(apiRequests.method, apiRequests.route)
      .orderBy(desc(count()))
      .limit(12),
    isAdmin(user)
      ? db
          .select({
            id: users.id,
            name: users.name,
            role: users.lastRole,
            n: count(),
            failed: sql<number>`count(*) filter (where ${apiRequests.status} >= 400)::int`,
          })
          .from(apiRequests)
          .innerJoin(users, eq(users.id, apiRequests.userId))
          .where(where)
          .groupBy(users.id, users.name, users.lastRole)
          .orderBy(desc(count()))
          .limit(10)
      : [],
  ]);
  ok(res, {
    from: r.from,
    to: r.to,
    since: r.since ?? null,
    totals: totals ?? { total: 0, writes: 0, failed: 0, avgMs: 0, p95Ms: 0, people: 0 },
    byRoute,
    slowest: [...byRoute].sort((a, b) => b.avgMs - a.avgMs).slice(0, 5),
    byPerson,
  });
});

const RequestQuery = zPagination.extend({
  from: zIsoDate,
  to: zIsoDate,
  since: zSince,
  userId: zId.optional(),
});

/** The raw stream of tracked requests (newest first). */
activityRouter.get('/requests', async (req, res) => {
  const user = currentUser(req);
  const q = parse(RequestQuery, req.query);
  const where = and(
    requestScope(user),
    inRange(apiRequests.createdAt, q),
    isAdmin(user) && q.userId ? eq(apiRequests.userId, q.userId) : undefined,
  );
  const [rows, [{ n } = { n: 0 }]] = await Promise.all([
    db
      .select({ r: apiRequests, user: { id: users.id, name: users.name } })
      .from(apiRequests)
      .leftJoin(users, eq(users.id, apiRequests.userId))
      .where(where)
      .orderBy(desc(apiRequests.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(apiRequests).where(where),
  ]);
  ok(
    res,
    rows.map((x) => ({ ...x.r, user: x.user?.id ? x.user : null })),
    pageMeta(q.page, q.pageSize, n),
  );
});

/** For tests: forget cached summaries. */
export function clearSummaryCache() {
  summaryCache.clear();
}
