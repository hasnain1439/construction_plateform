import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound, PlanLimit } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import * as repo from './team.repository.js';
import type { ListUsersQuery, SetUserProjectsInput, TeamUserDto, UpdateUserInput, UserDetailDto } from './team.schema.js';

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId!, role: ctx.role, sessionId: ctx.sessionId };
}

const userNotFound = () => new NotFound('USER_NOT_FOUND', 'User not found');

/**
 * Throws 402 when one more office user (THEKEDAR/PM) would exceed the plan.
 * Call inside a transaction after `lockOfficeSeats`.
 */
export async function assertOfficeSeat(
  tx: Tx,
  tenantId: string,
  options: { countPendingInvites: boolean; excludeInvitationId?: string },
): Promise<void> {
  const max = await repo.maxOfficeUsers(tx, tenantId);
  if (max === null) return;
  let used = await repo.countActiveOfficeUsers(tx);
  if (options.countPendingInvites) used += await repo.countPendingPmInvites(tx, new Date(), options.excludeInvitationId);
  if (used >= max) {
    throw new PlanLimit('PLAN_LIMIT_REACHED', `Your plan allows ${max} office users (THEKEDAR + PM). Upgrade to add more.`, {
      limit: max,
      used,
    });
  }
}

/**
 * Hook for the cash module: a user holding company cash (petty cash / advances) must
 * settle it before being deactivated.
 * TODO(cash module): throw new Conflict('CASH_BALANCE_OPEN', …) when the balance ≠ 0.
 */
export async function assertNoOpenCashBalance(_tx: Tx, _userId: string): Promise<void> {
  return;
}

function toListDto(u: repo.UserListRow, includeFinancials: boolean): TeamUserDto {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    status: u.status,
    ...(includeFinancials ? { canSeeFinancials: u.canSeeFinancials } : {}),
    allProjects: u.role === 'THEKEDAR',
    projects: u.projectAccess.map((a) => a.project).sort((a, b) => a.name.localeCompare(b.name)),
    lastActiveAt: (u.devices[0]?.lastActiveAt ?? u.lastLoginAt)?.toISOString() ?? null,
  };
}

