import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import type { Material, MaterialGroup, Prisma } from '../../generated/prisma/client.js';
import * as repo from './master-data.repository.js';
import type { CreateMaterialInput, ListMaterialsQuery, UpdateMaterialInput } from './master-data.schema.js';
import { audit, conflictOn, current } from './master-data.shared.js';

type MaterialWithGroup = Material & { group: Pick<MaterialGroup, 'id' | 'code' | 'name' | 'section'> };

/** Material row as every role sees it — never carries rates. */
export function toMaterialDto(m: MaterialWithGroup) {
  return {
    id: m.id,
    name: m.name,
    group: m.group,
    unit: m.unit,
    unitDetail: m.unitDetail,
    altUnits: m.altUnits,
    supplyCategory: m.supplyCategory,
    source: m.source,
    isHidden: m.isHidden,
  };
}

const notFound = () => new NotFound('MATERIAL_NOT_FOUND', 'Material not found');
const exists = conflictOn('MATERIAL_EXISTS', 'A material with this name already exists');

export async function listGroups() {
  return withTenant(current().tenantId, async (tx) => {
    const groups = await tx.materialGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    return groups.map((g) => ({ id: g.id, code: g.code, name: g.name, section: g.section, sortOrder: g.sortOrder }));
  });
}

export async function listMaterials(query: ListMaterialsQuery) {
  const { tenantId, role } = current();
  const includeHidden = Boolean(query.includeHidden) && (role === 'THEKEDAR' || role === 'PM');
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.material.findMany({
      where: {
        ...(includeHidden ? {} : { isHidden: false }),
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.supplyCategory ? { supplyCategory: query.supplyCategory } : {}),
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      },
      include: { group: repo.groupRef },
      orderBy: [{ group: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    return rows.map(toMaterialDto);
  });
}

export async function createMaterial(input: CreateMaterialInput) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const group = await tx.materialGroup.findUnique({ where: { id: input.groupId } });
    if (!group) throw new BadRequest('INVALID_GROUP', 'Material group not found');
    const material = await tx.material.create({
      data: {
        tenantId,
        groupId: group.id,
        name: input.name,
        unit: input.unit,
        unitDetail: input.unitDetail ?? null,
        altUnits: input.altUnits,
        supplyCategory: input.supplyCategory ?? (group.section === 'CIVIL' ? 'GREY_STRUCTURE' : 'FINISHING'),
        source: 'COMPANY',
        createdById: userId,
      },
      include: { group: repo.groupRef },
    });
    await audit(tx, 'material.create', 'Material', material.id, { name: material.name, unit: material.unit });
    return toMaterialDto(material);
  }).catch(exists);
}

export async function updateMaterial(id: string, input: UpdateMaterialInput) {
  return withTenant(current().tenantId, async (tx) => {
    const material = await tx.material.findUnique({ where: { id } });
    if (!material) throw notFound();
    if (input.unit !== undefined && input.unit !== material.unit) {
      if (material.source === 'PLATFORM' || (await repo.materialHasRates(tx, id))) {
        throw new BadRequest('UNIT_LOCKED', 'The unit of a catalog material, or of a material that already has rates, cannot be changed');
      }
    }
    if (input.groupId && !(await tx.materialGroup.findUnique({ where: { id: input.groupId } }))) {
      throw new BadRequest('INVALID_GROUP', 'Material group not found');
    }
    const data: Prisma.MaterialUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.unitDetail !== undefined ? { unitDetail: input.unitDetail } : {}),
      ...(input.altUnits !== undefined ? { altUnits: input.altUnits } : {}),
      ...(input.supplyCategory !== undefined ? { supplyCategory: input.supplyCategory } : {}),
      ...(input.groupId !== undefined ? { group: { connect: { id: input.groupId } } } : {}),
      isCustomised: true,
    };
    const updated = await tx.material.update({ where: { id }, data, include: { group: repo.groupRef } });
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateMaterialInput] !== undefined);
    await audit(tx, 'material.update', 'Material', id, { name: updated.name, fields });
    return toMaterialDto(updated);
  }).catch(exists);
}

export async function setHidden(id: string, isHidden: boolean) {
  return withTenant(current().tenantId, async (tx) => {
    const material = await tx.material.findUnique({ where: { id } });
    if (!material) throw notFound();
    const updated = await tx.material.update({ where: { id }, data: { isHidden }, include: { group: repo.groupRef } });
    if (material.isHidden !== isHidden) await audit(tx, isHidden ? 'material.hide' : 'material.show', 'Material', id, { name: material.name });
    return toMaterialDto(updated);
  });
}

export async function deleteMaterial(id: string) {
  return withTenant(current().tenantId, async (tx) => {
    const material = await tx.material.findUnique({ where: { id } });
    if (!material) throw notFound();
    if (material.source === 'PLATFORM') {
      throw new Conflict('MATERIAL_IN_USE', 'Catalog materials cannot be deleted — hide it instead', { reason: 'PLATFORM_MATERIAL' });
    }
    if (await repo.materialHasRates(tx, id)) {
      throw new Conflict('MATERIAL_IN_USE', 'This material has rates — hide it instead', { reason: 'HAS_RATES' });
    }
    await tx.material.delete({ where: { id } });
    await audit(tx, 'material.delete', 'Material', id, { name: material.name });
    return { id, deleted: true };
  });
}
