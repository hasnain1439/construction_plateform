import { seedMalikBilling } from '../../prisma/seedBilling.js';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import type { Seeded } from '../helpers.js';

export { api, mockPdf, owner, pm, pmWithFinancials, pdfCalls, rs, today } from '../billing/fixtures.js';
export { munshi } from '../inventory/fixtures.js';

/** The whole Malik & Sons demo (stock, labour & cash, billing) on top of the base test seed. */
export async function seedMalikDemo(s: Seeded) {
  const base = { tenantId: s.malik.id, ownerId: s.users.khalid.id, projects: s.projects };
  await seedMalikInventory(prismaAdmin, { ...base, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id });
  await seedMalikLabor(prismaAdmin, { ...base, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, asifId: s.users.asif.id });
  await seedMalikBilling(prismaAdmin, base);
}
