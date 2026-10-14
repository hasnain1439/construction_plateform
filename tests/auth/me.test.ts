import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, device, grantFinancials, lastOtp, loginMobile, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';
import { PERMISSION_KEYS } from '../../src/core/auth/permissionCatalog.js';

const seeded = useFreshDatabase();
const { owner, pm, munshi } = SEED.malik;

describe('GET /auth/me', () => {
  it('THEKEDAR gets every permission and an empty assignedProjectIds (= all)', async () => {
    const s = await loginMobile(owner.phone, owner.password);
    const res = await api().get('/api/v1/auth/me').set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual([...PERMISSION_KEYS].sort());
    expect(res.body.data.legacyPermissions).toEqual(
      expect.arrayContaining(['company.update', 'users.manage', 'billing.view', 'profit.view', 'rates.view', 'store.manage']),
    );
    expect(res.body.data.assignedProjectIds).toEqual([]);
    expect(res.body.data.subscription).toMatchObject({ plan: { code: 'PROFESSIONAL' }, status: 'ACTIVE' });
    expect(res.body.data.tenant).toMatchObject({ slug: SEED.malik.slug, readOnly: false, marlaStandard: 225 });
  });

  it('PM without financials has no profit.view / billing.view but has rates.view', async () => {
    const s = await loginMobile(pm.phone, pm.password);
    const res = await api().get('/api/v1/auth/me').set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toContain('fields.rates');
    expect(res.body.data.permissions).toContain('projects.project.edit');
    expect(res.body.data.permissions).not.toContain('fields.profit');
    expect(res.body.data.permissions).not.toContain('billing.invoice.view');
    expect(res.body.data.legacyPermissions).toEqual(['rates.view', 'projects.manage', 'site.entry']);
    const { dha, johar, valencia } = seeded().projects;
    expect(res.body.data.assignedProjectIds.sort()).toEqual([dha.id, johar.id, valencia.id].sort());
  });

  it('PM with canSeeFinancials gets billing.view and profit.view', async () => {
    await grantFinancials(seeded().malik.id, seeded().users.bilal.id);
    const s = await loginMobile(pm.phone, pm.password);
    const res = await api().get('/api/v1/auth/me').set(bearer(s.accessToken));
    expect(res.body.data.permissions).toEqual(expect.arrayContaining(['billing.invoice.view', 'finance.pnl.view', 'fields.amounts', 'fields.profit']));
    expect(res.body.data.legacyPermissions).toEqual(expect.arrayContaining(['billing.view', 'profit.view']));
    expect(res.body.data.user.canSeeFinancials).toBe(true);
    expect((await prismaAdmin.user.findUniqueOrThrow({ where: { id: seeded().users.bilal.id } })).canSeeFinancials).toBe(true);
  });

  it('MUNSHI has only site.entry — never rates.view', async () => {
    await api().post('/api/v1/auth/otp/request').send({ phone: munshi.phone });
    const login = await api()
      .post('/api/v1/auth/otp/verify')
      .send({ phone: munshi.phone, code: lastOtp(munshi.phone), tenantId: seeded().malik.id, client: 'mobile', device: device() });
    expect(login.status).toBe(200);

    const res = await api().get('/api/v1/auth/me').set(bearer(login.body.data.accessToken));
    expect(res.body.data.legacyPermissions).toEqual(['site.entry']);
    expect(res.body.data.permissions).not.toContain('fields.rates');
    expect(res.body.data.fieldAccess).toEqual({ rates: false, amounts: false, profit: false, contract: false });
    expect(res.body.data.assignedProjectIds).toEqual([seeded().projects.dha.id]);
  });

  it('requires authentication', async () => {
    const res = await api().get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    const bad = await api().get('/api/v1/auth/me').set(bearer('not.a.jwt'));
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('PATCH /auth/me', () => {
  it('updates name and language', async () => {
    const s = await loginMobile(owner.phone, owner.password);
    const res = await api().patch('/api/v1/auth/me').set(bearer(s.accessToken)).send({ name: 'Khalid M.', language: 'URDU' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ name: 'Khalid M.', language: 'ur' });
  });

  it('password change revokes other sessions but keeps the current one', async () => {
    const current = await loginMobile(owner.phone, owner.password);
    const other = await loginMobile(owner.phone, owner.password);

    const res = await api()
      .patch('/api/v1/auth/me')
      .set(bearer(current.accessToken))
      .send({ currentPassword: owner.password, newPassword: 'Thekedar#2027' });
    expect(res.status).toBe(200);

    expect((await refreshMobile(other.refreshToken)).status).toBe(401);
    expect((await refreshMobile(current.refreshToken)).status).toBe(200);

    expect((await api().post('/api/v1/auth/login').send({ login: owner.phone, password: owner.password })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ login: owner.phone, password: 'Thekedar#2027' })).status).toBe(200);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'auth.password_changed' } })).toBe(1);
  });

  it('wrong current password → 400 CURRENT_PASSWORD_WRONG; passwords must come together', async () => {
    const s = await loginMobile(owner.phone, owner.password);
    const wrong = await api()
      .patch('/api/v1/auth/me')
      .set(bearer(s.accessToken))
      .send({ currentPassword: 'Nope#2026', newPassword: 'Thekedar#2027' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_WRONG');

    const alone = await api().patch('/api/v1/auth/me').set(bearer(s.accessToken)).send({ newPassword: 'Thekedar#2027' });
    expect(alone.status).toBe(400);
    expect(alone.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /auth/sessions lists active sessions and flags the current one', async () => {
    const a = await loginMobile(owner.phone, owner.password);
    await loginMobile(owner.phone, owner.password);
    const res = await api().get('/api/v1/auth/sessions').set(bearer(a.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ platform: 'ANDROID', model: 'Test Phone' });
  });
});
