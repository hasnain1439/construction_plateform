import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { assertWithinLimit, getLimits, getUsage } from '../../src/core/plan/planLimits.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase, projectRow } from '../helpers.js';

const seeded = useFreshDatabase();

describe('planLimits', () => {
  it('usage counts active THEKEDAR + PM + pending PM invites; never Munshis', async () => {
    const { malik } = seeded();
    // Munshi invite should not count
    await prismaAdmin.invitation.create({
      data: { tenantId: malik.id, tokenHash: 'munshi-invite-hash-0001', role: 'MUNSHI', name: 'M', phone: '+923450000601', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    // Expired PM invite should not count either
    await prismaAdmin.invitation.create({
      data: { tenantId: malik.id, tokenHash: 'expired-pm-hash-0001', role: 'PM', name: 'P', phone: '+923450000602', expiresAt: new Date(Date.now() - 1000) },
    });
    const usage = await withTenant(malik.id, (tx) => getUsage(tx, malik.id));
    expect(usage).toEqual({ activeProjects: 3, officeUsers: 3 }); // DHA, Johar, Bahria; Khalid, Bilal, Kamran (pending PM)
    expect(await withTenant(malik.id, (tx) => getLimits(tx, malik.id))).toEqual({ activeProjects: 5, officeUsers: 10 });
  });

  it('Starter cannot add a 4th office user (402); Munshi invites are never blocked', async () => {
    const { ahmed } = seeded(); // Starter: 3 office users; 1 used (owner)
    await prismaAdmin.user.createMany({
      data: [
        { tenantId: ahmed.id, name: 'PM One', phone: '+923450000611', role: 'PM' },
        { tenantId: ahmed.id, name: 'PM Two', phone: '+923450000612', role: 'PM' },
      ],
    });
    const err = await withTenant(ahmed.id, (tx) => assertWithinLimit(tx, ahmed.id, 'officeUsers')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 402, code: 'PLAN_LIMIT_REACHED', details: { resource: 'officeUsers', limit: 3, used: 3 } });

    const s = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const pm = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Fourth PM', phone: '+923450000613', role: 'PM' });
    expect(pm.status).toBe(402);
    expect(pm.body.error.details).toMatchObject({ limit: 3, used: 3 });
    for (const phone of ['+923450000614', '+923450000615', '+923450000616']) {
      const munshi = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Site Munshi', phone, role: 'MUNSHI' });
      expect(munshi.status).toBe(201);
    }
  });

  it('active projects: Starter allows 2', async () => {
    const { ahmed } = seeded(); // 1 project
    await withTenant(ahmed.id, (tx) => assertWithinLimit(tx, ahmed.id, 'activeProjects'));
    await projectRow(ahmed.id, 'Second site');
    const err = await withTenant(ahmed.id, (tx) => assertWithinLimit(tx, ahmed.id, 'activeProjects')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 402, details: { resource: 'activeProjects', limit: 2, used: 2 } });
    // READ_ONLY / completed projects don't count
    await prismaAdmin.project.updateMany({ where: { tenantId: ahmed.id, name: 'Second site' }, data: { status: 'READ_ONLY' } });
    await withTenant(ahmed.id, (tx) => assertWithinLimit(tx, ahmed.id, 'activeProjects'));
  });

  it('unlimited plans never block', async () => {
    const { malik, plans } = seeded();
    await prismaAdmin.subscription.update({ where: { tenantId: malik.id }, data: { planId: plans.ENTERPRISE.id } });
    await withTenant(malik.id, (tx) => assertWithinLimit(tx, malik.id, 'officeUsers', 1000));
    await withTenant(malik.id, (tx) => assertWithinLimit(tx, malik.id, 'activeProjects', 1000));
  });
});
