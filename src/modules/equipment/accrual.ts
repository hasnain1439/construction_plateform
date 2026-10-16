/**
 * Daily equipment cost — the EquipmentCharge rows that feed the project P&L bucket EQUIPMENT.
 *
 *   INTERNAL_HIRE  owned units (no rental) at a SITE at the end of a Karachi day
 *                  × Equipment.hireRatePaisaPerDay → that site's project
 *   RENTAL         outstanding rented units (qty − returned − missing, by return date) at the end
 *                  of a day × the rental item's rate → the rental's project (none for the yard)
 *
 * Start day charged, return day not; only complete days (≤ yesterday) are posted. Idempotent:
 * every run computes what each (day, baseKey) should be and appends only the difference as a new
 * row (seq 0, then 1, 2, … for corrections after back-dated changes). A posted day keeps its
 * rate (rate changes never re-price the past). Rows are never updated or deleted.
 */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { EquipmentChargeKind } from '../../generated/prisma/client.js';
import { addDays } from '../labor/labor.shared.js';
import { pktDayEnd } from '../inventory/inventory.service.js';
import { D, dayOf, today, valueOf, ZERO, type Dec } from './equipment.shared.js';

/** Back-dated changes up to this many days back are corrected on every run. */
export const LOOKBACK_DAYS = 31;
/** Never compute more than a year at once. */
const MAX_DAYS = 366;

export const yesterday = () => addDays(today(), -1);
const maxDay = (...days: string[]) => days.reduce((m, d) => (d > m ? d : m));
const minDay = (...days: string[]) => days.reduce((m, d) => (d < m ? d : m));

interface Expected {
  date: string;
  baseKey: string;
  kind: EquipmentChargeKind;
  projectId: string | null;
  locationId: string | null;
  equipmentId: string;
  rentalId: string | null;
  rentalItemId: string | null;
  qty: Dec;
  /** Current rate (used only for days not posted yet). */
  rate: bigint;
}

export interface PostResult {
  rows: number;
  amountPaisa: bigint;
}

/**
 * Appends the difference between `expected` and what is posted for every (day, baseKey) of the
 * window [from, through] (restricted to `keys` when given).
 */
async function reconcile(tx: Tx, tenantId: string, kind: EquipmentChargeKind, from: string, through: string, expected: Expected[], where: Prisma.EquipmentChargeWhereInput): Promise<PostResult> {
  const posted = await tx.equipmentCharge.findMany({
    where: { tenantId, kind, date: { gte: dateOnly(from), lte: dateOnly(through) }, ...where },
    orderBy: [{ date: 'asc' }, { seq: 'asc' }],
  });
  const have = new Map<string, { qty: Dec; amount: bigint; count: number; rate: bigint; row: (typeof posted)[number] }>();
  for (const p of posted) {
    const k = `${formatDateOnly(p.date)}|${p.baseKey}`;
    const h = have.get(k);
    if (h) {
      h.qty = h.qty.add(p.qty);
      h.amount += p.amountPaisa;
      h.count += 1;
    } else have.set(k, { qty: p.qty, amount: p.amountPaisa, count: 1, rate: p.ratePaisa, row: p });
  }
  const want = new Map(expected.map((e) => [`${e.date}|${e.baseKey}`, e]));
  const rows: Prisma.EquipmentChargeCreateManyInput[] = [];
  let total = 0n;
  for (const k of new Set([...want.keys(), ...have.keys()])) {
    const e = want.get(k);
    const h = have.get(k);
    const rate = h?.rate ?? e!.rate;
    const qty = e?.qty ?? ZERO;
    const diffAmount = valueOf(qty, rate) - (h?.amount ?? 0n);
    if (diffAmount === 0n) continue;
    const ref = e ?? {
      date: formatDateOnly(h!.row.date),
      baseKey: h!.row.baseKey,
      projectId: h!.row.projectId,
      locationId: h!.row.locationId,
      equipmentId: h!.row.equipmentId,
      rentalId: h!.row.rentalId,
      rentalItemId: h!.row.rentalItemId,
    };
    rows.push({
      tenantId,
      date: dateOnly(ref.date),
      kind,
      baseKey: ref.baseKey,
      seq: h?.count ?? 0,
      projectId: ref.projectId,
      locationId: ref.locationId,
      equipmentId: ref.equipmentId,
      rentalId: ref.rentalId,
      rentalItemId: ref.rentalItemId,
      qty: qty.sub(h?.qty ?? ZERO),
      ratePaisa: rate,
      amountPaisa: diffAmount,
    });
    total += diffAmount;
  }
  if (rows.length) await tx.equipmentCharge.createMany({ data: rows });
  return { rows: rows.length, amountPaisa: total };
}

