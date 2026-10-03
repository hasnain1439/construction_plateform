import { env, isProduction } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound, TooManyRequests } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { hashSecret, randomToken } from '../../core/utils/crypto.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { smsProvider } from '../auth/sms.provider.js';
import * as repo from './team.repository.js';
import type { CreateInvitationInput, InvitationDto, InvitationSentDto, ListInvitationsQuery } from './team.schema.js';
import { assertOfficeSeat } from './users.service.js';

export const INVITE_TTL_DAYS = 7;
export const INVITE_RESEND_SECONDS = 60;

const ROLE_LABEL: Record<UserRole, string> = { THEKEDAR: 'Thekedar', PM: 'Project Manager', MUNSHI: 'Munshi' };

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

const notFound = () => new NotFound('INVITE_NOT_FOUND', 'Invitation not found');

function newToken() {
  const token = randomToken(32);
  return { token, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) };
}

function inviteUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/invite/${token}`;
}

/** Roman Urdu SMS with the one-time link. The token is never logged or stored in plain text. */
async function sendInviteSms(phone: string, companyName: string, role: UserRole, token: string): Promise<void> {
  try {
    await smsProvider().send({
      to: phone,
      body: `${companyName} ne aap ko ${ROLE_LABEL[role]} ke taur par invite kiya hai: ${inviteUrl(token)}`,
    });
  } catch (err) {
    // The invitation stays valid; the THEKEDAR can resend.
    logger.error({ err, phone: maskPhone(phone) }, 'invitation sms failed');
  }
}

function sentDto(row: { id: string; status: InvitationSentDto['status']; expiresAt: Date }, token: string): InvitationSentDto {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
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
    await repo.lockOfficeSeats(tx, tenantId);
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
    if (input.role === 'PM') await assertOfficeSeat(tx, tenantId, { countPendingInvites: true });

    const settings = await repo.findSettings(tx, tenantId);
    const canSeeFinancials = input.role === 'PM' ? (input.canSeeFinancials ?? settings?.pmCanSeeFinancials ?? false) : false;

    const created = await repo.createInvitation(tx, {
      tenantId,
      tokenHash,
      role: input.role,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      canSeeFinancials,
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
      details: { role: input.role, projects: projectIds.length, canSeeFinancials },
    });
    const tenant = await repo.findTenantName(tx, tenantId);
    return { invitation: created, companyName: tenant?.name ?? 'Your company' };
  });

  await sendInviteSms(invitation.phone, companyName, invitation.role, token);
  return sentDto(invitation, token);
}

export async function resendInvitation(id: string): Promise<InvitationSentDto> {
  const { tenantId, userId } = current();
  const { token, tokenHash, expiresAt } = newToken();

  const { invitation, companyName } = await withTenant(tenantId, async (tx) => {
    await repo.lockOfficeSeats(tx, tenantId);
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
      await assertOfficeSeat(tx, tenantId, { countPendingInvites: true, excludeInvitationId: id });
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

  await sendInviteSms(invitation.phone, companyName, invitation.role, token);
  return sentDto(invitation, token);
}

export async function cancelInvitation(id: string): Promise<{ id: string; status: 'CANCELLED' }> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    // Same lock as invite acceptance, so a cancel can never overwrite a just-accepted invite.
    await repo.lockOfficeSeats(tx, tenantId);
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
