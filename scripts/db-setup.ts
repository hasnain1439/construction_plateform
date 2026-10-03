/**
 * Local/dev bootstrap: creates the application database roles and the database.
 *
 *   app_user  – used by the API for all tenant-scoped work. RLS applies.
 *   app_admin – BYPASSRLS. Used only for cross-tenant auth lookups and platform-admin code.
 *
 * Role names and passwords are read from DATABASE_URL / DATABASE_ADMIN_URL, and the
 * script connects with DATABASE_MIGRATION_URL (a superuser, needed to grant BYPASSRLS).
 * Safe to run repeatedly. Usage: `npm run db:setup` (or `DOTENV_CONFIG_PATH=.env.test`).
 */
import 'dotenv/config';
import pg from 'pg';

function required(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return new URL(value);
}

const appUrl = required('DATABASE_URL');
const adminUrl = required('DATABASE_ADMIN_URL');
const migrationUrl = required('DATABASE_MIGRATION_URL');
const database = decodeURIComponent(migrationUrl.pathname.slice(1));

const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function ensureRole(client: pg.Client, url: URL, bypassRls: boolean) {
  const name = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const flags = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`;
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  await client.query(`${verb} ROLE ${ident(name)} WITH ${flags} PASSWORD ${literal(password)}`);
  console.log(`${verb === 'CREATE' ? 'created' : 'updated'} role ${name}${bypassRls ? ' (BYPASSRLS)' : ''}`);
}

async function main() {
  const serverUrl = new URL(migrationUrl);
  serverUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: serverUrl.toString() });
  await client.connect();
  try {
    await ensureRole(client, appUrl, false);
    await ensureRole(client, adminUrl, true);
    const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!db.rowCount) {
      await client.query(`CREATE DATABASE ${ident(database)}`);
      console.log(`created database ${database}`);
    }
    for (const url of [appUrl, adminUrl]) {
      await client.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(decodeURIComponent(url.username))}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
