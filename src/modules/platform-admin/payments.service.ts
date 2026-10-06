import { prismaAdmin, type Prisma } from '../../core/db/prisma.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { invalidateTenantStatus } from '../../core/middleware/tenantContext.js';
import { dateOnly, formatDateOnly, formatDisplayDate } from '../../core/utils/dates.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import { assertPlanFits, parkProjectsOverLimit } from '../subscription/subscription.rules.js';
import { syncTenantStatus } from '../subscription/subscription.status.js';
import * as alerts from '../notifications/alerts.js';
import { adminId, auditAdmin, nextReceiptNo, smsOwners } from './platformAdmin.shared.js';
import type { ApprovePaymentInput, PaymentsQuery, RejectPaymentInput } from './platformAdmin.schema.js';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const PERIOD_DAYS = 30;

const notFound = () => new NotFound('PAYMENT_NOT_FOUND', 'Payment not found');
const alreadyProcessed = (status: string) => new Conflict('ALREADY_PROCESSED', `This payment was already ${status.toLowerCase()}`);

interface PaymentKey {
  id: string;
  tenantId: string;
  amountPaisa: bigint;
  method: string;
  paidOn: Date;
}

/**
 * Possible duplicates of a payment:
 *  - another company paid the same amount by the same method within ±1 day, or
 *  - the same company already had a REJECTED payment with the same amount/method/date
 *    (transaction ids are unique platform-wide, so a resubmitted slip comes back under a new id).
 */
function duplicateWhere(p: PaymentKey): Prisma.SubscriptionPaymentWhereInput {
  const near = { gte: new Date(p.paidOn.getTime() - DAY), lte: new Date(p.paidOn.getTime() + DAY) };
  return {
    id: { not: p.id },
    amountPaisa: p.amountPaisa,
    method: p.method as never,
    OR: [
      { tenantId: { not: p.tenantId }, paidOn: near },
      { tenantId: p.tenantId, status: 'REJECTED', paidOn: p.paidOn },
    ],
  };
}

// ─── Queue / list ───────────────────────────────────────────────────────────

export async function listPayments(query: PaymentsQuery) {
  const where: Prisma.SubscriptionPaymentWhereInput = {
    status: query.status,
    ...(query.method ? { method: query.method } : {}),
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: dateOnly(query.from) } : {}),
            ...(query.to ? { lt: new Date(dateOnly(query.to).getTime() + DAY) } : {}),
          },
        }
      : {}),
  };
  const { skip, take } = skipTake(query);
  const rows = await prismaAdmin.subscriptionPayment.findMany({
    where,
    include: { tenant: { select: { id: true, name: true } }, plan: { select: { id: true, code: true, name: true, priceMonthlyPaisa: true } } },
    // The review queue is first-in, first-out; history is newest first.
    orderBy: query.status === 'PENDING_REVIEW' ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take,
  });
  const total = await prismaAdmin.subscriptionPayment.count({ where });

  const data = [];
  for (const p of rows) {
    const duplicates = await prismaAdmin.subscriptionPayment.count({ where: duplicateWhere(p) });
    data.push({
      id: p.id,
      tenant: p.tenant,
      plan: { id: p.plan.id, code: p.plan.code, name: p.plan.name },
      expectedAmountPaisa: p.plan.priceMonthlyPaisa.toString(),
      amountPaisa: p.amountPaisa.toString(),
      method: p.method,
      transactionId: p.transactionId,
      paidOn: formatDateOnly(p.paidOn),
      submittedAt: p.createdAt.toISOString(),
      status: p.status,
      receiptNo: p.receiptNo,
      duplicateWarning: duplicates > 0,
    });
  }
  return { data, meta: pageMeta(query, total) };
}

export async function getPayment(id: string) {
  const p = await prismaAdmin.subscriptionPayment.findUnique({
    where: { id },
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true } },
      plan: { select: { id: true, code: true, name: true, priceMonthlyPaisa: true } },
      slip: { select: { id: true, storageKey: true, mimeType: true, fileName: true } },
      submittedBy: { select: { id: true, name: true, phone: true } },
      reviewedBy: { select: { id: true, name: true, email: true } },
      subscription: { select: { status: true, currentPeriodEnd: true, trialEndsAt: true, pendingPlanId: true } },
    },
  });
  if (!p) throw notFound();
  const duplicates = await prismaAdmin.subscriptionPayment.findMany({
    where: duplicateWhere(p),
    include: { tenant: { select: { name: true } } },
    orderBy: { paidOn: 'desc' },
    take: 10,
  });
  return {
    id: p.id,
    tenant: p.tenant,
    plan: { id: p.plan.id, code: p.plan.code, name: p.plan.name },
    expectedAmountPaisa: p.plan.priceMonthlyPaisa.toString(),
    amountPaisa: p.amountPaisa.toString(),
    method: p.method,
    transactionId: p.transactionId,
    paidOn: formatDateOnly(p.paidOn),
    status: p.status,
    rejectReason: p.rejectReason,
    reviewNote: p.reviewNote,
    receiptNo: p.receiptNo,
    periodStart: p.periodStart?.toISOString() ?? null,
    periodEnd: p.periodEnd?.toISOString() ?? null,
    submittedAt: p.createdAt.toISOString(),
    submittedBy: p.submittedBy,
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
    reviewedBy: p.reviewedBy,
    slip: p.slip ? { id: p.slip.id, fileName: p.slip.fileName, mimeType: p.slip.mimeType, url: await optionalSignedUrl(p.slip) } : null,
    subscription: {
      status: p.subscription.status,
      currentPeriodEnd: p.subscription.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: p.subscription.trialEndsAt?.toISOString() ?? null,
      isForPendingPlan: p.subscription.pendingPlanId === p.plan.id,
    },
    duplicateOf: duplicates.map((d) => ({ tenantName: d.tenant.name, paidOn: formatDateOnly(d.paidOn), status: d.status })),
  };
}

