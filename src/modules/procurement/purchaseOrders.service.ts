/** Purchase orders. The status follows the purchases linked to the order. */
import { NUMBER_FORMATS, nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma, PurchaseOrderStatus } from '../../generated/prisma/client.js';
import { STOCK_OPEN_STATUSES } from '../inventory/usage.service.js';
import { actor, audit, loadMaterials, qn, siteLocation, systemLocations, valueOf, ZERO, type Actor, type Dec } from '../inventory/stock.js';
import { assertEditable, findProjectFor, projectScope } from '../projects/access.js';
import type { CreatePurchaseOrderInput, ListPurchaseOrdersQuery, UpdatePurchaseOrderInput } from './procurement.schema.js';

const poNotFound = () => new NotFound('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found');

const poInclude = {
  supplier: { select: { id: true, name: true, phone: true } },
  location: { select: { id: true, type: true, name: true, projectId: true } },
  project: { select: { id: true, code: true, name: true } },
  items: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } },
  purchases: { select: { id: true, number: true, challanNo: true, purchaseDate: true, status: true }, orderBy: { purchaseDate: 'asc' } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.PurchaseOrderInclude;

type PoRow = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

/** Purchases that brought goods in (not still waiting for the site count). */
const RECEIVED_PURCHASE: Prisma.PurchaseWhereInput = { status: { not: 'PENDING_RECEIPT' } };

/** Good quantity received per material against a purchase order. */
export async function receivedForOrder(tx: Tx, tenantId: string, purchaseOrderId: string): Promise<Map<string, Dec>> {
  const items = await tx.purchaseItem.findMany({
    where: { tenantId, purchase: { purchaseOrderId, ...RECEIVED_PURCHASE } },
    select: { materialId: true, countedQty: true, damagedQty: true },
  });
  const out = new Map<string, Dec>();
  for (const i of items) out.set(i.materialId, (out.get(i.materialId) ?? ZERO).add((i.countedQty ?? ZERO).sub(i.damagedQty)));
  return out;
}

/** OPEN → PARTLY_RECEIVED → RECEIVED from the linked purchases. Cancelled orders stay cancelled. */
export async function refreshOrderStatus(tx: Tx, tenantId: string, purchaseOrderId: string): Promise<void> {
  const po = await tx.purchaseOrder.findFirst({ where: { tenantId, id: purchaseOrderId }, include: { items: true } });
  if (!po || po.status === 'CANCELLED') return;
  const received = await receivedForOrder(tx, tenantId, purchaseOrderId);
  const any = [...received.values()].some((q) => q.gt(0));
  const all = po.items.every((i) => (received.get(i.materialId) ?? ZERO).gte(i.orderedQty));
  const status: PurchaseOrderStatus = all ? 'RECEIVED' : any ? 'PARTLY_RECEIVED' : 'OPEN';
  if (status !== po.status) await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } });
}

async function toPoDto(tx: Tx, po: PoRow) {
  const received = await receivedForOrder(tx, po.tenantId, po.id);
  const items = po.items.map((i) => {
    const got = received.get(i.materialId) ?? ZERO;
    return {
      id: i.id,
      material: i.material,
      orderedQty: qn(i.orderedQty),
      receivedQty: qn(got),
      pendingQty: qn(i.orderedQty.sub(got).gt(0) ? i.orderedQty.sub(got) : ZERO),
      ratePaisa: i.ratePaisa.toString(),
      amountPaisa: valueOf(i.orderedQty, i.ratePaisa).toString(),
    };
  });
  return {
    id: po.id,
    number: po.number,
    supplier: po.supplier,
    deliverTo: po.deliverTo,
    location: po.location,
    project: po.project,
    expectedDate: po.expectedDate ? formatDateOnly(po.expectedDate) : null,
    status: po.status,
    note: po.note,
    items,
    totalPaisa: po.items.reduce((s, i) => s + valueOf(i.orderedQty, i.ratePaisa), 0n).toString(),
    purchases: po.purchases.map((p) => ({ ...p, purchaseDate: formatDateOnly(p.purchaseDate) })),
    cancelledAt: po.cancelledAt?.toISOString() ?? null,
    createdBy: po.createdBy,
    createdAt: po.createdAt.toISOString(),
  };
}

/** Delivery location for STORE / SITE (the PM must have access to the project). */
export async function deliveryLocation(tx: Tx, a: Actor, deliverTo: 'STORE' | 'SITE', projectId: string | undefined) {
  if (deliverTo === 'STORE') {
    const project = projectId ? await findProjectFor(tx, a, projectId) : null;
    return { location: (await systemLocations(tx, a.tenantId)).store, project };
  }
  const project = await findProjectFor(tx, a, projectId!);
  assertEditable(project, [...STOCK_OPEN_STATUSES]);
  return { location: await siteLocation(tx, a.tenantId, project), project };
}

