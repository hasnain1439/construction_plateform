/**
 * Step 18 tax demo for Malik & Sons. Tax stays OFF (the default): the seed only fills in the
 * NTNs a taxed invoice would print (DHA client, company STRN) so switching tax on in
 * Settings → Tax is one click. Existing invoices are never touched (numbers / totals on dev
 * stay as they are).
 *
 * `SEED_TAX_DEMO=1` (or `enable: true`, tests / a demo database only) also switches tax on at
 * PRA 16 % — invoices issued after that carry the tax line.
 * Idempotent: values already set are kept.
 */
import type { PrismaClient } from '../src/generated/prisma/client.js';

export interface TaxSeedInput {
  tenantId: string;
  dhaProjectId: string;
  enable?: boolean;
}

export async function seedMalikTax(db: PrismaClient, s: TaxSeedInput): Promise<{ enabled: boolean }> {
  const dha = await db.project.findUnique({ where: { id: s.dhaProjectId }, select: { clientId: true } });
  if (dha?.clientId) await db.client.updateMany({ where: { tenantId: s.tenantId, id: dha.clientId, ntn: null }, data: { ntn: '4210187-6' } });
  const settings = await db.tenantSettings.findUnique({ where: { tenantId: s.tenantId } });
  if (!settings?.taxStrn) await db.tenantSettings.upsert({ where: { tenantId: s.tenantId }, create: { tenantId: s.tenantId, taxStrn: '3277876158392' }, update: { taxStrn: '3277876158392' } });
  const enable = s.enable ?? process.env['SEED_TAX_DEMO'] === '1';
  if (enable) {
    await db.tenantSettings.update({ where: { tenantId: s.tenantId }, data: { taxEnabled: true, taxAuthority: 'PRA', taxRatePercent: 16 } });
    await db.tenant.updateMany({ where: { id: s.tenantId, ntn: null }, data: { ntn: '1234567-8' } });
  }
  return { enabled: enable };
}