// ─── Approve / reject ───────────────────────────────────────────────────────

async function lockPayment(tx: Tx, id: string) {
  const p = await tx.subscriptionPayment.findUnique({ where: { id }, select: { tenantId: true } });
  if (!p) throw notFound();
  // Same lock as the company-side subscription routes and admin plan changes.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${p.tenantId}`}))`;
  const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id }, include: { plan: true } });
  if (payment.status !== 'PENDING_REVIEW') throw alreadyProcessed(payment.status);
  return payment;
}

/**
 * Approves a payment: 30 days from today (TRIAL / GRACE / LAPSED) or from the current
 * period end (ACTIVE); switches to the paid plan (clearing a matching pending change);
 * receipt number; subscription ACTIVE; company back to ACTIVE; SMS to the owner.
 */
export async function approvePayment(id: string, input: ApprovePaymentInput) {
  const now = new Date();
  const result = await prismaAdmin.$transaction(async (tx) => {
    const payment = await lockPayment(tx, id);
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId }, include: { plan: true } });

    const extending = sub.status === 'ACTIVE' && sub.currentPeriodEnd !== null;
    const start = extending ? sub.currentPeriodEnd! : now;
    const end = new Date(start.getTime() + PERIOD_DAYS * DAY);

    // Paying for another plan switches to it; the company must fit it (same rules as change-plan).
    let parked: string[] = [];
    const switching = payment.planId !== sub.planId;
    if (switching) {
      const keep = sub.pendingPlanId === payment.planId ? sub.keepActiveProjectIds : [];
      const validKeep = await assertPlanFits(tx, sub.tenantId, payment.plan, keep);
      parked = await parkProjectsOverLimit(tx, sub.tenantId, payment.plan, validKeep);
    }
    const clearsPending = sub.pendingPlanId === payment.planId;

    const receiptNo = await nextReceiptNo(tx, now);
    await tx.subscriptionPayment.update({
      where: { id },
      data: {
        status: 'APPROVED',
        periodStart: start,
        periodEnd: end,
        receiptNo,
        reviewedAt: now,
        reviewedById: adminId(),
        reviewNote: input.note ?? null,
      },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        planId: payment.planId,
        currentPeriodStart: extending ? sub.currentPeriodStart : start,
        currentPeriodEnd: end,
        graceEndsAt: null,
        lastReminderSentAt: null,
        ...(clearsPending ? { pendingPlanId: null, pendingEffectiveOn: null, keepActiveProjectIds: [] } : {}),
      },
    });
    const tenantChanged = await syncTenantStatus(tx, sub.tenantId, 'ACTIVE');
    await auditAdmin(tx, {
      tenantId: sub.tenantId,
      action: 'subscription.payment_approved',
      entityType: 'SubscriptionPayment',
      entityId: id,
      details: {
        receiptNo,
        plan: payment.plan.code,
        previousPlan: sub.plan.code,
        previousStatus: sub.status,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        tenantStatusChanged: tenantChanged,
        projectsReadOnly: parked,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    await alerts.subscriptionPayment(tx, { tenantId: sub.tenantId, paymentId: id, approved: true, detail: `${payment.plan.name} is active until ${formatDisplayDate(end)} (receipt ${receiptNo}).` });
    return { tenantId: sub.tenantId, planName: payment.plan.name, receiptNo, start, end };
  });

  invalidateTenantStatus(result.tenantId);
  await smsOwners(prismaAdmin, result.tenantId, `Payment approve ho gayi. ${result.planName} ${formatDisplayDate(result.end)} tak active.`);
  return {
    id,
    status: 'APPROVED' as const,
    receiptNo: result.receiptNo,
    periodStart: result.start.toISOString(),
    periodEnd: result.end.toISOString(),
  };
}

export async function rejectPayment(id: string, input: RejectPaymentInput) {
  const result = await prismaAdmin.$transaction(async (tx) => {
    const payment = await lockPayment(tx, id);
    await tx.subscriptionPayment.update({
      where: { id },
      data: { status: 'REJECTED', rejectReason: input.reason, reviewedAt: new Date(), reviewedById: adminId() },
    });
    await auditAdmin(tx, {
      tenantId: payment.tenantId,
      action: 'subscription.payment_rejected',
      entityType: 'SubscriptionPayment',
      entityId: id,
      details: { reason: input.reason, transactionId: payment.transactionId },
    });
    await alerts.subscriptionPayment(tx, { tenantId: payment.tenantId, paymentId: id, approved: false, detail: `Payment ${payment.transactionId} was rejected: ${input.reason}` });
    return payment;
  });
  await smsOwners(prismaAdmin, result.tenantId, `Aap ki payment (${result.transactionId}) reject ho gayi: ${input.reason}`);
  return { id, status: 'REJECTED' as const, rejectReason: input.reason };
}
