import { z } from 'zod';

const flag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.url(),
  DATABASE_URL_UNPOOLED: z.url().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: flag(false),
  COOKIE_CROSS_SITE: flag(false),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),

  SHARE_LINK_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SHARE_LINK_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  APP_URL: z.url().default('http://localhost:5173'),

  SCHEDULER_ENABLED: flag(true),
  INVOICE_CRON: z.string().default('0 0 * * *'),

  /** Firebase service-account JSON (raw or base64) for push notifications. Unset = push disabled. */
  FCM_SERVICE_ACCOUNT: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** When coaches get their "sessions today" push (IST). */
  REMINDER_CRON: z.string().default('0 7 * * *'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // The logger depends on env, so report directly on stderr and refuse to boot.
    process.stderr.write(`\nInvalid environment configuration:\n${details}\n\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
