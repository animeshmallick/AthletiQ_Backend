/**
 * What one API request spent on the database and whether it was served from memory, collected
 * while it runs (for the app-speed insights).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStats {
  queries: number;
  dbMs: number;
  cacheable: boolean;
  cacheHit: boolean;
}

export const requestStats = new AsyncLocalStorage<RequestStats>();

/** Times a database call for the request it belongs to. */
export function trackQuery<T>(run: () => Promise<T>): Promise<T> {
  const s = requestStats.getStore();
  if (!s) return run();
  s.queries++;
  const started = performance.now();
  return run().finally(() => {
    s.dbMs += performance.now() - started;
  });
}
