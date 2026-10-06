/**
 * Supplier udhaar (credit) ledger and supplier payments.
 * Entries are append-only and signed: + we owe more (purchase, reversal), − we owe less
 * (payment, return, credit). Balance = SUM; ageing pays off the oldest debits first (FIFO).
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { PaidFrom, Prisma, SupplierLedgerType, SupplierPaymentMethod } from '../../generated/prisma/client.js';
import { accountOf, spend } from '../cashbook/cash.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { actor, audit, occurredAtFor, type Actor } from '../inventory/stock.js';
import { findProjectFor } from '../projects/access.js';
import type { ChequeStatusInput, CreatePaymentInput, LedgerQuery, ListPaymentsQuery } from './procurement.schema.js';

const DAY_MS = 86_400_000;

export interface LedgerPost {
  supplierId: string;
  type: SupplierLedgerType;
  amountPaisa: bigint;
  refType?: string | null;
  refId?: string | null;
  projectId?: string | null;
  occurredAt: Date;
  note?: string | null;
}

export async function postLedger(tx: Tx, a: Pick<Actor, 'tenantId' | 'userId'>, e: LedgerPost): Promise<void> {
  if (e.amountPaisa === 0n) return;
  await tx.supplierLedgerEntry.create({
    data: {
      tenantId: a.tenantId,
      supplierId: e.supplierId,
      type: e.type,
      amountPaisa: e.amountPaisa,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      projectId: e.projectId ?? null,
      occurredAt: e.occurredAt,
      note: e.note ?? null,
      createdById: a.userId,
    },
  });
}

export interface SupplierBalance {
  balancePaisa: bigint;
  /** Days since the oldest debit that is not paid off yet (null when nothing is owed). */
  oldestUnpaidDays: number | null;
  oldestUnpaidSince: Date | null;
}

/** Balance + FIFO ageing for each supplier. */
export async function supplierBalances(tx: Tx, tenantId: string, supplierIds: string[], now = new Date()): Promise<Map<string, SupplierBalance>> {
  const out = new Map<string, SupplierBalance>(supplierIds.map((id) => [id, { balancePaisa: 0n, oldestUnpaidDays: null, oldestUnpaidSince: null }]));
  if (!supplierIds.length) return out;
  const entries = await tx.supplierLedgerEntry.findMany({
    where: { tenantId, supplierId: { in: supplierIds } },
    select: { supplierId: true, amountPaisa: true, occurredAt: true },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
  });
  const bySupplier = new Map<string, typeof entries>();
  for (const e of entries) bySupplier.set(e.supplierId, [...(bySupplier.get(e.supplierId) ?? []), e]);
  for (const [supplierId, list] of bySupplier) {
    const debits: Array<{ at: Date; left: bigint }> = [];
    let credit = 0n;
    for (const e of list) {
      if (e.amountPaisa > 0n) debits.push({ at: e.occurredAt, left: e.amountPaisa });
      else credit += -e.amountPaisa;
    }
    for (const d of debits) {
      const used = credit < d.left ? credit : d.left;
      d.left -= used;
      credit -= used;
    }
    const balance = list.reduce((s, e) => s + e.amountPaisa, 0n);
    const oldest = balance > 0n ? debits.find((d) => d.left > 0n) : undefined;
    out.set(supplierId, {
      balancePaisa: balance,
      oldestUnpaidSince: oldest?.at ?? null,
      oldestUnpaidDays: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.at.getTime()) / DAY_MS)) : null,
    });
  }
  return out;
}

export const balanceDto = (b: SupplierBalance | undefined) => ({
  udhaarBalancePaisa: (b?.balancePaisa ?? 0n).toString(),
  oldestUnpaidDays: b?.oldestUnpaidDays ?? null,
});

async function findSupplier(tx: Tx, tenantId: string, id: string) {
  const supplier = await tx.supplier.findFirst({ where: { tenantId, id } });
  if (!supplier) throw new NotFound('SUPPLIER_NOT_FOUND', 'Supplier not found');
  return supplier;
}

