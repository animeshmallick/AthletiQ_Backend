/**
 * Starts Sentry error reporting when SENTRY_DSN is set. Loaded first by server.ts.
 * No tracing/profiling (errors only), no personal data (see scrubEvent).
 */
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { scrubEvent, setErrorReporter } from './lib/monitoring.js';

export async function initMonitoring(): Promise<boolean> {
  if (!env.SENTRY_DSN) return false;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
      release:
        process.env.GIT_SHA && process.env.GIT_SHA !== 'unknown' ? process.env.GIT_SHA : undefined,
      // Collect nothing personal: no user info, cookies, bodies or query strings; only safe headers.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        httpHeaders: { request: { allow: ['user-agent', 'x-request-id'] }, response: false },
      },
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
    });
    setErrorReporter((err, ctx) => {
      Sentry.withScope((scope) => {
        scope.setTag('where', ctx.where);
        if (ctx.role) scope.setTag('role', ctx.role);
        if (ctx.userId) scope.setUser({ id: ctx.userId });
        scope.setContext('request', {
          id: ctx.requestId,
          method: ctx.method,
          path: ctx.path,
        });
        Sentry.captureException(err);
      });
    });
    logger.info('Error reporting enabled (Sentry)');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Could not start Sentry; continuing without error reporting');
    return false;
  }
}

/** Gives queued reports a moment to leave before the process exits. */
export async function flushMonitoring(timeoutMs = 2000) {
  if (!env.SENTRY_DSN) return;
  try {
    const Sentry = await import('@sentry/node');
    await Sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}
