import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { createWorkerDatabase, databaseOf, dropWorkerDatabases, ident, TEST_DB_SUFFIX, withServer, workerDatabaseName } from './testDatabases.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Worker databases construction_w1_test … construction_w<n>_test made by globalSetup (0 in serial mode). */
    workerDatabases: number;
  }
}

/**
 * Once per `npm test`: make sure the app roles and the test database exist, then apply the
 * migrations (including RLS) so tests run on the real production schema.
 *
 * Parallel mode (default): that database is the TEMPLATE — one copy per Vitest worker,
 * `construction_w<n>_test` (CREATE DATABASE … TEMPLATE), which tests/setup/workerDatabase.ts
 * points the worker at. The copies are dropped at the end (and at the start, if a run was killed).
 * Serial mode (`npm run test:serial`, TEST_DB_MODE=shared): every file uses it directly.
 * Each test starts from a reset + re-seeded database (tests/helpers.ts → resetDatabase).
 */
export default async function globalSetup(project: TestProject) {
  const migrationUrl = process.env['DATABASE_MIGRATION_URL'] ?? '';
  const template = databaseOf(migrationUrl);
  if (!template.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(`Refusing to run tests against "${template}": the test database name must end with ${TEST_DB_SUFFIX}`);
  }
  const parallel = process.env['TEST_DB_MODE'] !== 'shared';
  // node directly (not npx: ~1 s each on Windows).
  const node = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync(process.execPath, args, { stdio: 'inherit', env });
  node(['--import', 'tsx', 'scripts/db-setup.ts']);
  node(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  // Uploaded files of an interrupted run.
  const storageRoot = process.env['TEST_STORAGE_ROOT'] ?? '';
  const cleanStorage = () => storageRoot.includes('construction-platform-tests') && rmSync(storageRoot, { recursive: true, force: true });
  cleanStorage();
  // Seed + demo snapshots (tests/setup/seedSnapshot.ts) from the current seed code, in the
  // template, so every worker database starts with them. Their uploads go to <root>/seed.
  const seedStorage = parallel ? join(storageRoot, 'seed') : storageRoot;
  node(['--import', 'tsx', 'tests/setup/buildSeedSnapshots.ts'], { ...process.env, STORAGE_DIR: seedStorage });

  const workers = parallel ? Math.max(1, project.config.maxWorkers || project.vitest.config.maxWorkers || 1) : 0;
  await withServer(migrationUrl, async (client) => {
    // Test data only: no need to wait for the disk on every commit (much faster on Windows / CI).
    await client.query(`ALTER DATABASE ${ident(template)} SET synchronous_commit = off`);
    if (!parallel) return;
    // Nobody may be connected to the template while it is copied (a stale psql / GUI session on
    // the TEST database is closed).
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [template]);
  });
  // Left-overs of an interrupted run.
  if (parallel) await dropWorkerDatabases(migrationUrl, template);
  const started = Date.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => createWorkerDatabase(migrationUrl, template, workerDatabaseName(template, i + 1))));
  if (workers) console.log(`created ${workers} worker databases from ${template} in ${Date.now() - started} ms`);
  // Each worker has its own storage folder (workerDatabase.ts); give it the demo seeds' files.
  for (let i = 1; i <= workers; i++) if (existsSync(seedStorage)) cpSync(seedStorage, join(storageRoot, `w${i}`), { recursive: true });
  project.provide('workerDatabases', workers);

  return async () => {
    if (parallel) await dropWorkerDatabases(migrationUrl, template);
    // Delete the files uploaded during the run (temp folder set in vitest.config.ts).
    cleanStorage();
  };
}
