/**
 * Rentals from yards (an existing Supplier). Items arrive at a site or the yard on the start date
 * (RENTAL_IN with the rentalId); rent accrues daily (accrual.ts) to the rental's project.
 *
 * Supplier ledger (type ADJUSTMENT, signed: + we owe more):
 *   RENTAL_DEPOSIT         − deposit, at create
 *   RENTAL_DAMAGE          + damage charges, at each return
 *   RENTAL_CHARGE          + rent (Σ daily RENTAL charges), when everything is back → RETURNED
 *   RENTAL_DEPOSIT_REFUND  + cash the yard paid back, at close → CLOSED (the rest of the deposit
 *                          stays as a credit against the charges)
 */
import { fieldsOf, visible } from '../../core/auth/fieldStrip.js';
import { can, scopeAll } from '../../core/auth/access.js';
import { nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { findLocation } from '../inventory/stock.js';
import { addDays } from '../labor/labor.shared.js';
import { postLedger } from '../procurement/supplierLedger.service.js';
import { findProjectFor } from '../projects/access.js';
import { accrueRental, rentalAccrualInclude, rentalCostTo, yesterday } from './accrual.js';
import {
  actor,
  assertAvailable,
  audit,
  balances,
  D,
  EQUIPMENT_NUMBERS,
  equipmentRef,
  equipmentSelect,
  loadEquipment,
  locationSelect,
  lockLocations,
  occurredAtFor,
  postMove,
  projectSelect,
  qn,
  resolveLocation,
  seesYard,
  today,
  userSelect,
  ZERO,
  type Actor,
} from './equipment.shared.js';
import type { CloseRentalInput, CreateRentalInput, ExtendRentalInput, ListRentalsQuery, ReturnRentalInput } from './equipment.schema.js';

const rentalNotFound = () => new NotFound('RENTAL_NOT_FOUND', 'Rental not found');

export const rentalInclude = {
  supplier: { select: { id: true, name: true, phone: true } },
  project: projectSelect,
  location: locationSelect,
  createdBy: userSelect,
  items: { include: { equipment: equipmentSelect }, orderBy: { sortOrder: 'asc' } },
  returns: { include: { fromLocation: locationSelect, items: true }, orderBy: [{ returnDate: 'asc' }, { createdAt: 'asc' }] },
  charges: { select: { amountPaisa: true } },
} as const satisfies Prisma.EquipmentRentalInclude;

type RentalRow = Prisma.EquipmentRentalGetPayload<{ include: typeof rentalInclude }>;

const day = (d: Date | null) => (d ? formatDateOnly(d) : null);

export function rentalDto(r: RentalRow, a: Pick<Actor, 'seesRates'>) {
  const f = fieldsOf(a);
  const now = today();
  const lastDay = r.returnedDate ? addDays(formatDateOnly(r.returnedDate), -1) : now;
  const start = formatDateOnly(r.startDate);
  const daysOnRent = lastDay < start ? 0 : Math.round((dateOnly(lastDay).getTime() - dateOnly(start).getTime()) / 86_400_000) + 1;
  const accrual = {
    id: r.id,
    projectId: r.projectId,
    locationId: r.locationId,
    startDate: r.startDate,
    items: r.items.map((i) => ({ id: i.id, equipmentId: i.equipmentId, qty: i.qty, ratePaisaPerDay: i.ratePaisaPerDay })),
    returns: r.returns.map((x) => ({ returnDate: x.returnDate, items: x.items.map((y) => ({ rentalItemId: y.rentalItemId, qty: y.qty, missingQty: y.missingQty })) })),
  };
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    supplier: r.supplier,
    project: r.project,
    location: r.location,
    startDate: start,
    expectedEndDate: day(r.expectedEndDate),
    returnedDate: day(r.returnedDate),
    closedAt: r.closedAt?.toISOString() ?? null,
    reference: r.reference,
    note: r.note,
    items: r.items.map((i) => ({
      id: i.id,
      equipment: equipmentRef(i.equipment),
      qty: qn(i.qty),
      returnedQty: qn(i.returnedQty),
      missingQty: qn(i.missingQty),
      outstandingQty: qn(i.qty.sub(i.returnedQty).sub(i.missingQty)),
      ...visible(f, 'rates', { ratePaisaPerDay: i.ratePaisaPerDay.toString() }),
    })),
    ...visible(f, 'rates', {
      depositPaisa: r.depositPaisa.toString(),
      depositRefundedPaisa: r.depositRefundedPaisa.toString(),
      damageChargesPaisa: r.damageChargesPaisa.toString(),
      rentChargedPaisa: r.rentChargedPaisa.toString(),
      accruedToDatePaisa: rentalCostTo(accrual, now).toString(),
      postedPaisa: r.charges.reduce((s, c) => s + c.amountPaisa, 0n).toString(),
    }),
    daysOnRent,
    overdue: r.status === 'ACTIVE' && r.expectedEndDate !== null && formatDateOnly(r.expectedEndDate) < now,
    returns: r.returns.map((x) => ({
      id: x.id,
      returnDate: formatDateOnly(x.returnDate),
      location: x.fromLocation,
      ...visible(f, 'rates', { damageChargesPaisa: x.damageChargesPaisa.toString() }),
      note: x.note,
      items: x.items.map((y) => ({ rentalItemId: y.rentalItemId, qty: qn(y.qty), damagedQty: qn(y.damagedQty), missingQty: qn(y.missingQty) })),
    })),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

function scope(a: Actor): Prisma.EquipmentRentalWhereInput {
  if (scopeAll('equipment.view', a)) return {};
  const own: Prisma.EquipmentRentalWhereInput = { project: { userAccess: { some: { userId: a.userId } } } };
  return seesYard(a) ? { OR: [own, { projectId: null }] } : own;
}

async function findRental(tx: Tx, a: Actor, id: string): Promise<RentalRow> {
  const r = await tx.equipmentRental.findFirst({ where: { tenantId: a.tenantId, id, ...scope(a) }, include: rentalInclude });
  if (!r) throw rentalNotFound();
  return r;
}

/** The caller may manage this rental: its project in their rental scope, or a yard rental with equipment.manage / ALL_PROJECTS. */
async function assertManage(tx: Tx, a: Actor, r: Pick<RentalRow, 'projectId'>) {
  if (r.projectId) {
    await findProjectFor(tx, a, r.projectId, 'equipment.rental.manage').catch(() => {
      throw rentalNotFound();
    });
  } else if (!can('equipment.manage', a) && !scopeAll('equipment.rental.manage', a)) {
    throw new Forbidden('PERMISSION_DENIED', 'Only equipment managers handle yard rentals', { permission: 'equipment.manage' });
  }
}

export async function rentalDetail(tx: Tx, a: Actor, id: string) {
  return rentalDto(await findRental(tx, a, id), a);
}

export async function createRentalTx(tx: Tx, a: Actor, input: CreateRentalInput) {
  const supplier = await tx.supplier.findFirst({ where: { tenantId: a.tenantId, id: input.supplierId }, select: { id: true, name: true } });
  if (!supplier) throw new BadRequest('INVALID_SUPPLIER', 'Supplier not found');
  const location = await resolveLocation(tx, a, input, 'equipment.rental.manage', { open: true });
  const at = occurredAtFor(input.startDate);
  const equipment = await loadEquipment(tx, a.tenantId, input.items.map((i) => i.equipmentId));
  const number = await nextNumber(tx, a.tenantId, EQUIPMENT_NUMBERS.rental, at);
  const r = await tx.equipmentRental.create({
    data: {
      tenantId: a.tenantId,
      number,
      supplierId: supplier.id,
      projectId: location.projectId,
      locationId: location.id,
      startDate: dateOnly(input.startDate),
      expectedEndDate: input.expectedEndDate ? dateOnly(input.expectedEndDate) : null,
      depositPaisa: input.depositPaisa ?? 0n,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdById: a.userId,
    },
  });
  await lockLocations(tx, [location.id]);
  for (const [sortOrder, i] of input.items.entries()) {
    await tx.equipmentRentalItem.create({ data: { tenantId: a.tenantId, rentalId: r.id, equipmentId: i.equipmentId, qty: i.qty, ratePaisaPerDay: i.ratePaisaPerDay, sortOrder } });
    await postMove(tx, a.tenantId, { locationId: location.id, equipmentId: i.equipmentId, rentalId: r.id }, i.qty, {
      type: 'RENTAL_IN',
      refType: 'EQUIPMENT_RENTAL',
      refId: r.id,
      occurredAt: at,
      createdById: a.userId,
      note: `${number} · ${supplier.name}`,
    });
  }
  if ((input.depositPaisa ?? 0n) > 0n) {
    await postLedger(tx, a, {
      supplierId: supplier.id,
      type: 'ADJUSTMENT',
      amountPaisa: -input.depositPaisa!,
      refType: 'RENTAL_DEPOSIT',
      refId: r.id,
      projectId: location.projectId,
      occurredAt: at,
      note: `Deposit ${number}`,
    });
  }
  await audit(tx, a, 'equipment.rental.create', 'EquipmentRental', r.id, {
    number,
    supplier: supplier.name,
    location: location.name,
    startDate: input.startDate,
    depositPaisa: (input.depositPaisa ?? 0n).toString(),
    items: input.items.map((i) => ({ equipment: equipment.get(i.equipmentId)!.name, qty: qn(i.qty), ratePaisaPerDay: i.ratePaisaPerDay.toString() })),
  });
  return rentalDetail(tx, a, r.id);
}

export async function createRental(input: CreateRentalInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createRentalTx(tx, a, input));
}

export async function getRental(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => rentalDetail(tx, a, id));
}

