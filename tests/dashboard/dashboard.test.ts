import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setDashboardCache } from '../../src/modules/dashboard/dashboard.cache.js';
import { useFreshDatabase } from '../helpers.js';
import { api, mockPdf, munshi, owner, pm, rs, seedMalikDemo } from './fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  mockPdf();
  await seedMalikDemo(seeded());
});
afterEach(() => setDashboardCache(false));

const overview = async (auth: Record<string, string>, query: Record<string, string> = {}) => api().get('/api/v1/dashboard/overview').set(auth).query(query);

describe('GET /dashboard/overview', () => {
  it('THEKEDAR: KPIs and project rows match the receivables, cost and supplier modules', async () => {
    const o = await owner();
    const res = await overview(o);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const p = seeded().projects;
    expect(d.kpis).toMatchObject({
      activeProjects: { count: 3, atRisk: 2, delayed: 0 },
      receivablesOutstandingPaisa: rs(1100000 + 930000 + 840000),
      overduePaisa: rs(1100000 + 450000),
      supplierUdhaarPaisa: rs(740000 + 1210000 + 325000 + 115000 + 86000),
      dispatchesOnTheWay: 2,
      openShortages: 2,
      cashWithSiteStaffPaisa: rs(9300 + 21500),
    });
    const approvals = (await api().get('/api/v1/approvals').set(o)).body.data;
    expect(d.kpis.pendingApprovals).toBe(approvals.total);

    const company = (await api().get('/api/v1/receivables').set(o)).body.data;
    expect(d.kpis).toMatchObject({ receivedPaisa: company.totals.receivedPaisa, invoicedPaisa: company.totals.invoicedPaisa });
    const dha = d.projects.find((r: { project: { id: string } }) => r.project.id === p.dha.id);
    const rec = (await api().get(`/api/v1/projects/${p.dha.id}/receivables`).set(o)).body.data;
    expect(dha).toMatchObject({
      contractPaisa: rec.revisedContractPaisa,
      invoicedPaisa: rec.invoicedPaisa,
      receivedPaisa: rec.receivedPaisa,
      outstandingPaisa: rec.outstandingPaisa,
      spentToDatePaisa: rec.spentToDatePaisa,
      ownMoneyInvestedPaisa: rec.ownMoneyInvestedPaisa,
      atRisk: true,
      nextBillableStage: { label: 'Grey structure — first floor & roof' },
    });
    expect(d.projects.map((r: { project: { code: string } }) => r.project.code).sort()).toEqual(['MSB-2025-031', 'MSB-2026-008', 'MSB-2026-012', 'MSB-2026-014']);
    // Payments by method in the period; the bounced MCB cheque is shown on its own.
    const cheque = d.payments.byMethod.find((m: { method: string }) => m.method === 'CHEQUE');
    expect(cheque).toBeDefined();
    expect(d.alerts.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['CHEQUE_BOUNCED', 'INVOICE_OVERDUE']));
    expect(d.labor.subcontractorsOverpaid).toBe(1); // Latif
  });

  it('PM without financials gets the non-money version (no money keys at all)', async () => {
    const d = (await overview(await pm())).body.data;
    expect(d.seesFinancials).toBe(false);
    expect(Object.keys(d.kpis).sort()).toEqual(['activeProjects', 'dispatchesOnTheWay', 'openShortages', 'pendingApprovals']);
    expect(d.payments).toBeUndefined();
    expect(d.projects.map((r: { project: { code: string } }) => r.project.code).sort()).toEqual(['MSB-2025-031', 'MSB-2026-008', 'MSB-2026-012']);
    expect(Object.keys(d.projects[0]).sort()).toEqual(['client', 'project']);
    expect(JSON.stringify(d)).not.toMatch(/contractPaisa|invoicedPaisa|receivedPaisa|ownMoney|supplierUdhaar|storeStockValue|overduePaisa/);
    expect(d.alerts.every((x: { source: string }) => x.source === 'NOTIFICATION')).toBe(true);
  });

  it('MUNSHI: 403 on the company overview', async () => {
    expect((await overview(await munshi(seeded().malik.id))).status).toBe(403);
  });

  it('a projectId outside a PM’s list is 404', async () => {
    expect((await overview(await pm(), { projectId: seeded().projects.bahria.id })).status).toBe(404);
  });

  it('answers in under 500 ms on the seed (uncached)', async () => {
    const o = await owner();
    await overview(o);
    const started = Date.now();
    expect((await overview(o, { from: '2026-09-01' })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('caches for 60 s per user and clears after any write', async () => {
    setDashboardCache(true);
    const o = await owner();
    const first = (await overview(o)).body.data.kpis.pendingApprovals;
    // A row written behind the API's back is not seen (cached) …
    const s = seeded();
    const account = await prismaAdmin.cashAccount.findFirstOrThrow({ where: { tenantId: s.malik.id, holderUserId: s.users.asif.id } });
    await prismaAdmin.topupRequest.create({ data: { tenantId: s.malik.id, accountId: account.id, amountPaisa: 100000n } });
    expect((await overview(o)).body.data.kpis.pendingApprovals).toBe(first);
    // … until any write through the API clears the tenant's cache.
    expect((await api().patch('/api/v1/notifications/read-all').set(o)).status).toBe(200);
    expect((await overview(o)).body.data.kpis.pendingApprovals).toBe(first + 1);
  });
});

describe('GET /dashboard/site/:projectId', () => {
  it('MUNSHI: hazri, incoming material, own cash and to-dos — no rates or values', async () => {
    const s = seeded();
    const m = await munshi(s.malik.id);
    const res = await api().get(`/api/v1/dashboard/site/${s.projects.dha.id}`).set(m);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.project).toMatchObject({ code: 'MSB-2026-012' });
    expect(d.incoming.map((i: { number: string }) => i.number)).toContain('GP-0144');
    expect(d.myCash).toMatchObject({ balancePaisa: rs(9300), openTopup: { amountPaisa: rs(40000) } });
    expect(d.todo.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['RECEIVE']));
    expect(JSON.stringify(d)).not.toMatch(/ratePaisa|valuePaisa|unitCostPaisa|costPaisa|contract|invoiced/i);
    // Not his project → 404.
    expect((await api().get(`/api/v1/dashboard/site/${s.projects.bahria.id}`).set(m)).status).toBe(404);
  });

  it('THEKEDAR may open any site dashboard (no own cash account → null)', async () => {
    const d = (await api().get(`/api/v1/dashboard/site/${seeded().projects.bahria.id}`).set(await owner())).body.data;
    expect(d.myCash).toBeNull();
    expect(d.incoming.map((i: { number: string }) => i.number)).toEqual(expect.arrayContaining(['GP-0143']));
  });
});
