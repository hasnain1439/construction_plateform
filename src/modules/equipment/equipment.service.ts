/**
 * Equipment register, stock in / adjustments, the allocation map (balances per location),
 * the movement log, "equipment on site" for a project, daily charges and the accrual run.
 * Rates and money only with fields.rates.
 */
import { fieldsOf, visible } from '../../core/auth/fieldStrip.js';
import { scopeAll } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import type { Equipment, StockLocation } from '../../generated/prisma/client.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { systemLocations } from '../inventory/stock.js';
import { findProjectFor } from '../projects/access.js';
import { runAccrualTx, yesterday } from './accrual.js';
import {
  actor,
  assertAvailable,
  assertRentalItem,
  audit,
  balances,
  D,
  equipmentRef,
  iso,
  lockLocations,
  occurredAtFor,
  postMove,
  projectSelect,
  qn,
  resolveLocation,
  valueOf,
  visibleLocationIds,
  ZERO,
  type Actor,
  type Dec,
} from './equipment.shared.js';
import type {
  AccrualInput,
  AdjustInput,
  BalancesQuery,
  CreateEquipmentInput,
  ListChargesQuery,
  ListEquipmentQuery,
  MovementsQuery,
  StockInInput,
  UpdateEquipmentInput,
} from './equipment.schema.js';
import { lossDto, lossInclude } from './losses.service.js';
import { rentalDto, rentalInclude } from './rentals.service.js';
import { transferDto, transferInclude } from './transfers.service.js';

const notFound = () => new NotFound('EQUIPMENT_NOT_FOUND', 'Equipment not found');

interface Totals {
  ownedQty: Dec;
  rentedQty: Dec;
  atSitesQty: Dec;
  atYardQty: Dec;
  inTransitQty: Dec;
}
const emptyTotals = (): Totals => ({ ownedQty: ZERO, rentedQty: ZERO, atSitesQty: ZERO, atYardQty: ZERO, inTransitQty: ZERO });

/** Company-wide totals per equipment (owned vs rented, where they are). */
async function totalsFor(tx: Tx, tenantId: string, equipmentIds?: string[]): Promise<Map<string, Totals>> {
  const rows = await balances(tx, tenantId, equipmentIds ? { equipmentIds } : {});
  const types = new Map((await tx.stockLocation.findMany({ where: { tenantId }, select: { id: true, type: true } })).map((l) => [l.id, l.type]));
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const t = out.get(r.equipmentId) ?? emptyTotals();
    if (r.rentalId) t.rentedQty = t.rentedQty.add(r.qty);
    else t.ownedQty = t.ownedQty.add(r.qty);
    const type = types.get(r.locationId);
    if (type === 'SITE') t.atSitesQty = t.atSitesQty.add(r.qty);
    else if (type === 'TRANSIT') t.inTransitQty = t.inTransitQty.add(r.qty);
    else t.atYardQty = t.atYardQty.add(r.qty);
    out.set(r.equipmentId, t);
  }
  return out;
}

export function equipmentDto(e: Equipment, t: Totals | undefined, a: Pick<Actor, 'seesRates'>) {
  const x = t ?? emptyTotals();
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    kind: e.kind,
    category: e.category,
    unit: e.unit,
    serialNo: e.serialNo,
    coverageSqftPerUnit: e.coverageSqftPerUnit === null ? null : qn(e.coverageSqftPerUnit),
    isActive: e.isActive,
    notes: e.notes,
    ...visible(fieldsOf(a), 'rates', { hireRatePaisaPerDay: e.hireRatePaisaPerDay.toString(), replacementValuePaisa: e.replacementValuePaisa.toString() }),
    ownedQty: qn(x.ownedQty),
    rentedQty: qn(x.rentedQty),
    atSitesQty: qn(x.atSitesQty),
    atYardQty: qn(x.atYardQty),
    inTransitQty: qn(x.inTransitQty),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

async function findEquipment(tx: Tx, tenantId: string, id: string) {
  const e = await tx.equipment.findFirst({ where: { tenantId, id } });
  if (!e) throw notFound();
  return e;
}

export async function equipmentDetail(tx: Tx, a: Actor, id: string) {
  const e = await findEquipment(tx, a.tenantId, id);
  const totals = await totalsFor(tx, a.tenantId, [id]);
  const visibleIds = await visibleLocationIds(tx, a);
  const rows = (await balances(tx, a.tenantId, { equipmentIds: [id], locationIds: visibleIds })).filter((r) => !r.qty.eq(0));
  const locations = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.locationId))] } }, select: { id: true, type: true, name: true, projectId: true } });
  const byLocation = new Map<string, { owned: Dec; rented: Dec }>();
  for (const r of rows) {
    const b = byLocation.get(r.locationId) ?? { owned: ZERO, rented: ZERO };
    if (r.rentalId) b.rented = b.rented.add(r.qty);
    else b.owned = b.owned.add(r.qty);
    byLocation.set(r.locationId, b);
  }
  return {
    ...equipmentDto(e, totals.get(id), a),
    locations: locations.map((l) => ({ location: l, ownedQty: qn(byLocation.get(l.id)!.owned), rentedQty: qn(byLocation.get(l.id)!.rented) })),
  };
}

