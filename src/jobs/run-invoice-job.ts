/**
 * CLI entry point: `npm run jobs:invoices`. Useful for ops (e.g. an external cron or one-off
 * catch-up). Safe to run while the API is running thanks to the advisory lock.
 */
import { closeDatabase } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { runInvoiceJob } from './invoice-job.js';

try {
  const result = await runInvoiceJob('cli');
  logger.info(result, 'Invoice job complete');
} catch (err) {
  logger.error({ err }, 'Invoice job failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