export async function listRentals(query: ListRentalsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.EquipmentRentalWhereInput[] = [{ tenantId: a.tenantId }, scope(a)];
    if (query.status) and.push({ status: query.status });
    if (query.supplierId) and.push({ supplierId: query.supplierId });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.overdue !== undefined) {
      const overdue: Prisma.EquipmentRentalWhereInput = { status: 'ACTIVE', expectedEndDate: { lt: dateOnly(today()) } };
      and.push(query.overdue ? overdue : { NOT: overdue });
    }
    const where = { AND: and };
    const rows = await tx.equipmentRental.findMany({ where, include: rentalInclude, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.equipmentRental.count({ where });
    return { data: rows.map((r) => rentalDto(r, a)), meta: pageMeta(query, total) };
  });
}

export async function extendRental(id: string, input: ExtendRentalInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const r = await findRental(tx, a, id);
    await assertManage(tx, a, r);
    if (r.status !== 'ACTIVE') throw new Conflict('RENTAL_NOT_ACTIVE', 'Only an active rental can be extended', { status: r.status });
    if (input.expectedEndDate < formatDateOnly(r.startDate)) throw new BadRequest('INVALID_DATES', 'The end date is before the start');
    await tx.equipmentRental.update({ where: { id }, data: { expectedEndDate: dateOnly(input.expectedEndDate) } });
    await audit(tx, a, 'equipment.rental.extend', 'EquipmentRental', id, { number: r.number, from: day(r.expectedEndDate), to: input.expectedEndDate, note: input.note ?? null });
    return rentalDetail(tx, a, id);
  });
}