// ─── Register ───────────────────────────────────────────────────────────────

export async function listEquipment(query: ListEquipmentQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.EquipmentWhereInput = {
      tenantId: a.tenantId,
      ...(query.category ? { category: query.category } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.active === undefined ? {} : { isActive: query.active }),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { code: { contains: query.search, mode: 'insensitive' } }] } : {}),
    };
    const rows = await tx.equipment.findMany({ where, orderBy: [{ isActive: 'desc' }, { category: 'asc' }, { name: 'asc' }], ...skipTake(query) });
    const total = await tx.equipment.count({ where });
    const totals = await totalsFor(tx, a.tenantId, rows.map((r) => r.id));
    return { data: rows.map((e) => equipmentDto(e, totals.get(e.id), a)), meta: pageMeta(query, total) };
  });
}

export async function getEquipment(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => equipmentDetail(tx, a, id));
}

function uniqueName(err: unknown, name: string | undefined): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new Conflict('EQUIPMENT_EXISTS', `“${name}” is already in the equipment list`);
  throw err;
}

export async function createEquipmentTx(tx: Tx, a: Actor, input: CreateEquipmentInput) {
  const exists = await tx.equipment.findFirst({ where: { tenantId: a.tenantId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
  if (exists) uniqueName(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '' }), input.name);
  const e = await tx.equipment
    .create({
      data: {
        tenantId: a.tenantId,
        name: input.name,
        code: input.code ?? null,
        kind: input.kind,
        category: input.category,
        unit: input.unit ?? 'nos',
        serialNo: input.serialNo ?? null,
        hireRatePaisaPerDay: input.hireRatePaisaPerDay ?? 0n,
        replacementValuePaisa: input.replacementValuePaisa ?? 0n,
        coverageSqftPerUnit: input.coverageSqftPerUnit ?? null,
        notes: input.notes ?? null,
      },
    })
    .catch((err: unknown) => uniqueName(err, input.name));
  await audit(tx, a, 'equipment.create', 'Equipment', e.id, {
    name: e.name,
    kind: e.kind,
    category: e.category,
    hireRatePaisaPerDay: e.hireRatePaisaPerDay.toString(),
    replacementValuePaisa: e.replacementValuePaisa.toString(),
  });
  return equipmentDetail(tx, a, e.id);
}

export async function createEquipment(input: CreateEquipmentInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createEquipmentTx(tx, a, input));
}

export async function updateEquipment(id: string, input: UpdateEquipmentInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const before = await findEquipment(tx, a.tenantId, id);
    if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = await tx.equipment.findFirst({ where: { tenantId: a.tenantId, name: { equals: input.name, mode: 'insensitive' }, id: { not: id } }, select: { id: true } });
      if (clash) throw new Conflict('EQUIPMENT_EXISTS', `“${input.name}” is already in the equipment list`);
    }
    const data: Prisma.EquipmentUpdateInput = {};
    for (const k of ['name', 'code', 'kind', 'category', 'unit', 'serialNo', 'hireRatePaisaPerDay', 'replacementValuePaisa', 'coverageSqftPerUnit', 'notes', 'isActive'] as const) {
      if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
    }
    await tx.equipment.update({ where: { id }, data }).catch((err: unknown) => uniqueName(err, input.name));
    const changes = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, { from: String((before as Record<string, unknown>)[k] ?? null), to: v === null ? null : String(v) }]),
    );
    await audit(tx, a, 'equipment.update', 'Equipment', id, changes as Prisma.InputJsonValue);
    return equipmentDetail(tx, a, id);
  });
}

// ─── Stock in / adjust ──────────────────────────────────────────────────────

