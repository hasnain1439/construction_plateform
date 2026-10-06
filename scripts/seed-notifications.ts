/**
 * Writes the Malik & Sons demo notifications on a database that already has the stock,
 * labour and billing demo (`npm run db:seed` only adds them in the run that writes billing).
 * Replaces Malik's notifications — safe to run repeatedly.
 *   npm run db:seed:notifications
 */
import { SEED } from '../prisma/seed.js';
import { seedMalikNotifications } from '../prisma/seedNotifications.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';

try {
  const malik = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: SEED.malik.slug } });
  const user = (phone: string) => prismaAdmin.user.findFirstOrThrow({ where: { tenantId: malik.id, phone } });
  const project = (code: string) => prismaAdmin.project.findFirstOrThrow({ where: { tenantId: malik.id, code } });
  const r = await seedMalikNotifications(prismaAdmin, {
    tenantId: malik.id,
    ownerId: (await user(SEED.malik.owner.phone)).id,
    bilalId: (await user(SEED.malik.pm.phone)).id,
    rafaqatId: (await user(SEED.malik.munshi.phone)).id,
    projects: { dha: await project('MSB-2026-012'), johar: await project('MSB-2026-008') },
  });
  console.log(`Malik & Sons: ${r.created} notifications written.`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await disconnectDatabases();
}