async function loadDetail(tx: Tx, id: string): Promise<UserDetailDto> {
  const user = await repo.findUser(tx, id);
  if (!user) throw userNotFound();
  return {
    ...toListDto(user, true),
    canSeeFinancials: user.canSeeFinancials,
    language: user.language,
    activeDeviceCount: await repo.countActiveDevices(tx, id),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function listUsers(query: ListUsersQuery) {
  const { tenantId, role } = current();
  return withTenant(tenantId, async (tx) => {
    const where = repo.userWhere(query);
    const { skip, take } = skipTake(query);
    const rows = await repo.listUsers(tx, where, skip, take);
    const total = await repo.countUsers(tx, where);
    const usage = { officeUsers: await repo.countActiveOfficeUsers(tx), maxOfficeUsers: await repo.maxOfficeUsers(tx, tenantId) };
    const includeFinancials = role === 'THEKEDAR';
    return { data: rows.map((u) => toListDto(u, includeFinancials)), meta: { ...pageMeta(query, total), usage } };
  });
}

export async function getUser(id: string): Promise<UserDetailDto> {
  return withTenant(current().tenantId, (tx) => loadDetail(tx, id));
}

// ─── Changes ────────────────────────────────────────────────────────────────

export async function updateUser(id: string, input: UpdateUserInput): Promise<UserDetailDto> {
  const me = current();
  return withTenant(me.tenantId, async (tx) => {
    await repo.lockOfficeSeats(tx, me.tenantId);
    const target = await repo.findUser(tx, id);
    if (!target) throw userNotFound();

    if (input.role !== undefined && input.role !== target.role) {
      if (target.id === me.userId) throw new Forbidden('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
      if (target.role === 'THEKEDAR') throw new Forbidden('CANNOT_CHANGE_OWNER_ROLE', "An owner's role cannot be changed");
    }
    const newRole = input.role ?? target.role;
    if (input.canSeeFinancials !== undefined && newRole !== 'PM') {
      throw new BadRequest('FINANCIALS_PM_ONLY', 'canSeeFinancials can only be set for a PM');
    }
    if (target.role === 'MUNSHI' && newRole === 'PM' && target.status === 'ACTIVE') {
      await assertOfficeSeat(tx, me.tenantId, { countPendingInvites: true });
    }
    if (input.phone && input.phone !== target.phone && (await repo.phoneTakenByOther(tx, input.phone, id))) {
      throw new Conflict('PHONE_TAKEN', 'Another user in this company already uses this phone number');
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const data: Record<string, unknown> = {};
    const set = (field: 'name' | 'phone' | 'role' | 'canSeeFinancials', value: unknown) => {
      if (value === undefined || value === target[field]) return;
      changes[field] = { from: target[field], to: value };
      data[field] = value;
    };
    set('name', input.name);
    set('phone', input.phone);
    set('role', input.role);
    // A Munshi never sees financials; a role change to MUNSHI clears the flag.
    set('canSeeFinancials', newRole === 'MUNSHI' ? false : input.canSeeFinancials);

    if (Object.keys(data).length) {
      await repo.updateUser(tx, id, data).catch((err: unknown) => {
        // A concurrent edit took the phone between our check and the update.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new Conflict('PHONE_TAKEN', 'Another user in this company already uses this phone number');
        }
        throw err;
      });
      await writeAudit(tx, {
        tenantId: me.tenantId,
        actorType: 'USER',
        actorId: me.userId,
        action: 'user.update',
        entityType: 'User',
        entityId: id,
        details: { changes: changes as Prisma.InputJsonObject },
      });
    }
    return loadDetail(tx, id);
  });
}

export async function deactivateUser(id: string): Promise<UserDetailDto> {
  const me = current();
  if (id === me.userId) throw new Forbidden('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
  return withTenant(me.tenantId, async (tx) => {
    // Serialised so two owners deactivating each other at once can't leave zero owners.
    await repo.lockOfficeSeats(tx, me.tenantId);
    const target = await repo.findUser(tx, id);
    if (!target) throw userNotFound();
    if (target.status === 'INACTIVE') return loadDetail(tx, id);
    if (target.role === 'THEKEDAR' && (await repo.countActiveThekedars(tx)) <= 1) {
      throw new Forbidden('LAST_THEKEDAR', 'The company must keep at least one active THEKEDAR');
    }
    await assertNoOpenCashBalance(tx, id);

    const now = new Date();
    await repo.updateUser(tx, id, { status: 'INACTIVE', deactivatedAt: now });
    const sessions = await repo.revokeUserSessions(tx, id, now);
    const devices = await repo.revokeUserDevices(tx, id, now);
    await writeAudit(tx, {
      tenantId: me.tenantId,
      actorType: 'USER',
      actorId: me.userId,
      action: 'user.deactivate',
      entityType: 'User',
      entityId: id,
      details: { sessionsRevoked: sessions.count, devicesRevoked: devices.count },
    });
    return loadDetail(tx, id);
  });
}

export async function reactivateUser(id: string): Promise<UserDetailDto> {
  const me = current();
  return withTenant(me.tenantId, async (tx) => {
    await repo.lockOfficeSeats(tx, me.tenantId);
    const target = await repo.findUser(tx, id);
    if (!target) throw userNotFound();
    if (target.status === 'ACTIVE') throw new Conflict('USER_ALREADY_ACTIVE', 'This user is already active');
    if (target.role !== 'MUNSHI') await assertOfficeSeat(tx, me.tenantId, { countPendingInvites: true });

    await repo.updateUser(tx, id, { status: 'ACTIVE', deactivatedAt: null, failedLoginCount: 0, lockedUntil: null });
    await writeAudit(tx, {
      tenantId: me.tenantId,
      actorType: 'USER',
      actorId: me.userId,
      action: 'user.reactivate',
      entityType: 'User',
      entityId: id,
    });
    return loadDetail(tx, id);
  });
}

export async function setUserProjects(id: string, input: SetUserProjectsInput) {
  const me = current();
  return withTenant(me.tenantId, async (tx) => {
    const target = await repo.findUser(tx, id);
    if (!target) throw userNotFound();
    if (target.role === 'THEKEDAR') {
      throw new BadRequest('THEKEDAR_HAS_ALL_PROJECTS', 'A THEKEDAR already works on every project');
    }
    const projects = await repo.findProjects(tx, input.projectIds);
    const found = new Set(projects.map((p) => p.id));
    const invalidIds = input.projectIds.filter((pid) => !found.has(pid));
    if (invalidIds.length) throw new BadRequest('INVALID_PROJECT', 'Some projects do not exist in this company', { invalidIds });

    const before = await repo.userProjectIds(tx, id);
    await repo.replaceUserProjects(tx, me.tenantId, id, input.projectIds);
    await writeAudit(tx, {
      tenantId: me.tenantId,
      actorType: 'USER',
      actorId: me.userId,
      action: 'user.projects_update',
      entityType: 'User',
      entityId: id,
      details: { before, after: input.projectIds },
    });
    return { userId: id, projects };
  });
}
