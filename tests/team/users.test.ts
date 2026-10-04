import { describe, expect, it } from 'vitest';
import { runWithCtx } from '../../src/core/context/requestContext.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { deactivateUser } from '../../src/modules/team/users.service.js';
import { api, bearer, loginMobile, loginMunshi, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
const pm = () => loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);

describe('role checks', () => {
  it('PM cannot deactivate users; MUNSHI cannot list users', async () => {
    const p = await pm();
    const del = await api().delete(`/api/v1/users/${seeded().users.rafaqatMalik.id}`).set(bearer(p.accessToken));
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('FORBIDDEN');
    expect((await api().get(`/api/v1/users/${seeded().users.rafaqatMalik.id}`).set(bearer(p.accessToken))).status).toBe(403);

    const m = await loginMunshi(seeded().malik.id);
    expect((await api().get('/api/v1/users').set(bearer(m.accessToken))).status).toBe(403);
  });
});

describe('GET /users', () => {
  it('paginates and reports office-seat usage (Munshi not counted)', async () => {
    const s = await owner();
    const first = await api().get('/api/v1/users?limit=2').set(bearer(s.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2, usage: { officeUsers: 2, maxOfficeUsers: 10 } });
    const second = await api().get('/api/v1/users?limit=2&page=2').set(bearer(s.accessToken));
    expect(second.body.data).toHaveLength(2);
    const ids = [...first.body.data, ...second.body.data].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(4);
    expect((await api().get('/api/v1/users?limit=101').set(bearer(s.accessToken))).status).toBe(400);
  });

  it('filters by role, status, search and project', async () => {
    const s = await owner();
    const q = async (qs: string) => (await api().get(`/api/v1/users?${qs}`).set(bearer(s.accessToken))).body.data.map((u: { name: string }) => u.name).sort();
    expect(await q('role=PM')).toEqual(['Bilal Ahmed']);
    expect(await q('search=rafa')).toEqual(['Rafaqat Ali']);
    expect(await q('search=0333-111')).toEqual(['Bilal Ahmed']);
    expect(await q(`projectId=${seeded().projects.bahria.id}`)).toEqual(['Asif Mehmood', 'Khalid Malik']);
    expect(await q(`projectId=${seeded().projects.dha.id}`)).toEqual(['Bilal Ahmed', 'Khalid Malik', 'Rafaqat Ali']);
    expect(await q('status=INACTIVE')).toEqual([]);

    const bilal = (await api().get('/api/v1/users?role=PM').set(bearer(s.accessToken))).body.data[0];
    expect(bilal).toMatchObject({ canSeeFinancials: false, allProjects: false });
    expect(bilal.projects.map((p: { name: string }) => p.name)).toHaveLength(3); // DHA, Johar Town, Valencia
  });

  it('PM callers do not see canSeeFinancials', async () => {
    const p = await pm();
    const res = await api().get('/api/v1/users').set(bearer(p.accessToken));
    expect(res.status).toBe(200);
    for (const u of res.body.data) expect(u).not.toHaveProperty('canSeeFinancials');
  });

  it('GET /users/:id returns projects and active device count', async () => {
    const s = await owner();
    await pm();
    await pm();
    const res = await api().get(`/api/v1/users/${seeded().users.bilal.id}`).set(bearer(s.accessToken));
    expect(res.body.data).toMatchObject({ name: 'Bilal Ahmed', role: 'PM', activeDeviceCount: 2, deactivatedAt: null });
  });
});

