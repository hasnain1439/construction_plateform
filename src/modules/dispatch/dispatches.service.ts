/**
 * Dispatches (gate passes): stock leaves a location (DISPATCH_OUT at average cost), sits in
 * TRANSIT (TRANSIT_IN, same value) until the destination counts it (TRANSIT_OUT + RECEIPT_IN).
 */
import { logger } from '../../config/logger.js';
import { NUMBER_FORMATS, nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import type { DispatchStatus, Prisma, StockLocation } from '../../generated/prisma/client.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import { smsProvider } from '../auth/sms.provider.js';
import { pktDayEnd, pktDayStart, visibleLocations } from '../inventory/inventory.service.js';
import {
  actor,
  assertAttachment,
  assertAvailable,
  audit,
  findLocation,
  loadMaterials,
  lockLocations,
  materialRef,
  postIn,
  postOut,
  q,
  qn,
  siteLocation,
  systemLocations,
  valueOf,
  ZERO,
  type Actor,
  type Dec,
  type MaterialInfo,
} from '../inventory/stock.js';
import { STOCK_OPEN_STATUSES } from '../inventory/usage.service.js';
import { assertEditable, findProjectFor, projectNotFound } from '../projects/access.js';
import { resultOf } from '../procurement/purchases.service.js';
import type { CreateDispatchInput, ListDispatchesQuery, ReceiveDispatchInput } from './dispatch.schema.js';

const dispatchNotFound = () => new NotFound('DISPATCH_NOT_FOUND', 'Dispatch not found');

const locationSelect = { select: { id: true, type: true, name: true, projectId: true } } as const;
const dispatchInclude = {
  fromLocation: locationSelect,
  toLocation: locationSelect,
  items: { include: { material: { select: { id: true, name: true, unit: true } }, photo: { select: { id: true, storageKey: true } } }, orderBy: { sortOrder: 'asc' } },
  loadPhoto: { select: { id: true, storageKey: true } },
  shortages: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { createdAt: 'asc' } },
  createdBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.DispatchInclude;

type DispatchRow = Prisma.DispatchGetPayload<{ include: typeof dispatchInclude }>;

async function blindCount(tx: Tx, tenantId: string) {
  return (await tx.tenantSettings.findUnique({ where: { tenantId }, select: { blindCountEnabled: true } }))?.blindCountEnabled ?? true;
}

async function toDispatchDto(tx: Tx, d: DispatchRow, a: Actor) {
  // Blind count: while on the way, the receiving munshi doesn't see what was sent.
  const hide = d.status === 'ON_THE_WAY' && a.role === 'MUNSHI' && (await blindCount(tx, a.tenantId));
  return {
    id: d.id,
    number: d.number,
    from: d.fromLocation,
    to: d.toLocation,
    vehicleNo: d.vehicleNo,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    dispatchedAt: d.dispatchedAt.toISOString(),
    status: d.status,
    note: d.note,
    blindCount: hide,
    loadPhotoUrl: await optionalSignedUrl(d.loadPhoto),
    items: await Promise.all(
      d.items.map(async (i) => {
        const good = i.receivedQty === null ? null : i.receivedQty.sub(i.damagedQty ?? ZERO);
        return {
          id: i.id,
          material: materialRef(i.material),
          ...(hide ? {} : { sentQty: qn(i.sentQty) }),
          receivedQty: q(i.receivedQty),
          damagedQty: q(i.damagedQty),
          goodQty: q(good),
          differenceQty: good === null || hide ? null : qn(good.sub(i.sentQty)),
          note: i.note,
          photoUrl: await optionalSignedUrl(i.photo),
          ...(a.seesRates ? { unitCostPaisa: i.unitCostPaisa.toString(), valuePaisa: valueOf(i.sentQty, i.unitCostPaisa).toString() } : {}),
        };
      }),
    ),
    ...(a.seesRates ? { totalValuePaisa: d.items.reduce((s, i) => s + valueOf(i.sentQty, i.unitCostPaisa), 0n).toString() } : {}),
    shortages: d.shortages.map((s) => ({
      id: s.id,
      kind: s.kind,
      material: materialRef(s.material),
      qty: qn(s.qty),
      status: s.status,
      resolution: s.resolution,
      ...(a.seesRates ? { valuePaisa: s.valuePaisa.toString() } : {}),
    })),
    receivedBy: d.receivedBy,
    receivedAt: d.receivedAt?.toISOString() ?? null,
    receiveNote: d.receiveNote,
    cancelledAt: d.cancelledAt?.toISOString() ?? null,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
  };
}

/** THEKEDAR all; PM / MUNSHI dispatches to or from locations they can see (PM also the store). */
async function scope(tx: Tx, a: Actor): Promise<Prisma.DispatchWhereInput> {
  if (a.role === 'THEKEDAR') return {};
  const ids = (await visibleLocations(tx, a)).filter((l) => l.type === 'SITE').map((l) => l.id);
  return { OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] };
}

