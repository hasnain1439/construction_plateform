import type { Plan } from '../../generated/prisma/client.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { getLimits, getUsage } from '../../core/plan/planLimits.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import * as repo from './subscription.repository.js';
import type {
  ChangePlanInput,
  ChangePlanResultDto,
  ListPaymentsQuery,
  PaymentDto,
  PlanDto,
  PlanListItemDto,
  SubmitPaymentInput,
  SubscriptionDetailDto,
} from './subscription.schema.js';

const DAY = 86_400_000;
const PAYMENT_MAX_AGE_DAYS = 30;
const DEFAULT_TIMEZONE = 'Asia/Karachi';

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

function toPlanDto(plan: Plan): PlanDto {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    pricePaisa: plan.priceMonthlyPaisa.toString(),
    maxActiveProjects: plan.maxActiveProjects,
    maxOfficeUsers: plan.maxOfficeUsers,
    features: plan.features,
  };
}

function toPaymentDto(p: repo.PaymentRow): PaymentDto {
  return {
    id: p.id,
    plan: p.plan,
    amountPaisa: p.amountPaisa.toString(),
    method: p.method,
    transactionId: p.transactionId,
    paidOn: formatDateOnly(p.paidOn),
    status: p.status,
    rejectReason: p.rejectReason,
    periodStart: p.periodStart?.toISOString() ?? null,
    periodEnd: p.periodEnd?.toISOString() ?? null,
    receiptNo: p.receiptNo,
    createdAt: p.createdAt.toISOString(),
  };
}

async function loadSubscription(tx: Tx, tenantId: string): Promise<repo.SubscriptionRow> {
  const sub = await repo.findSubscription(tx, tenantId);
  if (!sub) throw new NotFound('SUBSCRIPTION_NOT_FOUND', 'This company has no subscription');
  return sub;
}

/** The date the current state ends: trial end, period end, or grace end. */
function stateEndsAt(sub: repo.SubscriptionRow): Date | null {
  switch (sub.status) {
    case 'TRIAL':
      return sub.trialEndsAt;
    case 'ACTIVE':
      return sub.currentPeriodEnd;
    case 'GRACE':
      return sub.graceEndsAt;
    default:
      return null;
  }
}

/** True while a paid period is running (downgrades then wait for its end). */
function inPaidPeriod(sub: repo.SubscriptionRow, now: Date): boolean {
  return sub.status === 'ACTIVE' && Boolean(sub.currentPeriodEnd && sub.currentPeriodEnd > now);
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getSubscription(): Promise<SubscriptionDetailDto> {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const sub = await loadSubscription(tx, tenantId);
    const usage = await getUsage(tx, tenantId);
    const limits = await getLimits(tx, tenantId);
    const endsAt = stateEndsAt(sub);
    const now = Date.now();
    return {
      plan: toPlanDto(sub.plan),
      status: sub.status,
      trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
      daysLeft: endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - now) / DAY)) : 0,
      usage: {
        activeProjects: { used: usage.activeProjects, limit: limits.activeProjects },
        officeUsers: { used: usage.officeUsers, limit: limits.officeUsers },
      },
      pendingChange: sub.pendingPlan
        ? {
            plan: toPlanDto(sub.pendingPlan),
            effectiveOn: sub.pendingEffectiveOn?.toISOString() ?? null,
            keepActiveProjectIds: sub.keepActiveProjectIds,
          }
        : null,
      readOnly: sub.tenant.status === 'READ_ONLY',
    };
  });
}

export async function listPlans(): Promise<PlanListItemDto[]> {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const sub = await loadSubscription(tx, tenantId);
    const plans = await repo.listPurchasablePlans(tx);
    return plans.map((p) => ({ ...toPlanDto(p), current: p.id === sub.planId }));
  });
}

export async function listPayments(query: ListPaymentsQuery) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const { skip, take } = skipTake(query);
    const rows = await repo.listPayments(tx, skip, take);
    const total = await repo.countPayments(tx);
    return { data: rows.map(toPaymentDto), meta: pageMeta(query, total) };
  });
}

