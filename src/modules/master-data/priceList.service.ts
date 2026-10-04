/** Quality categories (A+ / A / B …) and the company price list (rate history per material × category). */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import type { QualityCategory } from '../../generated/prisma/client.js';
import * as repo from './master-data.repository.js';
import type {
  BulkPercentInput,
  CreateCategoryInput,
  DuplicateCategoryInput,
  ListCategoriesQuery,
  PriceHistoryQuery,
  PriceListQuery,
  SetPriceListInput,
  UpdateCategoryInput,
} from './master-data.schema.js';
import { audit, conflictOn, current, iso, paisa } from './master-data.shared.js';

const categoryNotFound = () => new NotFound('CATEGORY_NOT_FOUND', 'Quality category not found');
const categoryExists = conflictOn('CATEGORY_EXISTS', 'A quality category with this name or code already exists');

function toCategoryDto(c: QualityCategory, ratedMaterials?: number) {
  return {
    id: c.id,
    name: c.name,
    code: c.code,
    description: c.description,
    isDefault: c.isDefault,
    isArchived: c.isArchived,
    sortOrder: c.sortOrder,
    ...(ratedMaterials === undefined ? {} : { ratedMaterials }),
  };
}

async function findCategory(tx: Tx, id: string, { activeOnly = false } = {}) {
  const category = await tx.qualityCategory.findUnique({ where: { id } });
  if (!category) throw categoryNotFound();
  if (activeOnly && category.isArchived) throw new BadRequest('CATEGORY_ARCHIVED', 'This quality category is archived');
  return category;
}

/** Copies the current rates of `fromId` into `toId` as new history rows. Returns the count. */
async function copyRates(tx: Tx, fromId: string, toId: string) {
  const { tenantId, userId } = current();
  const rates = await repo.currentRates(tx, tenantId, fromId);
  if (!rates.length) return 0;
  const now = await repo.dbNow(tx);
  await tx.materialRate.createMany({
    data: rates.map((r) => ({
      tenantId,
      materialId: r.materialId,
      categoryId: toId,
      ratePaisa: r.ratePaisa,
      specification: r.specification,
      effectiveFrom: now,
      createdById: userId,
    })),
  });
  return rates.length;
}

async function nextSortOrder(tx: Tx) {
  return ((await tx.qualityCategory.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
}

// ─── Quality categories ─────────────────────────────────────────────────────

export async function listCategories(query: ListCategoriesQuery) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const categories = await tx.qualityCategory.findMany({
      where: query.includeArchived ? {} : { isArchived: false },
      orderBy: [{ isArchived: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await tx.$queryRaw<Array<{ categoryId: string; n: bigint }>>`
      SELECT "categoryId", COUNT(DISTINCT "materialId") AS n FROM "MaterialRate" WHERE "tenantId" = ${tenantId}::uuid GROUP BY "categoryId"`;
    const byId = new Map(counts.map((c) => [c.categoryId, Number(c.n)]));
    return categories.map((c) => toCategoryDto(c, byId.get(c.id) ?? 0));
  });
}

async function create(input: DuplicateCategoryInput, copyFrom: string | undefined, action: string) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    if (copyFrom) await findCategory(tx, copyFrom);
    const category = await tx.qualityCategory.create({
      data: { tenantId, name: input.name, code: input.code, description: input.description ?? null, sortOrder: await nextSortOrder(tx) },
    });
    const copiedRates = copyFrom ? await copyRates(tx, copyFrom, category.id) : 0;
    await audit(tx, action, 'QualityCategory', category.id, { name: category.name, code: category.code, copiedFrom: copyFrom ?? null, copiedRates });
    return { ...toCategoryDto(category, copiedRates), copiedRates };
  }).catch(categoryExists);
}

export const createCategory = (input: CreateCategoryInput) => create(input, input.copyRatesFromCategoryId, 'quality_category.create');
export const duplicateCategory = (id: string, input: DuplicateCategoryInput) => create(input, id, 'quality_category.duplicate');

export async function updateCategory(id: string, input: UpdateCategoryInput) {
  return withTenant(current().tenantId, async (tx) => {
    const category = await findCategory(tx, id);
    if (input.isDefault) {
      if (category.isArchived) throw new BadRequest('CATEGORY_ARCHIVED', 'An archived category cannot be the default');
      await tx.qualityCategory.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    }
    const updated = await tx.qualityCategory.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isDefault ? { isDefault: true } : {}),
      },
    });
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateCategoryInput] !== undefined);
    await audit(tx, 'quality_category.update', 'QualityCategory', id, { name: updated.name, fields });
    return toCategoryDto(updated);
  }).catch(categoryExists);
}

export async function archiveCategory(id: string) {
  return withTenant(current().tenantId, async (tx) => {
    const category = await findCategory(tx, id);
    if (category.isArchived) return toCategoryDto(category);
    if (category.isDefault) throw new BadRequest('CATEGORY_IS_DEFAULT', 'Make another category the default before archiving this one');
    if ((await tx.qualityCategory.count({ where: { isArchived: false } })) <= 1) {
      throw new BadRequest('LAST_ACTIVE_CATEGORY', 'At least one quality category must stay active');
    }
    const updated = await tx.qualityCategory.update({ where: { id }, data: { isArchived: true } });
    await audit(tx, 'quality_category.archive', 'QualityCategory', id, { name: category.name });
    return toCategoryDto(updated);
  });
}

