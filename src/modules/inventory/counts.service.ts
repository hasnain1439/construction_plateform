/** Physical stock counts: the difference to the system becomes a COUNT_ADJUSTMENT. */
import { NUMBER_FORMATS, nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Forbidden } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { assertEditable, findProjectFor } from '../projects/access.js';
import type { StockCountInput, StockCountsQuery } from './inventory.schema.js';
import { visibleLocation, visibleLocations } from './inventory.service.js';
import {
  actor,
  audit,
  balanceOf,
  currentCost,
  findLocation,
  isOwnerSupplied,
  loadMaterials,
  locationRef,
  lockLocations,
  materialRef,
  ownerSuppliedCategories,
  postIn,
  postOut,
  qn,
  type Actor,
} from './stock.js';
import { STOCK_OPEN_STATUSES } from './usage.service.js';

const countInclude = {
  location: { select: { id: true, type: true, name: true, projectId: true } },
  items: { include: { material: { select: { id: true, name: true, unit: true } } } },
  createdBy: { select: { id: true, name: true } },
} as const;

type CountRow = Prisma.StockCountGetPayload<{ include: typeof countInclude }>;

function toCountDto(c: CountRow, a: Pick<Actor, 'seesRates'>) {
  return {
    id: c.id,
    number: c.number,
    location: c.location,
    countedAt: c.countedAt.toISOString(),
    note: c.note,
    items: c.items.map((i) => ({
      material: materialRef(i.material),
      ownerSupplied: i.ownerSupplied,
      systemQty: qn(i.systemQty),
      countedQty: qn(i.countedQty),
      difference: qn(i.difference),
      reason: i.reason,
      note: i.note,
      ...(a.seesRates ? { valuePaisa: i.valuePaisa.toString() } : {}),
    })),
    summary: {
      materials: c.items.length,
      withDifference: c.items.filter((i) => !i.difference.eq(0)).length,
      ...(a.seesRates ? { differenceValuePaisa: c.items.reduce((s, i) => s + i.valuePaisa, 0n).toString() } : {}),
    },
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function createCountTx(tx: Tx, a: Actor, input: StockCountInput, opts: { at?: Date } = {}) {
  const target = await findLocation(tx, a.tenantId, input.locationId);
  if (target.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Stock in transit is counted when it is received');
  if (target.type === 'STORE' && a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner can count the store');
  const location = await visibleLocation(tx, a, target.id);
  let ownerCats = new Set<string>();
  if (location.type === 'SITE') {
    const project = await findProjectFor(tx, a, location.projectId!);
    assertEditable(project, [...STOCK_OPEN_STATUSES]);
    ownerCats = await ownerSuppliedCategories(tx, a.tenantId, project.id);
  }
  const countedAt = opts.at ?? (input.countedAt ? new Date(input.countedAt) : new Date());
  if (countedAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequest('DATE_IN_FUTURE', 'The count time cannot be in the future');
  const materials = await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));

  await lockLocations(tx, [location.id]);
  const lines = [];
  for (const item of input.items) {
    const bucket = {
      locationId: location.id,
      materialId: item.materialId,
      ownerSupplied: item.ownerSupplied ?? (location.type === 'SITE' && isOwnerSupplied(materials.get(item.materialId)!, ownerCats)),
    };
    const system = (await balanceOf(tx, a.tenantId, bucket)).qty;
    const difference = item.countedQty.sub(system);
    if (!difference.eq(0) && !item.reason) {
      throw new BadRequest('REASON_REQUIRED', `Give a reason for the difference in ${materials.get(item.materialId)!.name}`, {
        materialId: item.materialId,
        systemQty: qn(system),
        countedQty: qn(item.countedQty),
      });
    }
    lines.push({ item, bucket, system, difference });
  }

  const number = await nextNumber(tx, a.tenantId, NUMBER_FORMATS.stockCount, countedAt);
  const count = await tx.stockCount.create({
    data: { tenantId: a.tenantId, number, locationId: location.id, countedAt, note: input.note ?? null, createdById: a.userId },
  });
  for (const l of lines) {
    const ref = { type: 'COUNT_ADJUSTMENT' as const, refType: 'STOCK_COUNT', refId: count.id, occurredAt: countedAt, createdById: a.userId, note: l.item.reason ?? null };
    let value = 0n;
    if (l.difference.lt(0)) value = -(await postOut(tx, a.tenantId, l.bucket, l.difference.neg(), ref)).valuePaisa;
    else if (l.difference.gt(0)) value = await postIn(tx, a.tenantId, l.bucket, l.difference, await currentCost(tx, a.tenantId, l.bucket), ref);
    await tx.stockCountItem.create({
      data: {
        tenantId: a.tenantId,
        countId: count.id,
        materialId: l.item.materialId,
        ownerSupplied: l.bucket.ownerSupplied,
        systemQty: l.system,
        countedQty: l.item.countedQty,
        difference: l.difference,
        reason: l.difference.eq(0) ? null : l.item.reason!,
        note: l.item.note ?? null,
        valuePaisa: value,
      },
    });
  }
  await audit(tx, a, 'stock.count', 'StockCount', count.id, {
    number,
    location: locationRef(location),
    differences: lines.filter((l) => !l.difference.eq(0)).map((l) => ({ materialId: l.item.materialId, difference: qn(l.difference), reason: l.item.reason ?? null })),
  });
  return toCountDto(await tx.stockCount.findUniqueOrThrow({ where: { id: count.id }, include: countInclude }), a);
}

export async function createCount(input: StockCountInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createCountTx(tx, a, input));
}

export async function listCounts(query: StockCountsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.StockCountWhereInput = { tenantId: a.tenantId };
    if (query.locationId) where.locationId = (await visibleLocation(tx, a, query.locationId)).id;
    else if (query.projectId) {
      const project = await findProjectFor(tx, a, query.projectId);
      where.location = { projectId: project.id };
    } else if (a.role !== 'THEKEDAR') where.locationId = { in: (await visibleLocations(tx, a)).map((l) => l.id) };
    const rows = await tx.stockCount.findMany({ where, include: countInclude, orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.stockCount.count({ where });
    return { data: rows.map((c) => toCountDto(c, a)), meta: pageMeta(query, total) };
  });
}