// ─── Payments ───────────────────────────────────────────────────────────────

const duplicateTransaction = () =>
  new Conflict('DUPLICATE_TRANSACTION', 'This transaction ID has already been used. Check the ID on your receipt.');

function isTransactionIdClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta ?? {}).includes('transactionId');
}

/**
 * Records a manual payment for review. Allowed while the company is READ_ONLY (that is
 * how a lapsed company pays). The transaction id is unique across all companies; a clash
 * with another company is reported exactly like a clash with your own — nothing about
 * the other company is revealed.
 */
export async function submitPayment(input: SubmitPaymentInput): Promise<PaymentDto> {
  const { tenantId, userId } = current();
  try {
    return await withTenant(tenantId, async (tx) => {
      await repo.lockSubscription(tx, tenantId);
      const sub = await loadSubscription(tx, tenantId);

      let plan: Plan | null;
      if (input.planId) {
        plan = await repo.findPurchasablePlan(tx, input.planId);
        if (!plan) throw new BadRequest('INVALID_PLAN', 'Choose one of the available plans');
      } else {
        plan = sub.pendingPlan ?? sub.plan;
        if (plan.code === 'TRIAL') throw new BadRequest('PLAN_REQUIRED', 'Choose a plan (planId) to pay for');
      }
      if (input.amountPaisa !== plan.priceMonthlyPaisa) {
        throw new BadRequest('AMOUNT_MISMATCH', `The ${plan.name} plan costs Rs ${Number(plan.priceMonthlyPaisa) / 100}`, {
          expectedPaisa: plan.priceMonthlyPaisa.toString(),
          plan: plan.code,
        });
      }

      const today = todayIn(sub.tenant.settings?.timezone ?? DEFAULT_TIMEZONE);
      if (input.paidOn > today) throw new BadRequest('PAID_ON_IN_FUTURE', 'paidOn cannot be in the future', { today });
      const oldest = formatDateOnly(new Date(dateOnly(today).getTime() - PAYMENT_MAX_AGE_DAYS * DAY));
      if (input.paidOn < oldest) {
        throw new BadRequest('PAID_ON_TOO_OLD', `Payments older than ${PAYMENT_MAX_AGE_DAYS} days can't be submitted. Contact support.`, { oldest });
      }

      const slip = await repo.findAttachment(tx, input.attachmentId);
      if (!slip || slip.kind !== 'PAYMENT_SLIP') {
        throw new NotFound('ATTACHMENT_NOT_FOUND', 'Payment slip not found. Upload it with kind PAYMENT_SLIP first.');
      }
      if (await repo.findPendingPayment(tx)) {
        throw new Conflict('PAYMENT_PENDING', 'A payment is already waiting for review. You can submit another after it is reviewed.');
      }
      if (await repo.findPaymentByTransactionId(tx, input.transactionId)) throw duplicateTransaction();

      const payment = await repo.createPayment(tx, {
        tenantId,
        subscriptionId: sub.id,
        planId: plan.id,
        amountPaisa: input.amountPaisa,
        method: input.method,
        transactionId: input.transactionId,
        paidOn: dateOnly(input.paidOn),
        attachmentId: slip.id,
        submittedById: userId,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'subscription.payment_submitted',
        entityType: 'SubscriptionPayment',
        entityId: payment.id,
        details: { plan: plan.code, amountPaisa: input.amountPaisa.toString(), method: input.method },
      });
      return toPaymentDto(payment);
    });
  } catch (err) {
    // Another company already used this id: the unique index fires even though RLS hides the row.
    if (isTransactionIdClash(err)) throw duplicateTransaction();
    throw err;
  }
}

// ─── Plan changes ───────────────────────────────────────────────────────────

/**
 * Upgrade (or any change while no paid period is running): stored as pending and applied
 * when its payment is approved. Downgrade during a paid period: checked against current
 * usage now and applied by the lifecycle job at the end of the period.
 */
