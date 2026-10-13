import { defaultRoleId } from '../permissions/provision.js';
import { assertAssignableRole } from '../permissions/permissions.service.js';
import { FINANCIAL_BUNDLE } from '../../core/auth/permissionCatalog.js';
import { accessOf, can } from '../../core/auth/access.js';
import { isProduction } from '../../config/env.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound, TooManyRequests } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { assertWithinLimit, lockPlanUsage } from '../../core/plan/planLimits.js';
import { hashSecret, randomToken } from '../../core/utils/crypto.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { deliverInvite, inviteUrl } from '../auth/inviteMessages.js';
import * as repo from './team.repository.js';
import type { CreateInvitationInput, InvitationDto, InvitationSentDto, ListInvitationsQuery } from './team.schema.js';

export const INVITE_TTL_DAYS = 7;
export const INVITE_RESEND_SECONDS = 60;


function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

const notFound = () => new NotFound('INVITE_NOT_FOUND', 'Invitation not found');

function newToken() {
  const token = randomToken(32);
  return { token, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) };
}

/** The one-time link by SMS, and by email when the invite has one. The token is never logged or stored in plain text. */
async function sendInvite(
  invitation: { tenantId: string; phone: string; email: string | null; name: string; role: UserRole },
  companyName: string,
  token: string,
): Promise<void> {
  // Best effort: the invitation stays valid; the THEKEDAR can resend.
  await deliverInvite({ ...invitation, companyName, token });
}

function sentDto(row: { id: string; status: InvitationSentDto['status']; expiresAt: Date }, token: string): InvitationSentDto {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    // The inviter may share the link themselves (WhatsApp / SMS / copy) when the SMS is slow.
    inviteUrl: inviteUrl(token),
    ...(isProduction ? {} : { devInviteUrl: inviteUrl(token) }),
  };
}

async function validProjectIds(tx: Tx, ids: string[] | undefined): Promise<string[]> {
  if (!ids?.length) return [];
  const projects = await repo.findProjects(tx, ids);
  const found = new Set(projects.map((p) => p.id));
  const invalidIds = ids.filter((id) => !found.has(id));
  if (invalidIds.length) throw new BadRequest('INVALID_PROJECT', 'Some projects do not exist in this company', { invalidIds });
  return ids;
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function listInvitations(query: ListInvitationsQuery) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    await repo.expireOverdueInvitations(tx, new Date());
    const { skip, take } = skipTake(query);
    const rows = await repo.listInvitations(tx, query.status, skip, take);
    const total = await repo.countInvitations(tx, query.status);
    const projects = await repo.findProjects(tx, [...new Set(rows.flatMap((r) => r.projectIds))]);
    const byId = new Map(projects.map((p) => [p.id, p]));

    const data: InvitationDto[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      role: r.role as InvitationDto['role'],
      canSeeFinancials: r.canSeeFinancials,
      roleId: r.roleId,
      projects: r.projectIds.map((id) => byId.get(id)).filter((p): p is { id: string; name: string } => Boolean(p)),
      status: r.status,
      expiresAt: r.expiresAt.toISOString(),
      lastResentAt: r.lastResentAt?.toISOString() ?? null,
      invitedBy: r.invitedBy,
      createdAt: r.createdAt.toISOString(),
    }));
    return { data, meta: pageMeta(query, total) };
  });
}

// ─── Commands ───────────────────────────────────────────────────────────────

