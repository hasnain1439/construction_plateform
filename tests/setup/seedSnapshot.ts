/**
 * Seed snapshots — what makes `resetDatabase()` fast.
 *
 * The base snapshot (schema `test_seed`) holds a copy of every table the test seed filled, plus
 * the seed's return value. A reset deletes every row and copies the snapshot back in ONE
 * transaction (~50 ms instead of ~1.5 s of seeding through Prisma). Demo data on top of the base
 * seed (stock, labour, billing…) is snapshotted the same way in `test_seed__<name>` schemas.
 *
 * globalSetup builds them once in the template database (tests/setup/buildSeedSnapshots.ts),
 * so every worker database copied from it starts with them. They are rebuilt in place when
 * older than 10 minutes or made on another day (the seed is relative to "today"), e.g. during a
 * long serial run. Used only on *_test databases, always over the superuser
 * DATABASE_MIGRATION_URL connection (needed for session_replication_role).
 */
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { Prisma } from '../../src/generated/prisma/client.js';

export const SNAPSHOT = 'test_seed';
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

type Db = Pick<pg.Pool, 'query'>;

export interface Snapshot {
  schema: string;
  /** Return value of the seed (encodeValue). */
  value: string;
  /** Tables (quoted) that had rows. */
  tables: string[];
  createdAt: Date;
  /** createdAt of the base snapshot a demo snapshot was built on. */
  base: string | null;
}

export const layerSchema = (name: string) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`seed snapshot: bad name "${name}"`);
  return `${SNAPSHOT}__${name}`;
};

const pktDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(d);

export function assertTestDatabase(url = process.env['DATABASE_MIGRATION_URL'] ?? '') {
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('test database resets only run against a database whose name ends with _test');
  }
}

/** Every application table, quoted (not _prisma_migrations). */
export async function publicTables(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
  );
  return rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`);
}

/** A snapshot that is still fresh, or undefined. */
export async function readSnapshot(db: Db, schema: string): Promise<Snapshot | undefined> {
  const { rows } = await db.query<{ ok: string | null }>(`SELECT to_regclass($1)::text AS ok`, [`"${schema}".__meta`]);
  if (!rows[0]?.ok) return undefined;
  const meta = await db.query<Omit<Snapshot, 'schema'>>(`SELECT value, tables, "createdAt", base FROM "${schema}".__meta`);
  const row = meta.rows[0];
  const now = new Date();
  if (!row || now.getTime() - row.createdAt.getTime() > SNAPSHOT_MAX_AGE_MS || pktDay(now) !== pktDay(row.createdAt)) return undefined;
  return { ...row, schema };
}

/** Deletes every row of every table and copies the snapshot back, in one transaction. */
export async function restoreSnapshot(db: Db, snapshot: Snapshot, tables: string[]): Promise<void> {
  // replica: no FK checks (any delete / insert order works) and no triggers (sync_track would
  // log the restore as sync changes). Superuser only.
  await db.query(
    [
      'BEGIN',
      'SET LOCAL session_replication_role = replica',
      ...tables.map((t) => `DELETE FROM public.${t}`),
      ...snapshot.tables.map((t) => `INSERT INTO public.${t} SELECT * FROM "${snapshot.schema}".${t}`),
      'COMMIT',
    ].join(';\n'),
  );
}

/** Copies the current rows of every filled table into `schema` (replacing it). Returns createdAt. */
export async function writeSnapshot(db: Db, schema: string, value: unknown, base: string | null, tables: string[]): Promise<Date> {
  const text = encodeValue(value);
  if (!isDeepStrictEqual(decodeValue(text), value ?? null)) {
    throw new Error(`seed snapshot ${schema}: the seed result does not survive encodeValue / decodeValue — add the new value type there`);
  }
  const { rows } = await db.query<{ t: string }>(tables.map((t) => `SELECT '${t.replace(/'/g, "''")}' AS t WHERE EXISTS (SELECT 1 FROM public.${t})`).join(' UNION ALL '));
  const filled = rows.map((r) => r.t);
  await db.query(
    [
      'BEGIN',
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      `CREATE SCHEMA "${schema}"`,
      ...filled.map((t) => `CREATE TABLE "${schema}".${t} AS SELECT * FROM public.${t}`),
      `CREATE TABLE "${schema}".__meta (value text NOT NULL, tables text[] NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), base text)`,
      'COMMIT',
    ].join(';\n'),
  );
  const { rows: meta } = await db.query<{ createdAt: Date }>(
    `INSERT INTO "${schema}".__meta (value, tables, base) VALUES ($1, $2, $3) RETURNING "createdAt"`,
    [text, filled, base],
  );
  return meta[0]!.createdAt;
}

/** Drops the demo snapshots (`layers`) or all snapshots. */
export async function dropSnapshots(db: Db, which: 'all' | 'layers'): Promise<void> {
  const { rows } = await db.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1) OR ($2 AND nspname = $3)`,
    [`${SNAPSHOT}__`, which === 'all', SNAPSHOT],
  );
  for (const r of rows) await db.query(`DROP SCHEMA IF EXISTS "${r.nspname.replace(/"/g, '""')}" CASCADE`);
}

/** JSON that keeps Date, BigInt and Prisma Decimal values (seed results are Prisma rows). */
export function encodeValue(value: unknown): string {
  return JSON.stringify(value ?? null, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return { $date: raw.toISOString() };
    if (typeof raw === 'bigint') return { $bigint: raw.toString() };
    if (Prisma.Decimal.isDecimal(raw)) return { $decimal: raw.toString() };
    return v;
  });
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, string>;
      if ('$date' in o) return new Date(o['$date']!);
      if ('$bigint' in o) return BigInt(o['$bigint']!);
      if ('$decimal' in o) return new Prisma.Decimal(o['$decimal']!);
    }
    return v;
  });
}
