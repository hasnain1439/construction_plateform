/**
 * Purchases (supplier challans), site receipt of direct deliveries, munshi rate pricing,
 * corrections and returns. Saved purchases are locked: a fix is a visible correction or
 * return, never an edit.
 *
 * Money: the supplier's bill (`totalPaisa`, ledger debit) is Σ challan qty × rate; each line's
 * `amountPaisa` is the good quantity (counted − damaged) × rate, which is what enters stock.
 * A short or damaged line becomes a Shortage the owner settles (e.g. SUPPLIER_CREDIT).
 */
import { NUMBER_FORMATS, nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { PaidFrom, Prisma, PurchasePaymentMode, PurchaseStatus } from '../../generated/prisma/client.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import {
  actor,
  assertAttachment,
  audit,
  balanceOf,
  D,
  loadMaterials,
  lockLocations,
  materialRef,
  occurredAtFor,
  postIn,
  postOut,
  postValueChange,
  q,
  qn,
  valueOf,
  ZERO,
  type Actor,
  type Dec,
  type MaterialInfo,
} from '../inventory/stock.js';
import * as mdRepo from '../master-data/master-data.repository.js';
import { findProjectFor, projectScope } from '../projects/access.js';
import type { CorrectionInput, CreatePurchaseInput, ListPurchasesQuery, ListReturnsQuery, PurchaseReturnInput, ReceivePurchaseInput, SetRatesInput } from './procurement.schema.js';
import { activeSupplier, deliveryLocation, refreshOrderStatus } from './purchaseOrders.service.js';
import { PAID_FROM_METHOD, postCashPurchaseFromSiteCash, postLedger, recordPaymentTx } from './supplierLedger.service.js';

