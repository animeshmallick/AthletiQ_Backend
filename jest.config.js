/**
 * Two projects:
 *  - unit: pure logic, no database.
 *  - api:  HTTP-level tests (supertest) against an in-memory Postgres (PGlite) migrated with the
 *          real Drizzle migrations, so SQL, constraints and business rules are all exercised.
 *
 * TypeScript is compiled to CommonJS by SWC; `.js` import suffixes (NodeNext style) are mapped
 * back to the `.ts` sources.
 */
const common = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
  },
  // jose is ESM-only; let SWC transpile it to CJS for the Jest runtime.
  transformIgnorePatterns: ['/node_modules/(?!(jose)/)'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  setupFiles: ['<rootDir>/tests/setup/env.ts'],
};

/** @type {import('jest').Config} */
export default {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...common,
      displayName: 'api',
      testMatch: ['<rootDir>/tests/api/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup/api.setup.ts'],
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    // Third-party SDK bootstrap; the logic it relies on (lib/monitoring.ts) is tested.
    '!src/instrument.ts',
    '!src/db/migrate.ts',
    '!src/db/seed.ts',
    '!src/db/client.ts',
    // Declarative table definitions; their only "functions" are lazily-evaluated FK callbacks.
    '!src/db/schema/**',
    '!src/jobs/run-invoice-job.ts',
    '!src/jobs/advisory-lock.ts',
    '!src/types/**',
  ],
  coverageReporters: ['text-summary', 'text', 'lcov', 'html'],
  coverageThreshold: {
    global: { statements: 95, branches: 88, functions: 95, lines: 95 },
  },
};
