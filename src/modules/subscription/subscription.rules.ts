/**
 * Plan-change rules shared by the company side (change-plan), the platform admin console
 * (immediate plan changes, payment approval) and the lifecycle job (scheduled downgrades).
 * All queries filter by tenantId explicitly, so they are correct under RLS (withTenant)
 * and under the platform-admin client.
 */
import type { Plan, Prisma } from '../../generated/prisma/client.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { getUsage, PLAN_COUNTED_PROJECT_STATUSES } from '../../core/plan/planLimits.js';

type Tx = Prisma.TransactionClient;
type PlanLimits = Pick<Plan, 'name' | 'maxActiveProjects' | 'maxOfficeUsers'>;

/**
 * Throws unless the company fits `target` right now. When it has more active projects
 * than the plan allows, `keepActiveProjectIds` must name which ones stay active.
 * Returns the validated keep list ([] when not needed).
 *
 * Errors: 400 DOWNGRADE_USERS_OVER_LIMIT, KEEP_PROJECTS_REQUIRED, TOO_MANY_PROJECTS, INVALID_PROJECT.
 */
export async function assertPlanFits(
  tx: Tx,
  tenantId: string,
  target: PlanLimits,
  keepActiveProjectIds: string[] = [],
): Promise<string[]> {
  const usage = await getUsage(tx, tenantId);

  if (target.maxOfficeUsers !== null && usage.officeUsers > target.maxOfficeUsers) {
    throw new BadRequest(
      'DOWNGRADE_USERS_OVER_LIMIT',
      `${target.name} allows ${target.maxOfficeUsers} office users; the company has ${usage.officeUsers}. Deactivate users or cancel PM invites first.`,
      { officeUsers: usage.officeUsers, limit: target.maxOfficeUsers },
    );
  }

  if (target.maxActiveProjects === null || usage.activeProjects <= target.maxActiveProjects) return [];

  const requested = [...new Set(keepActiveProjectIds)];
  if (!requested.length) {
    throw new BadRequest(
      'KEEP_PROJECTS_REQUIRED',
      `${target.name} allows ${target.maxActiveProjects} active projects; the company has ${usage.activeProjects}. Choose which to keep active (keepActiveProjectIds).`,
      { activeProjects: usage.activeProjects, limit: target.maxActiveProjects },
    );
  }
  if (requested.length > target.maxActiveProjects) {
    throw new BadRequest('TOO_MANY_PROJECTS', `Keep at most ${target.maxActiveProjects} projects active`, {
      limit: target.maxActiveProjects,
    });
  }
  const found = await tx.project.findMany({
    where: { tenantId, id: { in: requested }, status: { in: [...PLAN_COUNTED_PROJECT_STATUSES] } },
    select: { id: true },
  });
  const ok = new Set(found.map((p) => p.id));
  const invalidIds = requested.filter((id) => !ok.has(id));
  if (invalidIds.length) throw new BadRequest('INVALID_PROJECT', 'Some ids are not active projects of this company', { invalidIds });
  return requested;
}

/**
 * Puts ACTIVE / CLOSEOUT projects above `target.maxActiveProjects` into READ_ONLY, keeping
 * `keepActiveProjectIds` (or, if that list is empty/stale, the most recently used ones).
 * Returns the ids that were parked.
 */
export async function parkProjectsOverLimit(
  tx: Tx,
  tenantId: string,
  target: Pick<Plan, 'maxActiveProjects'>,
  keepActiveProjectIds: string[],
): Promise<string[]> {
  if (target.maxActiveProjects === null) return [];
  const active = await tx.project.findMany({
    where: { tenantId, status: { in: [...PLAN_COUNTED_PROJECT_STATUSES] } },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (active.length <= target.maxActiveProjects) return [];

  const chosen = keepActiveProjectIds.filter((id) => active.some((p) => p.id === id));
  const keep = new Set(
    chosen.length ? chosen.slice(0, target.maxActiveProjects) : active.slice(0, target.maxActiveProjects).map((p) => p.id),
  );
  const parked = active.map((p) => p.id).filter((id) => !keep.has(id));
  await tx.project.updateMany({ where: { tenantId, id: { in: parked } }, data: { status: 'READ_ONLY' } });
  return parked;
}
