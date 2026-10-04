import type { Prisma } from '../../generated/prisma/client.js';
import { DEFAULT_CATEGORIES, DEFAULT_LABOR_RATES, RESIDENTIAL_STANDARD } from './catalog.js';

type Tx = Prisma.TransactionClient;

export interface ProvisionResult {
  materials: number;
  categories: number;
  laborRates: number;
  templates: number;
}

/**
 * Gives a company its starting master data. Idempotent — safe for new companies
 * (signup, admin create) and for backfilling existing ones:
 *  - every active platform material (skips names / catalog rows it already has),
 *  - quality categories A+ Premium / A Standard (default) / B Economy (only if it has none),
 *  - default labour rates (skips kinds/keys it already has),
 *  - the "Residential standard" billing template (only if it has none).
 * All writes carry tenantId explicitly, so this works with withTenant or the admin (BYPASSRLS) client.
 */
export async function provisionMasterData(tx: Tx, tenantId: string): Promise<ProvisionResult> {
  const platform = await tx.platformMaterial.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const materials = await tx.material.createMany({
    data: platform.map((p) => ({
      tenantId,
      platformMaterialId: p.id,
      groupId: p.groupId,
      name: p.name,
      unit: p.unit,
      unitDetail: p.unitDetail,
      altUnits: p.altUnits ?? [],
      supplyCategory: p.supplyCategory,
      source: 'PLATFORM' as const,
    })),
    skipDuplicates: true,
  });

  let categories = 0;
  if ((await tx.qualityCategory.count({ where: { tenantId } })) === 0) {
    categories = (await tx.qualityCategory.createMany({ data: DEFAULT_CATEGORIES.map((c) => ({ ...c, tenantId })) })).count;
  }

  const laborRates = await tx.laborRate.createMany({
    data: DEFAULT_LABOR_RATES.map((r) => ({
      tenantId,
      kind: r.kind,
      key: r.key,
      label: r.label,
      unit: r.unit,
      ratePaisa: r.ratePaisa,
      overtimeMultiplier: r.overtimeMultiplier ?? null,
    })),
    skipDuplicates: true,
  });

  let templates = 0;
  if ((await tx.paymentScheduleTemplate.count({ where: { tenantId } })) === 0) {
    await tx.paymentScheduleTemplate.create({
      data: {
        tenantId,
        name: RESIDENTIAL_STANDARD.name,
        billingModel: RESIDENTIAL_STANDARD.billingModel,
        stages: RESIDENTIAL_STANDARD.stages as unknown as Prisma.InputJsonValue,
        isDefault: true,
      },
    });
    templates = 1;
  }

  return { materials: materials.count, categories, laborRates: laborRates.count, templates };
}
