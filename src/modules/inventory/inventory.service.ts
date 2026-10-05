/** Stock locations, store stock, low-stock levels, the movement log and per-project site stock. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma, StockLocation } from '../../generated/prisma/client.js';
import { findProjectFor, projectScope } from '../projects/access.js';
import type { LowStockLevelsInput, MovementsQuery, StoreStockQuery } from './inventory.schema.js';
import {
  actor,
  audit,
  avgOf,
  balances,
  D,
  findLocation,
  iso,
  locationRef,
  materialRef,
  paisa,
  qn,
  siteLocation,
  systemLocations,
  ZERO,
  type Actor,
  type Dec,
} from './stock.js';

// ─── Location scope ─────────────────────────────────────────────────────────

/** Creates the site location of every non-draft project in scope that doesn't have one yet. */
async function ensureSites(tx: Tx, a: Actor) {
  const missing = await tx.project.findMany({
    where: {
      tenantId: a.tenantId,
      status: { not: 'DRAFT' },
      stockLocation: null,
      ...projectScope(a),
    },
    select: { id: true, name: true, status: true },
  });
  for (const p of missing) await siteLocation(tx, a.tenantId, p);
}

/**
 * Locations the caller may see: THEKEDAR everything; PM the store, transit and their
 * project sites; MUNSHI only their project sites.
 */
export async function visibleLocations(tx: Tx, a: Actor): Promise<StockLocation[]> {
  await systemLocations(tx, a.tenantId);
  await ensureSites(tx, a);
  const sites: Prisma.StockLocationWhereInput = a.role === 'THEKEDAR' ? { type: 'SITE' } : { type: 'SITE', project: projectScope(a) };
  const where: Prisma.StockLocationWhereInput =
    a.role === 'MUNSHI'
      ? { tenantId: a.tenantId, ...sites }
      : {
          tenantId: a.tenantId,
          OR: [{ type: { in: ['STORE', 'TRANSIT'] } }, sites],
        };
  return tx.stockLocation.findMany({
    where,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
}

/** A location the caller may see, else 404 (never 403, like projects). */
export async function visibleLocation(tx: Tx, a: Actor, id: string): Promise<StockLocation> {
  const location = await findLocation(tx, a.tenantId, id);
  if (location.type === 'SITE') {
    if (a.role !== 'THEKEDAR')
      await findProjectFor(tx, a, location.projectId!).catch(() => {
        throw new NotFound('LOCATION_NOT_FOUND', 'Stock location not found');
      });
  } else if (a.role === 'MUNSHI') {
    throw new NotFound('LOCATION_NOT_FOUND', 'Stock location not found');
  }
  return location;
}

export async function listLocations() {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const rows = await visibleLocations(tx, a);
    const projects = new Map(
      (
        await tx.project.findMany({
          where: {
            tenantId: a.tenantId,
            id: { in: rows.flatMap((r) => (r.projectId ? [r.projectId] : [])) },
          },
          select: { id: true, code: true, name: true, status: true },
        })
      ).map((p) => [p.id, p]),
    );
    return rows.map((r) => ({
      ...locationRef(r),
      isActive: r.isActive,
      project: r.projectId ? (projects.get(r.projectId) ?? null) : null,
    }));
  });
}

// ─── Store stock ────────────────────────────────────────────────────────────

/** Quantity still in transit per material for dispatches that left `fromLocationId`. */
async function inTransitFrom(tx: Tx, tenantId: string, fromLocationId: string) {
  const rows = await tx.dispatchItem.groupBy({
    by: ['materialId'],
    where: { tenantId, dispatch: { fromLocationId, status: 'ON_THE_WAY' } },
    _sum: { sentQty: true },
  });
  return new Map(rows.map((r) => [r.materialId, r._sum.sentQty ?? ZERO]));
}

