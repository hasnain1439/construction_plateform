/**
 * The equipment engine. Every equipment change is one append-only EquipmentMovement row
 * (app_user SELECT + INSERT only); the quantity at a location is SUM(quantity) per
 * (location, equipment, rentalId) — owned units have rentalId null, rented units carry their rental.
 *
 * Locations are the stock locations: the Central Store is the equipment yard, one TRANSIT bucket,
 * one SITE per non-draft project.
 */
import { can, scopeAll } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { todayIn } from '../../core/utils/dates.js';
import type { Equipment, EquipmentMovementType, StockLocation } from '../../generated/prisma/client.js';
import { findLocation, qn, siteLocation, type Actor, type Dec } from '../inventory/stock.js';
import { STOCK_OPEN_STATUSES } from '../inventory/usage.service.js';
import { assertEditable, findProjectFor } from '../projects/access.js';

export { actor, audit, D, iso, occurredAtFor, q, qn, valueOf, ZERO, type Actor, type Dec } from '../inventory/stock.js';

export const EQUIPMENT_NUMBERS = { transfer: 'ET-####', rental: 'RNT-####', loss: 'EL-####' } as const;

/** Karachi calendar day of an instant. */
export const dayOf = (at: Date) => todayIn('Asia/Karachi', at);
export const today = () => todayIn('Asia/Karachi');

export const equipmentRef = (e: Pick<Equipment, 'id' | 'name' | 'code' | 'unit' | 'kind' | 'category'>) => ({
  id: e.id,
  name: e.name,
  code: e.code,
  unit: e.unit,
  kind: e.kind,
  category: e.category,
});
export const equipmentSelect = { select: { id: true, name: true, code: true, unit: true, kind: true, category: true, replacementValuePaisa: true, hireRatePaisaPerDay: true } } as const;
export const locationSelect = { select: { id: true, type: true, name: true, projectId: true } } as const;
export const projectSelect = { select: { id: true, code: true, name: true } } as const;
export const userSelect = { select: { id: true, name: true } } as const;

// ─── Visibility ─────────────────────────────────────────────────────────────

/** The yard (Central Store) and transit: equipment managers, senders, or company-wide viewers. */
export function seesYard(a: Actor): boolean {
  return can('equipment.manage', a) || can('equipment.transfer.create', a) || scopeAll('equipment.view', a);
}

/** Location ids the caller may see for `perm` (null = every location). */
export async function visibleLocationIds(tx: Tx, a: Actor, perm = 'equipment.view'): Promise<string[] | null> {
  if (scopeAll(perm, a)) return null;
  const sites = await tx.stockLocation.findMany({
    where: { tenantId: a.tenantId, type: 'SITE', project: { userAccess: { some: { userId: a.userId } } } },
    select: { id: true },
  });
  const ids = sites.map((s) => s.id);
  if (seesYard(a)) {
    const yard = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, type: { in: ['STORE', 'TRANSIT'] } }, select: { id: true } });
    ids.push(...yard.map((l) => l.id));
  }
  return ids;
}

const locationNotFound = () => new NotFound('LOCATION_NOT_FOUND', 'Location not found');

/**
 * A location the caller may act on with `perm`: a project's site (projectId, or a SITE location
 * of a project in scope) or the yard (needs equipment.manage or ALL_PROJECTS `perm`).
 * `open` = the project must be ACTIVE / CLOSEOUT. TRANSIT is never a valid target.
 */
export async function resolveLocation(
  tx: Tx,
  a: Actor,
  input: { locationId?: string | undefined; projectId?: string | undefined },
  perm: string,
  opts: { open?: boolean; projectPerm?: string } = {},
): Promise<StockLocation> {
  if (input.projectId) {
    const project = await findProjectFor(tx, a, input.projectId, opts.projectPerm ?? perm);
    if (opts.open) assertEditable(project, [...STOCK_OPEN_STATUSES]);
    return siteLocation(tx, a.tenantId, project);
  }
  const location = await findLocation(tx, a.tenantId, input.locationId!).catch(() => {
    throw locationNotFound();
  });
  if (location.type === 'TRANSIT') throw new BadRequest('INVALID_LOCATION', 'Choose the yard or a site, not transit');
  if (location.type === 'SITE') {
    const project = await findProjectFor(tx, a, location.projectId!, opts.projectPerm ?? perm).catch(() => {
      throw locationNotFound();
    });
    if (project.status === 'DRAFT') throw locationNotFound();
    if (opts.open) assertEditable(project, [...STOCK_OPEN_STATUSES]);
    return location;
  }
  if (!can('equipment.manage', a) && !scopeAll(perm, a)) {
    throw new Forbidden('PERMISSION_DENIED', 'Only equipment managers work with the yard', { permission: 'equipment.manage' });
  }
  return location;
}

