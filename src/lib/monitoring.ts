/**
 * Error reporting (Sentry when SENTRY_DSN is set; a no-op otherwise).
 * Only unexpected failures are reported: 5xx responses, failed background jobs, crashes.
 * Nothing personal is sent: no request bodies, cookies, auth headers or query strings.
 */

export interface ErrorContext {
  /** Where it happened, e.g. "http" or "job:Overdue notices". */
  where: string;
  requestId?: string;
  method?: string;
  path?: string;
  userId?: string;
  role?: string;
}

export type ErrorReporter = (err: unknown, ctx: ErrorContext) => void;

let reporter: ErrorReporter | null = null;

export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn;
}

export const monitoringEnabled = () => reporter !== null;

/** Never throws: reporting must not turn one failure into two. */
export function reportError(err: unknown, ctx: ErrorContext): void {
  if (!reporter) return;
  try {
    reporter(err, ctx);
  } catch {
    /* ignore */
  }
}

/** Keys whose values are dropped from anything sent to the error service. */
const SECRET = /pass(word)?|token|secret|authorization|cookie|otp|signature|dsn|key/i;

/** Removes secrets and personal fields from a Sentry-style event (mutates and returns it). */
export function scrubEvent<
  T extends {
    request?: {
      data?: unknown;
      cookies?: unknown;
      headers?: Record<string, string>;
      query_string?: unknown;
      url?: string;
    };
    user?: { id?: string | number; [key: string]: unknown };
    extra?: Record<string, unknown>;
  },
>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split('?')[0];
    if (event.request.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (SECRET.test(k)) delete event.request.headers[k];
      }
    }
  }
  if (event.user) {
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  if (event.extra) {
    for (const k of Object.keys(event.extra)) if (SECRET.test(k)) delete event.extra[k];
  }
  return event;
}