export async function storeStock(locationId: string, query: StoreStockQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await systemLocations(tx, a.tenantId);
    const location = await findLocation(tx, a.tenantId, locationId);
    if (location.type !== 'STORE') throw new NotFound('STORE_NOT_FOUND', 'Store not found');

    const bal = await balances(tx, a.tenantId, { locationIds: [location.id] });
    const transit = await inTransitFrom(tx, a.tenantId, location.id);
    const levels = new Map(
      (
        await tx.lowStockLevel.findMany({
          where: { tenantId: a.tenantId, locationId: location.id },
        })
      ).map((l) => [l.materialId, l.minQty]),
    );
    const lastPurchase = new Map(
      (
        await tx.stockMovement.groupBy({
          by: ['materialId'],
          where: {
            tenantId: a.tenantId,
            locationId: location.id,
            type: 'PURCHASE_IN',
          },
          _max: { occurredAt: true },
        })
      ).map((r) => [r.materialId, r._max.occurredAt]),
    );

    const ids = [...new Set([...bal.map((b) => b.materialId), ...transit.keys(), ...levels.keys()])];
    const materials = await tx.material.findMany({
      where: { tenantId: a.tenantId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        unit: true,
        group: { select: { code: true, name: true } },
      },
    });

    const rows = materials.map((m) => {
      const own = bal.filter((b) => b.materialId === m.id);
      const qty = own.reduce<Dec>((s, b) => s.add(b.qty), ZERO);
      const contractor = own.find((b) => !b.ownerSupplied);
      const value = contractor?.value ?? 0n;
      const minQty = levels.get(m.id) ?? null;
      return {
        material: { ...materialRef(m), group: m.group },
        inStore: qn(qty),
        inTransit: qn(transit.get(m.id) ?? ZERO),
        avgRatePaisa: paisa(avgOf(contractor?.qty ?? ZERO, value)),
        valuePaisa: paisa(value),
        lastPurchaseAt: iso(lastPurchase.get(m.id)),
        minQty: minQty === null ? null : qn(minQty),
        lowStock: minQty !== null && qty.lt(minQty),
        _value: value,
      };
    });
    const search = query.search?.toLowerCase();
    const items = rows
      .filter((r) => (search ? r.material.name.toLowerCase().includes(search) : true))
      .filter((r) => (query.lowStockOnly ? r.lowStock : true))
      .sort((x, y) => x.material.name.localeCompare(y.material.name));

    const dispatchesOnTheWay = await tx.dispatch.count({
      where: {
        tenantId: a.tenantId,
        fromLocationId: location.id,
        status: 'ON_THE_WAY',
      },
    });
    return {
      location: locationRef(location),
      summary: {
        totalValuePaisa: rows.reduce((s, r) => s + r._value, 0n).toString(),
        materials: rows.filter((r) => r.inStore !== 0).length,
        lowStockCount: rows.filter((r) => r.lowStock).length,
        dispatchesOnTheWay,
      },
      items: items.map(({ _value, ...r }) => r),
    };
  });
}

export async function setLowStockLevels(locationId: string, input: LowStockLevelsInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => setLowStockLevelsTx(tx, a, locationId, input));
}

export async function setLowStockLevelsTx(tx: Tx, a: Actor, locationId: string, input: LowStockLevelsInput) {
  const location = await findLocation(tx, a.tenantId, locationId);
  if (location.type === 'TRANSIT') throw new NotFound('LOCATION_NOT_FOUND', 'Stock location not found');
  const ids = input.map((l) => l.materialId);
  const found = new Set(
    (
      await tx.material.findMany({
        where: { tenantId: a.tenantId, id: { in: ids } },
        select: { id: true },
      })
    ).map((m) => m.id),
  );
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length)
    throw new NotFound('INVALID_MATERIAL', 'Some materials were not found', {
      materialIds: unknown,
    });

  for (const l of input) {
    if (l.minQty.eq(0)) {
      await tx.lowStockLevel.deleteMany({
        where: { tenantId: a.tenantId, locationId, materialId: l.materialId },
      });
    } else {
      await tx.lowStockLevel.upsert({
        where: {
          locationId_materialId: { locationId, materialId: l.materialId },
        },
        create: {
          tenantId: a.tenantId,
          locationId,
          materialId: l.materialId,
          minQty: l.minQty,
        },
        update: { minQty: l.minQty },
      });
    }
  }
  await audit(tx, a, 'stock.low_levels_update', 'StockLocation', locationId, {
    levels: input.map((l) => ({
      materialId: l.materialId,
      minQty: qn(l.minQty),
    })),
  });
  const levels = await tx.lowStockLevel.findMany({
    where: { tenantId: a.tenantId, locationId },
    include: { material: { select: { id: true, name: true, unit: true } } },
  });
  return levels.map((l) => ({ material: l.material, minQty: qn(l.minQty) })).sort((x, y) => x.material.name.localeCompare(y.material.name));
}

// ─── Movement log ───────────────────────────────────────────────────────────

const PKT_OFFSET_MS = 5 * 3_600_000;
/** Start of a calendar day in Pakistan time. */
export const pktDayStart = (date: string) => new Date(dateOnly(date).getTime() - PKT_OFFSET_MS);
export const pktDayEnd = (date: string) => new Date(dateOnly(date).getTime() - PKT_OFFSET_MS + 86_400_000);