describe('PATCH /users/:id', () => {
  it('cannot change own role (403) or an owner’s role', async () => {
    const s = await owner();
    const own = await api().patch(`/api/v1/users/${seeded().users.khalid.id}`).set(bearer(s.accessToken)).send({ role: 'PM' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
    // Own name is fine
    expect((await api().patch(`/api/v1/users/${seeded().users.khalid.id}`).set(bearer(s.accessToken)).send({ name: 'Khalid M.' })).status).toBe(200);
  });

  it('updates PM fields, normalises phone, 409 on duplicate phone, financials only for PM', async () => {
    const s = await owner();
    const { bilal, rafaqatMalik } = seeded().users;
    const res = await api().patch(`/api/v1/users/${bilal.id}`).set(bearer(s.accessToken)).send({ canSeeFinancials: true, phone: '0333 999 8877' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ canSeeFinancials: true, phone: '+923339998877' });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'user.update', entityId: bilal.id } });
    expect(audit.details).toEqual({
      changes: { phone: { from: '+923331112233', to: '+923339998877' }, canSeeFinancials: { from: false, to: true } },
    });

    const dup = await api().patch(`/api/v1/users/${rafaqatMalik.id}`).set(bearer(s.accessToken)).send({ phone: '+923339998877' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PHONE_TAKEN');

    const munshiFin = await api().patch(`/api/v1/users/${rafaqatMalik.id}`).set(bearer(s.accessToken)).send({ canSeeFinancials: true });
    expect(munshiFin.status).toBe(400);
    expect(munshiFin.body.error.code).toBe('FINANCIALS_PM_ONLY');

    // Demoting to MUNSHI clears financials
    const demoted = await api().patch(`/api/v1/users/${bilal.id}`).set(bearer(s.accessToken)).send({ role: 'MUNSHI' });
    expect(demoted.body.data).toMatchObject({ role: 'MUNSHI', canSeeFinancials: false });
  });

  it('MUNSHI → PM at the Starter office-user limit → 402', async () => {
    const { ahmed, users } = seeded(); // Starter: 3 office users; has 1 (owner)
    await prismaAdmin.user.createMany({
      data: [
        { tenantId: ahmed.id, name: 'PM One', phone: '+923450000021', role: 'PM' },
        { tenantId: ahmed.id, name: 'PM Two', phone: '+923450000022', role: 'PM' },
      ],
    });
    const s = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const res = await api().patch(`/api/v1/users/${users.rafaqatAhmed.id}`).set(bearer(s.accessToken)).send({ role: 'PM' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.details).toMatchObject({ limit: 3, used: 3 });
  });
});

describe('deactivate / reactivate', () => {
  it('deactivating revokes sessions and devices; the user can no longer refresh or log in', async () => {
    const s = await owner();
    const b = await pm();
    const res = await api().delete(`/api/v1/users/${seeded().users.bilal.id}`).set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('INACTIVE');
    expect(res.body.data.deactivatedAt).toEqual(expect.any(String));

    expect((await refreshMobile(b.refreshToken)).status).toBe(401);
    expect(await prismaAdmin.device.count({ where: { userId: seeded().users.bilal.id, revokedAt: null } })).toBe(0);
    expect(await prismaAdmin.session.count({ where: { userId: seeded().users.bilal.id, revokedAt: null } })).toBe(0);
    expect((await api().post('/api/v1/auth/login').send({ login: SEED.malik.pm.phone, password: SEED.malik.pm.password })).status).toBe(401);

    const list = await api().get('/api/v1/users?status=INACTIVE').set(bearer(s.accessToken));
    expect(list.body.data.map((u: { name: string }) => u.name)).toEqual(['Bilal Ahmed']);
    expect(list.body.meta.usage.officeUsers).toBe(1);

    const back = await api().post(`/api/v1/users/${seeded().users.bilal.id}/reactivate`).set(bearer(s.accessToken));
    expect(back.status).toBe(200);
    expect(back.body.data).toMatchObject({ status: 'ACTIVE', deactivatedAt: null });
    expect((await api().post('/api/v1/auth/login').send({ login: SEED.malik.pm.phone, password: SEED.malik.pm.password })).status).toBe(200);
    expect((await api().post(`/api/v1/users/${seeded().users.bilal.id}/reactivate`).set(bearer(s.accessToken))).status).toBe(409);
    expect(await prismaAdmin.auditLog.count({ where: { action: { in: ['user.deactivate', 'user.reactivate'] } } })).toBe(2);
  });

  it('cannot deactivate yourself (403)', async () => {
    const s = await owner();
    const res = await api().delete(`/api/v1/users/${seeded().users.khalid.id}`).set(bearer(s.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
  });

  it('the last active THEKEDAR cannot be deactivated (403)', async () => {
    // Through the API the caller is always another active THEKEDAR, so this guard only bites
    // in races; exercise the service directly with a different actor.
    const { malik, users } = seeded();
    const err = await runWithCtx(
      { requestId: 't', ip: undefined, userAgent: undefined, actorType: 'USER', userId: users.bilal.id, tenantId: malik.id, role: 'THEKEDAR', permissions: [] },
      () => deactivateUser(users.khalid.id).catch((e: unknown) => e),
    );
    expect(err).toMatchObject({ status: 403, code: 'LAST_THEKEDAR' });

    // With a second owner it works
    const second = await prismaAdmin.user.create({ data: { tenantId: malik.id, name: 'Tariq Malik', phone: '+923001112222', role: 'THEKEDAR', passwordHash: null } });
    const ok = await runWithCtx(
      { requestId: 't', ip: undefined, userAgent: undefined, actorType: 'USER', userId: second.id, tenantId: malik.id, role: 'THEKEDAR', permissions: [] },
      () => deactivateUser(users.khalid.id),
    );
    expect(ok.status).toBe('INACTIVE');
  });

  it('reactivating a PM re-checks the seat limit', async () => {
    const { ahmed } = seeded();
    const inactive = await prismaAdmin.user.create({ data: { tenantId: ahmed.id, name: 'Old PM', phone: '+923450000031', role: 'PM', status: 'INACTIVE' } });
    await prismaAdmin.user.createMany({
      data: [
        { tenantId: ahmed.id, name: 'PM One', phone: '+923450000032', role: 'PM' },
        { tenantId: ahmed.id, name: 'PM Two', phone: '+923450000033', role: 'PM' },
      ],
    });
    const s = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const res = await api().post(`/api/v1/users/${inactive.id}/reactivate`).set(bearer(s.accessToken));
    expect(res.status).toBe(402);
  });
});

describe('PUT /users/:id/projects', () => {
  it('replaces the whole list in one go', async () => {
    const s = await owner();
    const { bilal } = seeded().users;
    const { bahria } = seeded().projects;
    const res = await api().put(`/api/v1/users/${bilal.id}/projects`).set(bearer(s.accessToken)).send({ projectIds: [bahria.id, bahria.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.projects).toEqual([{ id: bahria.id, name: bahria.name }]);
    expect(await prismaAdmin.userProjectAccess.findMany({ where: { userId: bilal.id }, select: { projectId: true } })).toEqual([{ projectId: bahria.id }]);

    const cleared = await api().put(`/api/v1/users/${bilal.id}/projects`).set(bearer(s.accessToken)).send({ projectIds: [] });
    expect(cleared.body.data.projects).toEqual([]);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'user.projects_update' } })).toBe(2);
  });

  it("another company's project → 400 INVALID_PROJECT (nothing changes); THEKEDAR target → 400", async () => {
    const s = await owner();
    const { users, projects } = seeded();
    const res = await api()
      .put(`/api/v1/users/${users.bilal.id}/projects`)
      .set(bearer(s.accessToken))
      .send({ projectIds: [projects.dha.id, projects.ahmedProject.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PROJECT');
    expect(res.body.error.details.invalidIds).toEqual([projects.ahmedProject.id]);
    expect(await prismaAdmin.userProjectAccess.count({ where: { userId: users.bilal.id } })).toBe(3);

    const owner2 = await api().put(`/api/v1/users/${users.khalid.id}/projects`).set(bearer(s.accessToken)).send({ projectIds: [] });
    expect(owner2.status).toBe(400);
    expect(owner2.body.error.code).toBe('THEKEDAR_HAS_ALL_PROJECTS');
  });
});
