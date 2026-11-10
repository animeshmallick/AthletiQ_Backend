import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, jobRunStatus, timestamps, tz } from './_shared.js';
import { users } from './users.js';

/** Single-row table (id = 1) with academy details shown on invoices and shared messages. */
export const academySettings = pgTable(
  'academy_settings',
  {
    id: integer().primaryKey().default(1),
    name: text().notNull().default('AthletiQ Academy'),
    legalName: text(),
    address: text(),
    phone: text(),
    email: text(),
    website: text(),
    gstin: text(),
    /** Shown on invoices as a payment instruction, e.g. academy@upi. */
    upiId: text(),
    invoiceFooter: text(),
    ...timestamps,
  },
  (t) => [check('academy_settings_singleton_chk', sql`${t.id} = 1`)],
);

/** Append-only trail of sensitive actions (finance, enrollment, access changes). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    ipAddress: text(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.actorId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

/** History of scheduled job executions for observability. */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    jobName: text().notNull(),
    /** The business date the run processed (IST). */
    runDate: date({ mode: 'string' }).notNull(),
    trigger: text().notNull(),
    status: jobRunStatus().notNull(),
    stats: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
  },
  (t) => [index('job_runs_name_started_idx').on(t.jobName, t.startedAt)],
);

/**
 * Request log: every write (POST/PUT/PATCH/DELETE) and every failed request, by whom, how long
 * it took and how it ended. Collected in memory and saved in batches off the request path, so
 * tracking costs requests nothing noticeable; pruned after 90 days.
 */
export const apiRequests = pgTable(
  'api_requests',
  {
    id: id(),
    method: text().notNull(),
    /** Route pattern ("/api/v1/invoices/:id"), so the same endpoint groups together. */
    route: text().notNull(),
    status: integer().notNull(),
    durationMs: integer().notNull(),
    /** Error code and message for failed requests. */
    code: text(),
    message: text(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    requestId: text(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    index('api_requests_created_idx').on(t.createdAt),
    index('api_requests_status_idx').on(t.status, t.createdAt),
    index('api_requests_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * Wrong registration numbers typed on a shared link (key: "report:<linkId>" or
 * "invoice:<invoiceId>"). Too many in a row locks the link for a while.
 */
export const shareLinkAttempts = pgTable('share_link_attempts', {
  key: text().primaryKey(),
  failures: integer().notNull().default(0),
  lockedUntil: tz(),
  updatedAt: tz().notNull().defaultNow(),
});

/**
 * What went wrong on people's phones and browsers: crashes, script errors, failed updates,
 * freezes and failed API calls as the device saw them. Sent by the app in small batches; the same
 * error repeated in a session arrives once with a count. Pruned after 30 days.
 */
export const clientEvents = pgTable(
  'client_events',
  {
    id: id(),
    /** crash | error | update | freeze | stuck | api */
    kind: text().notNull(),
    /** Groups the same problem (kind + normalised message + where it happened). */
    fingerprint: text().notNull(),
    message: text().notNull(),
    stack: text(),
    /** The screen (path) the person was on. */
    screen: text(),
    appVersion: text(),
    /** web | pwa | android | ios */
    platform: text().notNull(),
    userAgent: text(),
    online: boolean(),
    /** Times it happened in the batch (repeats are merged on the device). */
    count: integer().notNull().default(1),
    /** Extra facts: the API call (method, route, status, ms), how long a freeze lasted… */
    details: jsonb().$type<Record<string, unknown>>(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Role in use at the time (admin / coach), when signed in. */
    role: text(),
    /** When it happened on the device. */
    occurredAt: tz().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    index('client_events_occurred_idx').on(t.occurredAt),
    index('client_events_fingerprint_idx').on(t.fingerprint, t.occurredAt),
    index('client_events_user_idx').on(t.userId, t.occurredAt),
  ],
);
