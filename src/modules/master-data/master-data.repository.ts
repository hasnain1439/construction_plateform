import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';

export interface CurrentRateRow {
  materialId: string;
  ratePaisa: bigint;
  specification: string | null;
  effectiveFrom: Date;
  createdById: string | null;
  createdByName: string | null;
}

/**
 * Current rate per material in one quality category: the row with the latest
 * effectiveFrom ≤ now (ties → newest createdAt). RLS limits it to the tenant; the
 * explicit tenantId keeps it correct even outside withTenant.
 */
export function currentRates(tx: Tx, tenantId: string, categoryId: string, materialIds?: string[]): Promise<CurrentRateRow[]> {
  const only = materialIds ? Prisma.sql`AND r."materialId" IN (${Prisma.join(materialIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
  if (materialIds && materialIds.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<CurrentRateRow[]>`
    SELECT DISTINCT ON (r."materialId")
           r."materialId", r."ratePaisa", r.specification, r."effectiveFrom", r."createdById", u.name AS "createdByName"
    FROM "MaterialRate" r
    LEFT JOIN "User" u ON u.id = r."createdById" AND u."tenantId" = r."tenantId"
    WHERE r."tenantId" = ${tenantId}::uuid AND r."categoryId" = ${categoryId}::uuid AND r."effectiveFrom" <= now() ${only}
    ORDER BY r."materialId", r."effectiveFrom" DESC, r."createdAt" DESC`;
}

/** Current agreed rate per material for one supplier. */
export function currentSupplierRates(tx: Tx, tenantId: string, supplierId: string) {
  return tx.$queryRaw<Array<{ materialId: string; ratePaisa: bigint; effectiveFrom: Date; createdByName: string | null }>>`
    SELECT DISTINCT ON (r."materialId") r."materialId", r."ratePaisa", r."effectiveFrom", u.name AS "createdByName"
    FROM "SupplierRate" r
    LEFT JOIN "User" u ON u.id = r."createdById" AND u."tenantId" = r."tenantId"
    WHERE r."tenantId" = ${tenantId}::uuid AND r."supplierId" = ${supplierId}::uuid AND r."effectiveFrom" <= now()
    ORDER BY r."materialId", r."effectiveFrom" DESC, r."createdAt" DESC`;
}

export const groupRef = { select: { id: true, code: true, name: true, section: true } } as const;

export async function materialHasRates(tx: Tx, materialId: string) {
  // Sequential: one transaction connection can't run two queries at once
  if (await tx.materialRate.findFirst({ where: { materialId }, select: { id: true } })) return true;
  return Boolean(await tx.supplierRate.findFirst({ where: { materialId }, select: { id: true } }));
}

export function defaultCategory(tx: Tx) {
  return tx.qualityCategory.findFirst({ where: { isDefault: true, isArchived: false } });
}

/**
 * The database clock (transaction start). New rate rows use it as effectiveFrom so the
 * "effectiveFrom ≤ now()" check never trips over app/DB clock drift.
 */
export async function dbNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return row!.now;
}