const purchaseNotFound = () => new NotFound('PURCHASE_NOT_FOUND', 'Purchase not found');
const RECEIVED_STATUSES: PurchaseStatus[] = ['SAVED', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE'];

const purchaseInclude = {
  supplier: { select: { id: true, name: true, phone: true } },
  location: { select: { id: true, type: true, name: true, projectId: true } },
  project: { select: { id: true, code: true, name: true } },
  purchaseOrder: { select: { id: true, number: true } },
  items: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } },
  challan: { select: { id: true, fileName: true, storageKey: true } },
  bill: { select: { id: true, fileName: true, storageKey: true } },
  corrections: { include: { createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
  returns: { select: { id: true, number: true, totalPaisa: true, reason: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  shortages: { include: { material: { select: { id: true, name: true, unit: true } } }, orderBy: { createdAt: 'asc' } },
  payments: { select: { id: true, amountPaisa: true, method: true, status: true, paidOn: true } },
  createdBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.PurchaseInclude;

type PurchaseRow = Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>;

interface CorrectionLine {
  purchaseItemId: string;
  materialId: string;
  fromQty: number;
  toQty: number;
  fromRatePaisa: string;
  toRatePaisa: string;
}

/** Current (corrected) good quantity and rate of each line. */
function effectiveLines(p: Pick<PurchaseRow, 'items' | 'corrections'>) {
  const out = new Map<string, { goodQty: Dec; billQty: Dec; ratePaisa: bigint }>();
  for (const i of p.items) {
    const good = (i.countedQty ?? ZERO).sub(i.damagedQty);
    out.set(i.id, { goodQty: good, billQty: i.challanQty, ratePaisa: i.ratePaisa ?? 0n });
  }
  for (const c of p.corrections) {
    for (const line of c.items as unknown as CorrectionLine[]) {
      out.set(line.purchaseItemId, { goodQty: D(line.toQty), billQty: D(line.toQty), ratePaisa: BigInt(line.toRatePaisa) });
    }
  }
  return out;
}

/** Blind count: while a site delivery waits for its count, site staff don't see the challan quantities. */
function hidesChallan(p: Pick<PurchaseRow, 'status'>, a: Actor, blind: boolean) {
  return blind && p.status === 'PENDING_RECEIPT' && a.role === 'MUNSHI';
}

async function toPurchaseDto(tx: Tx, p: PurchaseRow, a: Actor) {
  const blind = (await tx.tenantSettings.findUnique({ where: { tenantId: a.tenantId }, select: { blindCountEnabled: true } }))?.blindCountEnabled ?? true;
  const hide = hidesChallan(p, a, blind);
  const effective = effectiveLines(p);
  const correctionDelta = p.corrections.reduce((s, c) => s + c.deltaPaisa, 0n);
  const ledger = a.seesRates
    ? await tx.supplierLedgerEntry.findMany({
        where: { tenantId: a.tenantId, OR: [{ refType: 'PURCHASE', refId: p.id }, { refType: 'PURCHASE_CORRECTION', refId: { in: p.corrections.map((c) => c.id) } }, { refType: 'PURCHASE_RETURN', refId: { in: p.returns.map((r) => r.id) } }, { refType: 'SUPPLIER_PAYMENT', refId: { in: p.payments.map((x) => x.id) } }] },
        select: { type: true, amountPaisa: true, occurredAt: true, note: true },
        orderBy: { occurredAt: 'asc' },
      })
    : [];
  return {
    id: p.id,
    number: p.number,
    supplier: p.supplier,
    deliverTo: p.deliverTo,
    location: p.location,
    project: p.project,
    purchaseOrder: p.purchaseOrder,
    challanNo: p.challanNo,
    vehicleNo: p.vehicleNo,
    purchaseDate: formatDateOnly(p.purchaseDate),
    paymentMode: p.paymentMode,
    status: p.status,
    locked: p.status !== 'PENDING_RATE' && p.status !== 'PENDING_RECEIPT',
    blindCount: hide,
    note: p.note,
    items: p.items.map((i) => {
      const counted = i.countedQty;
      const good = counted === null ? null : counted.sub(i.damagedQty);
      const eff = effective.get(i.id)!;
      return {
        id: i.id,
        material: materialRef(i.material),
        ...(hide ? {} : { challanQty: qn(i.challanQty) }),
        countedQty: q(counted),
        damagedQty: qn(i.damagedQty),
        goodQty: q(good),
        shortQty: hide || good === null ? null : qn(i.challanQty.sub(good).gt(0) ? i.challanQty.sub(good) : ZERO),
        note: i.note,
        ...(a.seesRates
          ? {
              ratePaisa: i.ratePaisa === null ? null : i.ratePaisa.toString(),
              amountPaisa: i.amountPaisa.toString(),
              correctedQty: eff.goodQty.eq(good ?? ZERO) && eff.ratePaisa === (i.ratePaisa ?? 0n) ? null : qn(eff.goodQty),
              correctedRatePaisa: eff.ratePaisa === (i.ratePaisa ?? 0n) ? null : eff.ratePaisa.toString(),
            }
          : {}),
      };
    }),
    ...(a.seesRates
      ? {
          totalPaisa: p.totalPaisa.toString(),
          correctedTotalPaisa: (p.totalPaisa + correctionDelta).toString(),
          paidNowPaisa: p.paidNowPaisa.toString(),
          paidFrom: p.paidFrom,
          udhaarAddedPaisa: (p.totalPaisa - p.paidNowPaisa).toString(),
          ledgerEffect: ledger.map((l) => ({ type: l.type, amountPaisa: l.amountPaisa.toString(), occurredAt: l.occurredAt.toISOString(), note: l.note })),
          payments: p.payments.map((x) => ({ ...x, amountPaisa: x.amountPaisa.toString(), paidOn: formatDateOnly(x.paidOn) })),
        }
      : {}),
    challan: { id: p.challan.id, fileName: p.challan.fileName, url: await optionalSignedUrl(p.challan) },
    bill: p.bill ? { id: p.bill.id, fileName: p.bill.fileName, url: await optionalSignedUrl(p.bill) } : null,
    corrections: p.corrections.map((c) => ({
      id: c.id,
      reason: c.reason,
      items: a.seesRates ? (c.items as unknown as CorrectionLine[]) : (c.items as unknown as CorrectionLine[]).map(({ fromRatePaisa: _f, toRatePaisa: _t, ...rest }) => rest),
      ...(a.seesRates ? { deltaPaisa: c.deltaPaisa.toString() } : {}),
      createdBy: c.createdBy,
      createdAt: c.createdAt.toISOString(),
    })),
    returns: p.returns.map((r) => ({ id: r.id, number: r.number, reason: r.reason, ...(a.seesRates ? { totalPaisa: r.totalPaisa.toString() } : {}), createdAt: r.createdAt.toISOString() })),
    shortages: p.shortages.map((s) => ({
      id: s.id,
      kind: s.kind,
      material: materialRef(s.material),
      qty: qn(s.qty),
      status: s.status,
      resolution: s.resolution,
      ...(a.seesRates ? { valuePaisa: s.valuePaisa.toString() } : {}),
    })),
    receivedBy: p.receivedBy,
    receivedAt: p.receivedAt?.toISOString() ?? null,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
  };
}

/** THEKEDAR all; PM store purchases + their sites; MUNSHI only their sites. */
function scope(a: Actor): Prisma.PurchaseWhereInput {
  if (a.role === 'THEKEDAR') return {};
  if (a.role === 'MUNSHI') return { deliverTo: 'SITE', project: projectScope(a) };
  return { OR: [{ deliverTo: 'STORE' }, { project: projectScope(a) }] };
}

export async function findPurchase(tx: Tx, a: Actor, id: string): Promise<PurchaseRow> {
  const p = await tx.purchase.findFirst({ where: { tenantId: a.tenantId, id, ...scope(a) }, include: purchaseInclude });
  if (!p) throw purchaseNotFound();
  return p;
}

export async function purchaseDetail(tx: Tx, a: Actor, id: string) {
  return toPurchaseDto(tx, await findPurchase(tx, a, id), a);
}

/** Rates for each line: given → PO → supplier agreed rate. Missing (office entries) → 400 RATE_REQUIRED. */
async function resolveRates(
  tx: Tx,
  a: Actor,
  supplierId: string,
  items: Array<{ materialId: string; ratePaisa?: bigint | undefined }>,
  poRates: Map<string, bigint>,
  materials: Map<string, MaterialInfo>,
): Promise<Map<string, bigint>> {
  const agreed = new Map((await mdRepo.currentSupplierRates(tx, a.tenantId, supplierId)).map((r) => [r.materialId, r.ratePaisa]));
  const out = new Map<string, bigint>();
  const missing: string[] = [];
  for (const i of items) {
    const rate = i.ratePaisa ?? poRates.get(i.materialId) ?? agreed.get(i.materialId);
    if (rate === undefined) missing.push(i.materialId);
    else out.set(i.materialId, rate);
  }
  if (missing.length) {
    throw new BadRequest('RATE_REQUIRED', `Enter the rate for ${missing.map((id) => materials.get(id)?.name ?? id).join(', ')}`, { materialIds: missing });
  }
  return out;
}

function paymentSplit(mode: PurchasePaymentMode, total: bigint, paidNow: bigint | undefined): bigint {
  if (mode === 'UDHAAR') return 0n;
  if (mode === 'CASH') return total;
  if (paidNow === undefined || paidNow <= 0n || paidNow >= total) {
    throw new BadRequest('INVALID_PAID_AMOUNT', 'For a part payment, the amount paid now must be more than 0 and less than the bill', { totalPaisa: total.toString() });
  }
  return paidNow;
}

/** Ledger debit for the bill, then the payment made with it (CASH / PARTIAL). */
async function postBill(
  tx: Tx,
  a: Actor,
  p: { id: string; number: string; supplierId: string; projectId: string | null; purchaseDate: string; paidFrom: PaidFrom | null },
  total: bigint,
  paidNow: bigint,
  at: Date,
) {
  await postLedger(tx, a, { supplierId: p.supplierId, type: 'PURCHASE', amountPaisa: total, refType: 'PURCHASE', refId: p.id, projectId: p.projectId, occurredAt: at, note: p.number });
  if (paidNow > 0n && p.paidFrom) {
    await recordPaymentTx(tx, a, {
      supplierId: p.supplierId,
      amountPaisa: paidNow,
      method: PAID_FROM_METHOD[p.paidFrom],
      reference: p.number,
      paidOn: p.purchaseDate,
      purchaseId: p.id,
      projectId: p.projectId,
      occurredAt: at,
    });
    if (p.paidFrom === 'SITE_CASH') {
      await postCashPurchaseFromSiteCash(tx, { tenantId: a.tenantId, projectId: p.projectId, purchaseId: p.id, amountPaisa: paidNow, occurredAt: at, createdById: a.userId });
    }
  }
}

interface CountedLine {
  itemId: string;
  materialId: string;
  challanQty: Dec;
  countedQty: Dec;
  damagedQty: Dec;
  ratePaisa: bigint;
  note: string | null;
}

/** Validates counted lines (damaged ≤ counted; short / damaged needs a note) and writes the shortage rows. */
function checkCounted(lines: Array<Omit<CountedLine, 'itemId'>>, materials: Map<string, MaterialInfo>) {
  for (const l of lines) {
    if (l.damagedQty.gt(l.countedQty)) throw new BadRequest('DAMAGED_EXCEEDS_COUNTED', `Damaged ${materials.get(l.materialId)!.name} can’t be more than counted`, { materialId: l.materialId });
    const good = l.countedQty.sub(l.damagedQty);
    if (good.lt(l.challanQty) && !l.note) {
      throw new BadRequest('SHORTAGE_NOTE_REQUIRED', `Add a note: ${materials.get(l.materialId)!.name} is short or damaged`, {
        materialId: l.materialId,
        challanQty: qn(l.challanQty),
        goodQty: qn(good),
      });
    }
  }
}

async function writeShortages(tx: Tx, a: Actor, p: { id: string; projectId: string | null; locationId: string }, lines: CountedLine[]) {
  let any = false;
  for (const l of lines) {
    const short = l.challanQty.sub(l.countedQty);
    if (short.gt(0)) {
      any = true;
      await tx.shortage.create({
        data: {
          tenantId: a.tenantId,
          kind: 'SUPPLIER_SHORT',
          source: 'PURCHASE',
          purchaseId: p.id,
          projectId: p.projectId,
          locationId: p.locationId,
          materialId: l.materialId,
          qty: short,
          valuePaisa: valueOf(short, l.ratePaisa),
          note: l.note,
        },
      });
    }
    if (l.damagedQty.gt(0)) {
      any = true;
      await tx.shortage.create({
        data: {
          tenantId: a.tenantId,
          kind: 'DAMAGED',
          source: 'PURCHASE',
          purchaseId: p.id,
          projectId: p.projectId,
          locationId: p.locationId,
          materialId: l.materialId,
          qty: l.damagedQty,
          valuePaisa: valueOf(l.damagedQty, l.ratePaisa),
          note: l.note,
        },
      });
    }
  }
  return any;
}

/**
 * `opts.kharcha`: urgent material bought with site cash (cash book). It is entered like a
 * munshi's site purchase — counted now, rates later — whoever records it, and the receipt
 * photo may stand in for the challan. The cash already left with the kharcha entry.
 */
export async function createPurchaseTx(tx: Tx, a: Actor, input: CreatePurchaseInput, opts: { at?: Date; kharcha?: boolean } = {}) {
  const munshi = a.role === 'MUNSHI' || opts.kharcha === true;
  if (munshi && input.deliverTo !== 'SITE') throw new Forbidden('FORBIDDEN', 'A munshi can only record purchases delivered to their site');
  if (munshi && (input.items.some((i) => i.ratePaisa !== undefined) || input.paymentMode !== 'UDHAAR' || input.paidNowPaisa !== undefined)) {
    throw new BadRequest('RATES_NOT_ALLOWED', 'Leave rates and payment empty — the office adds them');
  }
  const supplier = await activeSupplier(tx, a.tenantId, input.supplierId);
  const { location, project } = await deliveryLocation(tx, a, input.deliverTo, input.projectId);
  const materials = await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
  await assertAttachment(tx, a.tenantId, input.challanAttachmentId, opts.kharcha ? ['CHALLAN', 'RECEIPT'] : ['CHALLAN'], 'CHALLAN_REQUIRED', 'Challan photo');
  if (input.billAttachmentId) await assertAttachment(tx, a.tenantId, input.billAttachmentId, ['CHALLAN', 'RECEIPT', 'DOCUMENT'], 'INVALID_ATTACHMENT', 'Bill');

  let poRates = new Map<string, bigint>();
  if (input.purchaseOrderId) {
    const po = await tx.purchaseOrder.findFirst({ where: { tenantId: a.tenantId, id: input.purchaseOrderId }, include: { items: true } });
    if (!po) throw new NotFound('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found');
    if (po.supplierId !== supplier.id) throw new BadRequest('PO_SUPPLIER_MISMATCH', 'The purchase order is for another supplier');
    if (po.status === 'CANCELLED' || po.status === 'RECEIVED') throw new Conflict('PO_CLOSED', `This purchase order is ${po.status.toLowerCase()}`, { status: po.status });
    poRates = new Map(po.items.map((i) => [i.materialId, i.ratePaisa]));
  }

  // Who counts: the store counts on arrival; an office SITE entry is counted by the site on receipt;
  // a munshi entering a site purchase is standing next to the goods and counts now.
  const pendingReceipt = input.deliverTo === 'SITE' && !munshi;
  const status: PurchaseStatus = munshi ? 'PENDING_RATE' : pendingReceipt ? 'PENDING_RECEIPT' : 'SAVED';
  const rates = munshi ? new Map<string, bigint>() : await resolveRates(tx, a, supplier.id, input.items, poRates, materials);

  const lines: Array<Omit<CountedLine, 'itemId'>> = input.items.map((i) => ({
    materialId: i.materialId,
    challanQty: i.challanQty,
    countedQty: i.countedQty ?? i.challanQty,
    damagedQty: i.damagedQty ?? ZERO,
    ratePaisa: rates.get(i.materialId) ?? 0n,
    note: i.note ?? null,
  }));
  if (!pendingReceipt) checkCounted(lines, materials);

  const total = munshi ? 0n : lines.reduce((s, l) => s + valueOf(l.challanQty, l.ratePaisa), 0n);
  const paidNow = munshi ? 0n : paymentSplit(input.paymentMode, total, input.paidNowPaisa);
  const at = opts.at ?? occurredAtFor(input.purchaseDate);

  const number = await nextNumber(tx, a.tenantId, NUMBER_FORMATS.purchase, dateOnly(input.purchaseDate));
  const purchase = await tx.purchase.create({
    data: {
      tenantId: a.tenantId,
      number,
      supplierId: supplier.id,
      deliverTo: input.deliverTo,
      locationId: location.id,
      projectId: project?.id ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      challanNo: input.challanNo,
      vehicleNo: input.vehicleNo ?? null,
      purchaseDate: dateOnly(input.purchaseDate),
      paymentMode: munshi ? 'UDHAAR' : input.paymentMode,
      paidNowPaisa: paidNow,
      paidFrom: input.paymentMode === 'UDHAAR' ? null : (input.paidFrom ?? null),
      totalPaisa: total,
      status,
      challanAttachmentId: input.challanAttachmentId,
      billAttachmentId: input.billAttachmentId ?? null,
      note: input.note ?? null,
      createdById: a.userId,
      ...(pendingReceipt ? {} : { receivedById: a.userId, receivedAt: at }),
    },
  });
  const counted: CountedLine[] = [];
  for (const [sortOrder, l] of lines.entries()) {
    const good = l.countedQty.sub(l.damagedQty);
    const item = await tx.purchaseItem.create({
      data: {
        tenantId: a.tenantId,
        purchaseId: purchase.id,
        materialId: l.materialId,
        challanQty: l.challanQty,
        countedQty: pendingReceipt ? null : l.countedQty,
        damagedQty: pendingReceipt ? ZERO : l.damagedQty,
        ratePaisa: munshi ? null : l.ratePaisa,
        amountPaisa: munshi ? 0n : valueOf(pendingReceipt ? l.challanQty : good, l.ratePaisa),
        note: l.note,
        sortOrder,
      },
    });
    counted.push({ ...l, itemId: item.id });
  }

  if (!pendingReceipt) {
    await lockLocations(tx, [location.id]);
    for (const l of counted) {
      const good = l.countedQty.sub(l.damagedQty);
      if (good.gt(0)) {
        await postIn(tx, a.tenantId, { locationId: location.id, materialId: l.materialId, ownerSupplied: false }, good, l.ratePaisa, {
          type: 'PURCHASE_IN',
          refType: 'PURCHASE',
          refId: purchase.id,
          occurredAt: at,
          createdById: a.userId,
        });
      }
    }
    await writeShortages(tx, a, { id: purchase.id, projectId: project?.id ?? null, locationId: location.id }, counted);
  }
  if (!munshi) {
    await postBill(tx, a, { id: purchase.id, number, supplierId: supplier.id, projectId: project?.id ?? null, purchaseDate: input.purchaseDate, paidFrom: input.paidFrom ?? null }, total, paidNow, at);
  }
  if (input.purchaseOrderId) await refreshOrderStatus(tx, a.tenantId, input.purchaseOrderId);

  await audit(tx, a, 'purchase.create', 'Purchase', purchase.id, {
    number,
    supplier: supplier.name,
    deliverTo: input.deliverTo,
    status,
    challanNo: input.challanNo,
    ...(munshi ? {} : { totalPaisa: total.toString(), paymentMode: input.paymentMode, paidNowPaisa: paidNow.toString() }),
  });
  return purchaseDetail(tx, a, purchase.id);
}

export async function createPurchase(input: CreatePurchaseInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createPurchaseTx(tx, a, input));
}

export async function getPurchase(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => purchaseDetail(tx, a, id));
}

export async function listPurchases(query: ListPurchasesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.PurchaseWhereInput[] = [{ tenantId: a.tenantId }, scope(a)];
    if (query.supplierId) and.push({ supplierId: query.supplierId });
    if (query.locationId) and.push({ locationId: query.locationId });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.paymentMode) and.push({ paymentMode: query.paymentMode });
    if (query.status) and.push({ status: query.status });
    if (query.from) and.push({ purchaseDate: { gte: dateOnly(query.from) } });
    if (query.to) and.push({ purchaseDate: { lte: dateOnly(query.to) } });
    if (query.search) and.push({ OR: [{ number: { contains: query.search, mode: 'insensitive' } }, { challanNo: { contains: query.search, mode: 'insensitive' } }] });
    const where: Prisma.PurchaseWhereInput = { AND: and };
    const rows = await tx.purchase.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        location: { select: { id: true, type: true, name: true, projectId: true } },
        project: { select: { id: true, code: true, name: true } },
        items: { select: { material: { select: { name: true } } }, orderBy: { sortOrder: 'asc' } },
        _count: { select: { shortages: { where: { status: 'OPEN' } } } },
      },
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      ...skipTake(query),
    });
    const total = await tx.purchase.count({ where });
    const sums = a.seesRates ? await tx.purchase.aggregate({ where, _sum: { totalPaisa: true, paidNowPaisa: true } }) : null;
    return {
      data: rows.map((p) => ({
        id: p.id,
        number: p.number,
        supplier: p.supplier,
        deliverTo: p.deliverTo,
        location: p.location,
        project: p.project,
        challanNo: p.challanNo,
        purchaseDate: formatDateOnly(p.purchaseDate),
        paymentMode: p.paymentMode,
        status: p.status,
        materials: p.items.map((i) => i.material.name),
        openShortages: p._count.shortages,
        ...(a.seesRates ? { totalPaisa: p.totalPaisa.toString(), paidNowPaisa: p.paidNowPaisa.toString() } : {}),
        createdAt: p.createdAt.toISOString(),
      })),
      meta: {
        ...pageMeta(query, total),
        ...(sums ? { totalPaisa: (sums._sum.totalPaisa ?? 0n).toString(), paidNowPaisa: (sums._sum.paidNowPaisa ?? 0n).toString() } : {}),
      },
    };
  });
}

