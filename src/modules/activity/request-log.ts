/**
 * Request log: who did what through the API, cheaply.
 *
 * Every write (POST/PUT/PATCH/DELETE) and every failed request is noted once its response has
 * been sent, kept in memory, and saved in one batch insert every few seconds (or sooner when the
 * batch fills). The request path does no database work for this, so tracking everything costs
 * a few microseconds per request. Reads (GET) that succeed aren't stored — too many, too little
 * value. Old rows are pruned after 90 days.
 */
import { lt, sql } from 'drizzle-orm';
import type { RequestHandler, Request } from 'express';
import { db } from '../../db/client.js';
import { apiRequests } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const FLUSH_MS = 3_000;
const MAX_BATCH = 200;
/** Never let a stuck database grow memory without bound. */
const MAX_BUFFER = 5_000;
const KEEP_DAYS = 90;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Entry = typeof apiRequests.$inferInsert;
const buffer: Entry[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

/** "/api/v1/invoices/3f…/pdf?x=1" → "/api/v1/invoices/:id/pdf", so one endpoint groups together. */
export function routeOf(url: string): string {
  return (url.split('?')[0] ?? url)
    .replace(UUID, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 200);
}

/** Expected, harmless failures that would only drown the real ones. */
function isNoise(req: Request, status: number, locals: Record<string, unknown>) {
  // An expired access token: the app renews it and retries by itself.
  if (status === 401 && locals.accessTokenExpired) return true;
  // Session keep-alive (and a signed-out browser checking for a session): constant and not
  // a change anyone made. Server errors on it are still recorded.
  return status < 500 && req.originalUrl.startsWith('/api/v1/auth/refresh');
}

/** Saves what's queued (one insert). Safe to call any time; used by tests and on shutdown. */
export function flushRequestLog(): Promise<void> {
  if (flushing) return flushing.then(() => flushRequestLog());
  if (!buffer.length) return Promise.resolve();
  const batch = buffer.splice(0, MAX_BATCH);
  flushing = db
    .insert(apiRequests)
    .values(batch)
    .then(async () => {
      if (Math.random() < 0.01)
        await db
          .delete(apiRequests)
          .where(lt(apiRequests.createdAt, sql`now() - make_interval(days => ${KEEP_DAYS})`));
    })
    // One bad row (e.g. a user deleted meanwhile) mustn't cost the whole batch: retry singly,
    // and without the user if that's what fails.
    .catch(() => saveOneByOne(batch))
    .finally(() => {
      flushing = null;
    });
  return flushing.then(() => (buffer.length >= MAX_BATCH ? flushRequestLog() : undefined));
}

async function saveOneByOne(batch: Entry[]) {
  let dropped = 0;
  for (const row of batch) {
    try {
      await db.insert(apiRequests).values(row);
    } catch {
      try {
        await db.insert(apiRequests).values({ ...row, userId: null });
      } catch {
        dropped++;
      }
    }
  }
  if (dropped) logger.warn({ dropped }, 'Some request log entries were not saved');
}

function schedule() {
  if (buffer.length >= MAX_BATCH) return void flushRequestLog();
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushRequestLog();
  }, FLUSH_MS);
  timer.unref(); // Never keeps the process (or tests) alive.
}

/** Notes writes and failures after the response is sent; never blocks or fails a request. */
export const requestLog: RequestHandler = (req, res, next) => {
  // A developer's local server may point at the shared database: keep its traffic out of the log.
  if (env.NODE_ENV === 'development') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const status = res.statusCode;
      if (READS.has(req.method) && status < 400) return;
      if (req.method === 'OPTIONS' || isNoise(req, status, res.locals)) return;
      if (buffer.length >= MAX_BUFFER) return;
      const error = res.locals.apiError as { code: string; message: string } | undefined;
      buffer.push({
        method: req.method,
        route: routeOf(req.originalUrl),
        status,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        code: error?.code ?? null,
        message: error?.message.slice(0, 500) ?? null,
        userId: req.user?.id ?? null,
        requestId: typeof req.id === 'string' ? req.id : null,
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        createdAt: new Date(),
      });
      schedule();
    } catch (err) {
      logger.warn({ err }, 'Request log entry skipped');
    }
  });
  next();
};