export async function changePlan(input: ChangePlanInput): Promise<ChangePlanResultDto> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    await repo.lockSubscription(tx, tenantId);
    const sub = await loadSubscription(tx, tenantId);
    const target = await repo.findPurchasablePlan(tx, input.planId);
    if (!target) throw new BadRequest('INVALID_PLAN', 'Choose one of the available plans');
    if (target.id === sub.planId) throw new BadRequest('SAME_PLAN', 'You are already on this plan');

    const now = new Date();
    const usage = await getUsage(tx, tenantId, now);

    // Whatever the timing, the company must fit the target plan.
    if (target.maxOfficeUsers !== null && usage.officeUsers > target.maxOfficeUsers) {
      throw new BadRequest(
        'DOWNGRADE_USERS_OVER_LIMIT',
        `${target.name} allows ${target.maxOfficeUsers} office users; you have ${usage.officeUsers}. Deactivate users or cancel PM invites first.`,
        { officeUsers: usage.officeUsers, limit: target.maxOfficeUsers },
      );
    }
    let keep: string[] = [];
    if (target.maxActiveProjects !== null && usage.activeProjects > target.maxActiveProjects) {
      const requested = input.keepActiveProjectIds ?? [];
      if (!requested.length) {
        throw new BadRequest(
          'KEEP_PROJECTS_REQUIRED',
          `${target.name} allows ${target.maxActiveProjects} active projects; you have ${usage.activeProjects}. Choose which to keep active (keepActiveProjectIds).`,
          { activeProjects: usage.activeProjects, limit: target.maxActiveProjects },
        );
      }
      if (requested.length > target.maxActiveProjects) {
        throw new BadRequest('TOO_MANY_PROJECTS', `Keep at most ${target.maxActiveProjects} projects active`, {
          limit: target.maxActiveProjects,
        });
      }
      const found = new Set((await repo.activeProjectIds(tx, requested)).map((p) => p.id));
      const invalidIds = requested.filter((id) => !found.has(id));
      if (invalidIds.length) throw new BadRequest('INVALID_PROJECT', 'Some ids are not active projects of this company', { invalidIds });
      keep = requested;
    }

    const isDowngrade = inPaidPeriod(sub, now) && target.priceMonthlyPaisa <= sub.plan.priceMonthlyPaisa;
    const effectiveOn = isDowngrade ? sub.currentPeriodEnd : null;
    const updated = await repo.setPendingChange(tx, tenantId, {
      pendingPlanId: target.id,
      pendingEffectiveOn: effectiveOn,
      keepActiveProjectIds: keep,
    });

    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'subscription.change_requested',
      entityType: 'Subscription',
      entityId: sub.id,
      details: {
        from: sub.plan.code,
        to: target.code,
        type: isDowngrade ? 'DOWNGRADE' : 'UPGRADE',
        effectiveOn: effectiveOn?.toISOString() ?? null,
        keepActiveProjects: keep.length,
      },
    });

    return {
      type: isDowngrade ? 'DOWNGRADE' : 'UPGRADE',
      pendingChange: {
        plan: toPlanDto(updated.pendingPlan!),
        effectiveOn: effectiveOn?.toISOString() ?? null,
        keepActiveProjectIds: keep,
      },
      amountDuePaisa: isDowngrade ? null : target.priceMonthlyPaisa.toString(),
    };
  });
}

export async function cancelPlanChange(): Promise<{ cancelled: true }> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    await repo.lockSubscription(tx, tenantId);
    const sub = await loadSubscription(tx, tenantId);
    if (!sub.pendingPlan) throw new NotFound('NO_PENDING_CHANGE', 'There is no pending plan change');
    await repo.setPendingChange(tx, tenantId, { pendingPlanId: null, pendingEffectiveOn: null, keepActiveProjectIds: [] });
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'subscription.change_cancelled',
      entityType: 'Subscription',
      entityId: sub.id,
      details: { cancelledPlan: sub.pendingPlan.code },
    });
    return { cancelled: true as const };
  });
}