export async function findDispatch(tx: Tx, a: Actor, id: string): Promise<DispatchRow> {
  const d = await tx.dispatch.findFirst({ where: { tenantId: a.tenantId, id, ...(await scope(tx, a)) }, include: dispatchInclude });
  if (!d) throw dispatchNotFound();
  return d;
}

export async function dispatchDetail(tx: Tx, a: Actor, id: string) {
  return toDispatchDto(tx, await findDispatch(tx, a, id), a);
}

// ─── SMS ────────────────────────────────────────────────────────────────────

const count = (n: Dec) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(qn(n));

/** "200 bags cement", "5,000 eent", "1 ton sariya", else "<qty> <unit> <name>". */
export function smsLine(m: MaterialInfo, qty: Dec): string {
  switch (m.groupCode) {
    case 'CEMENT':
      return `${count(qty)} bags ${m.name.toLowerCase().includes('white') ? 'white cement' : 'cement'}`;
    case 'BRICKS':
      return `${count(qty)} eent`;
    case 'STEEL':
      return `${count(qty)} ton sariya`;
    default:
      return `${count(qty)} ${m.unit} ${m.name}`;
  }
}

export function dispatchSms(number: string, lines: string[], vehicleNo: string | null): string {
  const list = lines.length > 1 ? `${lines.slice(0, -1).join(', ')} aur ${lines.at(-1)}` : lines[0]!;
  return `${number}: ${list} aap ki site par aa rahe hain${vehicleNo ? ` (${vehicleNo})` : ''}.`;
}

/** Tells the destination site's PM / munshis what is coming. Never fails the dispatch. */
async function notifySite(tx: Tx, tenantId: string, projectId: string, text: string) {
  const people = await tx.user.findMany({
    where: { tenantId, status: 'ACTIVE', role: { in: ['PM', 'MUNSHI'] }, projectAccess: { some: { projectId } } },
    select: { phone: true },
  });
  for (const p of people) {
    await smsProvider()
      .send({ to: p.phone, body: text })
      .catch((err: unknown) => logger.warn({ err }, 'dispatch sms failed'));
  }
}

// ─── Create / cancel ────────────────────────────────────────────────────────

interface DispatchPlan {
  from: StockLocation;
  to: StockLocation;
  items: Array<{ materialId: string; qty: Dec }>;
  vehicleNo?: string | null | undefined;
  driverName?: string | null | undefined;
  driverPhone?: string | null | undefined;
  loadPhotoAttachmentId?: string | null | undefined;
  note?: string | null | undefined;
  at: Date;
}

