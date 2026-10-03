import type { PaymentMethod, Prisma } from '../../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

/** Serialises payment submission and plan changes per company. */
export async function lockSubscription(tx: Db, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${tenantId}`}))`;
}

export function findSubscription(tx: Db, tenantId: string) {
  return tx.subscription.findUnique({
    where: { tenantId },
    include: { plan: true, pendingPlan: true, tenant: { select: { status: true, settings: { select: { timezone: true } } } } },
  });
}

export type SubscriptionRow = NonNullable<Awaited<ReturnType<typeof findSubscription>>>;

/** Purchasable plans (TRIAL is never offered). Plan is shared reference data. */
export function listPurchasablePlans(tx: Db) {
  return tx.plan.findMany({ where: { isActive: true, code: { not: 'TRIAL' } }, orderBy: [{ sortOrder: 'asc' }, { priceMonthlyPaisa: 'asc' }, { code: 'asc' }] });
}

export function findPurchasablePlan(tx: Db, id: string) {
  return tx.plan.findFirst({ where: { id, isActive: true, code: { not: 'TRIAL' } } });
}

export function findAttachment(tx: Db, id: string) {
  return tx.attachment.findUnique({ where: { id }, select: { id: true, kind: true } });
}

export function findPendingPayment(tx: Db) {
  return tx.subscriptionPayment.findFirst({ where: { status: 'PENDING_REVIEW' }, select: { id: true } });
}

/** Visible (same-company) payment with this transaction id. Other companies are caught by the unique index. */
export function findPaymentByTransactionId(tx: Db, transactionId: string) {
  return tx.subscriptionPayment.findUnique({ where: { transactionId }, select: { id: true } });
}

const paymentInclude = { plan: { select: { id: true, code: true, name: true } } } satisfies Prisma.SubscriptionPaymentInclude;
export type PaymentRow = Prisma.SubscriptionPaymentGetPayload<{ include: typeof paymentInclude }>;

export function createPayment(
  tx: Db,
  data: {
    tenantId: string;
    subscriptionId: string;
    planId: string;
    amountPaisa: bigint;
    method: PaymentMethod;
    transactionId: string;
    paidOn: Date;
    attachmentId: string;
    submittedById: string;
  },
) {
  return tx.subscriptionPayment.create({ data: { ...data, status: 'PENDING_REVIEW' }, include: paymentInclude });
}

export function listPayments(tx: Db, skip: number, take: number) {
  return tx.subscriptionPayment.findMany({
    include: paymentInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take,
  });
}

export function countPayments(tx: Db) {
  return tx.subscriptionPayment.count();
}

export function setPendingChange(
  tx: Db,
  tenantId: string,
  data: { pendingPlanId: string | null; pendingEffectiveOn: Date | null; keepActiveProjectIds: string[] },
) {
  return tx.subscription.update({ where: { tenantId }, data, include: { pendingPlan: true } });
}
