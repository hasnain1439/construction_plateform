/**
 * The stock engine. Every stock change in the system goes through here and becomes one
 * append-only StockMovement row; balances are always SUM(quantity) / SUM(valuePaisa) over
 * the ledger (app_user can't UPDATE or DELETE movements).
 *
 * Costing: weighted average per (location, material, ownerSupplied = false). Stock coming
 * in carries its own cost; stock going out leaves at the bucket's current average (or a
 * given cost, e.g. a purchase return at purchase rate). Owner-supplied stock is a separate
 * bucket at cost 0, so it never moves the contractor's average.
 */
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { todayIn } from '../../core/utils/dates.js';
import type { StockLocation, StockMovementType } from '../../generated/prisma/client.js';
import type { SupplyCategoryKey } from '../projects/presets.js';

// ─── Caller ─────────────────────────────────────────────────────────────────

export interface Actor {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  /** rates.view — rates, amounts, values and supplier balances are included */
  seesRates: boolean;
  /** billing.view (projects/access Caller compatibility) */
  seesFinancials: boolean;
}

export function actor(): Actor {
  const ctx = getCtx();
  return {
    tenantId: ctx.tenantId!,
    userId: ctx.userId!,
    role: ctx.role as Actor['role'],
    seesRates: ctx.permissions.includes('rates.view'),
    seesFinancials: ctx.permissions.includes('billing.view'),
  };
}

export function audit(tx: Tx, a: Pick<Actor, 'tenantId' | 'userId'>, action: string, entityType: string, entityId: string, details?: Prisma.InputJsonValue) {
  return writeAudit(tx, {
    tenantId: a.tenantId,
    actorType: 'USER',
    actorId: a.userId,
    action,
    entityType,
    entityId,
    ...(details === undefined ? {} : { details }),
  });
}

// ─── Quantities and money ───────────────────────────────────────────────────

export type Dec = Prisma.Decimal;
export const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
export const ZERO = D(0);

