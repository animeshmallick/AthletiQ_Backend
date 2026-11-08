import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobRuns } from '../db/schema/index.js';
import { todayInAppTz } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { tryAdvisoryLock } from './advisory-lock.js';

/** Stable 32-bit keys for pg advisory locks, one per job. */
export const LOCK_KEYS = {
  'invoice-generation': 728_100_001,
} as const;

export type JobName = keyof typeof LOCK_KEYS;
export type JobTrigger = 'schedule' | 'startup' | 'manual' | 'cli';

export interface JobResult {
  ran: boolean;
  runId?: string;
  stats?: Record<string, unknown>;
  reason?: string;
}

/**
 * Runs a job so that only one instance executes it at a time, even with several API servers,
 * and records every execution in `job_runs`.
 */
export async function runExclusive(
  name: JobName,
  trigger: JobTrigger,
  fn: () => Promise<Record<string, unknown>>,
): Promise<JobResult> {
  const lock = await tryAdvisoryLock(LOCK_KEYS[name]);
  if (!lock) {
    logger.info({ job: name, trigger }, 'Job already running elsewhere; skipping');
    return { ran: false, reason: 'Job is already running' };
  }

  try {
    const [run] = await db
      .insert(jobRuns)
      .values({ jobName: name, runDate: todayInAppTz(), trigger, status: 'running' })
      .returning({ id: jobRuns.id });
    const runId = run!.id;
    const started = Date.now();
    logger.info({ job: name, trigger, runId }, 'Job started');

    try {
      const stats = await fn();
      await db
        .update(jobRuns)
        .set({ status: 'succeeded', stats, finishedAt: new Date() })
        .where(eq(jobRuns.id, runId));
      logger.info({ job: name, runId, ms: Date.now() - started, stats }, 'Job finished');
      return { ran: true, runId, stats };
    } catch (err) {
      await db
        .update(jobRuns)
        .set({
          status: 'failed',
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          finishedAt: new Date(),
        })
        .where(eq(jobRuns.id, runId));
      logger.error({ err, job: name, runId }, 'Job failed');
      throw err;
    }
  } finally {
    await lock.release();
  }
}