// ─── Munshi purchase → office adds the rates ────────────────────────────────

export async function setRatesTx(tx: Tx, a: Actor, id: string, input: SetRatesInput, opts: { at?: Date } = {}) {
  const p = await findPurchase(tx, a, id);
  if (p.status !== 'PENDING_RATE') throw new Conflict('RATES_ALREADY_SET', 'This purchase already has its rates', { status: p.status });
  const materials = await loadMaterials(tx, a.tenantId, p.items.map((i) => i.materialId));
  const given = new Map(input.items.map((i) => [i.materialId, i.ratePaisa]));
  const unknown = input.items.filter((i) => !p.items.some((x) => x.materialId === i.materialId)).map((i) => i.materialId);
  if (unknown.length) throw new BadRequest('NOT_IN_PURCHASE', 'Some materials are not on this purchase', { materialIds: unknown });
  const rates = await resolveRates(tx, a, p.supplierId, p.items.map((i) => ({ materialId: i.materialId, ratePaisa: given.get(i.materialId) })), new Map(), materials);

  const total = p.items.reduce((s, i) => s + valueOf(i.challanQty, rates.get(i.materialId)!), 0n);
  // Bought with site cash (kharcha): that cash is the payment, whatever the form says.
  const kharcha = await tx.cashEntry.findFirst({ where: { tenantId: a.tenantId, refType: 'PURCHASE', refId: p.id }, select: { amountPaisa: true } });
  if (kharcha) {
    const cash = -kharcha.amountPaisa;
    const paid = cash < total ? cash : total;
    input = { ...input, paymentMode: paid >= total ? 'CASH' : 'PARTIAL', paidNowPaisa: paid, paidFrom: 'SITE_CASH' };
  }
  const paidNow = paymentSplit(input.paymentMode, total, input.paidNowPaisa);
  const at = opts.at ?? new Date();
  for (const i of p.items) {
    const rate = rates.get(i.materialId)!;
    const good = (i.countedQty ?? ZERO).sub(i.damagedQty);
    const amount = valueOf(good, rate);
    await tx.purchaseItem.update({ where: { id: i.id }, data: { ratePaisa: rate, amountPaisa: amount } });
    // The goods went in at cost 0 when the munshi saved them; add their value now.
    await postValueChange(tx, a.tenantId, { locationId: p.locationId, materialId: i.materialId, ownerSupplied: false }, amount, {
      type: 'PURCHASE_IN',
      refType: 'PURCHASE',
      refId: p.id,
      occurredAt: at,
      createdById: a.userId,
      note: 'Rates added by the office',
    });
  }
  for (const s of p.shortages) {
    await tx.shortage.update({ where: { id: s.id }, data: { valuePaisa: valueOf(s.qty, rates.get(s.materialId) ?? 0n) } });
  }
  const status: PurchaseStatus = p.shortages.length ? 'RECEIVED_WITH_SHORTAGE' : 'RECEIVED';
  await tx.purchase.update({
    where: { id },
    data: { status, totalPaisa: total, paidNowPaisa: paidNow, paymentMode: input.paymentMode, paidFrom: input.paymentMode === 'UDHAAR' ? null : (input.paidFrom ?? null), ratesSetAt: at },
  });
  await postBill(tx, a, { id, number: p.number, supplierId: p.supplierId, projectId: p.projectId, purchaseDate: formatDateOnly(p.purchaseDate), paidFrom: input.paymentMode === 'UDHAAR' ? null : (input.paidFrom ?? null) }, total, paidNow, at);
  if (p.purchaseOrderId) await refreshOrderStatus(tx, a.tenantId, p.purchaseOrderId);
  await audit(tx, a, 'purchase.rates_set', 'Purchase', id, { number: p.number, totalPaisa: total.toString(), paymentMode: input.paymentMode });
  return purchaseDetail(tx, a, id);
}

