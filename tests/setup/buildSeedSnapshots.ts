/**
 * Run by globalSetup (`tsx tests/setup/buildSeedSnapshots.ts`) against the TEMPLATE test
 * database, before the worker databases are copied from it: seeds once, stores the base snapshot
 * and every demo snapshot (tests/setup/demoSeeds.ts). Files the demo seeds upload go to
 * STORAGE_DIR (globalSetup copies them into each worker's storage folder).
 */
import pg from 'pg';
import { seed } from '../../prisma/seed.js';
import { disconnectDatabases, prismaAdmin } from '../../src/core/db/prisma.js';
import { DEMO_SEEDS, parentOf, type DemoSeed } from './demoSeeds.js';
import { assertTestDatabase, decodeValue, dropSnapshots, layerSchema, publicTables, readSnapshot, restoreSnapshot, SNAPSHOT, writeSnapshot } from './seedSnapshot.js';

assertTestDatabase();
const owner = new pg.Pool({ connectionString: process.env['DATABASE_MIGRATION_URL'], max: 2 });
try {
  const started = Date.now();
  const tables = await publicTables(owner);
  await dropSnapshots(owner, 'all');
  await owner.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
  const seeded = await seed(prismaAdmin, { inventory: false, labor: false, billing: false });
  await writeSnapshot(owner, SNAPSHOT, seeded, null, tables);
  const base = (await readSnapshot(owner, SNAPSHOT))!;
  const value = decodeValue(base.value) as typeof seeded;

  const built = new Map<DemoSeed, string>();
  const build = async (name: DemoSeed): Promise<string> => {
    const done = built.get(name);
    if (done) return done;
    const parent = parentOf(name);
    const parentStamp = parent ? await build(parent) : base.createdAt.toISOString();
    await restoreSnapshot(owner, parent ? (await readSnapshot(owner, layerSchema(parent)))! : base, tables);
    await DEMO_SEEDS[name].build(value);
    const stamp = (await writeSnapshot(owner, layerSchema(name), null, parentStamp, tables)).toISOString();
    built.set(name, stamp);
    return stamp;
  };
  for (const name of Object.keys(DEMO_SEEDS) as DemoSeed[]) await build(name);
  await restoreSnapshot(owner, base, tables);
  console.log(`seed snapshots built in ${Date.now() - started} ms (base, ${[...built.keys()].join(', ')})`);
} finally {
  await owner.end();
  await disconnectDatabases();
}