export async function stockInTx(tx: Tx, a: Actor, id: string, input: StockInInput, opts: { at?: Date } = {}) {
  const e = await findEquipment(tx, a.tenantId, id);
  const location = input.projectId || input.locationId ? await resolveLocation(tx, a, input, 'equipment.manage', { open: true, projectPerm: 'projects.project.view' }) : (await systemLocations(tx, a.tenantId)).store;
  const at = opts.at ?? (input.date ? occurredAtFor(input.date) : new Date());
  const refId = uuidv7();
  await lockLocations(tx, [location.id]);
  await postMove(tx, a.tenantId, { locationId: location.id, equipmentId: e.id, rentalId: null }, input.qty, {
    type: input.type === 'OPENING' ? 'OPENING_IN' : 'PURCHASE_IN',
    refType: 'EQUIPMENT_STOCK_IN',
    refId,
    occurredAt: at,
    createdById: a.userId,
    note: input.note ?? null,
  });
  await audit(tx, a, 'equipment.stock_in', 'Equipment', e.id, { type: input.type, qty: qn(input.qty), location: location.name, date: iso(at) });
  return equipmentDetail(tx, a, e.id);
}

export async function stockIn(id: string, input: StockInInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => stockInTx(tx, a, id, input));
}

export async function adjust(id: string, input: AdjustInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const e = await findEquipment(tx, a.tenantId, id);
    const location = await resolveLocation(tx, a, { locationId: input.locationId }, 'equipment.manage', { projectPerm: 'projects.project.view' });
    if (input.rentalId) await assertRentalItem(tx, a.tenantId, input.rentalId, e.id, false);
    const bucket = { locationId: location.id, equipmentId: e.id, rentalId: input.rentalId ?? null };
    await lockLocations(tx, [location.id]);
    if (input.qty.lt(0)) await assertAvailable(tx, a.tenantId, [{ ...bucket, qty: input.qty.neg() }], new Map([[e.id, e]]));
    const at = input.date ? occurredAtFor(input.date) : new Date();
    await postMove(tx, a.tenantId, bucket, input.qty, { type: 'ADJUSTMENT', refType: 'EQUIPMENT_ADJUSTMENT', refId: uuidv7(), occurredAt: at, createdById: a.userId, note: input.reason });
    await audit(tx, a, 'equipment.adjust', 'Equipment', e.id, { qty: qn(input.qty), location: location.name, rentalId: input.rentalId ?? null, reason: input.reason });
    return equipmentDetail(tx, a, e.id);
  });
}

// ─── Allocation map ─────────────────────────────────────────────────────────

export async function allocation(query: BalancesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    let locationIds = await visibleLocationIds(tx, a);
    if (query.projectId) {
      await findProjectFor(tx, a, query.projectId, 'equipment.view');
      const site = await tx.stockLocation.findFirst({ where: { tenantId: a.tenantId, projectId: query.projectId }, select: { id: true } });
      locationIds = site ? [site.id] : [];
    }
    if (query.locationId) locationIds = locationIds === null || locationIds.includes(query.locationId) ? [query.locationId] : [];
    const equipmentIds = query.category ? (await tx.equipment.findMany({ where: { tenantId: a.tenantId, category: query.category }, select: { id: true } })).map((e) => e.id) : undefined;
    const ids = query.equipmentId ? (equipmentIds ? equipmentIds.filter((i) => i === query.equipmentId) : [query.equipmentId]) : equipmentIds;
    const rows = (await balances(tx, a.tenantId, { locationIds, ...(ids ? { equipmentIds: ids } : {}) })).filter((r) => !r.qty.eq(0));
    const locations = await tx.stockLocation.findMany({
      where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.locationId))] } },
      select: { id: true, type: true, name: true, projectId: true, project: projectSelect },
    });
    const equipment = await tx.equipment.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.equipmentId))] } } });
    const eqById = new Map(equipment.map((e) => [e.id, e]));
    const rentals = await tx.equipmentRental.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(rows.flatMap((r) => (r.rentalId ? [r.rentalId] : [])))] } }, select: { id: true, number: true } });
    const rentalNo = new Map(rentals.map((r) => [r.id, r.number]));
    const order = { STORE: 0, TRANSIT: 1, SITE: 2 } as const;
    const totals = new Map<string, Totals>();
    const out = locations
      .sort((x, y) => order[x.type] - order[y.type] || x.name.localeCompare(y.name))
      .map((l) => {
        const items = new Map<string, { owned: Dec; rented: Dec; rentals: Array<{ id: string; number: string; qty: number }> }>();
        for (const r of rows.filter((x) => x.locationId === l.id)) {
          const it = items.get(r.equipmentId) ?? { owned: ZERO, rented: ZERO, rentals: [] };
          if (r.rentalId) {
            it.rented = it.rented.add(r.qty);
            it.rentals.push({ id: r.rentalId, number: rentalNo.get(r.rentalId) ?? '', qty: qn(r.qty) });
          } else it.owned = it.owned.add(r.qty);
          items.set(r.equipmentId, it);
          const t = totals.get(r.equipmentId) ?? emptyTotals();
          if (r.rentalId) t.rentedQty = t.rentedQty.add(r.qty);
          else t.ownedQty = t.ownedQty.add(r.qty);
          if (l.type === 'SITE') t.atSitesQty = t.atSitesQty.add(r.qty);
          else if (l.type === 'TRANSIT') t.inTransitQty = t.inTransitQty.add(r.qty);
          else t.atYardQty = t.atYardQty.add(r.qty);
          totals.set(r.equipmentId, t);
        }
        return {
          location: { id: l.id, type: l.type, name: l.name, projectId: l.projectId },
          project: l.project,
          items: [...items.entries()]
            .map(([eid, it]) => ({ equipment: equipmentRef(eqById.get(eid)!), ownedQty: qn(it.owned), rentedQty: qn(it.rented), totalQty: qn(it.owned.add(it.rented)), rentals: it.rentals }))
            .sort((x, y) => x.equipment.name.localeCompare(y.equipment.name)),
        };
      });
    return {
      locations: out,
      totals: [...totals.entries()]
        .map(([eid, t]) => ({ equipment: equipmentRef(eqById.get(eid)!), ownedQty: qn(t.ownedQty), rentedQty: qn(t.rentedQty), atYardQty: qn(t.atYardQty), atSitesQty: qn(t.atSitesQty), inTransitQty: qn(t.inTransitQty) }))
        .sort((x, y) => x.equipment.name.localeCompare(y.equipment.name)),
    };
  });
}