export async function activeSupplier(tx: Tx, tenantId: string, supplierId: string) {
  const supplier = await tx.supplier.findFirst({ where: { tenantId, id: supplierId } });
  if (!supplier) throw new NotFound('SUPPLIER_NOT_FOUND', 'Supplier not found');
  if (!supplier.isActive) throw new BadRequest('SUPPLIER_INACTIVE', 'This supplier is deactivated');
  return supplier;
}

/** PM sees orders for the store and their projects. */
function scope(a: Actor): Prisma.PurchaseOrderWhereInput {
  return a.role === 'THEKEDAR' ? {} : { OR: [{ projectId: null }, { project: projectScope(a) }] };
}

async function findOrder(tx: Tx, a: Actor, id: string) {
  const po = await tx.purchaseOrder.findFirst({ where: { tenantId: a.tenantId, id, ...scope(a) }, include: poInclude });
  if (!po) throw poNotFound();
  return po;
}

export async function listOrders(query: ListPurchaseOrdersQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.PurchaseOrderWhereInput = { tenantId: a.tenantId, ...scope(a) };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.projectId) where.projectId = query.projectId;
    if (query.status) where.status = query.status;
    const rows = await tx.purchaseOrder.findMany({ where, include: poInclude, orderBy: [{ createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.purchaseOrder.count({ where });
    const data = [];
    for (const r of rows) data.push(await toPoDto(tx, r));
    return { data, meta: pageMeta(query, total) };
  });
}

export async function getOrder(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => toPoDto(tx, await findOrder(tx, a, id)));
}

export async function createOrderTx(tx: Tx, a: Actor, input: CreatePurchaseOrderInput) {
  const supplier = await activeSupplier(tx, a.tenantId, input.supplierId);
  const { location, project } = await deliveryLocation(tx, a, input.deliverTo, input.projectId);
  await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
  const number = await nextNumber(tx, a.tenantId, NUMBER_FORMATS.purchaseOrder);
  const po = await tx.purchaseOrder.create({
    data: {
      tenantId: a.tenantId,
      number,
      supplierId: supplier.id,
      deliverTo: input.deliverTo,
      locationId: location.id,
      projectId: project?.id ?? null,
      expectedDate: input.expectedDate ? dateOnly(input.expectedDate) : null,
      note: input.note ?? null,
      createdById: a.userId,
      items: {
        create: input.items.map((i, sortOrder) => ({ materialId: i.materialId, orderedQty: i.orderedQty, ratePaisa: i.ratePaisa, sortOrder })),
      },
    },
  });
  await audit(tx, a, 'purchase_order.create', 'PurchaseOrder', po.id, { number, supplier: supplier.name, items: input.items.length });
  return toPoDto(tx, await findOrder(tx, a, po.id));
}

export async function createOrder(input: CreatePurchaseOrderInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createOrderTx(tx, a, input));
}

export async function updateOrder(id: string, input: UpdatePurchaseOrderInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const po = await findOrder(tx, a, id);
    if (po.status !== 'OPEN') throw new Conflict('PURCHASE_ORDER_LOCKED', 'Only an open order without deliveries can be changed', { status: po.status });
    if (input.items) {
      await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
      await tx.purchaseOrderItem.deleteMany({ where: { tenantId: a.tenantId, purchaseOrderId: id } });
      await tx.purchaseOrderItem.createMany({
        data: input.items.map((i, sortOrder) => ({ tenantId: a.tenantId, purchaseOrderId: id, materialId: i.materialId, orderedQty: i.orderedQty, ratePaisa: i.ratePaisa, sortOrder })),
      });
    }
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate ? dateOnly(input.expectedDate) : null } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    await audit(tx, a, 'purchase_order.update', 'PurchaseOrder', id, { number: po.number, fields: Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined) });
    return toPoDto(tx, await findOrder(tx, a, id));
  });
}

export async function cancelOrder(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const po = await findOrder(tx, a, id);
    if (po.status === 'CANCELLED') throw new Conflict('PURCHASE_ORDER_CANCELLED', 'This order is already cancelled');
    if (po.status !== 'OPEN' || po.purchases.length > 0) {
      throw new Conflict('PURCHASE_ORDER_HAS_RECEIPTS', 'Goods were already received against this order; it can’t be cancelled', { status: po.status });
    }
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await audit(tx, a, 'purchase_order.cancel', 'PurchaseOrder', id, { number: po.number });
    return toPoDto(tx, await findOrder(tx, a, id));
  });
}
