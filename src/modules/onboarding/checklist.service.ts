/**
 * First-login setup checklist. Every step is computed from the company's data (demo data never
 * counts); only "rates reviewed" can also be confirmed by hand, and the card can be dismissed.
 */
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';

export const CHECKLIST_STEPS = ['LOGO', 'RATES', 'TEAM', 'WORKERS', 'SUPPLIERS', 'PROJECT'] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

/** Audit actions that mean the owner looked at / changed the rates. */
const RATE_ACTIONS = ['labor_rates.update', 'price_list.update', 'price_list.bulk_percent', 'worker_type.create', 'worker_type.update', 'supplier.rates_update'];

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

async function compute(tx: Tx, tenantId: string) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { logoAttachmentId: true } });
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId }, select: { onboardingDismissedAt: true, ratesReviewedAt: true } });
  const rateEdits = await tx.auditLog.count({ where: { tenantId, action: { in: RATE_ACTIONS } } });
  const teamUsers = await tx.user.count({ where: { tenantId, isSystem: false, role: { not: 'THEKEDAR' } } });
  const invites = await tx.invitation.count({ where: { tenantId } });
  const workers = await tx.worker.count({ where: { tenantId, isDemo: false } });
  const suppliers = await tx.supplier.count({ where: { tenantId, isDemo: false } });
  const projects = await tx.project.count({ where: { tenantId, isDemo: false } });
  const demo = await tx.project.findFirst({ where: { tenantId, isDemo: true }, select: { id: true, code: true, name: true, createdAt: true } });

  const done: Record<ChecklistStep, boolean> = {
    LOGO: tenant.logoAttachmentId !== null,
    RATES: Boolean(settings?.ratesReviewedAt) || rateEdits > 0,
    TEAM: teamUsers > 0 || invites > 0,
    WORKERS: workers > 0,
    SUPPLIERS: suppliers > 0,
    PROJECT: projects > 0,
  };
  const steps = CHECKLIST_STEPS.map((key) => ({ key, done: done[key] }));
  const completed = steps.filter((s) => s.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    percent: Math.round((completed / steps.length) * 100),
    allDone: completed === steps.length,
    dismissed: Boolean(settings?.onboardingDismissedAt),
    dismissedAt: settings?.onboardingDismissedAt?.toISOString() ?? null,
    ratesReviewedAt: settings?.ratesReviewedAt?.toISOString() ?? null,
    counts: { workers, suppliers, projects, teamUsers, pendingOrSentInvites: invites },
    demo: demo ? { id: demo.id, code: demo.code, name: demo.name, createdAt: demo.createdAt.toISOString() } : null,
  };
}

export async function getChecklist() {
  const { tenantId } = current();
  return withTenant(tenantId, (tx) => compute(tx, tenantId));
}

/** Hides (or, with `dismissed: false`, shows again) the checklist card for the whole company. */
export async function dismiss(dismissed: boolean) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    await tx.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId, onboardingDismissedAt: dismissed ? new Date() : null, onboardingDismissedById: dismissed ? userId : null },
      update: { onboardingDismissedAt: dismissed ? new Date() : null, onboardingDismissedById: dismissed ? userId : null },
    });
    await writeAudit(tx, { tenantId, actorType: 'USER', actorId: userId, action: dismissed ? 'onboarding.dismiss' : 'onboarding.restore', entityType: 'TenantSettings', entityId: tenantId });
    return compute(tx, tenantId);
  });
}

/** "My rates are fine" — marks the RATES step done without changing a rate. */
export async function markRatesReviewed() {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    await tx.tenantSettings.upsert({ where: { tenantId }, create: { tenantId, ratesReviewedAt: new Date() }, update: { ratesReviewedAt: new Date() } });
    await writeAudit(tx, { tenantId, actorType: 'USER', actorId: userId, action: 'onboarding.rates_reviewed', entityType: 'TenantSettings', entityId: tenantId });
    return compute(tx, tenantId);
  });
}
