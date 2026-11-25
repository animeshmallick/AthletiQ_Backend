/** Serving lists that rarely change from memory, and emptying that memory on any change. */
import type { RequestHandler } from 'express';
import { cacheGeneration, cacheGet, cacheSet, clearCache } from '../lib/memory-cache.js';
import { requestStats } from '../lib/request-context.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Frequent writes that change nothing cached (when they succeed). */
const NEUTRAL =
  /^\/api\/v1\/(attendance\/session|coach-sessions\/check-in|client-events|me\/(notifications|devices)|auth\/(login|refresh))(\/|\?|$)/;

/** Any change empties the cache just before it is answered, so the next read is fresh. */
export const clearOnWrite: RequestHandler = (req, res, next) => {
  if (READS.has(req.method)) return next();
  const end = res.end.bind(res) as (...args: unknown[]) => typeof res;
  res.end = ((...args: unknown[]) => {
    // Failures too: a refused sign-in can end someone's sessions.
    if (res.statusCode >= 400 || !NEUTRAL.test(req.originalUrl)) clearCache();
    return end(...args);
  }) as typeof res.end;
  next();
};

const LIST_TTL = 60_000;

/** A list that rarely changes: kept per person and address. Only after sign-in checks. */
export const cachedList: RequestHandler = (req, res, next) => {
  const user = req.user;
  if (!user) return next();
  const key = `list:${user.role}:${user.id}:${req.originalUrl}`;
  const stats = requestStats.getStore();
  if (stats) stats.cacheable = true;
  const hit = cacheGet<unknown>(key);
  if (hit !== undefined) {
    if (stats) stats.cacheHit = true;
    res.json(hit);
    return;
  }
  const readAt = cacheGeneration();
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200) cacheSet(key, body, LIST_TTL, readAt);
    return json(body);
  };
  next();
};