/** Moves stock into transit and writes the gate pass. Callers have checked who may do it. */
export async function writeDispatch(tx: Tx, a: Pick<Actor, 'tenantId' | 'userId'>, plan: DispatchPlan) {
  const { transit } = await systemLocations(tx, a.tenantId);
  const materials = await loadMaterials(tx, a.tenantId, plan.items.map((i) => i.materialId));
  await lockLocations(tx, [plan.from.id, transit.id]);
  await assertAvailable(
    tx,
    a.tenantId,
    plan.items.map((i) => ({ locationId: plan.from.id, materialId: i.materialId, ownerSupplied: false, qty: i.qty })),
    materials,
  );
  const number = await nextNumber(tx, a.tenantId, NUMBER_FORMATS.dispatch, plan.at);
  const dispatch = await tx.dispatch.create({
    data: {
      tenantId: a.tenantId,
      number,
      fromLocationId: plan.from.id,
      toLocationId: plan.to.id,
      vehicleNo: plan.vehicleNo ?? null,
      driverName: plan.driverName ?? null,
      driverPhone: plan.driverPhone ?? null,
      dispatchedAt: plan.at,
      loadPhotoAttachmentId: plan.loadPhotoAttachmentId ?? null,
      note: plan.note ?? null,
      createdById: a.userId,
    },
  });
  const ref = { refType: 'DISPATCH', refId: dispatch.id, occurredAt: plan.at, createdById: a.userId, note: number };
  for (const [sortOrder, i] of plan.items.entries()) {
    const out = await postOut(tx, a.tenantId, { locationId: plan.from.id, materialId: i.materialId, ownerSupplied: false }, i.qty, { ...ref, type: 'DISPATCH_OUT' });
    await postIn(tx, a.tenantId, { locationId: transit.id, materialId: i.materialId, ownerSupplied: false }, i.qty, out.unitCostPaisa, { ...ref, type: 'TRANSIT_IN' }, out.valuePaisa);
    await tx.dispatchItem.create({ data: { tenantId: a.tenantId, dispatchId: dispatch.id, materialId: i.materialId, sentQty: i.qty, unitCostPaisa: out.unitCostPaisa, sortOrder } });
  }
  if (plan.to.type === 'SITE' && plan.to.projectId) {
    const text = dispatchSms(number, plan.items.map((i) => smsLine(materials.get(i.materialId)!, i.qty)), plan.vehicleNo ?? null);
    await notifySite(tx, a.tenantId, plan.to.projectId, text);
  }
  return dispatch;
}

/**
 * THEKEDAR dispatches from any store or site; a PM only from a site they manage, and only to
 * the store or another site they manage. Destination sites must be ACTIVE / CLOSEOUT.
 */