export async function createInvitation(input: CreateInvitationInput): Promise<InvitationSentDto> {
  const { tenantId, userId } = current();
  const { token, tokenHash, expiresAt } = newToken();

  const { invitation, companyName } = await withTenant(tenantId, async (tx) => {
    await lockPlanUsage(tx, tenantId);
    const now = new Date();
    if (await repo.findUserByPhone(tx, input.phone)) {
      throw new Conflict('ALREADY_MEMBER', 'This phone number already belongs to a member of your company');
    }
    if (await repo.findOpenInvitationForPhone(tx, input.phone, now)) {
      throw new Conflict('INVITE_PENDING', 'This person already has a pending invitation. Resend it instead.');
    }
    if (input.email && (await repo.findUserByEmail(tx, input.email))) {
      throw new Conflict('EMAIL_TAKEN', 'This email already belongs to a member of your company');
    }
    const projectIds = await validProjectIds(tx, input.projectIds);
    if (input.role === 'PM') await assertWithinLimit(tx, tenantId, 'officeUsers');

    const settings = await repo.findSettings(tx, tenantId);
    const canSeeFinancials = input.role === 'PM' ? (input.canSeeFinancials ?? settings?.pmCanSeeFinancials ?? false) : false;
    // The permission role given on accept: the chosen one (fits the account, within the inviter's
    // own permissions) or the system template of the invited role.
    const manager = { tenantId, userId, access: accessOf() };
    if (input.roleId) await assertAssignableRole(tx, manager, input.roleId, input.role);
    if (canSeeFinancials && input.canSeeFinancials && !manager.access.owner) {
      for (const k of FINANCIAL_BUNDLE) if (!can(k)) throw new Forbidden('GRANT_EXCEEDS_OWN', 'You can only give permissions you have yourself', { permission: k });
    }
    const roleId = input.roleId ?? (await defaultRoleId(tx, tenantId, input.role));

    const created = await repo.createInvitation(tx, {
      tenantId,
      tokenHash,
      role: input.role,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      canSeeFinancials,
      roleId,
      projectIds,
      status: 'PENDING',
      expiresAt,
      invitedById: userId,
    });
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'invite.create',
      entityType: 'Invitation',
      entityId: created.id,
      details: { role: input.role, roleId, projects: projectIds.length, canSeeFinancials },
    });
    const tenant = await repo.findTenantName(tx, tenantId);
    return { invitation: created, companyName: tenant?.name ?? 'Your company' };
  });

  await sendInvite(invitation, companyName, token);
  return sentDto(invitation, token);
}

export async function resendInvitation(id: string): Promise<InvitationSentDto> {
  const { tenantId, userId } = current();
  const { token, tokenHash, expiresAt } = newToken();

  const { invitation, companyName } = await withTenant(tenantId, async (tx) => {
    await lockPlanUsage(tx, tenantId);
    const existing = await repo.findInvitation(tx, id);
    if (!existing) throw notFound();
    if (existing.status === 'ACCEPTED') throw new Conflict('INVITE_ALREADY_ACCEPTED', 'This invitation has already been accepted');
    if (existing.status === 'CANCELLED') throw new Conflict('INVITE_CANCELLED', 'This invitation was cancelled. Create a new one.');

    const now = new Date();
    const lastSent = existing.lastResentAt ?? existing.createdAt;
    const waited = (now.getTime() - lastSent.getTime()) / 1000;
    if (waited < INVITE_RESEND_SECONDS) {
      const retryAfterSeconds = Math.ceil(INVITE_RESEND_SECONDS - waited);
      throw new TooManyRequests('INVITE_RESEND_WAIT', `Please wait ${retryAfterSeconds} seconds before resending`, { retryAfterSeconds });
    }
    if (await repo.findUserByPhone(tx, existing.phone)) {
      throw new Conflict('ALREADY_MEMBER', 'This phone number already belongs to a member of your company');
    }
    if (await repo.findOpenInvitationForPhone(tx, existing.phone, now, id)) {
      throw new Conflict('INVITE_PENDING', 'A newer invitation for this phone is still pending. Resend that one instead.');
    }
    const wasExpired = existing.status === 'EXPIRED' || existing.expiresAt <= now;
    if (wasExpired && existing.role === 'PM') {
      // An expired invite no longer holds a seat, so reviving it needs one.
      await assertWithinLimit(tx, tenantId, 'officeUsers');
    }

    // A new token invalidates the old link.
    const updated = await repo.updateInvitation(tx, id, { tokenHash, expiresAt, status: 'PENDING', lastResentAt: now });
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'invite.resend',
      entityType: 'Invitation',
      entityId: id,
      details: { wasExpired },
    });
    const tenant = await repo.findTenantName(tx, tenantId);
    return { invitation: updated, companyName: tenant?.name ?? 'Your company' };
  });

  await sendInvite(invitation, companyName, token);
  return sentDto(invitation, token);
}

export async function cancelInvitation(id: string): Promise<{ id: string; status: 'CANCELLED' }> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    // Same lock as invite acceptance, so a cancel can never overwrite a just-accepted invite.
    await lockPlanUsage(tx, tenantId);
    const existing = await repo.findInvitation(tx, id);
    if (!existing) throw notFound();
    if (existing.status === 'ACCEPTED') throw new Conflict('INVITE_ALREADY_ACCEPTED', 'This invitation has already been accepted');
    if (existing.status === 'CANCELLED') throw new Conflict('INVITE_CANCELLED', 'This invitation is already cancelled');

    if (!(await repo.cancelOpenInvitation(tx, id))) {
      throw new Conflict('INVITE_ALREADY_ACCEPTED', 'This invitation was accepted a moment ago');
    }
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'invite.cancel',
      entityType: 'Invitation',
      entityId: id,
    });
    return { id, status: 'CANCELLED' as const };
  });
}
