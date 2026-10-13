/**
 * First `setupFiles` entry: points this Vitest worker at its own database and storage folder.
 *
 * Runs in the worker before the test file is imported, so `src/config/env.ts` (parsed when the
 * app modules load) already sees the worker's DATABASE_URL / DATABASE_ADMIN_URL /
 * DATABASE_MIGRATION_URL. globalSetup made `construction_w<n>_test` for every worker slot
 * (n = VITEST_POOL_ID, 1…maxWorkers) as a copy of the migrated template; a worker runs one file
 * at a time, so its database is never used by two files at once.
 *
 * Serial mode (`TEST_DB_MODE=shared`, `npm run test:serial`): nothing changes, every file uses
 * the template database itself.
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { createWorkerDatabase, databaseOf, withDatabase, workerDatabaseName } from './testDatabases.js';

if (process.env['TEST_DB_MODE'] !== 'shared') {
  const poolId = Number(process.env['VITEST_POOL_ID'] ?? '1');
  const migrationUrl = process.env['DATABASE_MIGRATION_URL'] ?? '';
  // Remembered on first use: idempotent if this file runs again in the same process
  // (isolate: false, vm pools), when the URLs below already point at the copy.
  const template = (process.env['TEST_TEMPLATE_DATABASE'] ??= databaseOf(migrationUrl));
  const database = workerDatabaseName(template, poolId);
  // Only if globalSetup did not make it (more workers than it expected).
  const root = process.env['TEST_STORAGE_ROOT'];
  if (poolId > (inject('workerDatabases') ?? 0)) {
    await createWorkerDatabase(withDatabase(migrationUrl, template), template, database);
    if (root && existsSync(join(root, 'seed'))) cpSync(join(root, 'seed'), join(root, `w${poolId}`), { recursive: true });
  }

  for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_MIGRATION_URL'] as const) {
    process.env[key] = withDatabase(process.env[key] ?? '', database);
  }
  // Uploaded files: one folder per worker (globalSetup removes the parent folder at the end).
  if (root) process.env['STORAGE_DIR'] = join(root, `w${poolId}`);
  // Several workers share one Postgres (max_connections is often 100): smaller pools per worker.
  process.env['DB_POOL_MAX'] = process.env['TEST_DB_POOL_MAX'] ?? '5';
}
