import { isProduction } from '../../config/env.js';
import { Prisma, prismaAdmin } from '../../core/db/prisma.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { invalidateTenantStatus } from '../../core/middleware/tenantContext.js';
import { getLimits, getUsage, PLAN_COUNTED_PROJECT_STATUSES } from '../../core/plan/planLimits.js';
import { hashSecret, randomToken } from '../../core/utils/crypto.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import { slugify } from '../../core/utils/slug.js';
import type { Plan, TenantStatus } from '../../generated/prisma/client.js';
import { deliverInvite, inviteUrl } from '../auth/inviteMessages.js';
import { provisionMasterData } from '../master-data/provision.js';
import { assertPlanFits, parkProjectsOverLimit } from '../subscription/subscription.rules.js';
import { syncTenantStatus, tenantStatusFor } from '../subscription/subscription.status.js';
import { adminId, auditAdmin, nextReceiptNo } from './platformAdmin.shared.js';
import type { CreateTenantInput, TenantPlanInput, TenantStatusInput, TenantsQuery } from './platformAdmin.schema.js';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const PERIOD_DAYS = 30;
const INVITE_DAYS = 7;
const PAYMENT_MAX_AGE_DAYS = 30;

const notFound = () => new NotFound('TENANT_NOT_FOUND', 'Company not found');

function renewsOn(sub: { currentPeriodEnd: Date | null; trialEndsAt: Date | null } | null): string | null {
  return (sub?.currentPeriodEnd ?? sub?.trialEndsAt)?.toISOString() ?? null;
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listTenants(query: TenantsQuery) {
  const and: Prisma.TenantWhereInput[] = [];
  if (query.search) {
    const digits = query.search.replace(/\D/g, '').replace(/^0+/, '').replace(/^92/, '');
    and.push({
      OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search.toLowerCase() } },
        ...(digits.length >= 3 ? [{ users: { some: { role: 'THEKEDAR' as const, phone: { contains: digits } } } }] : []),
      ],
    });
  }
  if (query.tenantStatus) and.push({ status: query.tenantStatus });
  const sub: Prisma.SubscriptionWhereInput = {};
  if (query.subscriptionStatus) sub.status = query.subscriptionStatus;
  if (query.plan) sub.plan = { code: query.plan };
  if (query.renewsBefore) {
    const before = new Date(dateOnly(query.renewsBefore).getTime() + DAY - 1);
    sub.OR = [{ currentPeriodEnd: { lte: before } }, { currentPeriodEnd: null, trialEndsAt: { lte: before } }];
  }
  if (Object.keys(sub).length) and.push({ subscription: { is: sub } });
  const where: Prisma.TenantWhereInput = and.length ? { AND: and } : {};

  const { skip, take } = skipTake(query);
  const rows = await prismaAdmin.tenant.findMany({
    where,
    include: {
      subscription: { include: { plan: true } },
      users: { where: { role: 'THEKEDAR', isSystem: false }, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }], take: 1, select: { name: true, phone: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip,
    take,
  });
  const total = await prismaAdmin.tenant.count({ where });

  // Usage for the whole page in three grouped queries (not N+1).
  const ids = rows.map((r) => r.id);
  const projects = await prismaAdmin.project.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, status: { in: [...PLAN_COUNTED_PROJECT_STATUSES] } }, _count: { _all: true } });
  const office = await prismaAdmin.user.groupBy({
    by: ['tenantId'],
    where: { tenantId: { in: ids }, status: 'ACTIVE', role: { in: ['THEKEDAR', 'PM'] } },
    _count: { _all: true },
  });
  const pending = await prismaAdmin.invitation.groupBy({
    by: ['tenantId'],
    where: { tenantId: { in: ids }, role: 'PM', status: 'PENDING', expiresAt: { gt: new Date() } },
    _count: { _all: true },
  });
  const count = (list: Array<{ tenantId: string; _count: { _all: number } }>, id: string) => list.find((x) => x.tenantId === id)?._count._all ?? 0;

  const data = rows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    owner: t.users[0] ?? null,
    region: t.region,
    plan: t.subscription ? { id: t.subscription.plan.id, code: t.subscription.plan.code, name: t.subscription.plan.name } : null,
    subscriptionStatus: t.subscription?.status ?? null,
    tenantStatus: t.status,
    usage: {
      activeProjects: { used: count(projects, t.id), limit: t.subscription?.plan.maxActiveProjects ?? null },
      officeUsers: { used: count(office, t.id) + count(pending, t.id), limit: t.subscription?.plan.maxOfficeUsers ?? null },
    },
    renewsOn: renewsOn(t.subscription),
    createdAt: t.createdAt.toISOString(),
  }));
  return { data, meta: pageMeta(query, total) };
}