/** Ledger with running balance, newest first. Filters narrow the rows; the running balance is the supplier's whole account. */
export async function getLedger(supplierId: string, query: LedgerQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const supplier = await findSupplier(tx, a.tenantId, supplierId);
    if (query.projectId) await findProjectFor(tx, a, query.projectId);
    const all = await tx.supplierLedgerEntry.findMany({
      where: { tenantId: a.tenantId, supplierId },
      include: { project: { select: { id: true, code: true, name: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    let running = 0n;
    const withRunning = all.map((e) => {
      running += e.amountPaisa;
      return { e, running };
    });
    const from = query.from ? pktDayStart(query.from) : null;
    const to = query.to ? pktDayEnd(query.to) : null;
    const rows = withRunning.filter(({ e }) => (!query.projectId || e.projectId === query.projectId) && (!from || e.occurredAt >= from) && (!to || e.occurredAt < to));
    const opening = from ? withRunning.filter(({ e }) => e.occurredAt < from).reduce((s, { e }) => s + e.amountPaisa, 0n) : 0n;
    const newestFirst = [...rows].reverse();
    const pageRows = newestFirst.slice((query.page - 1) * query.limit, query.page * query.limit);
    const balance = (await supplierBalances(tx, a.tenantId, [supplierId])).get(supplierId);
    return {
      data: {
        supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone },
        ...balanceDto(balance),
        openingBalancePaisa: opening.toString(),
        totals: {
          debitPaisa: rows.filter(({ e }) => e.amountPaisa > 0n).reduce((s, { e }) => s + e.amountPaisa, 0n).toString(),
          creditPaisa: rows.filter(({ e }) => e.amountPaisa < 0n).reduce((s, { e }) => s - e.amountPaisa, 0n).toString(),
        },
        entries: pageRows.map(({ e, running: r }) => ({
          id: e.id,
          type: e.type,
          amountPaisa: e.amountPaisa.toString(),
          runningBalancePaisa: r.toString(),
          refType: e.refType,
          refId: e.refId,
          project: e.project,
          occurredAt: e.occurredAt.toISOString(),
          note: e.note,
          createdBy: e.createdBy,
        })),
      },
      meta: pageMeta(query, rows.length),
    };
  });
}

// ─── Payments ───────────────────────────────────────────────────────────────

const paymentInclude = {
  supplier: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true } },
  purchase: { select: { id: true, number: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.SupplierPaymentInclude;

type PaymentRow = Prisma.SupplierPaymentGetPayload<{ include: typeof paymentInclude }>;

function toPaymentDto(p: PaymentRow) {
  return {
    id: p.id,
    supplier: p.supplier,
    amountPaisa: p.amountPaisa.toString(),
    method: p.method,
    reference: p.reference,
    chequeNo: p.chequeNo,
    chequeDate: p.chequeDate ? formatDateOnly(p.chequeDate) : null,
    status: p.status,
    paidOn: formatDateOnly(p.paidOn),
    note: p.note,
    project: p.project,
    purchase: p.purchase,
    statusChangedAt: p.statusChangedAt?.toISOString() ?? null,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
  };
}

export const PAID_FROM_METHOD: Record<PaidFrom, SupplierPaymentMethod> = {
  OFFICE_CASH: 'CASH',
  SITE_CASH: 'CASH',
  BANK: 'BANK',
  CHEQUE: 'CHEQUE',
  JAZZCASH: 'JAZZCASH',
  EASYPAISA: 'EASYPAISA',
};

export interface PaymentPost {
  supplierId: string;
  amountPaisa: bigint;
  method: SupplierPaymentMethod;
  reference?: string | null;
  chequeNo?: string | null;
  chequeDate?: string | null;
  paidOn: string;
  note?: string | null;
  purchaseId?: string | null;
  projectId?: string | null;
  occurredAt: Date;
}

/** Records a payment (cheques start PENDING) and its PAYMENT ledger entry. */
export async function recordPaymentTx(tx: Tx, a: Pick<Actor, 'tenantId' | 'userId'>, p: PaymentPost) {
  const payment = await tx.supplierPayment.create({
    data: {
      tenantId: a.tenantId,
      supplierId: p.supplierId,
      amountPaisa: p.amountPaisa,
      method: p.method,
      reference: p.reference ?? null,
      chequeNo: p.chequeNo ?? null,
      chequeDate: p.chequeDate ? dateOnly(p.chequeDate) : null,
      status: p.method === 'CHEQUE' ? 'PENDING' : 'CLEARED',
      paidOn: dateOnly(p.paidOn),
      note: p.note ?? null,
      purchaseId: p.purchaseId ?? null,
      projectId: p.projectId ?? null,
      createdById: a.userId,
    },
  });
  await postLedger(tx, a, {
    supplierId: p.supplierId,
    type: 'PAYMENT',
    amountPaisa: -p.amountPaisa,
    refType: 'SUPPLIER_PAYMENT',
    refId: payment.id,
    projectId: p.projectId ?? null,
    occurredAt: p.occurredAt,
    note: p.chequeNo ? `Cheque ${p.chequeNo}` : (p.reference ?? null),
  });
  return payment;
}

export async function createPaymentTx(tx: Tx, a: Actor, input: CreatePaymentInput, opts: { at?: Date } = {}) {
  const supplier = await findSupplier(tx, a.tenantId, input.supplierId);
  if (input.projectId) await findProjectFor(tx, a, input.projectId);
  const payment = await recordPaymentTx(tx, a, {
    ...input,
    reference: input.reference ?? null,
    chequeNo: input.chequeNo ?? null,
    chequeDate: input.chequeDate ?? null,
    note: input.note ?? null,
    projectId: input.projectId ?? null,
    occurredAt: opts.at ?? occurredAtFor(input.paidOn),
  });
  await audit(tx, a, 'supplier_payment.create', 'SupplierPayment', payment.id, {
    supplier: supplier.name,
    amountPaisa: input.amountPaisa.toString(),
    method: input.method,
    chequeNo: input.chequeNo ?? null,
  });
  return toPaymentDto(await tx.supplierPayment.findUniqueOrThrow({ where: { id: payment.id }, include: paymentInclude }));
}

export async function createPayment(input: CreatePaymentInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createPaymentTx(tx, a, input));
}

export async function setChequeStatusTx(tx: Tx, a: Actor, id: string, input: ChequeStatusInput, opts: { at?: Date } = {}) {
  const payment = await tx.supplierPayment.findFirst({ where: { tenantId: a.tenantId, id } });
  if (!payment) throw new NotFound('PAYMENT_NOT_FOUND', 'Payment not found');
  if (payment.method !== 'CHEQUE') throw new Conflict('NOT_A_CHEQUE', 'Only cheque payments have a clearing status');
  if (payment.status !== 'PENDING') throw new Conflict('CHEQUE_ALREADY_SETTLED', `This cheque is already ${payment.status.toLowerCase()}`, { status: payment.status });
  const at = opts.at ?? new Date();
  await tx.supplierPayment.update({ where: { id }, data: { status: input.status, statusChangedAt: at, ...(input.note ? { note: input.note } : {}) } });
  if (input.status === 'BOUNCED') {
    await postLedger(tx, a, {
      supplierId: payment.supplierId,
      type: 'PAYMENT_REVERSAL',
      amountPaisa: payment.amountPaisa,
      refType: 'SUPPLIER_PAYMENT',
      refId: payment.id,
      projectId: payment.projectId,
      occurredAt: at,
      note: `Cheque ${payment.chequeNo ?? ''} bounced`.replace('  ', ' '),
    });
  }
  await audit(tx, a, input.status === 'BOUNCED' ? 'supplier_payment.cheque_bounced' : 'supplier_payment.cheque_cleared', 'SupplierPayment', id, {
    chequeNo: payment.chequeNo,
    amountPaisa: payment.amountPaisa.toString(),
  });
  return toPaymentDto(await tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: paymentInclude }));
}