// ─── Movement log ───────────────────────────────────────────────────────────

export async function listMovements(query: MovementsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const visibleIds = await visibleLocationIds(tx, a);
    const and: Prisma.EquipmentMovementWhereInput[] = [{ tenantId: a.tenantId }];
    if (visibleIds) and.push({ locationId: { in: visibleIds } });
    if (query.equipmentId) and.push({ equipmentId: query.equipmentId });
    if (query.locationId) and.push({ locationId: query.locationId });
    if (query.projectId) and.push({ location: { projectId: query.projectId } });
    if (query.type) and.push({ type: query.type });
    if (query.from) and.push({ occurredAt: { gte: pktDayStart(query.from) } });
    if (query.to) and.push({ occurredAt: { lt: pktDayEnd(query.to) } });
    const where = { AND: and };
    const rows = await tx.equipmentMovement.findMany({
      where,
      include: {
        equipment: true,
        location: { select: { id: true, type: true, name: true, projectId: true } },
        rental: { select: { id: true, number: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      ...skipTake(query),
    });
    const total = await tx.equipmentMovement.count({ where });
    return {
      data: rows.map((m) => ({
        id: m.id,
        type: m.type,
        equipment: equipmentRef(m.equipment),
        location: m.location,
        rental: m.rental,
        quantity: qn(m.quantity),
        refType: m.refType,
        refId: m.refId,
        occurredAt: m.occurredAt.toISOString(),
        note: m.note,
        createdBy: m.createdBy,
      })),
      meta: pageMeta(query, total),
    };
  });
}

// ─── Equipment on site ──────────────────────────────────────────────────────

async function chargeTotal(tx: Tx, tenantId: string, where: Prisma.EquipmentChargeWhereInput) {
  return (await tx.equipmentCharge.aggregate({ where: { tenantId, ...where }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0n;
}

export async function projectEquipment(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await findProjectFor(tx, a, projectId, 'equipment.view');
    const site: Pick<StockLocation, 'id' | 'type' | 'name' | 'projectId'> | null = await tx.stockLocation.findFirst({
      where: { tenantId: a.tenantId, projectId },
      select: { id: true, type: true, name: true, projectId: true },
    });
    const rows = site ? (await balances(tx, a.tenantId, { locationIds: [site.id] })).filter((r) => !r.qty.eq(0)) : [];
    const equipment = await tx.equipment.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.equipmentId))] } } });
    const items = equipment
      .map((e) => {
        const owned = rows.filter((r) => r.equipmentId === e.id && !r.rentalId).reduce((s, r) => s.add(r.qty), D(0));
        const rented = rows.filter((r) => r.equipmentId === e.id && r.rentalId).reduce((s, r) => s.add(r.qty), D(0));
        return {
          equipment: equipmentRef(e),
          ownedQty: qn(owned),
          rentedQty: qn(rented),
          ...visible(fieldsOf(a), 'rates', { hireRatePaisaPerDay: e.hireRatePaisaPerDay.toString(), dailyHirePaisa: (owned.gt(0) ? valueOf(owned, e.hireRatePaisaPerDay) : 0n).toString() }),
        };
      })
      .sort((x, y) => x.equipment.name.localeCompare(y.equipment.name));
    const incoming = site
      ? await tx.equipmentTransfer.findMany({ where: { tenantId: a.tenantId, toLocationId: site.id, status: 'ON_THE_WAY' }, include: transferInclude, orderBy: { sentAt: 'asc' } })
      : [];
    const rentals = await tx.equipmentRental.findMany({ where: { tenantId: a.tenantId, projectId, status: 'ACTIVE' }, include: rentalInclude, orderBy: { startDate: 'asc' } });
    const losses = await tx.equipmentLoss.findMany({ where: { tenantId: a.tenantId, projectId, status: 'REPORTED' }, include: lossInclude, orderBy: { reportedAt: 'desc' } });
    const incomingDtos = [];
    for (const t of incoming) incomingDtos.push(await transferDto(tx, t, a));
    const lossDtos = [];
    for (const l of losses) lossDtos.push(await lossDto(l, a));
    return {
      site,
      items,
      incoming: incomingDtos,
      rentals: rentals.map((r) => rentalDto(r, a)),
      openLosses: lossDtos,
      ...visible(fieldsOf(a), 'rates', {
        hireToDatePaisa: (await chargeTotal(tx, a.tenantId, { projectId, kind: 'INTERNAL_HIRE' })).toString(),
        rentalToDatePaisa: (await chargeTotal(tx, a.tenantId, { projectId, kind: 'RENTAL' })).toString(),
      }),
    };
  });
}