export async function setRates(id: string, input: SetRatesInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => setRatesTx(tx, a, id, input));
}

// ─── Site receipt of a direct delivery (blind count) ────────────────────────

export async function receivePurchaseTx(tx: Tx, a: Actor, id: string, input: ReceivePurchaseInput, opts: { at?: Date } = {}) {
  const p = await findPurchase(tx, a, id);
  if (p.status !== 'PENDING_RECEIPT') throw new Conflict('ALREADY_RECEIVED', 'This delivery has already been received', { status: p.status });
  if (p.projectId) await findProjectFor(tx, a, p.projectId);
  const materials = await loadMaterials(tx, a.tenantId, p.items.map((i) => i.materialId));
  const byMaterial = new Map(input.items.map((i) => [i.materialId, i]));
  const missing = p.items.filter((i) => !byMaterial.has(i.materialId)).map((i) => i.materialId);
  const extra = input.items.filter((i) => !p.items.some((x) => x.materialId === i.materialId)).map((i) => i.materialId);
  if (missing.length || extra.length) {
    throw new BadRequest('ITEMS_MISMATCH', 'Count every material on the delivery (and only those)', { missing, extra });
  }
  const lines: CountedLine[] = p.items.map((i) => {
    const c = byMaterial.get(i.materialId)!;
    return { itemId: i.id, materialId: i.materialId, challanQty: i.challanQty, countedQty: c.countedQty, damagedQty: c.damagedQty ?? ZERO, ratePaisa: i.ratePaisa ?? 0n, note: c.note ?? null };
  });
  checkCounted(lines, materials);
  const at = opts.at ?? new Date();

  await lockLocations(tx, [p.locationId]);
  for (const l of lines) {
    const good = l.countedQty.sub(l.damagedQty);
    await tx.purchaseItem.update({ where: { id: l.itemId }, data: { countedQty: l.countedQty, damagedQty: l.damagedQty, amountPaisa: valueOf(good, l.ratePaisa), note: l.note } });
    if (good.gt(0)) {
      await postIn(tx, a.tenantId, { locationId: p.locationId, materialId: l.materialId, ownerSupplied: false }, good, l.ratePaisa, {
        type: 'PURCHASE_IN',
        refType: 'PURCHASE',
        refId: p.id,
        occurredAt: at,
        createdById: a.userId,
      });
    }
  }
  const short = await writeShortages(tx, a, { id: p.id, projectId: p.projectId, locationId: p.locationId }, lines);
  const status: PurchaseStatus = short ? 'RECEIVED_WITH_SHORTAGE' : 'RECEIVED';
  await tx.purchase.update({ where: { id }, data: { status, receivedById: a.userId, receivedAt: at, ...(input.note ? { note: p.note ? `${p.note}\n${input.note}` : input.note } : {}) } });
  if (p.purchaseOrderId) await refreshOrderStatus(tx, a.tenantId, p.purchaseOrderId);
  await audit(tx, a, 'purchase.receive', 'Purchase', id, {
    number: p.number,
    status,
    items: lines.map((l) => ({ materialId: l.materialId, challanQty: qn(l.challanQty), countedQty: qn(l.countedQty), damagedQty: qn(l.damagedQty) })),
  });
  // The count is in: reveal challan vs counted vs difference.
  return {
    purchase: await purchaseDetail(tx, a, id),
    comparison: lines.map((l) => {
      const good = l.countedQty.sub(l.damagedQty);
      return {
        material: materialRef(materials.get(l.materialId)!),
        expectedQty: qn(l.challanQty),
        countedQty: qn(l.countedQty),
        damagedQty: qn(l.damagedQty),
        goodQty: qn(good),
        differenceQty: qn(good.sub(l.challanQty)),
        result: resultOf(l.challanQty, l.countedQty, l.damagedQty),
      };
    }),
  };
}

