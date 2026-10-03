import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const admin = async () => bearer((await loginAdmin()).accessToken);
const nextYear = new Date().getUTCFullYear() + 1;

describe('plans', () => {
  it('lists every plan (inactive too) with the number of companies on it', async () => {
    await prismaAdmin.plan.update({ where: { code: 'ENTERPRISE' }, data: { isActive: false } });
    const res = await api().get('/api/v1/admin/plans').set(await admin());
    expect(res.body.data.map((p: { code: string }) => p.code)).toEqual(['TRIAL', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']);
    expect(res.body.data.map((p: { companies: number }) => p.companies)).toEqual([0, 3, 1, 0]);
    expect(res.body.data[3]).toMatchObject({ isActive: false, maxActiveProjects: null, pricePaisa: '2000000' });
  });

  it('create: code upper-cased and unique; null limits = unlimited', async () => {
    const h = await admin();
    const body = { code: 'business_plus', name: 'Business Plus', pricePaisa: '1500000', maxActiveProjects: 8, maxOfficeUsers: null, features: ['8 projects'], sortOrder: 3 };
    const res = await api().post('/api/v1/admin/plans').set(h).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'BUSINESS_PLUS', pricePaisa: '1500000', maxOfficeUsers: null, isActive: true, companies: 0 });
    const dup = await api().post('/api/v1/admin/plans').set(h).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PLAN_CODE_TAKEN');
    // It is now offered to companies
    const k = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const plans = await api().get('/api/v1/subscription/plans').set(bearer(k.accessToken));
    expect(plans.body.data.map((p: { code: string }) => p.code)).toContain('BUSINESS_PLUS');
  });

  it('update: code is immutable; price change affects future payments only', async () => {
    const h = await admin();
    const starter = seeded().plans.STARTER.id;
    const code = await api().patch(`/api/v1/admin/plans/${starter}`).set(h).send({ code: 'CHEAP' });
    expect(code.status).toBe(400);
    const res = await api().patch(`/api/v1/admin/plans/${starter}`).set(h).send({ pricePaisa: '450000', features: ['2 active projects'] });
    expect(res.body.data).toMatchObject({ pricePaisa: '450000', code: 'STARTER' });
    // Ahmed's existing payment keeps its amount
    expect((await prismaAdmin.subscriptionPayment.findUniqueOrThrow({ where: { transactionId: 'EP2610010042' } })).amountPaisa).toBe(400_000n);
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'admin.plan_updated' } });
    expect(audit.details).toMatchObject({ planCode: 'STARTER', changes: { pricePaisa: '450000' } });
  });

  it('cannot deactivate the only active paid plan', async () => {
    const h = await admin();
    const { plans } = seeded();
    expect((await api().patch(`/api/v1/admin/plans/${plans.STARTER.id}`).set(h).send({ isActive: false })).status).toBe(200);
    expect((await api().patch(`/api/v1/admin/plans/${plans.PROFESSIONAL.id}`).set(h).send({ isActive: false })).status).toBe(200);
    const last = await api().patch(`/api/v1/admin/plans/${plans.ENTERPRISE.id}`).set(h).send({ isActive: false });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_ACTIVE_PLAN');
  });
});