// ─── Charges ────────────────────────────────────────────────────────────────

export async function listCharges(query: ListChargesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.EquipmentChargeWhereInput[] = [{ tenantId: a.tenantId }];
    if (!scopeAll('equipment.view', a)) and.push({ project: { userAccess: { some: { userId: a.userId } } } });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.kind) and.push({ kind: query.kind });
    if (query.equipmentId) and.push({ equipmentId: query.equipmentId });
    if (query.rentalId) and.push({ rentalId: query.rentalId });
    if (query.from) and.push({ date: { gte: dateOnly(query.from) } });
    if (query.to) and.push({ date: { lte: dateOnly(query.to) } });
    const where = { AND: and };
    const rows = await tx.equipmentCharge.findMany({
      where,
      include: { project: projectSelect, location: { select: { id: true, type: true, name: true, projectId: true } }, equipment: true, rental: { select: { id: true, number: true } } },
      orderBy: [{ date: 'desc' }, { baseKey: 'asc' }, { seq: 'asc' }],
      ...skipTake(query),
    });
    const total = await tx.equipmentCharge.count({ where });
    const sum = (await tx.equipmentCharge.aggregate({ where, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0n;
    const f = fieldsOf(a);
    return {
      data: rows.map((c) => ({
        id: c.id,
        date: formatDateOnly(c.date),
        kind: c.kind,
        project: c.project,
        location: c.location,
        equipment: equipmentRef(c.equipment),
        rental: c.rental,
        qty: qn(c.qty),
        correction: c.seq > 0,
        ...visible(f, 'rates', { ratePaisa: c.ratePaisa.toString(), amountPaisa: c.amountPaisa.toString() }),
      })),
      meta: { ...pageMeta(query, total), ...visible(f, 'rates', { totalPaisa: sum.toString() }) },
    };
  });
}

export async function runAccrual(input: AccrualInput) {
  const a = actor();
  const through = input.through ?? yesterday();
  if (input.through && !/^\d{4}-\d{2}-\d{2}$/.test(input.through)) throw new BadRequest('VALIDATION_ERROR', 'Invalid date');
  return withTenant(a.tenantId, async (tx) => {
    const r = await runAccrualTx(tx, a.tenantId, through);
    await audit(tx, a, 'equipment.accrual.run', 'EquipmentCharge', a.tenantId, {
      through,
      internalHireRows: r.internalHire.rows,
      internalHirePaisa: r.internalHire.amountPaisa.toString(),
      rentalRows: r.rental.rows,
      rentalPaisa: r.rental.amountPaisa.toString(),
    });
    return {
      through,
      internalHire: { rows: r.internalHire.rows, ...visible(fieldsOf(a), 'rates', { amountPaisa: r.internalHire.amountPaisa.toString() }) },
      rental: { rows: r.rental.rows, ...visible(fieldsOf(a), 'rates', { amountPaisa: r.rental.amountPaisa.toString() }) },
    };
  });
}
