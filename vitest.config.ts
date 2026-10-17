import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests run against separate databases configured in .env.test (see .env.test.example).
if (!existsSync('.env.test')) {
  throw new Error('Missing .env.test — copy .env.test.example and set the postgres password.');
}

export default defineConfig(({ mode }) => {
  const testEnv = parse(readFileSync('.env.test'));
  // TEST_* settings: the shell wins over .env.test.
  const setting = (key: string) => process.env[key] ?? testEnv[key];
  // `npm run test:serial` (= `vitest run --mode serial`, or TEST_SERIAL=1): the old behaviour —
  // one database (construction_test), one file at a time.
  const serial = mode === 'serial' || setting('TEST_SERIAL') === '1';
  // Default: half the CPU threads (Postgres needs the other half). Override with TEST_MAX_WORKERS.
  const maxWorkers = serial ? 1 : Number(setting('TEST_MAX_WORKERS')) || Math.max(1, Math.floor(availableParallelism() / 2));
  const poolMax = setting('TEST_DB_POOL_MAX');
  if (poolMax) testEnv['TEST_DB_POOL_MAX'] = poolMax;

  // Uploaded test files go to the OS temp folder (one sub-folder per worker, removed after the
  // run), never into the project. The folder is named after the test database, so checkouts with
  // their own .env.test database (parallel worktrees) never share or delete each other's files.
  const testDb = new URL(testEnv['DATABASE_MIGRATION_URL'] ?? 'postgres://x/construction_test').pathname.slice(1) || 'construction_test';
  testEnv['TEST_STORAGE_ROOT'] = join(tmpdir(), 'construction-platform-tests', testDb, 'storage');
  testEnv['STORAGE_DIR'] = testEnv['TEST_STORAGE_ROOT'];
  // per-worker = each Vitest worker gets its own copy of the migrated template database
  // (tests/setup/workerDatabase.ts); shared = every file uses construction_test.
  testEnv['TEST_DB_MODE'] = serial ? 'shared' : 'per-worker';
  // Workers share the CPU: a busy moment must not turn a slow connect into a 503 SERVICE_BUSY
  // (production default 10 s).
  testEnv['DB_TX_MAX_WAIT_MS'] ??= '30000';
  Object.assign(process.env, testEnv);

  return {
    test: {
      include: ['tests/**/*.test.ts'],
      env: testEnv,
      globalSetup: ['tests/setup/globalSetup.ts'],
      setupFiles: [
        // Must stay first: points the worker at its own database before any app module loads.
        'tests/setup/workerDatabase.ts',
        // Fails any test that runs two queries at once on one pg connection (Promise.all on a tx).
        'tests/setup/pgConcurrency.ts',
      ],
      // Separate processes: module singletons (Prisma clients, rate limiters, caches, the
      // console SMS / mail outbox) are never shared between files running at the same time.
      pool: 'forks',
      // Transformed TypeScript is cached in node_modules/.vitest-cache between runs.
      fsModuleCache: true,
      fileParallelism: !serial,
      maxWorkers,
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  };
});
