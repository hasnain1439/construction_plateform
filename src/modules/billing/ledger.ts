/**
 * The billing engine. Invoice money is always derived from allocations:
 *   paid    = Σ allocations from CLEARED payments (incl. WHT)
 *   pending = Σ allocations from PENDING cheques
 *   balance = total − paid        (a BOUNCED cheque's allocations simply stop counting)
 *   open    = total − paid − pending   (what new money may still be put against)
 * Status: PAID when paid ≥ total, PARTLY_PAID when paid > 0, else ISSUED. The stage of a
 * STAGE / RETENTION invoice follows it (INVOICED → PARTLY_PAID → PAID).
 * Project credit = money received (non-bounced, incl. WHT) not yet allocated; it is applied
 * to the next issued invoice.
 */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import type { BillingEventType, BillingStageStatus, InvoiceStatus } from '../../generated/prisma/client.js';

export const LIVE: InvoiceStatus[] = ['ISSUED', 'PARTLY_PAID', 'PAID'];

export async function recomputeInvoice(tx: Tx, tenantId: string, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const allocs = await tx.paymentAllocation.findMany({ where: { tenantId, invoiceId }, include: { payment: { select: { status: true } } } });
  const paid = allocs.filter((a) => a.payment.status === 'CLEARED').reduce((s, a) => s + a.amountPaisa, 0n);
  const pending = allocs.filter((a) => a.payment.status === 'PENDING').reduce((s, a) => s + a.amountPaisa, 0n);
  let status = inv.status;
  if (LIVE.includes(inv.status)) status = paid >= inv.totalPaisa ? 'PAID' : paid > 0n ? 'PARTLY_PAID' : 'ISSUED';
  const updated = await tx.invoice.update({ where: { id: inv.id }, data: { paidPaisa: paid, pendingPaisa: pending, balancePaisa: inv.totalPaisa - paid, status } });
  if (inv.billingStageId) await syncStage(tx, tenantId, inv.billingStageId);
  if (updated.balancePaisa <= 0n) await resolveEvent(tx, tenantId, 'INVOICE_OVERDUE', inv.id);
  if (updated.status === 'PAID' || updated.status === 'CANCELLED') await resolveBouncedFor(tx, tenantId, inv.id);
  return updated;
}

/** A bounced-cheque alert is settled once every invoice that cheque was meant for is paid or cancelled. */
export async function resolveBouncedFor(tx: Tx, tenantId: string, invoiceId: string) {
  const bounced = await tx.paymentAllocation.findMany({ where: { tenantId, invoiceId, payment: { status: 'BOUNCED' } }, select: { paymentId: true } });
  for (const { paymentId } of bounced) {
    const open = await tx.paymentAllocation.count({ where: { tenantId, paymentId, invoice: { status: { notIn: ['PAID', 'CANCELLED'] } } } });
    if (!open) await resolveEvent(tx, tenantId, 'CHEQUE_BOUNCED', paymentId);
  }
}

/** Stage status from its live invoice (or back to READY / UPCOMING when there is none). */
export async function syncStage(tx: Tx, tenantId: string, stageId: string) {
  const stage = await tx.projectBillingStage.findUniqueOrThrow({ where: { id: stageId } });
  const inv = await tx.invoice.findFirst({ where: { tenantId, billingStageId: stageId, status: { in: LIVE } }, orderBy: { createdAt: 'desc' } });
  const status: BillingStageStatus = inv
    ? inv.status === 'PAID'
      ? 'PAID'
      : inv.status === 'PARTLY_PAID'
        ? 'PARTLY_PAID'
        : 'INVOICED'
    : stage.readyAt
      ? 'READY'
      : 'UPCOMING';
  if (status !== stage.status) await tx.projectBillingStage.update({ where: { id: stageId }, data: { status } });
}

export const openAmount = (inv: { totalPaisa: bigint; paidPaisa: bigint; pendingPaisa: bigint }) => inv.totalPaisa - inv.paidPaisa - inv.pendingPaisa;

/** Live invoices of a project still open, oldest due first. */
export function openInvoices(tx: Tx, tenantId: string, projectId: string) {
  return tx.invoice
    .findMany({ where: { tenantId, projectId, status: { in: ['ISSUED', 'PARTLY_PAID'] } }, orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }, { createdAt: 'asc' }] })
    .then((rows) => rows.filter((r) => openAmount(r) > 0n));
}

/** Unallocated money per non-bounced payment (amount + WHT − allocations), oldest first. */
export async function paymentCredits(tx: Tx, tenantId: string, projectId: string) {
  const payments = await tx.clientPayment.findMany({
    where: { tenantId, projectId, status: { not: 'BOUNCED' } },
    include: { allocations: { select: { amountPaisa: true } } },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
  });
  return payments
    .map((p) => ({ payment: p, free: p.amountPaisa + p.whtDeductedPaisa - p.allocations.reduce((s, a) => s + a.amountPaisa, 0n) }))
    .filter((x) => x.free > 0n);
}

export async function projectCredit(tx: Tx, tenantId: string, projectId: string): Promise<bigint> {
  return (await paymentCredits(tx, tenantId, projectId)).reduce((s, x) => s + x.free, 0n);
}

/** Puts unallocated project credit against an invoice (oldest payment first). Returns the amount applied. */
export async function applyCredit(tx: Tx, tenantId: string, invoiceId: string): Promise<bigint> {
  let inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  let left = openAmount(inv);
  let applied = 0n;
  for (const c of await paymentCredits(tx, tenantId, inv.projectId)) {
    if (left <= 0n) break;
    const take = c.free < left ? c.free : left;
    await tx.paymentAllocation.create({ data: { tenantId, paymentId: c.payment.id, invoiceId, amountPaisa: take } });
    left -= take;
    applied += take;
  }
  if (applied > 0n) inv = await recomputeInvoice(tx, tenantId, invoiceId);
  return applied;
}

// ─── Events ─────────────────────────────────────────────────────────────────

/** One row per (type, ref): a repeat only re-opens / refreshes it. Returns true when new. */
export async function recordEvent(
  tx: Tx,
  e: { tenantId: string; projectId: string; type: BillingEventType; refType: string; refId: string; details?: Prisma.InputJsonValue; occurredAt?: Date },
): Promise<boolean> {
  const existing = await tx.billingEvent.findUnique({ where: { tenantId_type_refId: { tenantId: e.tenantId, type: e.type, refId: e.refId } } });
  if (existing) {
    if (existing.resolvedAt) await tx.billingEvent.update({ where: { id: existing.id }, data: { resolvedAt: null, occurredAt: e.occurredAt ?? new Date(), ...(e.details !== undefined ? { details: e.details } : {}) } });
    return false;
  }
  await tx.billingEvent.create({
    data: {
      tenantId: e.tenantId,
      projectId: e.projectId,
      type: e.type,
      refType: e.refType,
      refId: e.refId,
      ...(e.details !== undefined ? { details: e.details } : {}),
      occurredAt: e.occurredAt ?? new Date(),
    },
  });
  return true;
}

export async function resolveEvent(tx: Tx, tenantId: string, type: BillingEventType, refId: string) {
  await tx.billingEvent.updateMany({ where: { tenantId, type, refId, resolvedAt: null }, data: { resolvedAt: new Date() } });
}
