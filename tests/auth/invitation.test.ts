import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { hashSecret } from '../../src/core/utils/crypto.js';
import { api, device, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const accept = (token: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', device: device(), ...body });

async function createInvite(data: {
  tenantId: string;
  token: string;
  role: 'PM' | 'MUNSHI';
  phone: string;
  expiresAt?: Date;
  status?: 'PENDING' | 'CANCELLED';
  projectIds?: string[];
}) {
  return prismaAdmin.invitation.create({
    data: {
      tenantId: data.tenantId,
      tokenHash: hashSecret(data.token),
      role: data.role,
      name: 'Invited Person',
      phone: data.phone,
      projectIds: data.projectIds ?? [],
      status: data.status ?? 'PENDING',
      expiresAt: data.expiresAt ?? new Date(Date.now() + 86_400_000),
    },
  });
}

describe('POST /invitations/:token/accept', () => {
  it('creates the user with project access, marks the invite accepted and signs in', async () => {
    const res = await accept(SEED.invitation.token, { password: 'Kamran#2026' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ name: 'Kamran Shah', phone: SEED.invitation.phone, role: 'PM', canSeeFinancials: false });
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    const userId = res.body.data.user.id as string;
    const access = await prismaAdmin.userProjectAccess.findMany({ where: { userId } });
    expect(access.map((a) => a.projectId)).toEqual([seeded().projects.dha.id]);

    const invite = await prismaAdmin.invitation.findUniqueOrThrow({ where: { tokenHash: hashSecret(SEED.invitation.token) } });
    expect(invite.status).toBe('ACCEPTED');
    expect(invite.acceptedUserId).toBe(userId);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'invite.accept' } })).toBe(1);

    const twice = await accept(SEED.invitation.token, { password: 'Kamran#2026' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
  });

  it('drops project ids that belong to another company', async () => {
    const { malik, projects } = seeded();
    await createInvite({
      tenantId: malik.id,
      token: 'cross-tenant-projects-token-0001',
      role: 'MUNSHI',
      phone: '+923451230000',
      projectIds: [projects.bahria.id, projects.ahmedProject.id],
    });
    const res = await accept('cross-tenant-projects-token-0001', {});
    expect(res.status).toBe(201);
    const access = await prismaAdmin.userProjectAccess.findMany({ where: { userId: res.body.data.user.id } });
    expect(access.map((a) => a.projectId)).toEqual([projects.bahria.id]);
  });

  it('PM must set a password; MUNSHI may not', async () => {
    const noPassword = await accept(SEED.invitation.token, {});
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error.details.fields[0].field).toBe('password');
  });

  it('expired → 410 INVITE_EXPIRED, cancelled → 410 INVITE_CANCELLED, unknown → 404', async () => {
    const { malik } = seeded();
    await createInvite({ tenantId: malik.id, token: 'expired-invite-token-0001', role: 'PM', phone: '+923450000001', expiresAt: new Date(Date.now() - 1000) });
    await createInvite({ tenantId: malik.id, token: 'cancelled-invite-token-0001', role: 'PM', phone: '+923450000002', status: 'CANCELLED' });

    const expired = await accept('expired-invite-token-0001', { password: 'Valid#2026' });
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('INVITE_EXPIRED');
    const row = await prismaAdmin.invitation.findUniqueOrThrow({ where: { tokenHash: hashSecret('expired-invite-token-0001') } });
    expect(row.status).toBe('EXPIRED');

    const cancelled = await accept('cancelled-invite-token-0001', { password: 'Valid#2026' });
    expect(cancelled.status).toBe(410);
    expect(cancelled.body.error.code).toBe('INVITE_CANCELLED');

    const unknown = await accept('no-such-invite-token-000000', { password: 'Valid#2026' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('INVITE_NOT_FOUND');
  });

  it('PM over the plan office-user limit → 402; MUNSHI is not counted', async () => {
    const { ahmed } = seeded(); // Starter: 3 office users, has 1 (owner)
    await prismaAdmin.user.createMany({
      data: [
        { tenantId: ahmed.id, name: 'PM One', phone: '+923450000011', role: 'PM' },
        { tenantId: ahmed.id, name: 'PM Two', phone: '+923450000012', role: 'PM' },
      ],
    });
    await createInvite({ tenantId: ahmed.id, token: 'over-limit-pm-token-0001', role: 'PM', phone: '+923450000013' });
    await createInvite({ tenantId: ahmed.id, token: 'munshi-at-limit-token-01', role: 'MUNSHI', phone: '+923450000014' });

    const pm = await accept('over-limit-pm-token-0001', { password: 'Valid#2026' });
    expect(pm.status).toBe(402);
    expect(pm.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(await prismaAdmin.user.count({ where: { phone: '+923450000013' } })).toBe(0);

    const munshi = await accept('munshi-at-limit-token-01', {});
    expect(munshi.status).toBe(201);
    expect(munshi.body.data.user.role).toBe('MUNSHI');
  });

  it('never logs the invitation token from the URL', async () => {
    const { testLogSink } = await import('../../src/config/logger.js');
    testLogSink.length = 0;
    await accept(SEED.invitation.token, { password: 'Kamran#2026' });
    expect(testLogSink.join('\n')).not.toContain(SEED.invitation.token);
  });
});