/** Days from `from` to `through` inclusive. */
function daysBetween(from: string, through: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= through && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

// ─── Internal hire ──────────────────────────────────────────────────────────

export async function accrueHire(tx: Tx, tenantId: string, through: string): Promise<PostResult> {
  // Days are bucketed here (not in SQL) so the result never depends on the database session time zone.
  const moves = await tx.equipmentMovement.findMany({
    where: { tenantId, rentalId: null, location: { type: 'SITE' }, occurredAt: { lt: pktDayEnd(through) } },
    select: { locationId: true, equipmentId: true, quantity: true, occurredAt: true, location: { select: { projectId: true } } },
  });
  const netMap = new Map<string, { locationId: string; projectId: string; equipmentId: string; day: string; qty: Dec }>();
  for (const m of moves) {
    const day = dayOf(m.occurredAt);
    const k = [m.locationId, m.equipmentId, day].join(':');
    const n = netMap.get(k);
    if (n) n.qty = n.qty.add(m.quantity);
    else netMap.set(k, { locationId: m.locationId, projectId: m.location.projectId!, equipmentId: m.equipmentId, day, qty: D(m.quantity) });
  }
  const nets = [...netMap.values()];
  if (!nets.length) return { rows: 0, amountPaisa: 0n };
  const first = nets.reduce((m, n) => (n.day < m ? n.day : m), nets[0]!.day);
  const last = await tx.equipmentCharge.findFirst({ where: { tenantId, kind: 'INTERNAL_HIRE' }, orderBy: { date: 'desc' }, select: { date: true } });
  const lastDay = last ? formatDateOnly(last.date) : null;
  const from = maxDay(first, lastDay ? minDay(addDays(lastDay, 1), addDays(through, -LOOKBACK_DAYS)) : first, addDays(through, -MAX_DAYS));
  if (from > through) return { rows: 0, amountPaisa: 0n };

  const equipment = await tx.equipment.findMany({ where: { tenantId }, select: { id: true, hireRatePaisaPerDay: true } });
  const rateOf = new Map(equipment.map((e) => [e.id, e.hireRatePaisaPerDay]));
  const groups = new Map<string, { locationId: string; projectId: string; equipmentId: string; byDay: Map<string, Dec> }>();
  for (const n of nets) {
    const k = `${n.locationId}:${n.equipmentId}`;
    const g = groups.get(k) ?? { locationId: n.locationId, projectId: n.projectId, equipmentId: n.equipmentId, byDay: new Map() };
    g.byDay.set(n.day, D(n.qty));
    groups.set(k, g);
  }
  const days = daysBetween(from, through);
  const expected: Expected[] = [];
  for (const g of groups.values()) {
    let bal = ZERO;
    for (const [d, q] of g.byDay) if (d < from) bal = bal.add(q);
    for (const d of days) {
      const q = g.byDay.get(d);
      if (q) bal = bal.add(q);
      if (bal.gt(0)) {
        expected.push({
          date: d,
          baseKey: `INTERNAL_HIRE:${g.locationId}:${g.equipmentId}`,
          kind: 'INTERNAL_HIRE',
          projectId: g.projectId,
          locationId: g.locationId,
          equipmentId: g.equipmentId,
          rentalId: null,
          rentalItemId: null,
          qty: bal,
          rate: rateOf.get(g.equipmentId) ?? 0n,
        });
      }
    }
  }
  return reconcile(tx, tenantId, 'INTERNAL_HIRE', from, through, expected, {});
}

// ─── Rentals ────────────────────────────────────────────────────────────────

export interface RentalForAccrual {
  id: string;
  projectId: string | null;
  locationId: string;
  startDate: Date;
  items: Array<{ id: string; equipmentId: string; qty: Dec; ratePaisaPerDay: bigint }>;
  returns: Array<{ returnDate: Date; items: Array<{ rentalItemId: string; qty: Dec; missingQty: Dec }> }>;
}

export const rentalAccrualInclude = {
  items: { select: { id: true, equipmentId: true, qty: true, ratePaisaPerDay: true } },
  returns: { select: { returnDate: true, items: { select: { rentalItemId: true, qty: true, missingQty: true } } } },
} as const satisfies Prisma.EquipmentRentalInclude;

/** Units of a rental item still on hire at the end of `day`. */
export function outstandingOn(r: RentalForAccrual, itemId: string, day: string): Dec {
  const item = r.items.find((i) => i.id === itemId)!;
  let left = D(item.qty);
  for (const ret of r.returns) {
    if (formatDateOnly(ret.returnDate) > day) continue;
    for (const ri of ret.items) if (ri.rentalItemId === itemId) left = left.sub(ri.qty).sub(ri.missingQty);
  }
  return left.lt(0) ? ZERO : left;
}

/** What a rental's days cost from its start through `through` (inclusive), without posting. */
export function rentalExpected(r: RentalForAccrual, through: string): Expected[] {
  const start = formatDateOnly(r.startDate);
  const out: Expected[] = [];
  if (start > through) return out;
  for (const d of daysBetween(maxDay(start, addDays(through, -MAX_DAYS)), through)) {
    for (const item of r.items) {
      const qty = outstandingOn(r, item.id, d);
      if (qty.lte(0)) continue;
      out.push({
        date: d,
        baseKey: `RENTAL:${item.id}`,
        kind: 'RENTAL',
        projectId: r.projectId,
        locationId: r.locationId,
        equipmentId: item.equipmentId,
        rentalId: r.id,
        rentalItemId: item.id,
        qty,
        rate: item.ratePaisaPerDay,
      });
    }
  }
  return out;
}

/** Live cost of a rental through `through` (default today): Σ days × outstanding × rate. */
export function rentalCostTo(r: RentalForAccrual, through = today()): bigint {
  return rentalExpected(r, through).reduce((s, e) => s + valueOf(e.qty, e.rate), 0n);
}

export async function accrueRental(tx: Tx, tenantId: string, r: RentalForAccrual, through: string): Promise<PostResult> {
  const start = formatDateOnly(r.startDate);
  if (start > through) return { rows: 0, amountPaisa: 0n };
  return reconcile(tx, tenantId, 'RENTAL', maxDay(start, addDays(through, -MAX_DAYS)), through, rentalExpected(r, through), { rentalId: r.id });
}

// ─── Run ────────────────────────────────────────────────────────────────────

export function assertCompleteDay(through: string) {
  if (through > yesterday()) throw new BadRequest('DATE_NOT_COMPLETE', 'Only complete days can be charged — choose yesterday or earlier', { latest: yesterday() });
}

/** Posts internal hire and the rent of active rentals through `through` (one company, idempotent). */
export async function runAccrualTx(tx: Tx, tenantId: string, through = yesterday()) {
  assertCompleteDay(through);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`equipment-accrual:${tenantId}`}))`;
  const internalHire = await accrueHire(tx, tenantId, through);
  const rentals = await tx.equipmentRental.findMany({ where: { tenantId, status: 'ACTIVE' }, include: rentalAccrualInclude });
  const rental = { rows: 0, amountPaisa: 0n };
  for (const r of rentals) {
    const res = await accrueRental(tx, tenantId, r, through);
    rental.rows += res.rows;
    rental.amountPaisa += res.amountPaisa;
  }
  return { through, internalHire, rental };
}
