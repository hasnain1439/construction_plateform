import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma, Supplier } from '../../generated/prisma/client.js';
import * as repo from './master-data.repository.js';
import type { CreateSupplierInput, ListSuppliersQuery, SetSupplierRatesInput, UpdateSupplierInput } from './master-data.schema.js';
import { audit, conflictOn, current } from './master-data.shared.js';

const notFound = () => new NotFound('SUPPLIER_NOT_FOUND', 'Supplier not found');
const exists = conflictOn('SUPPLIER_EXISTS', 'A supplier with this name already exists');

function toSupplierDto(s: Supplier) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    phone: s.phone,
    city: s.city,
    address: s.address,
    ntn: s.ntn,
    notes: s.notes,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  };
}

async function findSupplier(tx: Tx, id: string) {
  const supplier = await tx.supplier.findUnique({ where: { id } });
  if (!supplier) throw notFound();
  return supplier;
}

async function currentRatesOf(tx: Tx, supplierId: string) {
  const rates = await repo.currentSupplierRates(tx, current().tenantId, supplierId);
  if (!rates.length) return [];
  const materials = new Map(
    (await tx.material.findMany({ where: { id: { in: rates.map((r) => r.materialId) } }, select: { id: true, name: true, unit: true } })).map((m) => [m.id, m]),
  );
  return rates
    .map((r) => ({ material: materials.get(r.materialId)!, ratePaisa: r.ratePaisa.toString(), effectiveFrom: r.effectiveFrom.toISOString(), updatedBy: r.createdByName }))
    .sort((a, b) => a.material.name.localeCompare(b.material.name));
}

export async function listSuppliers(query: ListSuppliersQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const and: Prisma.SupplierWhereInput[] = [];
    if (query.search) {
      const digits = query.search.replace(/\D/g, '').replace(/^0+/, '').replace(/^92/, '');
      and.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { city: { contains: query.search, mode: 'insensitive' } },
          ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
        ],
      });
    }
    if (query.category) and.push({ category: { equals: query.category, mode: 'insensitive' } });
    if (query.isActive !== undefined) and.push({ isActive: query.isActive });
    const where: Prisma.SupplierWhereInput = and.length ? { AND: and } : {};
    const rows = await tx.supplier.findMany({ where, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], ...skipTake(query) });
    const total = await tx.supplier.count({ where });
    return { data: rows.map(toSupplierDto), meta: pageMeta(query, total) };
  });
}

export async function getSupplier(id: string) {
  return withTenant(current().tenantId, async (tx) => ({ ...toSupplierDto(await findSupplier(tx, id)), rates: await currentRatesOf(tx, id) }));
}

export async function createSupplier(input: CreateSupplierInput) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const supplier = await tx.supplier.create({
      data: {
        tenantId,
        name: input.name,
        category: input.category,
        phone: input.phone ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
        ntn: input.ntn ?? null,
        notes: input.notes ?? null,
      },
    });
    await audit(tx, 'supplier.create', 'Supplier', supplier.id, { name: supplier.name, category: supplier.category });
    return toSupplierDto(supplier);
  }).catch(exists);
}

export async function updateSupplier(id: string, input: UpdateSupplierInput) {
  return withTenant(current().tenantId, async (tx) => {
    await findSupplier(tx, id);
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Prisma.SupplierUpdateInput;
    const updated = await tx.supplier.update({ where: { id }, data });
    await audit(tx, 'supplier.update', 'Supplier', id, { name: updated.name, fields: Object.keys(data) });
    return toSupplierDto(updated);
  }).catch(exists);
}

export async function setActive(id: string, isActive: boolean) {
  return withTenant(current().tenantId, async (tx) => {
    const supplier = await findSupplier(tx, id);
    if (supplier.isActive === isActive) return toSupplierDto(supplier);
    const updated = await tx.supplier.update({ where: { id }, data: { isActive } });
    await audit(tx, isActive ? 'supplier.activate' : 'supplier.deactivate', 'Supplier', id, { name: supplier.name });
    return toSupplierDto(updated);
  });
}

export async function getRates(id: string) {
  return withTenant(current().tenantId, async (tx) => {
    const supplier = await findSupplier(tx, id);
    const history = await tx.supplierRate.findMany({
      where: { supplierId: id },
      include: { material: { select: { id: true, name: true, unit: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return {
      supplier: { id: supplier.id, name: supplier.name },
      current: await currentRatesOf(tx, id),
      history: history.map((h) => ({
        id: h.id,
        material: h.material,
        ratePaisa: h.ratePaisa.toString(),
        effectiveFrom: h.effectiveFrom.toISOString(),
        changedBy: h.createdBy,
      })),
    };
  });
}

export async function setRates(id: string, input: SetSupplierRatesInput) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const supplier = await findSupplier(tx, id);
    const ids = input.rates.map((r) => r.materialId);
    const found = new Set((await tx.material.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((m) => m.id));
    const unknown = ids.filter((m) => !found.has(m));
    if (unknown.length) throw new BadRequest('INVALID_MATERIAL', 'Some materials were not found', { materialIds: unknown });

    const existing = new Map((await repo.currentSupplierRates(tx, tenantId, id)).map((r) => [r.materialId, r.ratePaisa]));
    const now = await repo.dbNow(tx);
    const rows = input.rates
      .filter((r) => existing.get(r.materialId) !== r.ratePaisa)
      .map((r) => ({ tenantId, supplierId: id, materialId: r.materialId, ratePaisa: r.ratePaisa, effectiveFrom: now, createdById: userId }));
    if (rows.length) await tx.supplierRate.createMany({ data: rows });
    const result = { changed: rows.length, unchanged: input.rates.length - rows.length };
    await audit(tx, 'supplier.rates_update', 'Supplier', id, { name: supplier.name, ...result });
    return { ...result, current: await currentRatesOf(tx, id) };
  });
}
