import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/**
 * Once per `npm test`: make sure the app roles and the test database exist, then
 * apply the migrations (including RLS) so tests run on the real production schema.
 * Each test file then truncates + re-seeds (tests/helpers.ts → resetDatabase).
 */
export default function globalSetup() {
  const url = new URL(process.env['DATABASE_MIGRATION_URL'] ?? '');
  if (!url.pathname.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${url.pathname.slice(1)}": the test database name must end with _test`);
  }
  const run = (cmd: string) => execSync(cmd, { stdio: 'inherit', env: process.env });
  run('npx tsx scripts/db-setup.ts');
  run('npx prisma migrate deploy');

  // Teardown: delete the files uploaded during the run (temp folder set in vitest.config.ts).
  return () => {
    const dir = process.env['STORAGE_DIR'];
    if (dir?.includes('construction-platform-tests')) rmSync(dir, { recursive: true, force: true });
  };
}