export async function listMovements(query: MovementsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.StockMovementWhereInput = { tenantId: a.tenantId };
    if (query.locationId) where.locationId = (await visibleLocation(tx, a, query.locationId)).id;
    else if (query.projectId) {
      const project = await findProjectFor(tx, a, query.projectId);
      where.locationId = project.status === 'DRAFT' ? '00000000-0000-0000-0000-000000000000' : (await siteLocation(tx, a.tenantId, project)).id;
    } else if (a.role !== 'THEKEDAR')
      where.locationId = {
        in: (await visibleLocations(tx, a)).map((l) => l.id),
      };
    if (query.materialId) where.materialId = query.materialId;
    if (query.type) where.type = query.type;
    if (query.from || query.to)
      where.occurredAt = {
        ...(query.from ? { gte: pktDayStart(query.from) } : {}),
        ...(query.to ? { lt: pktDayEnd(query.to) } : {}),
      };

    const rows = await tx.stockMovement.findMany({
      where,
      include: {
        location: {
          select: { id: true, type: true, name: true, projectId: true },
        },
        material: { select: { id: true, name: true, unit: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      ...skipTake(query),
    });
    const total = await tx.stockMovement.count({ where });
    return {
      data: rows.map((m) => ({
        id: m.id,
        type: m.type,
        location: m.location,
        material: m.material,
        quantity: qn(m.quantity),
        ownerSupplied: m.ownerSupplied,
        ...(a.seesRates
          ? {
              unitCostPaisa: m.unitCostPaisa.toString(),
              valuePaisa: m.valuePaisa.toString(),
            }
          : {}),
        refType: m.refType,
        refId: m.refId,
        note: m.note,
        occurredAt: m.occurredAt.toISOString(),
        createdBy: m.createdBy,
      })),
      meta: pageMeta(query, total),
    };
  });
}

// ─── Project (site) stock ───────────────────────────────────────────────────

const RECEIVED_TYPES = new Set(['PURCHASE_IN', 'RECEIPT_IN']);
const ADJUSTMENT_TYPES = new Set(['COUNT_ADJUSTMENT', 'CORRECTION', 'PURCHASE_RETURN_OUT']);

export async function projectStock(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await findProjectFor(tx, a, projectId);
    if (project.status === 'DRAFT') {
      return {
        project: { id: project.id, code: project.code, name: project.name },
        location: null,
        summary: {
          materials: 0,
          lastCountAt: null,
          ...(a.seesRates ? { totalValuePaisa: '0' } : {}),
        },
        items: [],
      };
    }
    const location = await siteLocation(tx, a.tenantId, project);
    const grouped = await tx.stockMovement.groupBy({
      by: ['materialId', 'ownerSupplied', 'type'],
      where: { tenantId: a.tenantId, locationId: location.id },
      _sum: { quantity: true, valuePaisa: true },
    });
    const counts = await tx.stockCountItem.findMany({
      where: { tenantId: a.tenantId, count: { locationId: location.id } },
      select: { materialId: true, count: { select: { countedAt: true } } },
    });
    const lastCount = new Map<string, Date>();
    for (const c of counts) {
      const prev = lastCount.get(c.materialId);
      if (!prev || c.count.countedAt > prev) lastCount.set(c.materialId, c.count.countedAt);
    }
    const ids = [...new Set(grouped.map((g) => g.materialId))];
    const materials = await tx.material.findMany({
      where: { tenantId: a.tenantId, id: { in: ids } },
      select: { id: true, name: true, unit: true },
    });

    let totalValue = 0n;
    const items = materials
      .map((m) => {
        const rows = grouped.filter((g) => g.materialId === m.id);
        const sum = (pred: (g: (typeof rows)[number]) => boolean) => rows.filter(pred).reduce<Dec>((s, g) => s.add(g._sum.quantity ?? ZERO), ZERO);
        const contractorQty = sum((g) => !g.ownerSupplied);
        const contractorValue = rows.filter((g) => !g.ownerSupplied).reduce((s, g) => s + (g._sum.valuePaisa ?? 0n), 0n);
        totalValue += contractorValue;
        const ownerQty = sum((g) => g.ownerSupplied);
        return {
          material: m,
          receivedContractor: qn(sum((g) => !g.ownerSupplied && RECEIVED_TYPES.has(g.type))),
          receivedOwner: qn(sum((g) => g.type === 'OWNER_DELIVERY_IN')),
          used: qn(sum((g) => g.type === 'USAGE_OUT').neg()),
          transferredOut: qn(sum((g) => g.type === 'DISPATCH_OUT').neg()),
          adjustments: qn(sum((g) => ADJUSTMENT_TYPES.has(g.type))),
          inStock: qn(contractorQty.add(ownerQty)),
          inStockContractor: qn(contractorQty),
          inStockOwner: qn(ownerQty),
          lastCountAt: iso(lastCount.get(m.id)),
          ...(a.seesRates
            ? {
                avgRatePaisa: paisa(avgOf(contractorQty, contractorValue)),
                valuePaisa: contractorValue.toString(),
              }
            : {}),
        };
      })
      .sort((x, y) => x.material.name.localeCompare(y.material.name));

    const latest = [...lastCount.values()].sort((x, y) => y.getTime() - x.getTime())[0];
    return {
      project: { id: project.id, code: project.code, name: project.name },
      location: locationRef(location),
      summary: {
        materials: items.filter((i) => i.inStock !== 0).length,
        lastCountAt: iso(latest),
        ...(a.seesRates ? { totalValuePaisa: totalValue.toString() } : {}),
      },
      items,
    };
  });
}

/** Store-level actions (count the store, set its levels) are the owner's. */
export function assertOwner(a: Actor, message = 'Only the owner can do this') {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', message);
}