describe('platform holidays', () => {
  it('CRUD with validation; companies see them in their calendar', async () => {
    const h = await admin();
    const bad = await api().post('/api/v1/admin/holidays').set(h).send({ name: 'Eid ul Fitr', startDate: `${nextYear}-03-22`, endDate: `${nextYear}-03-20` });
    expect(bad.status).toBe(400);

    const eid = await api().post('/api/v1/admin/holidays').set(h).send({ name: 'Eid ul Fitr', startDate: `${nextYear}-03-20`, endDate: `${nextYear}-03-22` });
    expect(eid.status).toBe(201);
    expect(eid.body.data).toMatchObject({ endDate: `${nextYear}-03-22`, type: 'NON_WORKING', region: null });
    const dup = await api().post('/api/v1/admin/holidays').set(h).send({ name: 'Eid ul Fitr', startDate: `${nextYear}-03-20` });
    expect(dup.body.error.code).toBe('HOLIDAY_EXISTS');

    const sindh = await api().post('/api/v1/admin/holidays').set(h).send({ name: 'Sindh Culture Day', startDate: `${nextYear}-12-07`, type: 'PARTIAL', region: 'KARACHI_SINDH' });
    expect(sindh.status).toBe(201);

    const listed = await api().get(`/api/v1/admin/holidays?year=${nextYear}`).set(h);
    expect(listed.body.data.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['Eid ul Fitr', 'Sindh Culture Day', 'Pakistan Day']));

    const moved = await api().patch(`/api/v1/admin/holidays/${eid.body.data.id}`).set(h).send({ startDate: `${nextYear}-03-21`, endDate: `${nextYear}-03-23` });
    expect(moved.body.data).toMatchObject({ startDate: `${nextYear}-03-21`, endDate: `${nextYear}-03-23` });
    const reversed = await api().patch(`/api/v1/admin/holidays/${eid.body.data.id}`).set(h).send({ endDate: `${nextYear}-03-01` });
    expect(reversed.status).toBe(400);

    // Malik (Punjab) sees Eid but not the Sindh-only holiday
    const k = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const cal = await api().get(`/api/v1/company/holidays?year=${nextYear}`).set(bearer(k.accessToken));
    const names = cal.body.data.map((x: { name: string }) => x.name);
    expect(names).toContain('Eid ul Fitr');
    expect(names).not.toContain('Sindh Culture Day');
    expect(cal.body.data.find((x: { name: string }) => x.name === 'Eid ul Fitr')).toMatchObject({ endDate: `${nextYear}-03-23`, source: 'platform' });

    expect((await api().delete(`/api/v1/admin/holidays/${eid.body.data.id}`).set(h)).status).toBe(200);
    expect((await api().delete(`/api/v1/admin/holidays/${eid.body.data.id}`).set(h)).status).toBe(404);
    expect(await prismaAdmin.auditLog.count({ where: { action: { startsWith: 'admin.holiday_' } } })).toBe(4);
  });
});

describe('GET /admin/audit-logs', () => {
  it('filters by tenant, actor type, action prefix and date; newest first; never returns secrets', async () => {
    const h = await admin();
    await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    await api().post('/api/v1/admin/holidays').set(h).send({ name: 'Audit Day', startDate: `${nextYear}-06-01` });
    await prismaAdmin.auditLog.create({
      data: { tenantId: seeded().malik.id, actorType: 'SYSTEM', action: 'test.secret_check', details: { password: 'hunter2', nested: { refreshToken: 'abc' }, plan: 'STARTER' } },
    });

    const malik = await api().get(`/api/v1/admin/audit-logs?tenantId=${seeded().malik.id}`).set(h);
    expect(malik.body.data.every((e: { tenant: { id: string } }) => e.tenant.id === seeded().malik.id)).toBe(true);
    const times = malik.body.data.map((e: { createdAt: string }) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());

    const logins = await api().get('/api/v1/admin/audit-logs?action=auth.').set(h);
    expect(logins.body.data.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['auth.login', 'admin.login'].filter((a) => a.startsWith('auth.'))));
    expect(logins.body.data.every((e: { action: string }) => e.action.startsWith('auth.'))).toBe(true);

    const adminActs = await api().get('/api/v1/admin/audit-logs?actorType=PLATFORM_ADMIN').set(h);
    expect(adminActs.body.data.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['admin.login', 'admin.holiday_created']));

    const secret = await api().get('/api/v1/admin/audit-logs?action=test.secret').set(h);
    expect(secret.body.data[0].details).toEqual({ password: '[REDACTED]', nested: { refreshToken: '[REDACTED]' }, plan: 'STARTER' });

    const future = await api().get(`/api/v1/admin/audit-logs?from=${nextYear}-01-01`).set(h);
    expect(future.body.meta.total).toBe(0);
    const page = await api().get('/api/v1/admin/audit-logs?limit=2').set(h);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta.total).toBeGreaterThan(2);
  });
});
