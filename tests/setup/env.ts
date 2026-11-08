// Loaded before any test module so `src/config/env.ts` validates against deterministic values.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test?sslmode=disable',
  DATABASE_URL_UNPOOLED: 'postgresql://test:test@localhost:5432/test?sslmode=disable',
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0123456789',
  SHARE_LINK_SECRET: 'test-share-secret-test-share-secret-0123456789',
  PUBLIC_API_URL: 'https://api.test',
  APP_URL: 'https://app.test',
  CORS_ORIGINS: 'https://app.test',
  SCHEDULER_ENABLED: 'false',
  COOKIE_SECURE: 'false',
});
