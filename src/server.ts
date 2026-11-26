import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { logger } from './lib/logger.js';
import {
  flushHealth,
  startHealthMonitor,
  stopHealthMonitor,
} from './modules/activity/server-health.js';
import { flushPerf } from './modules/activity/perf-log.js';
import { flushRequestLog } from './modules/activity/request-log.js';

const app = createApp();
const server: Server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'AthletiQ API listening');
});

// Slightly above typical load-balancer idle timeouts (AWS ALB default 60s) to avoid 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

startScheduler();
// The live server only: a developer's machine may share its database.
if (env.NODE_ENV === 'production') startHealthMonitor();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');

  const force = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 20_000);
  force.unref();

  try {
    stopScheduler();
    stopHealthMonitor();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    // Save the request log still waiting in memory before the database goes away.
    await flushRequestLog();
    await flushPerf();
    await flushHealth().catch(() => undefined);
    await closeDatabase();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  void shutdown('uncaughtException');
});