export function resultOf(expected: Dec, counted: Dec, damaged: Dec): 'COMPLETE' | 'SHORT' | 'DAMAGED' | 'SHORT_AND_DAMAGED' | 'EXCESS' {
  const short = counted.lt(expected);
  if (short && damaged.gt(0)) return 'SHORT_AND_DAMAGED';
  if (short) return 'SHORT';
  if (damaged.gt(0)) return 'DAMAGED';
  if (counted.gt(expected)) return 'EXCESS';
  return 'COMPLETE';
}

export async function receivePurchase(id: string, input: ReceivePurchaseInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => receivePurchaseTx(tx, a, id, input));
}

// ─── Corrections ────────────────────────────────────────────────────────────

export async function correctPurchase(id: string, input: CorrectionInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const p = await findPurchase(tx, a, id);
    if (!RECEIVED_STATUSES.includes(p.status)) throw new Conflict('PURCHASE_NOT_FINAL', 'Only a saved / received purchase can be corrected', { status: p.status });
    const effective = effectiveLines(p);
    const materials = await loadMaterials(tx, a.tenantId, p.items.map((i) => i.materialId));
    const at = new Date();
    const lines: CorrectionLine[] = [];
    let delta = 0n;

    await lockLocations(tx, [p.locationId]);
    for (const c of input.items) {
      const item = p.items.find((i) => i.id === c.purchaseItemId);
      if (!item) throw new BadRequest('NOT_IN_PURCHASE', 'This line is not on the purchase', { purchaseItemId: c.purchaseItemId });
      const cur = effective.get(item.id)!;
      const toQty = c.qty ?? cur.goodQty;
      const toRate = c.ratePaisa ?? cur.ratePaisa;
      if (toQty.eq(cur.goodQty) && toRate === cur.ratePaisa) continue;

      const qtyDelta = toQty.sub(cur.goodQty);
      const valueDelta = valueOf(toQty, toRate) - valueOf(cur.goodQty, cur.ratePaisa);
      const bucket = { locationId: p.locationId, materialId: item.materialId, ownerSupplied: false };
      if (qtyDelta.lt(0)) {
        const bal = await balanceOf(tx, a.tenantId, bucket);
        if (bal.qty.lt(qtyDelta.neg())) {
          throw new BadRequest('INSUFFICIENT_STOCK', `Only ${qn(bal.qty)} ${materials.get(item.materialId)!.unit} of ${materials.get(item.materialId)!.name} is left to take back`, {
            materialId: item.materialId,
            available: qn(bal.qty),
          });
        }
      }
      await tx.stockMovement.create({
        data: {
          tenantId: a.tenantId,
          locationId: p.locationId,
          materialId: item.materialId,
          ownerSupplied: false,
          quantity: qtyDelta,
          unitCostPaisa: toRate,
          valuePaisa: valueDelta,
          type: 'CORRECTION',
          refType: 'PURCHASE_CORRECTION',
          refId: p.id,
          occurredAt: at,
          createdById: a.userId,
          note: input.reason,
        },
      });
      delta += valueOf(toQty, toRate) - valueOf(cur.billQty, cur.ratePaisa);
      lines.push({
        purchaseItemId: item.id,
        materialId: item.materialId,
        fromQty: qn(cur.goodQty),
        toQty: qn(toQty),
        fromRatePaisa: cur.ratePaisa.toString(),
        toRatePaisa: toRate.toString(),
      });
    }
    if (!lines.length) throw new BadRequest('NOTHING_TO_CORRECT', 'The corrected values are the same as now');

    const correction = await tx.purchaseCorrection.create({
      data: { tenantId: a.tenantId, purchaseId: id, reason: input.reason, items: lines as unknown as Prisma.InputJsonValue, deltaPaisa: delta, createdById: a.userId },
    });
    await postLedger(tx, a, {
      supplierId: p.supplierId,
      type: 'ADJUSTMENT',
      amountPaisa: delta,
      refType: 'PURCHASE_CORRECTION',
      refId: correction.id,
      projectId: p.projectId,
      occurredAt: at,
      note: `${p.number}: ${input.reason}`,
    });
    await audit(tx, a, 'purchase.correct', 'Purchase', id, { number: p.number, reason: input.reason, deltaPaisa: delta.toString(), items: lines as unknown as Prisma.InputJsonValue });
    return purchaseDetail(tx, a, id);
  });
}