// ─── Price list ─────────────────────────────────────────────────────────────

export async function getPriceList(query: PriceListQuery) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const category = query.categoryId ? await findCategory(tx, query.categoryId) : await repo.defaultCategory(tx);
    if (!category) throw categoryNotFound();
    const materials = await tx.material.findMany({
      where: {
        isHidden: false,
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      },
      include: { group: repo.groupRef },
      orderBy: [{ group: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    const rates = new Map((await repo.currentRates(tx, tenantId, category.id)).map((r) => [r.materialId, r]));
    const items = materials.map((m) => {
      const rate = rates.get(m.id);
      return {
        material: { id: m.id, name: m.name, unit: m.unit, unitDetail: m.unitDetail, group: m.group },
        ratePaisa: paisa(rate?.ratePaisa),
        specification: rate?.specification ?? null,
        lastUpdatedAt: iso(rate?.effectiveFrom),
        lastUpdatedBy: rate?.createdById ? { id: rate.createdById, name: rate.createdByName } : null,
      };
    });
    return { category: toCategoryDto(category), items };
  });
}

export async function setPriceList(input: SetPriceListInput) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const category = await findCategory(tx, input.categoryId, { activeOnly: true });
    const ids = input.rates.map((r) => r.materialId);
    const found = new Set((await tx.material.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((m) => m.id));
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length) throw new BadRequest('INVALID_MATERIAL', 'Some materials were not found', { materialIds: unknown });

    const existing = new Map((await repo.currentRates(tx, tenantId, category.id, ids)).map((r) => [r.materialId, r]));
    const now = await repo.dbNow(tx);
    const rows = input.rates.flatMap((r) => {
      const cur = existing.get(r.materialId);
      const specification = r.specification === undefined ? (cur?.specification ?? null) : r.specification || null;
      if (cur && cur.ratePaisa === r.ratePaisa && cur.specification === specification) return [];
      return [{ tenantId, materialId: r.materialId, categoryId: category.id, ratePaisa: r.ratePaisa, specification, effectiveFrom: now, createdById: userId }];
    });
    if (rows.length) await tx.materialRate.createMany({ data: rows });
    const result = { categoryId: category.id, changed: rows.length, unchanged: input.rates.length - rows.length };
    await audit(tx, 'price_list.update', 'QualityCategory', category.id, { category: category.code, changed: result.changed, unchanged: result.unchanged });
    return result;
  });
}

/** Rounds paisa to the nearest whole rupee (half up). */
export function roundToRupee(p: number): bigint {
  return BigInt(Math.round(p / 100) * 100);
}

export async function bulkPercent(input: BulkPercentInput) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const category = await findCategory(tx, input.categoryId, { activeOnly: true });
    let ids: string[] | undefined;
    if (input.groupId || input.materialIds) {
      ids = (
        await tx.material.findMany({
          where: { ...(input.groupId ? { groupId: input.groupId } : {}), ...(input.materialIds ? { id: { in: input.materialIds } } : {}) },
          select: { id: true },
        })
      ).map((m) => m.id);
    }
    const rates = await repo.currentRates(tx, tenantId, category.id, ids);
    const now = await repo.dbNow(tx);
    const rows = rates.flatMap((r) => {
      const next = roundToRupee((Number(r.ratePaisa) * (100 + input.percent)) / 100);
      if (next === r.ratePaisa) return [];
      return [{ tenantId, materialId: r.materialId, categoryId: category.id, ratePaisa: next, specification: r.specification, effectiveFrom: now, createdById: userId }];
    });
    if (rows.length) await tx.materialRate.createMany({ data: rows });
    const result = { categoryId: category.id, percent: input.percent, changed: rows.length, unchanged: rates.length - rows.length };
    await audit(tx, 'price_list.bulk_percent', 'QualityCategory', category.id, {
      category: category.code,
      percent: input.percent,
      groupId: input.groupId ?? null,
      changed: result.changed,
    });
    return result;
  });
}

export async function priceHistory(query: PriceHistoryQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const material = await tx.material.findUnique({ where: { id: query.materialId }, select: { id: true, name: true, unit: true } });
    if (!material) throw new NotFound('MATERIAL_NOT_FOUND', 'Material not found');
    const rows = await tx.materialRate.findMany({
      where: { materialId: query.materialId, ...(query.categoryId ? { categoryId: query.categoryId } : {}) },
      include: { category: { select: { id: true, name: true, code: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return {
      material,
      history: rows.map((r) => ({
        id: r.id,
        category: r.category,
        ratePaisa: r.ratePaisa.toString(),
        specification: r.specification,
        effectiveFrom: r.effectiveFrom.toISOString(),
        changedBy: r.createdBy,
      })),
    };
  });
}
