/** Platform material catalog (shared by all companies). */
import { Prisma, prismaAdmin } from '../../core/db/prisma.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import type { PlatformMaterial } from '../../generated/prisma/client.js';
import { auditAdmin } from './platformAdmin.shared.js';
import type { CatalogMaterialsQuery, CreateCatalogMaterialInput, UpdateCatalogMaterialInput } from './platformAdmin.schema.js';

function toDto(m: PlatformMaterial & { group: { id: string; code: string; name: string } }, companies?: number) {
  return {
    id: m.id,
    group: m.group,
    name: m.name,
    unit: m.unit,
    unitDetail: m.unitDetail,
    altUnits: m.altUnits,
    supplyCategory: m.supplyCategory,
    usedByRulebook: m.usedByRulebook,
    rulebookKey: m.rulebookKey,
    isActive: m.isActive,
    sortOrder: m.sortOrder,
    ...(companies === undefined ? {} : { companies }),
  };
}

const groupSelect = { select: { id: true, code: true, name: true } } as const;

export async function listGroups() {
  const groups = await prismaAdmin.materialGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { _count: { select: { platformMaterials: true } } } });
  return groups.map((g) => ({ id: g.id, code: g.code, name: g.name, section: g.section, sortOrder: g.sortOrder, materials: g._count.platformMaterials }));
}

export async function listMaterials(query: CatalogMaterialsQuery) {
  const rows = await prismaAdmin.platformMaterial.findMany({
    where: {
      ...(query.groupId ? { groupId: query.groupId } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.supplyCategory ? { supplyCategory: query.supplyCategory } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    },
    include: { group: groupSelect, _count: { select: { copies: true } } },
    orderBy: [{ group: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((m) => toDto(m, m._count.copies));
}

/** Creates a catalog material and (by default) adds it to every company that doesn't have that name yet. */
export async function createMaterial(input: CreateCatalogMaterialInput) {
  try {
    return await prismaAdmin.$transaction(async (tx) => {
      const group = await tx.materialGroup.findUnique({ where: { id: input.groupId } });
      if (!group) throw new BadRequest('INVALID_GROUP', 'Material group not found');
      const sortOrder = input.sortOrder ?? ((await tx.platformMaterial.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
      const material = await tx.platformMaterial.create({
        data: {
          groupId: input.groupId,
          name: input.name,
          unit: input.unit,
          unitDetail: input.unitDetail ?? null,
          altUnits: input.altUnits,
          supplyCategory: input.supplyCategory,
          usedByRulebook: input.usedByRulebook,
          rulebookKey: input.rulebookKey ?? null,
          sortOrder,
        },
        include: { group: groupSelect },
      });

      let pushedTo = 0;
      if (input.pushToTenants) {
        const tenants = await tx.tenant.findMany({ select: { id: true } });
        pushedTo = (
          await tx.material.createMany({
            data: tenants.map((t) => ({
              tenantId: t.id,
              platformMaterialId: material.id,
              groupId: material.groupId,
              name: material.name,
              unit: material.unit,
              unitDetail: material.unitDetail,
              altUnits: input.altUnits,
              supplyCategory: material.supplyCategory,
              source: 'PLATFORM' as const,
            })),
            skipDuplicates: true, // a company with its own material of the same name keeps it
          })
        ).count;
      }
      await auditAdmin(tx, {
        action: 'admin.catalog_material_created',
        entityType: 'PlatformMaterial',
        entityId: material.id,
        details: { name: material.name, unit: material.unit, pushedTo },
      });
      return { ...toDto(material), pushedTo };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new Conflict('PLATFORM_MATERIAL_EXISTS', 'A catalog material with this name (or rulebook key) already exists');
    }
    throw err;
  }
}

/**
 * Updates a catalog material. Name / unitDetail / altUnits flow into company copies
 * that were never customised (and whose new name doesn't clash with one of their own).
 * The unit is immutable.
 */
export async function updateMaterial(id: string, input: UpdateCatalogMaterialInput) {
  try {
    return await prismaAdmin.$transaction(async (tx) => {
      const current = await tx.platformMaterial.findUnique({ where: { id } });
      if (!current) throw new NotFound('PLATFORM_MATERIAL_NOT_FOUND', 'Catalog material not found');
      const updated = await tx.platformMaterial.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.unitDetail !== undefined ? { unitDetail: input.unitDetail } : {}),
          ...(input.altUnits !== undefined ? { altUnits: input.altUnits } : {}),
          ...(input.supplyCategory !== undefined ? { supplyCategory: input.supplyCategory } : {}),
          ...(input.usedByRulebook !== undefined ? { usedByRulebook: input.usedByRulebook } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
        include: { group: groupSelect },
      });

      let propagatedTo = 0;
      if (input.name !== undefined || input.unitDetail !== undefined || input.altUnits !== undefined) {
        propagatedTo = await tx.$executeRaw`
          UPDATE "Material" m
          SET name = ${updated.name}, "unitDetail" = ${updated.unitDetail},
              "altUnits" = ${JSON.stringify(updated.altUnits)}::jsonb, "updatedAt" = now()
          WHERE m."platformMaterialId" = ${id}::uuid
            AND m."isCustomised" = false
            AND NOT EXISTS (
              SELECT 1 FROM "Material" o WHERE o."tenantId" = m."tenantId" AND o.name = ${updated.name} AND o.id <> m.id
            )`;
      }
      const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      await auditAdmin(tx, {
        action: 'admin.catalog_material_updated',
        entityType: 'PlatformMaterial',
        entityId: id,
        details: { name: current.name, changes: changes as Prisma.InputJsonObject, propagatedTo },
      });
      return { ...toDto(updated), propagatedTo };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new Conflict('PLATFORM_MATERIAL_EXISTS', 'A catalog material with this name already exists');
    }
    throw err;
  }
}
