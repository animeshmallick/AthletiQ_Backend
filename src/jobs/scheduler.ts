import cron, { type ScheduledTask } from 'node-cron';
import { APP_TIMEZONE } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runInvoiceJob } from './invoice-job.js';
import {
  runSafely,
  runSessionAlerts,
  sendAdminDigest,
  sendFeedbackReminders,
  sendOverdueNotices,
  sendWeeklyFeesSummary,
} from './alerts.js';
import { sendSessionReminders } from './session-reminders.js';
import { sendMoneyReminders } from '../modules/funds/notices.js';

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

  if (cron.validate(env.REMINDER_CRON)) {
    tasks.push(
      cron.schedule(
        env.REMINDER_CRON,
        () => {
          sendSessionReminders().catch((err: unknown) =>
            logger.error({ err }, 'Session reminders failed'),
          );
        },
        { timezone: APP_TIMEZONE, name: 'session-reminders', noOverlap: true },
      ),
    );
  } else {
    logger.warn({ cron: env.REMINDER_CRON }, 'Invalid REMINDER_CRON; session reminders disabled');
  }

  // Live session alerts (reminders, missed check-ins, wrap-ups); de-duplicated per session.
  tasks.push(
    cron.schedule('* * * * *', () => runSafely('Session alerts', () => runSessionAlerts()), {
      timezone: APP_TIMEZONE,
      name: 'session-alerts',
      noOverlap: true,
    }),
    cron.schedule('0 20 * * *', () => runSafely('Admin digest', () => sendAdminDigest()), {
      timezone: APP_TIMEZONE,
      name: 'admin-digest',
      noOverlap: true,
    }),
    cron.schedule(
      '0 10 * * 1',
      () => runSafely('Feedback reminders', () => sendFeedbackReminders()),
      {
        timezone: APP_TIMEZONE,
        name: 'feedback-reminders',
        noOverlap: true,
      },
    ),
    cron.schedule('0 10 * * *', () => runSafely('Overdue notices', () => sendOverdueNotices()), {
      timezone: APP_TIMEZONE,
      name: 'overdue-notices',
      noOverlap: true,
    }),
    cron.schedule('30 9 * * 1', () => runSafely('Money reminders', () => sendMoneyReminders()), {
      timezone: APP_TIMEZONE,
      name: 'money-reminders',
      noOverlap: true,
    }),
    cron.schedule('0 9 * * 1', () => runSafely('Weekly fees', () => sendWeeklyFeesSummary()), {
      timezone: APP_TIMEZONE,
      name: 'weekly-fees',
      noOverlap: true,
    }),
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
