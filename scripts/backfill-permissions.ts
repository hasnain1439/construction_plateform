/**
 * Gives every existing company the permission role templates, assigns them to users without a
 * role and moves PMs with the old canSeeFinancials flag to ALLOW overrides. Idempotent — safe to
 * run repeatedly; re-syncs the system templates when their code definition changed.
 *   npm run backfill:permissions
 */
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { provisionPermissions } from '../src/modules/permissions/provision.js';

try {
  const tenants = await prismaAdmin.tenant.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  for (const t of tenants) {
    const r = await prismaAdmin.$transaction((tx) => provisionPermissions(tx, t.id));
    console.log(`${t.name.padEnd(32)} roles +${r.rolesCreated} ~${r.rolesUpdated}, users assigned ${r.usersAssigned}, financial PMs migrated ${r.financialUsersMigrated}`);
  }
  console.log(`Done: ${tenants.length} companies checked.`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await disconnectDatabases();
}
