import cron, { type ScheduledTask } from 'node-cron';
import { APP_TIMEZONE } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runInvoiceJob } from './invoice-job.js';

const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
  if (!env.SCHEDULER_ENABLED) {
    logger.info('Scheduler disabled (SCHEDULER_ENABLED=false)');
    return;
  }
  if (!cron.validate(env.INVOICE_CRON)) {
    throw new Error(`Invalid INVOICE_CRON expression: ${env.INVOICE_CRON}`);
  }

  tasks.push(
    cron.schedule(
      env.INVOICE_CRON,
      () => {
        runInvoiceJob('schedule').catch((err: unknown) =>
          logger.error({ err }, 'Scheduled invoice job failed'),
        );
      },
      { timezone: APP_TIMEZONE, name: 'invoice-generation', noOverlap: true },
    ),
  );

  // Catch up shortly after boot in case the server was down at midnight. Idempotent.
  setTimeout(() => {
    runInvoiceJob('startup').catch((err: unknown) =>
      logger.error({ err }, 'Startup invoice job failed'),
    );
  }, 15_000).unref();

  logger.info({ cron: env.INVOICE_CRON, timezone: APP_TIMEZONE }, 'Scheduler started');
}

export function stopScheduler(): void {
  for (const t of tasks) void t.stop();
  tasks.length = 0;
}