// ─── Equipment ──────────────────────────────────────────────────────────────

export async function loadEquipment(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, Equipment>> {
  const unique = [...new Set(ids)];
  const rows = await tx.equipment.findMany({ where: { tenantId, id: { in: unique } } });
  const map = new Map(rows.map((e) => [e.id, e]));
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length) throw new BadRequest('INVALID_EQUIPMENT', 'Some equipment was not found', { equipmentIds: missing });
  return map;
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export interface Bucket {
  locationId: string;
  equipmentId: string;
  rentalId: string | null;
}

/** Serialises equipment changes per location until the transaction ends (id order, no deadlocks). */
export async function lockLocations(tx: Tx, locationIds: string[]): Promise<void> {
  for (const id of [...new Set(locationIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`equipment:${id}`}))`;
  }
}

export async function balanceOf(tx: Tx, tenantId: string, b: Bucket): Promise<Dec> {
  const agg = await tx.equipmentMovement.aggregate({ where: { tenantId, locationId: b.locationId, equipmentId: b.equipmentId, rentalId: b.rentalId }, _sum: { quantity: true } });
  return agg._sum.quantity ?? new Prisma.Decimal(0);
}

export interface BalanceRow extends Bucket {
  qty: Dec;
}

export async function balances(tx: Tx, tenantId: string, where: { locationIds?: string[] | null; equipmentIds?: string[]; rentalId?: string } = {}): Promise<BalanceRow[]> {
  const rows = await tx.equipmentMovement.groupBy({
    by: ['locationId', 'equipmentId', 'rentalId'],
    where: {
      tenantId,
      ...(where.locationIds ? { locationId: { in: where.locationIds } } : {}),
      ...(where.equipmentIds ? { equipmentId: { in: where.equipmentIds } } : {}),
      ...(where.rentalId ? { rentalId: where.rentalId } : {}),
    },
    _sum: { quantity: true },
  });
  return rows.map((r) => ({ locationId: r.locationId, equipmentId: r.equipmentId, rentalId: r.rentalId, qty: r._sum.quantity ?? new Prisma.Decimal(0) }));
}

export interface MoveRef {
  type: EquipmentMovementType;
  refType: string;
  refId: string;
  occurredAt: Date;
  createdById: string | null;
  note?: string | null;
}

/** One ledger row; `qty` is signed (+ in, − out). */
export async function postMove(tx: Tx, tenantId: string, b: Bucket, qty: Dec, ref: MoveRef): Promise<void> {
  await tx.equipmentMovement.create({
    data: {
      tenantId,
      locationId: b.locationId,
      equipmentId: b.equipmentId,
      rentalId: b.rentalId,
      quantity: qty,
      type: ref.type,
      refType: ref.refType,
      refId: ref.refId,
      occurredAt: ref.occurredAt,
      createdById: ref.createdById,
      note: ref.note ?? null,
    },
  });
}

/** Every line must be available in its bucket (same bucket lines added up) → 400 INSUFFICIENT_EQUIPMENT. */
export async function assertAvailable(tx: Tx, tenantId: string, lines: Array<Bucket & { qty: Dec }>, equipment: Map<string, Pick<Equipment, 'name' | 'unit'>>): Promise<void> {
  const need = new Map<string, Bucket & { qty: Dec }>();
  for (const l of lines) {
    const key = `${l.locationId}:${l.equipmentId}:${l.rentalId ?? ''}`;
    const prev = need.get(key);
    need.set(key, prev ? { ...prev, qty: prev.qty.add(l.qty) } : { ...l });
  }
  const short = [];
  for (const l of need.values()) {
    const have = await balanceOf(tx, tenantId, l);
    if (have.lt(l.qty)) {
      const e = equipment.get(l.equipmentId);
      short.push({ equipmentId: l.equipmentId, rentalId: l.rentalId, name: e?.name ?? l.equipmentId, unit: e?.unit ?? '', requested: qn(l.qty), available: qn(have) });
    }
  }
  if (short.length) {
    throw new BadRequest('INSUFFICIENT_EQUIPMENT', `Not enough ${short.map((s) => s.name).join(', ')} there`, { equipmentId: short[0]!.equipmentId, available: short[0]!.available, items: short });
  }
}

/** A rental that may hold `equipmentId` (any status unless `active`) → 400 INVALID_RENTAL. */
export async function assertRentalItem(tx: Tx, tenantId: string, rentalId: string, equipmentId: string, active = true) {
  const rental = await tx.equipmentRental.findFirst({ where: { tenantId, id: rentalId }, include: { items: { where: { equipmentId } } } });
  if (!rental || !rental.items.length || (active && rental.status !== 'ACTIVE')) {
    throw new BadRequest('INVALID_RENTAL', 'This rental does not have that equipment on hire', { rentalId, equipmentId });
  }
  return rental;
}