/** qty × rate, rounded half-up to whole paisa. */
export function valueOf(qty: Dec, ratePaisa: bigint): bigint {
  return BigInt(qty.mul(ratePaisa.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

/** value ÷ qty, rounded to whole paisa (0 when there is no stock). */
export function avgOf(qty: Dec, value: bigint): bigint {
  if (qty.lte(0)) return 0n;
  return BigInt(D(value.toString()).div(qty).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

/**
 * Ledger time for a document dated `date` ("YYYY-MM-DD"): now when it is today (Pakistan
 * time), else noon of that day. Future dates → 400 DATE_IN_FUTURE.
 */
export function occurredAtFor(date: string, now = new Date()): Date {
  const today = todayIn('Asia/Karachi', now);
  if (date > today) throw new BadRequest('DATE_IN_FUTURE', 'The date cannot be in the future');
  if (date === today) return now;
  return new Date(`${date}T07:00:00.000Z`);
}

/** Decimal → number with at most 3 dp (API output). */
export const q = (d: Dec | null | undefined) => (d === null || d === undefined ? null : Number(d.toFixed(3)));
export const qn = (d: Dec) => Number(d.toFixed(3));
export const paisa = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

// ─── Locations ──────────────────────────────────────────────────────────────

export const CENTRAL_STORE = 'CENTRAL_STORE';
export const TRANSIT = 'TRANSIT';

/** The company's Central Store and in-transit location (created on first use). */
export async function systemLocations(tx: Tx, tenantId: string): Promise<{ store: StockLocation; transit: StockLocation }> {
  let rows = await tx.stockLocation.findMany({ where: { tenantId, systemKey: { in: [CENTRAL_STORE, TRANSIT] } } });
  if (rows.length < 2) {
    await tx.stockLocation.createMany({
      data: [
        { tenantId, type: 'STORE', name: 'Central Store', systemKey: CENTRAL_STORE },
        { tenantId, type: 'TRANSIT', name: 'In transit', systemKey: TRANSIT },
      ],
      skipDuplicates: true,
    });
    rows = await tx.stockLocation.findMany({ where: { tenantId, systemKey: { in: [CENTRAL_STORE, TRANSIT] } } });
  }
  return { store: rows.find((r) => r.systemKey === CENTRAL_STORE)!, transit: rows.find((r) => r.systemKey === TRANSIT)! };
}

/** The site location of a non-draft project (created on first use, e.g. at activation). */
export async function siteLocation(tx: Tx, tenantId: string, project: { id: string; name: string; status: string }): Promise<StockLocation> {
  if (project.status === 'DRAFT') throw new Conflict('PROJECT_IS_DRAFT', 'Activate the project before moving stock to its site');
  const existing = await tx.stockLocation.findUnique({ where: { tenantId_projectId: { tenantId, projectId: project.id } } });
  if (existing) return existing;
  await tx.stockLocation.createMany({ data: [{ tenantId, type: 'SITE', name: project.name, projectId: project.id }], skipDuplicates: true });
  return tx.stockLocation.findUniqueOrThrow({ where: { tenantId_projectId: { tenantId, projectId: project.id } } });
}

export async function findLocation(tx: Tx, tenantId: string, id: string): Promise<StockLocation> {
  const location = await tx.stockLocation.findFirst({ where: { tenantId, id } });
  if (!location) throw new NotFound('LOCATION_NOT_FOUND', 'Stock location not found');
  return location;
}

export function locationRef(l: Pick<StockLocation, 'id' | 'type' | 'name' | 'projectId'>) {
  return { id: l.id, type: l.type, name: l.name, projectId: l.projectId };
}

// ─── Materials ──────────────────────────────────────────────────────────────

export interface MaterialInfo {
  id: string;
  name: string;
  unit: string;
  groupCode: string;
}

export const materialRef = (m: Pick<MaterialInfo, 'id' | 'name' | 'unit'>) => ({ id: m.id, name: m.name, unit: m.unit });

/** Loads the materials of a document; unknown ids → 400 INVALID_MATERIAL. */
export async function loadMaterials(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, MaterialInfo>> {
  const unique = [...new Set(ids)];
  const rows = await tx.material.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, name: true, unit: true, group: { select: { code: true } } },
  });
  const map = new Map(rows.map((m) => [m.id, { id: m.id, name: m.name, unit: m.unit, groupCode: m.group.code }]));
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length) throw new BadRequest('INVALID_MATERIAL', 'Some materials were not found', { materialIds: missing });
  return map;
}

/** Material group → the project supply category that decides who supplies it. */
const GROUP_SUPPLY_CATEGORY: Record<string, SupplyCategoryKey | null> = {
  CEMENT: 'CEMENT',
  BRICKS: 'BRICKS',
  STEEL: 'STEEL',
  AGGREGATES: 'SAND_BAJRI',
  WATERPROOFING: 'WATERPROOFING',
  PLUMBING: 'PIPES',
  ELECTRICAL: 'ELECTRICAL',
  FLOORING: 'TILES_FLOORING',
  SANITARY: 'SANITARY',
  WOODWORK: 'WOODWORK',
  PAINT: 'PAINT',
  OTHER: null,
};

export const supplyCategoryOf = (m: Pick<MaterialInfo, 'groupCode'>) => GROUP_SUPPLY_CATEGORY[m.groupCode] ?? null;

/** Supply categories the owner supplies on this project. */
export async function ownerSuppliedCategories(tx: Tx, tenantId: string, projectId: string): Promise<Set<string>> {
  const rules = await tx.projectSupplyRule.findMany({ where: { tenantId, projectId, suppliedBy: 'OWNER' }, select: { categoryKey: true } });
  return new Set(rules.map((r) => r.categoryKey));
}

export function isOwnerSupplied(m: MaterialInfo, ownerCategories: Set<string>): boolean {
  const key = supplyCategoryOf(m);
  return key !== null && ownerCategories.has(key);
}

// ─── Balances ───────────────────────────────────────────────────────────────

export interface Bucket {
  locationId: string;
  materialId: string;
  ownerSupplied: boolean;
}

export interface Balance {
  qty: Dec;
  value: bigint;
}

/**
 * Serialises stock changes per location until the transaction ends, so two dispatches
 * can't both take the last 50 bags. Locks are taken in id order (no deadlocks).
 */
export async function lockLocations(tx: Tx, locationIds: string[]): Promise<void> {
  for (const id of [...new Set(locationIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock:${id}`}))`;
  }
}

export async function balanceOf(tx: Tx, tenantId: string, b: Bucket): Promise<Balance> {
  const agg = await tx.stockMovement.aggregate({
    where: { tenantId, locationId: b.locationId, materialId: b.materialId, ownerSupplied: b.ownerSupplied },
    _sum: { quantity: true, valuePaisa: true },
  });
  return { qty: agg._sum.quantity ?? ZERO, value: agg._sum.valuePaisa ?? 0n };
}

export interface BalanceRow extends Balance {
  locationId: string;
  materialId: string;
  ownerSupplied: boolean;
}

/** Balances grouped by location × material × bucket. */
export async function balances(tx: Tx, tenantId: string, where: { locationIds?: string[]; materialIds?: string[] } = {}): Promise<BalanceRow[]> {
  const rows = await tx.stockMovement.groupBy({
    by: ['locationId', 'materialId', 'ownerSupplied'],
    where: {
      tenantId,
      ...(where.locationIds ? { locationId: { in: where.locationIds } } : {}),
      ...(where.materialIds ? { materialId: { in: where.materialIds } } : {}),
    },
    _sum: { quantity: true, valuePaisa: true },
  });
  return rows.map((r) => ({
    locationId: r.locationId,
    materialId: r.materialId,
    ownerSupplied: r.ownerSupplied,
    qty: r._sum.quantity ?? ZERO,
    value: r._sum.valuePaisa ?? 0n,
  }));
}

// ─── Posting ────────────────────────────────────────────────────────────────

export interface MovementRef {
  type: StockMovementType;
  refType: string;
  refId: string;
  occurredAt: Date;
  createdById: string | null;
  note?: string | null;
}

export interface ShortItem {
  materialId: string;
  material: string;
  unit: string;
  requested: number;
  available: number;
}

export const insufficientStock = (items: ShortItem[]) =>
  new BadRequest('INSUFFICIENT_STOCK', `Not enough ${items.map((i) => i.material).join(', ')} in stock`, {
    materialId: items[0]!.materialId,
    available: items[0]!.available,
    items,
  });

/**
 * Checks that every line can be taken out of its bucket (lines for the same bucket are
 * added up first). Throws 400 INSUFFICIENT_STOCK listing every short material.
 */
export async function assertAvailable(
  tx: Tx,
  tenantId: string,
  lines: Array<Bucket & { qty: Dec }>,
  materials: Map<string, MaterialInfo>,
): Promise<void> {
  const need = new Map<string, Bucket & { qty: Dec }>();
  for (const l of lines) {
    const key = `${l.locationId}:${l.materialId}:${l.ownerSupplied}`;
    const prev = need.get(key);
    need.set(key, prev ? { ...prev, qty: prev.qty.add(l.qty) } : { ...l });
  }
  const short: ShortItem[] = [];
  for (const l of need.values()) {
    const bal = await balanceOf(tx, tenantId, l);
    if (bal.qty.lt(l.qty)) {
      const m = materials.get(l.materialId);
      short.push({ materialId: l.materialId, material: m?.name ?? l.materialId, unit: m?.unit ?? '', requested: qn(l.qty), available: qn(bal.qty) });
    }
  }
  if (short.length) throw insufficientStock(short);
}

/**
 * Stock in. Owner-supplied stock always carries cost 0. `exactValue` carries a value over
 * unchanged (e.g. the value that just left the source going into transit). Returns the value posted.
 */
export async function postIn(tx: Tx, tenantId: string, b: Bucket, qty: Dec, unitCostPaisa: bigint, ref: MovementRef, exactValue?: bigint): Promise<bigint> {
  const cost = b.ownerSupplied ? 0n : unitCostPaisa;
  const value = b.ownerSupplied ? 0n : (exactValue ?? valueOf(qty, cost));
  await tx.stockMovement.create({
    data: {
      tenantId,
      locationId: b.locationId,
      materialId: b.materialId,
      ownerSupplied: b.ownerSupplied,
      quantity: qty,
      unitCostPaisa: cost,
      valuePaisa: value,
      type: ref.type,
      refType: ref.refType,
      refId: ref.refId,
      occurredAt: ref.occurredAt,
      createdById: ref.createdById,
      note: ref.note ?? null,
    },
  });
  return value;
}

/**
 * Stock out at the bucket's average cost (or `fixedUnitCost`). Taking everything that is
 * left takes exactly the remaining value, so no rounding residue stays behind.
 * Callers lock the location and check availability first.
 */
export async function postOut(
  tx: Tx,
  tenantId: string,
  b: Bucket,
  qty: Dec,
  ref: MovementRef,
  fixedUnitCost?: bigint,
  exactValue?: bigint,
): Promise<{ valuePaisa: bigint; unitCostPaisa: bigint }> {
  const bal = await balanceOf(tx, tenantId, b);
  if (bal.qty.lt(qty)) throw new BadRequest('INSUFFICIENT_STOCK', 'Not enough stock', { materialId: b.materialId, available: qn(bal.qty) });
  let value: bigint;
  let unit: bigint;
  if (exactValue !== undefined) {
    value = exactValue;
    unit = fixedUnitCost ?? avgOf(qty, exactValue);
  } else if (b.ownerSupplied) {
    value = 0n;
    unit = 0n;
  } else if (qty.eq(bal.qty)) {
    value = bal.value;
    unit = fixedUnitCost ?? avgOf(bal.qty, bal.value);
  } else if (fixedUnitCost !== undefined) {
    value = valueOf(qty, fixedUnitCost);
    if (value > bal.value) value = bal.value;
    unit = fixedUnitCost;
  } else {
    value = BigInt(D(bal.value.toString()).mul(qty).div(bal.qty).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
    unit = avgOf(bal.qty, bal.value);
  }
  await tx.stockMovement.create({
    data: {
      tenantId,
      locationId: b.locationId,
      materialId: b.materialId,
      ownerSupplied: b.ownerSupplied,
      quantity: qty.neg(),
      unitCostPaisa: unit,
      valuePaisa: -value,
      type: ref.type,
      refType: ref.refType,
      refId: ref.refId,
      occurredAt: ref.occurredAt,
      createdById: ref.createdById,
      note: ref.note ?? null,
    },
  });
  return { valuePaisa: value, unitCostPaisa: unit };
}

/** Cost for stock that appears without a purchase (count surplus): the bucket's average, else its last known cost. */
export async function currentCost(tx: Tx, tenantId: string, b: Bucket): Promise<bigint> {
  if (b.ownerSupplied) return 0n;
  const bal = await balanceOf(tx, tenantId, b);
  if (bal.qty.gt(0)) return avgOf(bal.qty, bal.value);
  const last = await tx.stockMovement.findFirst({
    where: { tenantId, locationId: b.locationId, materialId: b.materialId, ownerSupplied: false, quantity: { gt: 0 } },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    select: { unitCostPaisa: true },
  });
  return last?.unitCostPaisa ?? 0n;
}

/** Value-only correction (qty 0), e.g. a munshi purchase that gets its rates later. */
export async function postValueChange(tx: Tx, tenantId: string, b: Bucket, valuePaisa: bigint, ref: MovementRef): Promise<void> {
  if (valuePaisa === 0n || b.ownerSupplied) return;
  await tx.stockMovement.create({
    data: {
      tenantId,
      locationId: b.locationId,
      materialId: b.materialId,
      ownerSupplied: false,
      quantity: ZERO,
      unitCostPaisa: 0n,
      valuePaisa,
      type: ref.type,
      refType: ref.refType,
      refId: ref.refId,
      occurredAt: ref.occurredAt,
      createdById: ref.createdById,
      note: ref.note ?? null,
    },
  });
}

// ─── Attachments ────────────────────────────────────────────────────────────

/** An attachment of this company of one of `kinds`; else 400 with `code`. */
export async function assertAttachment(tx: Tx, tenantId: string, id: string, kinds: string[], code: string, label: string) {
  const att = await tx.attachment.findFirst({ where: { tenantId, id }, select: { id: true, kind: true } });
  if (!att) throw new BadRequest(code, `${label} not found. Upload it first.`);
  if (!kinds.includes(att.kind)) throw new BadRequest(code, `${label} must be uploaded as ${kinds.join(' or ')}`, { kind: att.kind });
  return att;
}
