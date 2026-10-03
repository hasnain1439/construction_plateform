/**
 * Daily subscription lifecycle. Cross-tenant by nature, so it uses prismaAdmin (jobs are
 * on the prismaAdmin allowlist). Every transition is a conditional update, so running
 * the job twice — or two instances at once — gives the same result.
 *
 *   downgrade due (pendingEffectiveOn ≤ now) → switch plan, extra active projects → READ_ONLY
 *   TRIAL  past trialEndsAt        → LAPSED  (company READ_ONLY)
 *   ACTIVE past currentPeriodEnd   → GRACE   (graceEndsAt = periodEnd + 3 days)
 *   GRACE  past graceEndsAt        → LAPSED  (company READ_ONLY)
 *   reminder SMS to THEKEDARs 3 days and 1 day before a trial/period ends (once each)
 */
import { logger } from '../config/logger.js';
import { writeAudit } from '../core/audit/audit.js';
import { prismaAdmin } from '../core/db/prisma.js';
import { invalidateTenantStatus } from '../core/middleware/tenantContext.js';
import { formatDisplayDate } from '../core/utils/dates.js';
import { maskPhone } from '../core/utils/phone.js';
import type { Prisma, SubscriptionStatus } from '../generated/prisma/client.js';
import { smsProvider } from '../modules/auth/sms.provider.js';
import { parkProjectsOverLimit } from '../modules/subscription/subscription.rules.js';
import { syncTenantStatus } from '../modules/subscription/subscription.status.js';

const DAY = 86_400_000;
export const GRACE_DAYS = 3;
export const REMINDER_DAYS = [3, 1] as const;

export interface LifecycleResult {
  downgraded: string[];
  trialLapsed: string[];
  graceStarted: string[];
  lapsed: string[];
  reminded: string[];
}

type Tx = Prisma.TransactionClient;

async function auditSystem(tx: Tx, tenantId: string, subscriptionId: string, action: string, details: Prisma.InputJsonObject) {
  await writeAudit(tx, { tenantId, actorType: 'SYSTEM', action, entityType: 'Subscription', entityId: subscriptionId, details });
}

/** Moves one subscription from → to if it is still in `from`. Returns whether it moved. */
async function transition(
  sub: { id: string; tenantId: string },
  from: SubscriptionStatus,
  to: SubscriptionStatus,
  data: Prisma.SubscriptionUpdateManyMutationInput,
  action: string,
  details: Prisma.InputJsonObject,
): Promise<boolean> {
  const moved = await prismaAdmin.$transaction(async (tx) => {
    const { count } = await tx.subscription.updateMany({ where: { id: sub.id, status: from }, data: { ...data, status: to } });
    if (!count) return false;
    const tenantChanged = await syncTenantStatus(tx, sub.tenantId, to);
    await auditSystem(tx, sub.tenantId, sub.id, action, { from, to, tenantStatusChanged: tenantChanged, ...details });
    return true;
  });
  if (moved) invalidateTenantStatus(sub.tenantId);
  return moved;
}

/** Applies a scheduled downgrade and parks projects above the new plan's limit. */
async function applyDowngrade(subId: string, now: Date): Promise<string | null> {
  return prismaAdmin.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { id: subId }, include: { plan: true, pendingPlan: true } });
    if (!sub?.pendingPlan || !sub.pendingEffectiveOn || sub.pendingEffectiveOn > now) return null;
    const target = sub.pendingPlan;

    const { count } = await tx.subscription.updateMany({
      where: { id: sub.id, pendingPlanId: target.id, pendingEffectiveOn: sub.pendingEffectiveOn },
      data: { planId: target.id, pendingPlanId: null, pendingEffectiveOn: null, keepActiveProjectIds: [] },
    });
    if (!count) return null;

    const parked = await parkProjectsOverLimit(tx, sub.tenantId, target, sub.keepActiveProjectIds);
    await auditSystem(tx, sub.tenantId, sub.id, 'subscription.downgraded', {
      from: sub.plan.code,
      to: target.code,
      projectsReadOnly: parked,
    });
    return sub.tenantId;
  });
}