async function planLocations(tx: Tx, a: Actor, input: Pick<CreateDispatchInput, 'fromLocationId' | 'toLocationId' | 'toProjectId'>) {
  const from = await findLocation(tx, a.tenantId, input.fromLocationId);
  if (from.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Dispatch from the store or a site');
  if (from.type === 'SITE') {
    const project = await findProjectFor(tx, a, from.projectId!).catch(() => {
      throw new NotFound('LOCATION_NOT_FOUND', 'Stock location not found');
    });
    if (project.status === 'DRAFT') throw projectNotFound();
  } else if (a.role !== 'THEKEDAR') {
    throw new Forbidden('FORBIDDEN', 'Only the owner can dispatch from the store; a PM can transfer from a site they manage');
  }

  let to: StockLocation;
  if (input.toProjectId) {
    const project = await findProjectFor(tx, a, input.toProjectId);
    assertEditable(project, [...STOCK_OPEN_STATUSES]);
    to = await siteLocation(tx, a.tenantId, project);
  } else {
    to = await findLocation(tx, a.tenantId, input.toLocationId!);
    if (to.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Send to the store or a site');
    if (to.type === 'SITE') assertEditable(await findProjectFor(tx, a, to.projectId!), [...STOCK_OPEN_STATUSES]);
  }
  if (to.id === from.id) throw new BadRequest('SAME_LOCATION', 'Choose a different destination');
  return { from, to };
}

export async function createDispatchTx(tx: Tx, a: Actor, input: CreateDispatchInput, opts: { at?: Date } = {}) {
  const { from, to } = await planLocations(tx, a, input);
  if (input.loadPhotoAttachmentId) await assertAttachment(tx, a.tenantId, input.loadPhotoAttachmentId, ['SITE_PHOTO', 'DOCUMENT'], 'INVALID_ATTACHMENT', 'Load photo');
  const at = opts.at ?? (input.dispatchedAt ? new Date(input.dispatchedAt) : new Date());
  if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequest('DATE_IN_FUTURE', 'The dispatch time cannot be in the future');
  const dispatch = await writeDispatch(tx, a, { ...input, from, to, at });
  await audit(tx, a, 'dispatch.create', 'Dispatch', dispatch.id, {
    number: dispatch.number,
    from: from.name,
    to: to.name,
    items: input.items.map((i) => ({ materialId: i.materialId, qty: qn(i.qty) })),
    vehicleNo: input.vehicleNo ?? null,
  });
  return dispatchDetail(tx, a, dispatch.id);
}

export async function createDispatch(input: CreateDispatchInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createDispatchTx(tx, a, input));
}

/** The transit value a dispatch put in for each material (taken out again exactly). */
async function transitValues(tx: Tx, tenantId: string, dispatchId: string) {
  const rows = await tx.stockMovement.findMany({ where: { tenantId, refType: 'DISPATCH', refId: dispatchId, type: 'TRANSIT_IN' }, select: { materialId: true, valuePaisa: true } });
  return new Map(rows.map((r) => [r.materialId, r.valuePaisa]));
}

export async function cancelDispatchTx(tx: Tx, a: Actor, id: string, opts: { at?: Date } = {}) {
  const d = await findDispatch(tx, a, id);
  if (d.status !== 'ON_THE_WAY') throw new Conflict('DISPATCH_NOT_CANCELLABLE', 'Only a dispatch that is still on the way can be cancelled', { status: d.status });
  await planLocations(tx, a, { fromLocationId: d.fromLocationId, toLocationId: d.toLocationId });
  const { transit } = await systemLocations(tx, a.tenantId);
  const values = await transitValues(tx, a.tenantId, d.id);
  const at = opts.at ?? new Date();
  await lockLocations(tx, [d.fromLocationId, transit.id]);
  const ref = { refType: 'DISPATCH', refId: d.id, occurredAt: at, createdById: a.userId, note: `${d.number} cancelled` };
  for (const i of d.items) {
    const value = values.get(i.materialId) ?? valueOf(i.sentQty, i.unitCostPaisa);
    await postOut(tx, a.tenantId, { locationId: transit.id, materialId: i.materialId, ownerSupplied: false }, i.sentQty, { ...ref, type: 'TRANSIT_OUT' }, i.unitCostPaisa, value);
    await postIn(tx, a.tenantId, { locationId: d.fromLocationId, materialId: i.materialId, ownerSupplied: false }, i.sentQty, i.unitCostPaisa, { ...ref, type: 'CORRECTION' }, value);
  }
  await tx.dispatch.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: at } });
  await audit(tx, a, 'dispatch.cancel', 'Dispatch', id, { number: d.number });
  return dispatchDetail(tx, a, id);
}

export async function cancelDispatch(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => cancelDispatchTx(tx, a, id));
}

export async function getDispatch(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => dispatchDetail(tx, a, id));
}

