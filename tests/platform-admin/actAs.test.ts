import { beforeEach, describe, expect, it } from 'vitest';
import { clearSystemUserCache, SYSTEM_USER_NAME, SYSTEM_USER_PHONE } from '../../src/modules/auth/actAs.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
beforeEach(() => clearSystemUserCache());

/** The super admin's token + the company to work in. */
const actingIn = async (tenantId: string) => ({ ...bearer((await loginAdmin()).accessToken), 'X-Act-As-Tenant': tenantId });

describe('super admin acting inside a company (X-Act-As-Tenant)', () => {
  it("reads the company's data through the normal company API, as the owner would", async () => {
    const s = seeded();
    const res = await api().get('/api/v1/projects?limit=100').set(await actingIn(s.malik.id));
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(s.projects.dha.id);
    expect(ids).not.toContain(s.projects.ahmedProject.id); // only the chosen company
    const me = await api().get('/api/v1/auth/me').set(await actingIn(s.malik.id));
    expect(me.body.data).toMatchObject({ user: { name: SYSTEM_USER_NAME, role: 'THEKEDAR' }, tenant: { id: s.malik.id } });
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(['users.manage', 'billing.view', 'rates.view', 'projects.manage']));
  });

  it('changes go through the company rules; the row is by "Super Admin (Platform)", the audit names the real admin', async () => {
    const s = seeded();
    const res = await api().post('/api/v1/suppliers').set(await actingIn(s.malik.id)).send({ name: 'Admin Fixed Traders', category: 'Cement', city: 'Lahore' });
    expect(res.status).toBe(201);
    const system = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: s.malik.id, isSystem: true } });
    expect(system).toMatchObject({ name: SYSTEM_USER_NAME, role: 'THEKEDAR', status: 'INACTIVE' });
    const admin = await prismaAdmin.platformAdmin.findUniqueOrThrow({ where: { email: SEED.admin.email } });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: s.malik.id, entityId: res.body.data.id } });
    expect(audit).toMatchObject({ actorType: 'PLATFORM_ADMIN', actorId: admin.id });
    expect(audit.details).toMatchObject({ actingAsCompany: true });
    // Company validation still applies (duplicate name is refused like for the owner).
    const dup = await api().post('/api/v1/suppliers').set(await actingIn(s.malik.id)).send({ name: 'Admin Fixed Traders', category: 'Cement' });
    expect(dup.status).toBe(409);
  });

  it('the system user never shows up: not in the team list, not counted, cannot sign in', async () => {
    const s = seeded();
    await api().get('/api/v1/projects').set(await actingIn(s.malik.id)); // creates it
    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    const team = await api().get('/api/v1/users?limit=100').set(owner);
    expect((team.body.data as Array<{ name: string }>).map((u) => u.name)).not.toContain(SYSTEM_USER_NAME);
    const detail = await api().get(`/api/v1/admin/tenants/${s.malik.id}`).set(bearer((await loginAdmin()).accessToken));
    expect(detail.body.data.usage.officeUsers.used).toBe(3);
    expect(detail.body.data.owner.name).toBe('Khalid Malik');
    const otp = await api().post('/api/v1/auth/otp/request').send({ phone: SYSTEM_USER_PHONE });
    expect(otp.status).not.toBe(200);
  });

  it('only a signed-in platform admin can act: company tokens and logged-out admins are refused', async () => {
    const s = seeded();
    // A company owner cannot use the header to reach another company.
    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    const sneaky = await api().get('/api/v1/projects').set({ ...owner, 'X-Act-As-Tenant': s.ahmed.id });
    expect(sneaky.status).toBe(401);
    // A logged-out admin token stops working at once.
    const session = await loginAdmin();
    await api().post('/api/v1/admin/auth/logout').set(bearer(session.accessToken));
    const after = await api().get('/api/v1/projects').set({ ...bearer(session.accessToken), 'X-Act-As-Tenant': s.malik.id });
    expect(after.status).toBe(401);
    // Garbage / unknown company.
    expect((await api().get('/api/v1/projects').set(await actingIn('not-a-uuid'))).status).toBe(400);
    expect((await api().get('/api/v1/projects').set(await actingIn('01a10000-0000-7000-8000-000000000000'))).status).toBe(404);
  });

  it('works for a suspended company too (the owner is locked out, the admin is not)', async () => {
    const s = seeded();
    await prismaAdmin.tenant.update({ where: { id: s.ahmed.id }, data: { status: 'SUSPENDED' } });
    const res = await api().get('/api/v1/projects').set(await actingIn(s.ahmed.id));
    expect(res.status).toBe(200);
  });
});
