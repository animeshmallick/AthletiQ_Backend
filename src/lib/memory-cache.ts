/**
 * A small cache in this process's memory. Never used for money owed or paid, or attendance.
 *
 * Any change made through the API empties it before that change is answered (see
 * `clearOnWrite`), so people always see their own and others' edits; the short lifetimes only
 * bound changes made elsewhere (nightly jobs, another server on the same database).
 */
import { isTest } from '../config/env.js';

interface Entry {
  value: unknown;
  until: number;
}

const MAX_ENTRIES = 500;
const entries = new Map<string, Entry>();
/** Goes up at every clear: a value read before a change is never stored after it. */
let generation = 0;
// Tests change the database directly; the cache's own tests turn it on.
let enabled = !isTest;

export function setCacheEnabled(on: boolean) {
  enabled = on;
  clearCache();
}

export function clearCache() {
  generation++;
  entries.clear();
}

export function cacheGet<T>(key: string): T | undefined {
  if (!enabled) return undefined;
  const e = entries.get(key);
  if (!e) return undefined;
  if (e.until <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return e.value as T;
}

export const cacheGeneration = () => generation;

/** Stores a value that was read while `readAt` was the generation; dropped if it changed since. */
export function cacheSet(key: string, value: unknown, ttlMs: number, readAt: number) {
  if (!enabled || readAt !== generation) return;
  // Oldest out first.
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  entries.set(key, { value, until: Date.now() + ttlMs });
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const readAt = generation;
  const value = await load();
  if (value !== undefined) cacheSet(key, value, ttlMs, readAt);
  return value;
}
