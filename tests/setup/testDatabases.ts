/**
 * Names and admin helpers for the test databases (used by globalSetup and workerDatabase).
 *
 * Parallel mode (default): globalSetup migrates the template database named in .env.test
 * (`construction_test`); each Vitest worker gets its own copy, `construction_w<poolId>_test`,
 * created by globalSetup with `CREATE DATABASE … TEMPLATE construction_test` (by the worker
 * itself if globalSetup expected fewer workers).
 * Serial mode (`npm run test:serial`): every file uses the template database itself, one at a time.
 */
import pg from 'pg';

/** Every test database name must end with this (globalSetup, resetDatabase and this file refuse others). */
export const TEST_DB_SUFFIX = '_test';

export const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Same server / user / password / options, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** `construction_test` + pool 3 → `construction_w3_test`. */
export function workerDatabaseName(template: string, poolId: string | number): string {
  if (!template.endsWith(TEST_DB_SUFFIX)) throw new Error(`template database "${template}" must end with ${TEST_DB_SUFFIX}`);
  const name = `${template.slice(0, -TEST_DB_SUFFIX.length)}_w${poolId}${TEST_DB_SUFFIX}`;
  // Postgres cuts names at 63 bytes — a cut name would lose the _test suffix.
  if (Buffer.byteLength(name) > 63) throw new Error(`worker database name too long: ${name}`);
  return name;
}

/** LIKE pattern matching every worker database of a template (for cleanup). */
export function workerDatabasePattern(template: string): string {
  const base = template.slice(0, -TEST_DB_SUFFIX.length).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `${base}\\_w%\\_test`;
}

/** Runs `fn` on a superuser connection to the server's `postgres` database. */
export async function withServer<T>(migrationUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(migrationUrl, 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Drops every worker database of `template` (also left-overs of an interrupted run). All at once,
 * one connection each: on Windows each DROP DATABASE waits for a checkpoint, and dropping them
 * together lets that one checkpoint skip the dirty pages of every dropped database (~0.3 s, not ~10 s).
 */
export async function dropWorkerDatabases(migrationUrl: string, template: string): Promise<string[]> {
  const names = await withServer(migrationUrl, async (client) => {
    const { rows } = await client.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [workerDatabasePattern(template)]);
    return rows.map((r) => r.datname).filter((name) => name.endsWith(TEST_DB_SUFFIX));
  });
  await Promise.all(names.map((name) => withServer(migrationUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`))));
  return names;
}

/**
 * `CREATE DATABASE <database> TEMPLATE <template>` (skipped if it exists), commits without
 * waiting for the disk, and lets the app roles connect. Roles (app_user with RLS, app_admin with
 * BYPASSRLS) are cluster-wide; schema, RLS policies and table grants come with the copy.
 */
export async function createWorkerDatabase(migrationUrl: string, template: string, database: string): Promise<void> {
  if (!database.endsWith(TEST_DB_SUFFIX)) throw new Error(`refusing to create worker database "${database}"`);
  await withServer(migrationUrl, async (client) => {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount) return;
    // Copies made at the same moment can briefly fail with "source database is being accessed
    // by other users" — retry a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE ${ident(database)} TEMPLATE ${ident(template)}`);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '42P04') break; // created meanwhile
        if (code !== '55006' || attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
    // Test data only: no need to wait for the disk on every commit (much faster on Windows / CI).
    await client.query(`ALTER DATABASE ${ident(database)} SET synchronous_commit = off`);
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
      const role = decodeURIComponent(new URL(process.env[key] ?? '').username);
      await client.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(role)}`);
    }
  });
}
