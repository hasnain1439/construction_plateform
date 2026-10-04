import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { trackJobRun } from '../../src/jobs/jobRuns.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();
const someId = '0199a8c0-0000-7000-8000-000000000999';

const ADMIN_ROUTES: Array<[string, string]> = [
  ['GET', '/api/v1/admin/overview'],
  ['GET', '/api/v1/admin/health'],
  ['GET', '/api/v1/admin/tenants'],
  ['POST', '/api/v1/admin/tenants'],
  ['GET', `/api/v1/admin/tenants/${someId}`],
  ['PATCH', `/api/v1/admin/tenants/${someId}/status`],
  ['PATCH', `/api/v1/admin/tenants/${someId}/plan`],
  ['GET', '/api/v1/admin/payments'],
  ['GET', `/api/v1/admin/payments/${someId}`],
  ['POST', `/api/v1/admin/payments/${someId}/approve`],
  ['POST', `/api/v1/admin/payments/${someId}/reject`],
  ['GET', '/api/v1/admin/plans'],
  ['POST', '/api/v1/admin/plans'],
  ['PATCH', `/api/v1/admin/plans/${someId}`],
  ['GET', '/api/v1/admin/holidays'],
  ['POST', '/api/v1/admin/holidays'],
  ['PATCH', `/api/v1/admin/holidays/${someId}`],
  ['DELETE', `/api/v1/admin/holidays/${someId}`],
  ['GET', '/api/v1/admin/audit-logs'],
  ['GET', '/api/v1/admin/material-groups'],
  ['GET', '/api/v1/admin/materials'],
  ['POST', '/api/v1/admin/materials'],
  ['PATCH', `/api/v1/admin/materials/${someId}`],
];

const send = (method: string, path: string, token?: string) => {
  const req = api()[method.toLowerCase() as 'get'](path);
  if (token) req.set(bearer(token));
  return method === 'GET' ? req : req.send({});
};

describe('platform admin access', () => {
  it('every /admin route rejects company tokens and anonymous calls (401)', async () => {
    const company = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    for (const [method, path] of ADMIN_ROUTES) {
      const asCompany = await send(method, path, company.accessToken);
      expect(asCompany.status, `${method} ${path}`).toBe(401);
      const anonymous = await send(method, path);
      expect(anonymous.status, `${method} ${path}`).toBe(401);
    }
  });

  it('platform tokens are rejected on company routes (401)', async () => {
    const admin = await loginAdmin();
    for (const path of ['/api/v1/auth/me', '/api/v1/company', '/api/v1/users', '/api/v1/subscription']) {
      expect((await api().get(path).set(bearer(admin.accessToken))).status, path).toBe(401);
    }
  });

  it('a logged-out admin token stops working at once', async () => {
    const admin = await loginAdmin();
    expect((await api().get('/api/v1/admin/overview').set(bearer(admin.accessToken))).status).toBe(200);
    await api().post('/api/v1/admin/auth/logout').set(bearer(admin.accessToken));
    expect((await api().get('/api/v1/admin/overview').set(bearer(admin.accessToken))).status).toBe(401);
  });
});

describe('GET /admin/overview', () => {
  it('matches the seeded companies, MRR, plans and payments', async () => {
    const admin = await loginAdmin();
    const res = await api().get('/api/v1/admin/overview').set(bearer(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      activeCompanies: 2, // Malik, Ahmed
      trialCompanies: 0,
      graceCompanies: 1, // Valley
      readOnlyCompanies: 1, // Old Town
      suspendedCompanies: 0,
      mrrPaisa: '1750000', // Professional 9,500 + Starter 4,000 (Ahmed) + Starter 4,000 (Valley, GRACE)
      paymentsAwaitingReview: 1,
      trialsEndingThisWeek: 0,
      planDistribution: [
        { planCode: 'STARTER', count: 3 },
        { planCode: 'PROFESSIONAL', count: 1 },
      ],
    });
    const months = res.body.data.revenueByMonth as Array<{ month: string; amountPaisa: string }>;
    expect(months).toHaveLength(12);
    expect(months.map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
    expect(months.reduce((sum, m) => sum + BigInt(m.amountPaisa), 0n)).toBe(2_850_000n); // 3 approved Malik payments
  });

  it('counts a new trial ending this week', async () => {
    const admin = await loginAdmin();
    const sub = await prismaAdmin.subscription.findFirstOrThrow({ where: { tenant: { slug: SEED.ahmed.slug } } });
    await prismaAdmin.subscription.update({ where: { id: sub.id }, data: { status: 'TRIAL', trialEndsAt: new Date(Date.now() + 3 * 86_400_000) } });
    const res = await api().get('/api/v1/admin/overview').set(bearer(admin.accessToken));
    expect(res.body.data).toMatchObject({ trialCompanies: 1, trialsEndingThisWeek: 1, activeCompanies: 1 });
  });
});

describe('GET /admin/health', () => {
  it('reports database, providers, version and the lifecycle job', async () => {
    const admin = await loginAdmin();
    const before = await api().get('/api/v1/admin/health').set(bearer(admin.accessToken));
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      api: { ok: true },
      database: { ok: true },
      smsProvider: 'console',
      mailProvider: 'console',
      storageProvider: 'local',
      version: '1.0.0',
    });
    expect(before.body.data.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(before.body.data.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await trackJobRun('subscription-lifecycle', async () => ({ lapsed: [] }));
    const after = await api().get('/api/v1/admin/health').set(bearer(admin.accessToken));
    expect(after.body.data.jobs.subscriptionLifecycle).toMatchObject({ lastStatus: 'SUCCESS', lastError: null });
    expect(after.body.data.jobs.subscriptionLifecycle.lastRunAt).toEqual(expect.any(String));
  });
});
