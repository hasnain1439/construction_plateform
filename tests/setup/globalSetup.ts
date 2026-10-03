import { execSync } from 'node:child_process';

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
}
