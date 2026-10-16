/**
 * Equipment transfers: equipment leaves a location (TRANSFER_OUT) into TRANSIT (TRANSIT_IN) and is
 * counted at the destination (TRANSIT_OUT + RECEIPT_IN of what arrived). Sent − received becomes a
 * MISSING loss, damaged units a DAMAGED loss (source TRANSFER_GAP), both waiting to be charged.
 *   DISPATCH  yard → site     TRANSFER  site → site (or yard → yard)     RETURN  site → yard
 */
import { fieldsOf, visible } from '../../core/auth/fieldStrip.js';
import { can, scopeAll } from '../../core/auth/access.js';
import { nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { EquipmentTransferKind, Prisma, StockLocation } from '../../generated/prisma/client.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import { assertAttachment, findLocation, siteLocation, systemLocations } from '../inventory/stock.js';
import { STOCK_OPEN_STATUSES } from '../inventory/usage.service.js';
import { assertEditable, findProjectFor } from '../projects/access.js';
import {
  actor,
  assertAvailable,
  assertRentalItem,
  audit,
  dayOf,
  EQUIPMENT_NUMBERS,
  equipmentRef,
  equipmentSelect,
  loadEquipment,
  locationSelect,
  lockLocations,
  occurredAtFor,
  postMove,
  q,
  qn,
  userSelect,
  valueOf,
  visibleLocationIds,
  ZERO,
  type Actor,
} from './equipment.shared.js';
import type { CreateTransferInput, ListTransfersQuery, ReceiveTransferInput } from './equipment.schema.js';

const transferNotFound = () => new NotFound('TRANSFER_NOT_FOUND', 'Equipment transfer not found');

export const transferInclude = {
  fromLocation: locationSelect,
  toLocation: locationSelect,
  items: { include: { equipment: equipmentSelect, rental: { select: { id: true, number: true } }, photo: { select: { id: true, storageKey: true } } }, orderBy: { sortOrder: 'asc' } },
  losses: { select: { id: true, number: true, kind: true, qty: true }, orderBy: { createdAt: 'asc' } },
  createdBy: userSelect,
  receivedBy: userSelect,
} as const satisfies Prisma.EquipmentTransferInclude;

type TransferRow = Prisma.EquipmentTransferGetPayload<{ include: typeof transferInclude }>;

async function blindCount(tx: Tx, tenantId: string) {
  return (await tx.tenantSettings.findUnique({ where: { tenantId }, select: { blindCountEnabled: true } }))?.blindCountEnabled ?? true;
}

export async function transferDto(tx: Tx, t: TransferRow, a: Actor) {
  // Blind count (company setting): the receiving munshi counts without seeing what was sent.
  const hide = t.status === 'ON_THE_WAY' && a.role === 'MUNSHI' && (await blindCount(tx, a.tenantId));
  const items = [];
  for (const i of t.items) {
    const gap = i.receivedQty === null ? null : i.sentQty.sub(i.receivedQty);
    items.push({
      id: i.id,
      equipment: equipmentRef(i.equipment),
      rental: i.rental,
      ...(hide ? {} : { sentQty: qn(i.sentQty) }),
      receivedQty: q(i.receivedQty),
      damagedQty: q(i.damagedQty),
      gapQty: gap === null ? null : qn(gap),
      note: i.note,
      photoUrl: await optionalSignedUrl(i.photo),
      ...visible(fieldsOf(a), 'rates', { replacementValuePaisa: i.equipment.replacementValuePaisa.toString() }),
    });
  }
  return {
    id: t.id,
    number: t.number,
    kind: t.kind,
    status: t.status,
    from: t.fromLocation,
    to: t.toLocation,
    vehicleNo: t.vehicleNo,
    driverName: t.driverName,
    note: t.note,
    sentAt: t.sentAt.toISOString(),
    blindCount: hide,
    items,
    losses: t.losses.map((l) => ({ id: l.id, number: l.number, kind: l.kind, qty: qn(l.qty) })),
    receivedBy: t.receivedBy,
    receivedAt: t.receivedAt?.toISOString() ?? null,
    receiveNote: t.receiveNote,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

async function scope(tx: Tx, a: Actor): Promise<Prisma.EquipmentTransferWhereInput> {
  const ids = await visibleLocationIds(tx, a);
  return ids === null ? {} : { OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] };
}

export async function findTransfer(tx: Tx, a: Actor, id: string): Promise<TransferRow> {
  const t = await tx.equipmentTransfer.findFirst({ where: { tenantId: a.tenantId, id, ...(await scope(tx, a)) }, include: transferInclude });
  if (!t) throw transferNotFound();
  return t;
}

export async function transferDetail(tx: Tx, a: Actor, id: string) {
  return transferDto(tx, await findTransfer(tx, a, id), a);
}

const kindOf = (from: StockLocation, to: StockLocation): EquipmentTransferKind =>
  from.type === 'STORE' && to.type === 'SITE' ? 'DISPATCH' : from.type === 'SITE' && to.type === 'STORE' ? 'RETURN' : 'TRANSFER';

/**
 * From: the yard (equipment.manage, or ALL_PROJECTS transfer.create) or a site in the caller's
 * transfer scope. To: the yard or an ACTIVE / CLOSEOUT site the caller can see.
 */
async function planLocations(tx: Tx, a: Actor, input: Pick<CreateTransferInput, 'fromLocationId' | 'toLocationId' | 'toProjectId'>) {
  const from = await findLocation(tx, a.tenantId, input.fromLocationId);
  if (from.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Send from the yard or a site');
  if (from.type === 'SITE') {
    const project = await findProjectFor(tx, a, from.projectId!, 'equipment.transfer.create').catch(() => {
      throw new NotFound('LOCATION_NOT_FOUND', 'Location not found');
    });
    if (project.status === 'DRAFT') throw new NotFound('LOCATION_NOT_FOUND', 'Location not found');
  } else if (!can('equipment.manage', a) && !scopeAll('equipment.transfer.create', a)) {
    throw new Forbidden('PERMISSION_DENIED', 'Only equipment managers send from the yard; a PM sends from a site they manage', { permission: 'equipment.manage' });
  }
  let to: StockLocation;
  if (input.toProjectId) {
    const project = await findProjectFor(tx, a, input.toProjectId);
    assertEditable(project, [...STOCK_OPEN_STATUSES]);
    to = await siteLocation(tx, a.tenantId, project);
  } else {
    to = await findLocation(tx, a.tenantId, input.toLocationId!);
    if (to.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Send to the yard or a site');
    if (to.type === 'SITE') assertEditable(await findProjectFor(tx, a, to.projectId!), [...STOCK_OPEN_STATUSES]);
  }
  if (to.id === from.id) throw new BadRequest('SAME_LOCATION', 'Choose a different destination');
  return { from, to };
}

export async function createTransferTx(tx: Tx, a: Actor, input: CreateTransferInput, opts: { at?: Date } = {}) {
  const { from, to } = await planLocations(tx, a, input);
  const equipment = await loadEquipment(tx, a.tenantId, input.items.map((i) => i.equipmentId));
  for (const i of input.items) if (i.rentalId) await assertRentalItem(tx, a.tenantId, i.rentalId, i.equipmentId);
  const at = opts.at ?? (input.date ? occurredAtFor(input.date) : new Date());
  const { transit } = await systemLocations(tx, a.tenantId);
  await lockLocations(tx, [from.id, transit.id]);
  await assertAvailable(
    tx,
    a.tenantId,
    input.items.map((i) => ({ locationId: from.id, equipmentId: i.equipmentId, rentalId: i.rentalId ?? null, qty: i.qty })),
    equipment,
  );
  const number = await nextNumber(tx, a.tenantId, EQUIPMENT_NUMBERS.transfer, at);
  const t = await tx.equipmentTransfer.create({
    data: {
      tenantId: a.tenantId,
      number,
      kind: kindOf(from, to),
      fromLocationId: from.id,
      toLocationId: to.id,
      vehicleNo: input.vehicleNo ?? null,
      driverName: input.driverName ?? null,
      note: input.note ?? null,
      sentAt: at,
      createdById: a.userId,
    },
  });
  const ref = { refType: 'EQUIPMENT_TRANSFER', refId: t.id, occurredAt: at, createdById: a.userId, note: number };
  for (const [sortOrder, i] of input.items.entries()) {
    const rentalId = i.rentalId ?? null;
    await postMove(tx, a.tenantId, { locationId: from.id, equipmentId: i.equipmentId, rentalId }, i.qty.neg(), { ...ref, type: 'TRANSFER_OUT' });
    await postMove(tx, a.tenantId, { locationId: transit.id, equipmentId: i.equipmentId, rentalId }, i.qty, { ...ref, type: 'TRANSIT_IN' });
    await tx.equipmentTransferItem.create({ data: { tenantId: a.tenantId, transferId: t.id, equipmentId: i.equipmentId, rentalId, sentQty: i.qty, sortOrder } });
  }
  await audit(tx, a, 'equipment.transfer.create', 'EquipmentTransfer', t.id, {
    number,
    kind: t.kind,
    from: from.name,
    to: to.name,
    items: input.items.map((i) => ({ equipmentId: i.equipmentId, rentalId: i.rentalId ?? null, qty: qn(i.qty) })),
  });
  return transferDetail(tx, a, t.id);
}

export async function createTransfer(input: CreateTransferInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createTransferTx(tx, a, input));
}

export async function getTransfer(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => transferDetail(tx, a, id));
}

export async function listTransfers(query: ListTransfersQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.EquipmentTransferWhereInput[] = [{ tenantId: a.tenantId }, await scope(tx, a)];
    if (query.status) and.push({ status: query.status });
    if (query.kind) and.push({ kind: query.kind });
    if (query.locationId) and.push({ OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] });
    if (query.projectId) and.push({ OR: [{ fromLocation: { projectId: query.projectId } }, { toLocation: { projectId: query.projectId } }] });
    const where = { AND: and };
    const rows = await tx.equipmentTransfer.findMany({ where, include: transferInclude, orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.equipmentTransfer.count({ where });
    const data = [];
    for (const t of rows) data.push(await transferDto(tx, t, a));
    return { data, meta: pageMeta(query, total) };
  });
}

// ─── Receive ────────────────────────────────────────────────────────────────

export async function receiveTransferTx(tx: Tx, a: Actor, id: string, input: ReceiveTransferInput, opts: { at?: Date } = {}) {
  const t = await findTransfer(tx, a, id);
  if (t.status === 'CANCELLED') throw new Conflict('TRANSFER_CANCELLED', 'This transfer was cancelled');
  if (t.status !== 'ON_THE_WAY') throw new Conflict('ALREADY_RECEIVED', 'This transfer has already been received', { status: t.status });
  if (t.toLocation.type === 'SITE') {
    await findProjectFor(tx, a, t.toLocation.projectId!, 'equipment.receiving.create').catch(() => {
      throw transferNotFound();
    });
  } else if (!can('equipment.manage', a) && !scopeAll('equipment.receiving.create', a)) throw transferNotFound();

  const byItem = new Map(input.items.map((i) => [i.itemId, i]));
  const missing = t.items.filter((i) => !byItem.has(i.id)).map((i) => i.id);
  const extra = input.items.filter((i) => !t.items.some((x) => x.id === i.itemId)).map((i) => i.itemId);
  if (missing.length || extra.length) throw new BadRequest('ITEMS_MISMATCH', 'Count every item on the transfer (and only those)', { missing, extra });
  for (const item of t.items) {
    const c = byItem.get(item.id)!;
    const damaged = c.damagedQty ?? ZERO;
    if (c.receivedQty.gt(item.sentQty)) throw new BadRequest('RECEIVED_EXCEEDS_SENT', `More ${item.equipment.name} counted than sent — check the count`, { itemId: item.id, sentQty: qn(item.sentQty) });
    if (damaged.gt(c.receivedQty)) throw new BadRequest('DAMAGED_EXCEEDS_COUNTED', `Damaged ${item.equipment.name} can’t be more than received`, { itemId: item.id });
    if ((c.receivedQty.lt(item.sentQty) || damaged.gt(0)) && !c.note) throw new BadRequest('NOTE_REQUIRED', `Add a note: ${item.equipment.name} is short or damaged`, { itemId: item.id });
    if (c.photoAttachmentId) await assertAttachment(tx, a.tenantId, c.photoAttachmentId, ['SITE_PHOTO'], 'INVALID_ATTACHMENT', 'Photo');
  }
  const at = opts.at ?? (input.date ? occurredAtFor(input.date) : new Date());
  if (dayOf(at) < dayOf(t.sentAt)) throw new BadRequest('INVALID_DATES', 'The receive date is before the transfer was sent');
  const at2 = at < t.sentAt ? t.sentAt : at;

  const { transit } = await systemLocations(tx, a.tenantId);
  await lockLocations(tx, [transit.id, t.toLocationId]);
  const ref = { refType: 'EQUIPMENT_TRANSFER', refId: t.id, occurredAt: at2, createdById: a.userId, note: t.number };
  const projectId = t.toLocation.projectId ?? t.fromLocation.projectId;
  let gap = false;
  for (const item of t.items) {
    const c = byItem.get(item.id)!;
    const damaged = c.damagedQty ?? ZERO;
    const bucket = { equipmentId: item.equipmentId, rentalId: item.rentalId };
    await postMove(tx, a.tenantId, { ...bucket, locationId: transit.id }, item.sentQty.neg(), { ...ref, type: 'TRANSIT_OUT' });
    if (c.receivedQty.gt(0)) await postMove(tx, a.tenantId, { ...bucket, locationId: t.toLocationId }, c.receivedQty, { ...ref, type: 'RECEIPT_IN' });
    await tx.equipmentTransferItem.update({ where: { id: item.id }, data: { receivedQty: c.receivedQty, damagedQty: damaged, note: c.note ?? null, photoAttachmentId: c.photoAttachmentId ?? null } });
    const losses: Array<{ kind: 'MISSING' | 'DAMAGED'; qty: typeof damaged }> = [];
    if (c.receivedQty.lt(item.sentQty)) losses.push({ kind: 'MISSING', qty: item.sentQty.sub(c.receivedQty) });
    if (damaged.gt(0)) losses.push({ kind: 'DAMAGED', qty: damaged });
    for (const l of losses) {
      gap = true;
      await tx.equipmentLoss.create({
        data: {
          tenantId: a.tenantId,
          number: await nextNumber(tx, a.tenantId, EQUIPMENT_NUMBERS.loss, at2),
          kind: l.kind,
          source: 'TRANSFER_GAP',
          equipmentId: item.equipmentId,
          rentalId: item.rentalId,
          locationId: t.toLocationId,
          projectId,
          transferId: t.id,
          qty: l.qty,
          valuePaisa: valueOf(l.qty, item.equipment.replacementValuePaisa),
          photoAttachmentId: c.photoAttachmentId ?? null,
          note: c.note ?? null,
          reportedById: a.userId,
          reportedAt: at2,
        },
      });
    }
  }
  const status = gap ? 'RECEIVED_WITH_GAP' : 'RECEIVED';
  await tx.equipmentTransfer.update({ where: { id }, data: { status, receivedById: a.userId, receivedAt: at2, receiveNote: input.note ?? null } });
  await audit(tx, a, 'equipment.transfer.receive', 'EquipmentTransfer', id, {
    number: t.number,
    status,
    items: t.items.map((i) => ({ itemId: i.id, equipmentId: i.equipmentId, sent: qn(i.sentQty), received: qn(byItem.get(i.id)!.receivedQty), damaged: qn(byItem.get(i.id)!.damagedQty ?? ZERO) })),
  });
  return transferDetail(tx, a, id);
}

export async function receiveTransfer(id: string, input: ReceiveTransferInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => receiveTransferTx(tx, a, id, input));
}

