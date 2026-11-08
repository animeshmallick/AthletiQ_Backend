import { afterAll, afterEach, beforeAll, beforeEach, jest } from '@jest/globals';

// Swap the real Postgres pool for the in-memory database.
jest.mock('../../src/db/client', () => jest.requireActual('../helpers/test-db'));

// The production lock needs a dedicated TCP connection; in tests the single PGlite instance is
// already exclusive, so the lock is always granted (individual tests override this).
jest.mock('../../src/jobs/advisory-lock', () => ({
  tryAdvisoryLock: jest.fn(async () => ({ release: async () => undefined })),
}));

const testDb = jest.requireActual<typeof import('../helpers/test-db')>('../helpers/test-db');

beforeAll(async () => {
  await testDb.migrateTestDb();
}, 60_000);

beforeEach(async () => {
  await testDb.resetTestDb();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(async () => {
  await testDb.shutdownTestDb();
});
