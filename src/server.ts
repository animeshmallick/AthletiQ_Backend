import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { flushMonitoring, initMonitoring } from './instrument.js';
import { logger } from './lib/logger.js';
import { reportError } from './lib/monitoring.js';

await initMonitoring();

const app = createApp();
const server: Server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'AthletiQ API listening');
});

// Slightly above typical load-balancer idle timeouts (AWS ALB default 60s) to avoid 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

startScheduler();

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
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await closeDatabase();
    await flushMonitoring();
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
  reportError(reason, { where: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  reportError(err, { where: 'uncaughtException' });
  void shutdown('uncaughtException');
});
