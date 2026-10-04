import type { Tx } from '../db/withTenant.js';
import type { ProjectStatus } from '../../generated/prisma/enums.js';
import { PlanLimit } from '../errors/AppError.js';

/**
 * Plan limits shared by every module that creates something the plan counts.
 *
 *   activeProjects – projects with status ACTIVE or CLOSEOUT (DRAFT, handed-over, closed
 *                    and READ_ONLY projects are free)
 *   officeUsers    – active THEKEDAR + PM, plus pending (unexpired) PM invitations,
 *                    which reserve a seat. MUNSHI users and invites never count.
 *
 * Every count filters by tenantId explicitly, so these work both inside `withTenant`
 * (RLS) and with the platform-admin client (BYPASSRLS). Callers that check-then-create
 * should hold `lockPlanUsage` for the same transaction.
 */
export type LimitedResource = 'activeProjects' | 'officeUsers';

/** Project statuses that count against `maxActiveProjects`. */
export const PLAN_COUNTED_PROJECT_STATUSES = ['ACTIVE', 'CLOSEOUT'] as const satisfies ProjectStatus[];

export interface Usage {
  activeProjects: number;
  officeUsers: number;
}

export interface Limits {
  /** null = unlimited */
  activeProjects: number | null;
  officeUsers: number | null;
}

/** Serialises check-then-create for plan-counted resources in one company. */
export async function lockPlanUsage(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`office-seats:${tenantId}`}))`;
}

async function activeOfficeUsers(tx: Tx, tenantId: string): Promise<number> {
  return tx.user.count({ where: { tenantId, status: 'ACTIVE', role: { in: ['THEKEDAR', 'PM'] } } });
}

async function pendingPmInvites(tx: Tx, tenantId: string, now: Date): Promise<number> {
  return tx.invitation.count({ where: { tenantId, role: 'PM', status: 'PENDING', expiresAt: { gt: now } } });
}

export async function getUsage(tx: Tx, tenantId: string, now = new Date()): Promise<Usage> {
  const activeProjects = await tx.project.count({ where: { tenantId, status: { in: [...PLAN_COUNTED_PROJECT_STATUSES] } } });
  const officeUsers = (await activeOfficeUsers(tx, tenantId)) + (await pendingPmInvites(tx, tenantId, now));
  return { activeProjects, officeUsers };
}

export async function getLimits(tx: Tx, tenantId: string): Promise<Limits> {
  const sub = await tx.subscription.findUnique({
    where: { tenantId },
    select: { plan: { select: { maxActiveProjects: true, maxOfficeUsers: true } } },
  });
  return { activeProjects: sub?.plan.maxActiveProjects ?? null, officeUsers: sub?.plan.maxOfficeUsers ?? null };
}

/**
 * Throws 402 PLAN_LIMIT_REACHED `{ limit, used }` when adding `adding` more would exceed
 * the plan.
 *
 * `countPendingInvites: false` is for accepting an invitation: that invite already holds
 * its reserved seat, so only seats taken by real users are compared.
 */
export async function assertWithinLimit(
  tx: Tx,
  tenantId: string,
  resource: LimitedResource,
  adding = 1,
  options: { countPendingInvites?: boolean } = {},
): Promise<void> {
  const limit = (await getLimits(tx, tenantId))[resource];
  if (limit === null) return;

  let used: number;
  if (resource === 'officeUsers') {
    used = await activeOfficeUsers(tx, tenantId);
    if (options.countPendingInvites !== false) used += await pendingPmInvites(tx, tenantId, new Date());
  } else {
    used = (await getUsage(tx, tenantId)).activeProjects;
  }

  if (used + adding > limit) {
    const what = resource === 'officeUsers' ? 'office users (THEKEDAR + PM)' : 'active projects';
    throw new PlanLimit('PLAN_LIMIT_REACHED', `Your plan allows ${limit} ${what}. Upgrade to add more.`, {
      resource,
      limit,
      used,
    });
  }
}