// ─── Returns ────────────────────────────────────────────────────────────────

const returnInclude = {
  purchase: { select: { id: true, number: true, challanNo: true } },
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, type: true, name: true, projectId: true } },
  items: { include: { material: { select: { id: true, name: true, unit: true } } } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.PurchaseReturnInclude;

function toReturnDto(r: Prisma.PurchaseReturnGetPayload<{ include: typeof returnInclude }>) {
  return {
    id: r.id,
    number: r.number,
    purchase: r.purchase,
    supplier: r.supplier,
    location: r.location,
    reason: r.reason,
    note: r.note,
    attachmentId: r.attachmentId,
    items: r.items.map((i) => ({ material: i.material, qty: qn(i.qty), ratePaisa: i.ratePaisa.toString(), amountPaisa: i.amountPaisa.toString() })),
    totalPaisa: r.totalPaisa.toString(),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function createReturnTx(tx: Tx, a: Actor, purchaseId: string, input: PurchaseReturnInput, opts: { at?: Date } = {}) {
  const p = await findPurchase(tx, a, purchaseId);
  if (!RECEIVED_STATUSES.includes(p.status)) throw new Conflict('PURCHASE_NOT_FINAL', 'Goods can be returned once the purchase is saved / received', { status: p.status });
  if (input.attachmentId) await assertAttachment(tx, a.tenantId, input.attachmentId, ['CHALLAN', 'RECEIPT', 'DOCUMENT', 'SITE_PHOTO'], 'INVALID_ATTACHMENT', 'Return document');
  const materials = await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
  const effective = effectiveLines(p);
  const returned = await tx.purchaseReturnItem.groupBy({ by: ['materialId'], where: { tenantId: a.tenantId, return: { purchaseId } }, _sum: { qty: true } });
  const returnedQty = new Map(returned.map((r) => [r.materialId, r._sum.qty ?? ZERO]));
  const at = opts.at ?? new Date();

  await lockLocations(tx, [p.locationId]);
  const lines = [];
  for (const i of input.items) {
    const item = p.items.find((x) => x.materialId === i.materialId);
    if (!item) throw new BadRequest('NOT_IN_PURCHASE', `${materials.get(i.materialId)!.name} is not on this purchase`, { materialId: i.materialId });
    const eff = effective.get(item.id)!;
    const left = eff.goodQty.sub(returnedQty.get(i.materialId) ?? ZERO);
    if (i.qty.gt(left)) throw new BadRequest('RETURN_EXCEEDS_PURCHASE', `Only ${qn(left)} ${materials.get(i.materialId)!.unit} of ${materials.get(i.materialId)!.name} can still be returned`, { materialId: i.materialId, available: qn(left) });
    const bal = await balanceOf(tx, a.tenantId, { locationId: p.locationId, materialId: i.materialId, ownerSupplied: false });
    if (i.qty.gt(bal.qty)) {
      throw new BadRequest('RETURN_EXCEEDS_STOCK', `Only ${qn(bal.qty)} ${materials.get(i.materialId)!.unit} of ${materials.get(i.materialId)!.name} is in stock here`, { materialId: i.materialId, available: qn(bal.qty) });
    }
    lines.push({ materialId: i.materialId, qty: i.qty, ratePaisa: eff.ratePaisa, amountPaisa: valueOf(i.qty, eff.ratePaisa) });
  }
  const total = lines.reduce((s, l) => s + l.amountPaisa, 0n);
  const number = await nextNumber(tx, a.tenantId, NUMBER_FORMATS.purchaseReturn);
  const ret = await tx.purchaseReturn.create({
    data: {
      tenantId: a.tenantId,
      number,
      purchaseId,
      supplierId: p.supplierId,
      locationId: p.locationId,
      reason: input.reason,
      totalPaisa: total,
      attachmentId: input.attachmentId ?? null,
      note: input.note ?? null,
      createdById: a.userId,
      items: { create: lines },
    },
  });
  for (const l of lines) {
    await postOut(tx, a.tenantId, { locationId: p.locationId, materialId: l.materialId, ownerSupplied: false }, l.qty, {
      type: 'PURCHASE_RETURN_OUT',
      refType: 'PURCHASE_RETURN',
      refId: ret.id,
      occurredAt: at,
      createdById: a.userId,
      note: input.reason,
    }, l.ratePaisa);
  }
  await postLedger(tx, a, { supplierId: p.supplierId, type: 'RETURN', amountPaisa: -total, refType: 'PURCHASE_RETURN', refId: ret.id, projectId: p.projectId, occurredAt: at, note: `${number} (${p.number})` });
  await audit(tx, a, 'purchase.return', 'PurchaseReturn', ret.id, { number, purchase: p.number, totalPaisa: total.toString(), reason: input.reason });
  return toReturnDto(await tx.purchaseReturn.findUniqueOrThrow({ where: { id: ret.id }, include: returnInclude }));
}

export async function createReturn(purchaseId: string, input: PurchaseReturnInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createReturnTx(tx, a, purchaseId, input));
}

export async function listReturns(query: ListReturnsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.PurchaseReturnWhereInput = { tenantId: a.tenantId, purchase: scope(a) };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.purchaseId) where.purchaseId = query.purchaseId;
    const rows = await tx.purchaseReturn.findMany({ where, include: returnInclude, orderBy: { createdAt: 'desc' }, ...skipTake(query) });
    const total = await tx.purchaseReturn.count({ where });
    return { data: rows.map(toReturnDto), meta: pageMeta(query, total) };
  });
}
