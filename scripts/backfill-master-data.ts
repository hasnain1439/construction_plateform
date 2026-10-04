/**
 * Gives every existing company the starting master data (material catalog, quality
 * categories, labour rates, billing template). Idempotent — safe to run repeatedly.
 *   npm run backfill:master-data
 */
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { provisionMasterData } from '../src/modules/master-data/provision.js';

try {
  const tenants = await prismaAdmin.tenant.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  for (const t of tenants) {
    const r = await prismaAdmin.$transaction((tx) => provisionMasterData(tx, t.id));
    console.log(`${t.name.padEnd(32)} +${r.materials} materials, +${r.categories} categories, +${r.laborRates} labour rates, +${r.templates} templates`);
  }
  console.log(`Done: ${tenants.length} companies checked.`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await disconnectDatabases();
}