/** Sends the 3-day / 1-day reminder for one subscription if it is due and not sent yet. */
async function remind(
  sub: { id: string; tenantId: string; status: SubscriptionStatus; trialEndsAt: Date | null; currentPeriodEnd: Date | null; planName: string },
  now: Date,
): Promise<boolean> {
  const endsAt = sub.status === 'TRIAL' ? sub.trialEndsAt : sub.currentPeriodEnd;
  if (!endsAt || endsAt <= now) return false;
  const due = REMINDER_DAYS.map((d) => ({ days: d, at: new Date(endsAt.getTime() - d * DAY) })).filter((r) => r.at <= now);
  const reminder = due.at(-1); // the closest threshold already reached (1 day beats 3 days)
  if (!reminder) return false;

  // Claim it atomically so concurrent runs can't both send.
  const { count } = await prismaAdmin.subscription.updateMany({
    where: { id: sub.id, OR: [{ lastReminderSentAt: null }, { lastReminderSentAt: { lt: reminder.at } }] },
    data: { lastReminderSentAt: now },
  });
  if (!count) return false;

  const owners = await prismaAdmin.user.findMany({
    where: { tenantId: sub.tenantId, role: 'THEKEDAR', status: 'ACTIVE' },
    select: { phone: true },
  });
  const body = `Aap ka ${sub.planName} plan ${formatDisplayDate(endsAt)} ko khatam ho raha hai. Payment slip upload karein.`;
  for (const owner of owners) {
    try {
      await smsProvider().send({ to: owner.phone, body });
    } catch (err) {
      logger.error({ err, phone: maskPhone(owner.phone) }, 'subscription reminder sms failed');
    }
  }
  await prismaAdmin.$transaction((tx) =>
    auditSystem(tx, sub.tenantId, sub.id, 'subscription.reminder_sent', { daysBefore: reminder.days, recipients: owners.length }),
  );
  return true;
}

export async function runSubscriptionLifecycle(now = new Date()): Promise<LifecycleResult> {
  const result: LifecycleResult = { downgraded: [], trialLapsed: [], graceStarted: [], lapsed: [], reminded: [] };

  // 1. Scheduled downgrades first, so the new plan is in place when the period rolls over.
  const dueDowngrades = await prismaAdmin.subscription.findMany({
    where: { pendingPlanId: { not: null }, pendingEffectiveOn: { lte: now } },
    select: { id: true },
  });
  for (const { id } of dueDowngrades) {
    const tenantId = await applyDowngrade(id, now);
    if (tenantId) result.downgraded.push(tenantId);
  }

  // 2. Trials that ended
  const trials = await prismaAdmin.subscription.findMany({ where: { status: 'TRIAL', trialEndsAt: { lte: now } } });
  for (const s of trials) {
    if (await transition(s, 'TRIAL', 'LAPSED', {}, 'subscription.trial_ended', { trialEndsAt: s.trialEndsAt!.toISOString() })) {
      result.trialLapsed.push(s.tenantId);
    }
  }

  // 3. Paid periods that ended → grace
  const ended = await prismaAdmin.subscription.findMany({ where: { status: 'ACTIVE', currentPeriodEnd: { lte: now } } });
  for (const s of ended) {
    const graceEndsAt = new Date(s.currentPeriodEnd!.getTime() + GRACE_DAYS * DAY);
    if (await transition(s, 'ACTIVE', 'GRACE', { graceEndsAt }, 'subscription.grace_started', { graceEndsAt: graceEndsAt.toISOString() })) {
      result.graceStarted.push(s.tenantId);
    }
  }

  // 4. Grace that ran out (also catches step 3 when the job was down for days)
  const graceOver = await prismaAdmin.subscription.findMany({ where: { status: 'GRACE', graceEndsAt: { lte: now } } });
  for (const s of graceOver) {
    if (await transition(s, 'GRACE', 'LAPSED', {}, 'subscription.lapsed', { graceEndsAt: s.graceEndsAt!.toISOString() })) {
      result.lapsed.push(s.tenantId);
    }
  }

  // 5. Reminders for trials / periods ending within 3 days
  const horizon = new Date(now.getTime() + Math.max(...REMINDER_DAYS) * DAY);
  const upcoming = await prismaAdmin.subscription.findMany({
    where: {
      OR: [
        { status: 'TRIAL', trialEndsAt: { gt: now, lte: horizon } },
        { status: 'ACTIVE', currentPeriodEnd: { gt: now, lte: horizon } },
      ],
    },
    include: { plan: { select: { name: true } } },
  });
  for (const s of upcoming) {
    if (await remind({ ...s, planName: s.plan.name }, now)) result.reminded.push(s.tenantId);
  }

  return result;
}