export async function listDispatches(query: ListDispatchesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.DispatchWhereInput[] = [{ tenantId: a.tenantId }, await scope(tx, a)];
    if (query.status) and.push({ status: query.status });
    if (query.fromLocationId) and.push({ fromLocationId: query.fromLocationId });
    if (query.toLocationId) and.push({ toLocationId: query.toLocationId });
    if (query.projectId) and.push({ OR: [{ fromLocation: { projectId: query.projectId } }, { toLocation: { projectId: query.projectId } }] });
    if (query.from) and.push({ dispatchedAt: { gte: pktDayStart(query.from) } });
    if (query.to) and.push({ dispatchedAt: { lt: pktDayEnd(query.to) } });
    if (query.search) and.push({ OR: [{ number: { contains: query.search, mode: 'insensitive' } }, { vehicleNo: { contains: query.search, mode: 'insensitive' } }] });
    const where: Prisma.DispatchWhereInput = { AND: and };
    const rows = await tx.dispatch.findMany({ where, include: dispatchInclude, orderBy: [{ dispatchedAt: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.dispatch.count({ where });
    const data = [];
    for (const d of rows) data.push(await toDispatchDto(tx, d, a));
    return { data, meta: pageMeta(query, total) };
  });
}

// ─── Receiving ──────────────────────────────────────────────────────────────

export async function receiveDispatchTx(tx: Tx, a: Actor, id: string, input: ReceiveDispatchInput, opts: { at?: Date } = {}) {
  const d = await findDispatch(tx, a, id);
  if (d.status === 'CANCELLED') throw new Conflict('DISPATCH_CANCELLED', 'This dispatch was cancelled');
  if (d.status !== 'ON_THE_WAY') throw new Conflict('ALREADY_RECEIVED', 'This dispatch has already been received', { status: d.status });
  if (d.toLocation.type === 'SITE') await findProjectFor(tx, a, d.toLocation.projectId!);
  else if (a.role === 'MUNSHI') throw dispatchNotFound();

  const byMaterial = new Map(input.items.map((i) => [i.materialId, i]));
  const missing = d.items.filter((i) => !byMaterial.has(i.materialId)).map((i) => i.materialId);
  const extra = input.items.filter((i) => !d.items.some((x) => x.materialId === i.materialId)).map((i) => i.materialId);
  if (missing.length || extra.length) throw new BadRequest('ITEMS_MISMATCH', 'Count every material on the gate pass (and only those)', { missing, extra });
  const materials = await loadMaterials(tx, a.tenantId, d.items.map((i) => i.materialId));
  for (const i of input.items) {
    const damaged = i.damagedQty ?? ZERO;
    const sent = d.items.find((x) => x.materialId === i.materialId)!.sentQty;
    if (damaged.gt(i.receivedQty)) throw new BadRequest('DAMAGED_EXCEEDS_COUNTED', `Damaged ${materials.get(i.materialId)!.name} can’t be more than received`, { materialId: i.materialId });
    if (i.receivedQty.sub(damaged).lt(sent) && !i.note) {
      throw new BadRequest('SHORTAGE_NOTE_REQUIRED', `Add a note: ${materials.get(i.materialId)!.name} is short or damaged`, { materialId: i.materialId });
    }
    if (i.photoAttachmentId) await assertAttachment(tx, a.tenantId, i.photoAttachmentId, ['SITE_PHOTO'], 'INVALID_ATTACHMENT', 'Photo');
  }

  const { transit } = await systemLocations(tx, a.tenantId);
  const values = await transitValues(tx, a.tenantId, d.id);
  const at = opts.at ?? new Date();
  await lockLocations(tx, [transit.id, d.toLocationId]);
  const ref = { refType: 'DISPATCH', refId: d.id, occurredAt: at, createdById: a.userId, note: d.number };
  const projectId = d.toLocation.projectId ?? d.fromLocation.projectId;
  let short = false;
  let excess = false;
  const comparison = [];
  for (const item of d.items) {
    const c = byMaterial.get(item.materialId)!;
    const damaged = c.damagedQty ?? ZERO;
    const good = c.receivedQty.sub(damaged);
    const transitValue = values.get(item.materialId) ?? valueOf(item.sentQty, item.unitCostPaisa);
    await postOut(tx, a.tenantId, { locationId: transit.id, materialId: item.materialId, ownerSupplied: false }, item.sentQty, { ...ref, type: 'TRANSIT_OUT' }, item.unitCostPaisa, transitValue);
    if (good.gt(0)) {
      await postIn(
        tx,
        a.tenantId,
        { locationId: d.toLocationId, materialId: item.materialId, ownerSupplied: false },
        good,
        item.unitCostPaisa,
        { ...ref, type: 'RECEIPT_IN' },
        good.eq(item.sentQty) ? transitValue : undefined,
      );
    }
    await tx.dispatchItem.update({ where: { id: item.id }, data: { receivedQty: c.receivedQty, damagedQty: damaged, note: c.note ?? null, photoAttachmentId: c.photoAttachmentId ?? null } });

    const rows: Array<{ kind: 'DISPATCH_SHORT' | 'DAMAGED' | 'EXCESS'; qty: Dec }> = [];
    if (c.receivedQty.lt(item.sentQty)) rows.push({ kind: 'DISPATCH_SHORT', qty: item.sentQty.sub(c.receivedQty) });
    if (damaged.gt(0)) rows.push({ kind: 'DAMAGED', qty: damaged });
    if (c.receivedQty.gt(item.sentQty)) rows.push({ kind: 'EXCESS', qty: c.receivedQty.sub(item.sentQty) });
    for (const r of rows) {
      if (r.kind === 'EXCESS') excess = true;
      else short = true;
      await tx.shortage.create({
        data: {
          tenantId: a.tenantId,
          kind: r.kind,
          source: 'DISPATCH',
          dispatchId: d.id,
          projectId,
          locationId: d.toLocationId,
          materialId: item.materialId,
          qty: r.qty,
          valuePaisa: valueOf(r.qty, item.unitCostPaisa),
          note: c.note ?? null,
        },
      });
    }
    comparison.push({
      material: materialRef(materials.get(item.materialId)!),
      expectedQty: qn(item.sentQty),
      countedQty: qn(c.receivedQty),
      damagedQty: qn(damaged),
      goodQty: qn(good),
      differenceQty: qn(good.sub(item.sentQty)),
      result: resultOf(item.sentQty, c.receivedQty, damaged),
    });
  }
  const status: DispatchStatus = short ? 'RECEIVED_WITH_SHORTAGE' : excess ? 'RECEIVED_WITH_EXCESS' : 'RECEIVED';
  await tx.dispatch.update({ where: { id }, data: { status, receivedById: a.userId, receivedAt: at, receiveNote: input.note ?? null } });
  await audit(tx, a, 'dispatch.receive', 'Dispatch', id, {
    number: d.number,
    status,
    items: comparison.map((c) => ({ materialId: c.material.id, sent: c.expectedQty, received: c.countedQty, damaged: c.damagedQty })),
  });
  return { dispatch: await dispatchDetail(tx, a, id), comparison };
}

export async function receiveDispatch(id: string, input: ReceiveDispatchInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => receiveDispatchTx(tx, a, id, input));
}

/** On-the-way dispatches and direct purchases waiting for this site's count. Never shows values. */
export async function incoming(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await findProjectFor(tx, a, projectId);
    if (project.status === 'DRAFT') return { blindCount: true, count: 0, dispatches: [], purchases: [] };
    const site = await siteLocation(tx, a.tenantId, project);
    const blind = await blindCount(tx, a.tenantId);
    const dispatches = await tx.dispatch.findMany({
      where: { tenantId: a.tenantId, toLocationId: site.id, status: 'ON_THE_WAY' },
      include: { fromLocation: locationSelect, items: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { dispatchedAt: 'asc' },
    });
    const purchases = await tx.purchase.findMany({
      where: { tenantId: a.tenantId, locationId: site.id, status: 'PENDING_RECEIPT' },
      include: { supplier: { select: { id: true, name: true, phone: true } }, items: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { purchaseDate: 'asc' },
    });
    return {
      blindCount: blind,
      count: dispatches.length + purchases.length,
      dispatches: dispatches.map((d) => ({
        type: 'DISPATCH' as const,
        id: d.id,
        number: d.number,
        from: d.fromLocation,
        vehicleNo: d.vehicleNo,
        driverName: d.driverName,
        driverPhone: d.driverPhone,
        dispatchedAt: d.dispatchedAt.toISOString(),
        items: d.items.map((i) => ({ material: materialRef(i.material), ...(blind ? {} : { sentQty: qn(i.sentQty) }) })),
      })),
      purchases: purchases.map((p) => ({
        type: 'PURCHASE' as const,
        id: p.id,
        number: p.number,
        supplier: p.supplier,
        challanNo: p.challanNo,
        vehicleNo: p.vehicleNo,
        purchaseDate: formatDateOnly(p.purchaseDate),
        items: p.items.map((i) => ({ material: materialRef(i.material), ...(blind ? {} : { challanQty: qn(i.challanQty) }) })),
      })),
    };
  });
}