export async function cancelTransfer(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const t = await findTransfer(tx, a, id);
    if (t.status !== 'ON_THE_WAY') throw new Conflict('TRANSFER_NOT_CANCELLABLE', 'Only a transfer still on the way can be cancelled', { status: t.status });
    await planLocations(tx, a, { fromLocationId: t.fromLocationId, toLocationId: t.toLocationId });
    const { transit } = await systemLocations(tx, a.tenantId);
    const at = new Date();
    await lockLocations(tx, [t.fromLocationId, transit.id]);
    const ref = { refType: 'EQUIPMENT_TRANSFER', refId: t.id, occurredAt: at, createdById: a.userId, note: `${t.number} cancelled` };
    for (const i of t.items) {
      const bucket = { equipmentId: i.equipmentId, rentalId: i.rentalId };
      await postMove(tx, a.tenantId, { ...bucket, locationId: transit.id }, i.sentQty.neg(), { ...ref, type: 'TRANSIT_OUT' });
      await postMove(tx, a.tenantId, { ...bucket, locationId: t.fromLocationId }, i.sentQty, { ...ref, type: 'RECEIPT_IN' });
    }
    await tx.equipmentTransfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: at } });
    await audit(tx, a, 'equipment.transfer.cancel', 'EquipmentTransfer', id, { number: t.number });
    return transferDetail(tx, a, id);
  });
}