// ─── Detail ─────────────────────────────────────────────────────────────────

export async function getTenant(id: string) {
  const t = await prismaAdmin.tenant.findUnique({
    where: { id },
    include: {
      settings: true,
      subscription: { include: { plan: true, pendingPlan: true } },
      users: { where: { role: 'THEKEDAR', isSystem: false }, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }], take: 1, select: { id: true, name: true, phone: true, email: true, status: true, lastLoginAt: true } },
    },
  });
  if (!t) throw notFound();
  const usage = await getUsage(prismaAdmin, id);
  const limits = await getLimits(prismaAdmin, id);
  const payments = await prismaAdmin.subscriptionPayment.findMany({
    where: { tenantId: id },
    include: { plan: { select: { code: true, name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 10,
  });
  const events = await prismaAdmin.auditLog.findMany({ where: { tenantId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 });
  const s = t.subscription;
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    region: t.region,
    ntn: t.ntn,
    address: t.address,
    phone: t.phone,
    email: t.email,
    createdAt: t.createdAt.toISOString(),
    owner: t.users[0] ? { ...t.users[0], lastLoginAt: iso(t.users[0].lastLoginAt) } : null,
    settings: t.settings
      ? {
          marlaStandard: Number(t.settings.marlaStandardSqft),
          timezone: t.settings.timezone,
          defaultLanguage: t.settings.defaultLanguage,
          kharchaApprovalLimitPaisa: t.settings.kharchaApprovalLimitPaisa.toString(),
          taxEnabled: t.settings.taxEnabled,
        }
      : null,
    subscription: s
      ? {
          id: s.id,
          status: s.status,
          plan: { id: s.plan.id, code: s.plan.code, name: s.plan.name, pricePaisa: s.plan.priceMonthlyPaisa.toString() },
          trialEndsAt: iso(s.trialEndsAt),
          currentPeriodStart: iso(s.currentPeriodStart),
          currentPeriodEnd: iso(s.currentPeriodEnd),
          graceEndsAt: iso(s.graceEndsAt),
          pendingPlan: s.pendingPlan ? { id: s.pendingPlan.id, code: s.pendingPlan.code, name: s.pendingPlan.name } : null,
          pendingEffectiveOn: iso(s.pendingEffectiveOn),
          keepActiveProjectIds: s.keepActiveProjectIds,
          lastReminderSentAt: iso(s.lastReminderSentAt),
          cancelledAt: iso(s.cancelledAt),
        }
      : null,
    usage: {
      activeProjects: { used: usage.activeProjects, limit: limits.activeProjects },
      officeUsers: { used: usage.officeUsers, limit: limits.officeUsers },
    },
    payments: payments.map((p) => ({
      id: p.id,
      plan: p.plan,
      amountPaisa: p.amountPaisa.toString(),
      method: p.method,
      transactionId: p.transactionId,
      paidOn: formatDateOnly(p.paidOn),
      status: p.status,
      receiptNo: p.receiptNo,
      rejectReason: p.rejectReason,
      createdAt: p.createdAt.toISOString(),
    })),
    auditEvents: events.map((e) => ({
      id: e.id,
      action: e.action,
      actorType: e.actorType,
      actorId: e.actorId,
      entityType: e.entityType,
      entityId: e.entityId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ─── Create from the console ───────────────────────────────────────────────

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await tx.tenant.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((t) => t.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${randomToken(4).toLowerCase()}`;
}

/**
 * Creates a company, its settings, subscription (TRIAL, or PAID with an approved payment
 * and receipt) and a THEKEDAR invitation for the owner — all in one transaction. The
 * owner sets a password by accepting the invitation (SMS link).
 */
export async function createTenant(input: CreateTenantInput) {
  const now = new Date();
  const token = randomToken(32);
  const { company, owner, subscription: subInput } = input;

  let created;
  try {
    created = await prismaAdmin.$transaction(async (tx) => {
      const plan = await tx.plan.findFirst({ where: { code: subInput.planCode, isActive: true } });
      if (!plan) throw new BadRequest('INVALID_PLAN', `No active plan with code ${subInput.planCode}`);
      if (subInput.mode === 'PAID' && plan.code === 'TRIAL') throw new BadRequest('INVALID_PLAN', 'Choose a paid plan for PAID mode');

      if (company.slug && (await tx.tenant.findUnique({ where: { slug: company.slug }, select: { id: true } }))) {
        throw new Conflict('SLUG_TAKEN', `The slug "${company.slug}" is already used by another company`);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signup:${owner.phone}`}))`;
      if (await tx.user.findFirst({ where: { phone: owner.phone, role: 'THEKEDAR' }, select: { id: true } })) {
        throw new Conflict('PHONE_TAKEN', 'This phone number already owns a company');
      }

      const payment = subInput.payment;
      if (payment) {
        if (payment.amountPaisa !== plan.priceMonthlyPaisa) {
          throw new BadRequest('AMOUNT_MISMATCH', `The ${plan.name} plan costs Rs ${Number(plan.priceMonthlyPaisa) / 100}`, {
            expectedPaisa: plan.priceMonthlyPaisa.toString(),
            plan: plan.code,
          });
        }
        const today = todayIn('Asia/Karachi', now);
        if (payment.paidOn > today) throw new BadRequest('PAID_ON_IN_FUTURE', 'paidOn cannot be in the future', { today });
        if (payment.paidOn < formatDateOnly(new Date(dateOnly(today).getTime() - PAYMENT_MAX_AGE_DAYS * DAY))) {
          throw new BadRequest('PAID_ON_TOO_OLD', `paidOn must be within the last ${PAYMENT_MAX_AGE_DAYS} days`);
        }
        if (await tx.subscriptionPayment.findUnique({ where: { transactionId: payment.transactionId }, select: { id: true } })) {
          throw new Conflict('DUPLICATE_TRANSACTION', 'This transaction ID has already been used');
        }
      }

      const periodEnd = new Date(now.getTime() + PERIOD_DAYS * DAY);
      const tenant = await tx.tenant.create({
        data: {
          name: company.name,
          slug: company.slug ?? (await uniqueSlug(tx, company.name)),
          region: company.region,
          status: 'ACTIVE',
          phone: company.phone,
          email: company.email ?? null,
          ntn: company.ntn ?? null,
          address: company.address ?? null,
          settings: { create: { marlaStandardSqft: company.marlaStandard ?? 225 } },
          subscription: {
            create:
              subInput.mode === 'TRIAL'
                ? { planId: plan.id, status: 'TRIAL', trialEndsAt: new Date(now.getTime() + subInput.trialDays * DAY) }
                : { planId: plan.id, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd },
          },
        },
        include: { subscription: true },
      });

      let receiptNo: string | null = null;
      if (payment) {
        receiptNo = await nextReceiptNo(tx, now);
        await tx.subscriptionPayment.create({
          data: {
            tenantId: tenant.id,
            subscriptionId: tenant.subscription!.id,
            planId: plan.id,
            amountPaisa: payment.amountPaisa,
            method: payment.method,
            transactionId: payment.transactionId,
            paidOn: dateOnly(payment.paidOn),
            status: 'APPROVED',
            periodStart: now,
            periodEnd,
            receiptNo,
            reviewedAt: now,
            reviewedById: adminId(),
            reviewNote: input.note ?? 'Recorded when the company was created from the console',
          },
        });
      }

      await provisionMasterData(tx, tenant.id);

      const invitation = await tx.invitation.create({
        data: {
          tenantId: tenant.id,
          tokenHash: hashSecret(token),
          role: 'THEKEDAR',
          name: owner.name,
          phone: owner.phone,
          email: owner.email ?? null,
          status: 'PENDING',
          expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY),
        },
      });

      await auditAdmin(tx, {
        tenantId: tenant.id,
        action: 'admin.tenant_created',
        entityType: 'Tenant',
        entityId: tenant.id,
        details: { mode: subInput.mode, plan: plan.code, receiptNo, ...(input.note ? { note: input.note } : {}) },
      });
      return { tenant, plan, invitation, receiptNo };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = JSON.stringify(err.meta ?? {});
      if (target.includes('slug')) throw new Conflict('SLUG_TAKEN', 'This slug is already used by another company');
      if (target.includes('transactionId')) throw new Conflict('DUPLICATE_TRANSACTION', 'This transaction ID has already been used');
    }
    throw err;
  }

  const { tenant, plan, invitation, receiptNo } = created;
  // The owner gets the link by SMS and, when an email is known, by email too.
  await deliverInvite({
    phone: owner.phone,
    email: owner.email ?? company.email ?? null,
    name: owner.name,
    companyName: tenant.name,
    role: 'THEKEDAR',
    token,
    newCompany: true,
  });

  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    subscription: {
      status: tenant.subscription!.status,
      plan: { code: plan.code, name: plan.name },
      trialEndsAt: tenant.subscription!.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: tenant.subscription!.currentPeriodEnd?.toISOString() ?? null,
      receiptNo,
    },
    owner: {
      name: owner.name,
      phone: owner.phone,
      invitation: {
        id: invitation.id,
        status: invitation.status,
        expiresAt: invitation.expiresAt.toISOString(),
        ...(isProduction ? {} : { devInviteUrl: inviteUrl(token) }),
      },
    },
  };
}

// ─── Status actions ─────────────────────────────────────────────────────────

/** EXTEND_TRIAL / SET_READ_ONLY / REACTIVATE / SUSPEND / CLOSE. */
export async function changeTenantStatus(id: string, input: TenantStatusInput) {
  const now = new Date();
  const result = await prismaAdmin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${id}`}))`;
    const tenant = await tx.tenant.findUnique({ where: { id }, include: { subscription: true } });
    if (!tenant) throw notFound();
    const sub = tenant.subscription;
    const from = { tenantStatus: tenant.status, subscriptionStatus: sub?.status ?? null };
    let sessionsRevoked = 0;

    switch (input.action) {
      case 'EXTEND_TRIAL': {
        // Only a trial, or a trial that already lapsed (never paid).
        const trialLapsed = sub?.status === 'LAPSED' && sub.trialEndsAt && !sub.currentPeriodEnd;
        if (!sub || (sub.status !== 'TRIAL' && !trialLapsed)) {
          throw new Conflict('CANNOT_EXTEND_TRIAL', 'Only a trial (or a lapsed trial) can be extended');
        }
        const base = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
        await tx.subscription.update({
          where: { id: sub.id },
          data: { status: 'TRIAL', trialEndsAt: new Date(base.getTime() + input.days! * DAY), lastReminderSentAt: null },
        });
        await syncTenantStatus(tx, id, 'TRIAL');
        break;
      }
      case 'SET_READ_ONLY':
        if (tenant.status === 'CLOSED') throw new Conflict('TENANT_CLOSED', 'This company is closed. Reactivate it first.');
        await tx.tenant.update({ where: { id }, data: { status: 'READ_ONLY' } });
        break;
      case 'REACTIVATE': {
        const target: TenantStatus = sub ? tenantStatusFor(sub.status) : 'ACTIVE';
        await tx.tenant.update({ where: { id }, data: { status: target } });
        break;
      }
      case 'SUSPEND':
      case 'CLOSE': {
        await tx.tenant.update({ where: { id }, data: { status: input.action === 'SUSPEND' ? 'SUSPENDED' : 'CLOSED' } });
        // Sign everybody out right away.
        sessionsRevoked = (await tx.session.updateMany({ where: { tenantId: id, revokedAt: null }, data: { revokedAt: now } })).count;
        break;
      }
    }

    const after = await tx.tenant.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
    await auditAdmin(tx, {
      tenantId: id,
      action: 'admin.tenant_status',
      entityType: 'Tenant',
      entityId: id,
      details: {
        action: input.action,
        from,
        to: { tenantStatus: after.status, subscriptionStatus: after.subscription?.status ?? null },
        ...(input.days ? { days: input.days } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(sessionsRevoked ? { sessionsRevoked } : {}),
      },
    });
    return after;
  });
  invalidateTenantStatus(id);
  return {
    id,
    tenantStatus: result.status,
    subscriptionStatus: result.subscription?.status ?? null,
    trialEndsAt: result.subscription?.trialEndsAt?.toISOString() ?? null,
  };
}

// ─── Plan change ────────────────────────────────────────────────────────────

/**
 * IMMEDIATE: switches now (the company must fit — same checks and codes as the company
 * side; projects outside keepActiveProjectIds become READ_ONLY).
 * NEXT_RENEWAL: scheduled for the end of the paid period, or on the next approved
 * payment when no paid period is running.
 */
export async function changeTenantPlan(id: string, input: TenantPlanInput) {
  return prismaAdmin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${id}`}))`;
    const sub = await tx.subscription.findUnique({ where: { tenantId: id }, include: { plan: true } });
    if (!sub) throw notFound();
    const target: Plan | null = await tx.plan.findFirst({ where: { id: input.planId, isActive: true, code: { not: 'TRIAL' } } });
    if (!target) throw new BadRequest('INVALID_PLAN', 'Choose an active paid plan');
    if (target.id === sub.planId) throw new BadRequest('SAME_PLAN', 'The company is already on this plan');

    const keep = await assertPlanFits(tx, id, target, input.keepActiveProjectIds ?? []);
    let parked: string[] = [];
    let effectiveOn: Date | null = null;

    if (input.effective === 'IMMEDIATE') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { planId: target.id, pendingPlanId: null, pendingEffectiveOn: null, keepActiveProjectIds: [] },
      });
      parked = await parkProjectsOverLimit(tx, id, target, keep);
    } else {
      const now = new Date();
      effectiveOn = sub.status === 'ACTIVE' && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : null;
      await tx.subscription.update({
        where: { id: sub.id },
        data: { pendingPlanId: target.id, pendingEffectiveOn: effectiveOn, keepActiveProjectIds: keep },
      });
    }

    await auditAdmin(tx, {
      tenantId: id,
      action: 'admin.plan_changed',
      entityType: 'Subscription',
      entityId: sub.id,
      details: {
        from: sub.plan.code,
        to: target.code,
        effective: input.effective,
        effectiveOn: effectiveOn?.toISOString() ?? null,
        projectsReadOnly: parked,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    return {
      tenantId: id,
      effective: input.effective,
      plan: { code: (input.effective === 'IMMEDIATE' ? target : sub.plan).code },
      pendingPlan: input.effective === 'NEXT_RENEWAL' ? { code: target.code, effectiveOn: effectiveOn?.toISOString() ?? null } : null,
      projectsReadOnly: parked,
    };
  });
}