export async function returnRentalTx(tx: Tx, a: Actor, id: string, input: ReturnRentalInput) {
  const r = await findRental(tx, a, id);
  await assertManage(tx, a, r);
  if (r.status !== 'ACTIVE') throw new Conflict('RENTAL_NOT_ACTIVE', 'This rental is already returned', { status: r.status });
  const at = occurredAtFor(input.returnDate);
  if (input.returnDate < formatDateOnly(r.startDate)) throw new BadRequest('INVALID_DATES', 'The return date is before the rental started');
  const from = input.fromLocationId ? await findLocation(tx, a.tenantId, input.fromLocationId) : r.location;
  if (from.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Return from the yard or a site');
  if (from.type === 'SITE' && from.projectId !== r.projectId) {
    await findProjectFor(tx, a, from.projectId!, 'equipment.rental.manage').catch(() => {
      throw new NotFound('LOCATION_NOT_FOUND', 'Location not found');
    });
  }
  const equipment = await loadEquipment(tx, a.tenantId, r.items.map((i) => i.equipmentId));
  await lockLocations(tx, [from.id]);
  for (const ri of input.items) {
    const item = r.items.find((i) => i.id === ri.rentalItemId);
    if (!item) throw new BadRequest('INVALID_RENTAL_ITEM', 'This item is not on the rental', { rentalItemId: ri.rentalItemId });
    const missing = ri.missingQty ?? ZERO;
    const outstanding = item.qty.sub(item.returnedQty).sub(item.missingQty);
    if (ri.qty.add(missing).gt(outstanding)) {
      throw new BadRequest('RETURN_EXCEEDS_OUTSTANDING', `Only ${qn(outstanding)} ${item.equipment.unit} ${item.equipment.name} are still on hire`, { rentalItemId: item.id, outstandingQty: qn(outstanding) });
    }
    if (missing.gt(0)) {
      const onLedger = (await balances(tx, a.tenantId, { rentalId: r.id, equipmentIds: [item.equipmentId] })).reduce((s, b) => s.add(b.qty), D(0));
      const unaccounted = outstanding.sub(onLedger);
      if (missing.gt(unaccounted)) {
        throw new BadRequest('MISSING_NOT_REPORTED', `Report the missing ${item.equipment.name} as a loss first`, { rentalItemId: item.id, reportedMissingQty: qn(unaccounted.lt(0) ? ZERO : unaccounted) });
      }
    }
  }
  await assertAvailable(
    tx,
    a.tenantId,
    input.items.filter((i) => i.qty.gt(0)).map((i) => ({ locationId: from.id, equipmentId: r.items.find((x) => x.id === i.rentalItemId)!.equipmentId, rentalId: r.id, qty: i.qty })),
    equipment,
  );

  const ret = await tx.equipmentRentalReturn.create({
    data: { tenantId: a.tenantId, rentalId: r.id, returnDate: dateOnly(input.returnDate), fromLocationId: from.id, damageChargesPaisa: input.damageChargesPaisa ?? 0n, note: input.note ?? null, createdById: a.userId },
  });
  for (const ri of input.items) {
    const item = r.items.find((i) => i.id === ri.rentalItemId)!;
    const missing = ri.missingQty ?? ZERO;
    await tx.equipmentRentalReturnItem.create({ data: { tenantId: a.tenantId, returnId: ret.id, rentalItemId: item.id, qty: ri.qty, damagedQty: ri.damagedQty ?? ZERO, missingQty: missing } });
    if (ri.qty.gt(0)) {
      await postMove(tx, a.tenantId, { locationId: from.id, equipmentId: item.equipmentId, rentalId: r.id }, ri.qty.neg(), {
        type: 'RENTAL_RETURN_OUT',
        refType: 'EQUIPMENT_RENTAL_RETURN',
        refId: ret.id,
        occurredAt: at,
        createdById: a.userId,
        note: r.number,
      });
    }
    await tx.equipmentRentalItem.update({ where: { id: item.id }, data: { returnedQty: { increment: ri.qty }, missingQty: { increment: missing } } });
  }
  const damage = input.damageChargesPaisa ?? 0n;
  if (damage > 0n) {
    await postLedger(tx, a, { supplierId: r.supplierId, type: 'ADJUSTMENT', amountPaisa: damage, refType: 'RENTAL_DAMAGE', refId: ret.id, projectId: r.projectId, occurredAt: at, note: `Damage charges ${r.number}` });
  }

  const items = await tx.equipmentRentalItem.findMany({ where: { tenantId: a.tenantId, rentalId: r.id } });
  const allBack = items.every((i) => i.qty.sub(i.returnedQty).sub(i.missingQty).lte(0));
  let rent = 0n;
  if (allBack) {
    // Post the remaining complete days (and correct any day posted after the return date), then bill the rent.
    const fresh = await tx.equipmentRental.findUniqueOrThrow({ where: { id: r.id }, include: rentalAccrualInclude });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`equipment-accrual:${a.tenantId}`}))`;
    await accrueRental(tx, a.tenantId, fresh, yesterday());
    rent = (await tx.equipmentCharge.aggregate({ where: { tenantId: a.tenantId, rentalId: r.id }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0n;
    const lastReturn = (await tx.equipmentRentalReturn.aggregate({ where: { tenantId: a.tenantId, rentalId: r.id }, _max: { returnDate: true } }))._max.returnDate!;
    if (rent > 0n) {
      await postLedger(tx, a, { supplierId: r.supplierId, type: 'ADJUSTMENT', amountPaisa: rent, refType: 'RENTAL_CHARGE', refId: r.id, projectId: r.projectId, occurredAt: at, note: `Rent ${r.number}` });
    }
    await tx.equipmentRental.update({ where: { id: r.id }, data: { status: 'RETURNED', returnedDate: lastReturn, rentChargedPaisa: rent, damageChargesPaisa: { increment: damage } } });
  } else if (damage > 0n) {
    await tx.equipmentRental.update({ where: { id: r.id }, data: { damageChargesPaisa: { increment: damage } } });
  }
  await audit(tx, a, 'equipment.rental.return', 'EquipmentRental', r.id, {
    number: r.number,
    returnId: ret.id,
    returnDate: input.returnDate,
    from: from.name,
    items: input.items.map((i) => ({ rentalItemId: i.rentalItemId, qty: qn(i.qty), damagedQty: qn(i.damagedQty ?? ZERO), missingQty: qn(i.missingQty ?? ZERO) })),
    damageChargesPaisa: damage.toString(),
    ...(allBack ? { status: 'RETURNED', rentChargedPaisa: rent.toString() } : {}),
  });
  return rentalDetail(tx, a, r.id);
}

export async function returnRental(id: string, input: ReturnRentalInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => returnRentalTx(tx, a, id, input));
}

export async function closeRental(id: string, input: CloseRentalInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const r = await findRental(tx, a, id);
    await assertManage(tx, a, r);
    if (r.status !== 'RETURNED') throw new Conflict('RENTAL_NOT_RETURNED', 'Return everything before closing the rental', { status: r.status });
    const refund = input.depositRefundPaisa ?? 0n;
    if (refund > r.depositPaisa) throw new BadRequest('REFUND_EXCEEDS_DEPOSIT', 'The refund is more than the deposit', { depositPaisa: r.depositPaisa.toString() });
    const at = new Date();
    if (refund > 0n) {
      await postLedger(tx, a, { supplierId: r.supplierId, type: 'ADJUSTMENT', amountPaisa: refund, refType: 'RENTAL_DEPOSIT_REFUND', refId: r.id, projectId: r.projectId, occurredAt: at, note: `Deposit refund ${r.number}` });
    }
    await tx.equipmentRental.update({ where: { id }, data: { status: 'CLOSED', closedAt: at, depositRefundedPaisa: refund } });
    await audit(tx, a, 'equipment.rental.close', 'EquipmentRental', id, { number: r.number, depositRefundPaisa: refund.toString(), note: input.note ?? null });
    return rentalDetail(tx, a, id);
  });
}