export async function setChequeStatus(id: string, input: ChequeStatusInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => setChequeStatusTx(tx, a, id, input));
}

export async function listPayments(query: ListPaymentsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.SupplierPaymentWhereInput = { tenantId: a.tenantId };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.method) where.method = query.method;
    if (query.status) where.status = query.status;
    if (query.from || query.to) where.paidOn = { ...(query.from ? { gte: dateOnly(query.from) } : {}), ...(query.to ? { lte: dateOnly(query.to) } : {}) };
    const rows = await tx.supplierPayment.findMany({ where, include: paymentInclude, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.limit, take: query.limit });
    const total = await tx.supplierPayment.count({ where });
    const sum = await tx.supplierPayment.aggregate({ where: { ...where, status: { not: 'BOUNCED' } }, _sum: { amountPaisa: true } });
    return { data: rows.map(toPaymentDto), meta: { ...pageMeta(query, total), totalPaidPaisa: (sum._sum.amountPaisa ?? 0n).toString() } };
  });
}

/**
 * A purchase paid from SITE_CASH also leaves the site cash book (a PURCHASE entry). Whose
 * cash: the person recording it, else the one munshi holding cash on that project. Skipped
 * when the purchase was itself entered as a kharcha (its cash already left).
 */
export async function postCashPurchaseFromSiteCash(
  tx: Tx,
  entry: { tenantId: string; projectId: string | null; purchaseId: string; amountPaisa: bigint; occurredAt: Date; createdById: string },
): Promise<void> {
  const linked = await tx.cashEntry.findFirst({ where: { tenantId: entry.tenantId, refType: 'PURCHASE', refId: entry.purchaseId }, select: { id: true } });
  if (linked || entry.amountPaisa <= 0n) return;
  let account = await accountOf(tx, entry.tenantId, entry.createdById);
  if (!account && entry.projectId) {
    const onSite = await tx.cashAccount.findMany({
      where: { tenantId: entry.tenantId, isActive: true, holder: { role: 'MUNSHI', status: 'ACTIVE', projectAccess: { some: { projectId: entry.projectId } } } },
    });
    if (onSite.length === 1) account = onSite[0]!;
  }
  if (!account) throw new BadRequest('NO_CASH_ACCOUNT', 'Nobody holds site cash for this — pay it another way or send a float first');
  const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: entry.purchaseId }, select: { number: true, supplier: { select: { name: true } } } });
  await spend(tx, entry.tenantId, {
    accountId: account.id,
    projectId: entry.projectId,
    type: 'PURCHASE',
    amountPaisa: entry.amountPaisa,
    description: `${purchase.number} — ${purchase.supplier.name}`,
    status: 'POSTED',
    costBucket: 'MATERIAL',
    refType: 'PURCHASE',
    refId: entry.purchaseId,
    occurredAt: entry.occurredAt,
    createdById: entry.createdById,
  });
}
