import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const malikOwner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const malikPm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const ahmedOwner = async () => bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);
const done = (body: { data: { steps: Array<{ key: string; done: boolean }> } }) => Object.fromEntries(body.data.steps.map((s) => [s.key, s.done]));

describe('setup checklist', () => {
  it('is computed from the company data, can be confirmed / dismissed, and is owner-only', async () => {
    const auth = await ahmedOwner();
    const first = await api().get('/api/v1/onboarding/checklist').set(auth);
    expect(first.status).toBe(200);
    expect(done(first.body)).toMatchObject({ WORKERS: false, SUPPLIERS: false, PROJECT: true, RATES: false });
    expect(first.body.data).toMatchObject({ total: 6, dismissed: false, demo: null });

    expect((await api().post('/api/v1/workers').set(auth).send({ name: 'Ustad Bashir', type: 'MISTRI' })).status).toBe(201);
    expect((await api().post('/api/v1/suppliers').set(auth).send({ name: 'Ravi Steel', category: 'Steel' })).status).toBe(201);
    const reviewed = await api().post('/api/v1/onboarding/checklist/rates-reviewed').set(auth);
    expect(done(reviewed.body)).toMatchObject({ WORKERS: true, SUPPLIERS: true, RATES: true });
    expect(reviewed.body.data.completed).toBe(reviewed.body.data.steps.filter((s: { done: boolean }) => s.done).length);
    expect(reviewed.body.data.percent).toBe(Math.round((reviewed.body.data.completed / 6) * 100));

    const dismissed = await api().post('/api/v1/onboarding/checklist/dismiss').set(auth).send({});
    expect(dismissed.body.data).toMatchObject({ dismissed: true, dismissedAt: expect.any(String) });
    expect((await api().get('/api/v1/onboarding/checklist').set(auth)).body.data.dismissed).toBe(true);
    const tenantId = seeded().ahmed.id;
    expect(await prismaAdmin.auditLog.count({ where: { tenantId, action: { in: ['onboarding.dismiss', 'onboarding.rates_reviewed'] } } })).toBe(2);
    expect((await api().post('/api/v1/onboarding/checklist/dismiss').set(auth).send({ dismissed: false })).body.data.dismissed).toBe(false);

    const denied = await api().get('/api/v1/onboarding/checklist').set(await malikPm());
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'company.settings.manage' } });
  });
});

describe('opening balances', () => {
  it('supplier udhaar: OPENING ledger entry, shows in the balance, locked after first use, audited', async () => {
    const tenantId = seeded().malik.id;
    const auth = await malikOwner();
    const supplier = await prismaAdmin.supplier.create({ data: { tenantId, name: 'Opening Test Traders', category: 'Cement' } });
    const res = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'SUPPLIER_UDHAAR', supplierId: supplier.id, amountPaisa: '7400000', date: '2026-10-01' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'SUPPLIER_UDHAAR', entity: { id: supplier.id, name: 'Opening Test Traders' }, amountPaisa: '7400000', locked: true });
    expect(await prismaAdmin.supplierLedgerEntry.findFirst({ where: { tenantId, supplierId: supplier.id } })).toMatchObject({ type: 'OPENING', amountPaisa: 7400000n });
    const detail = await api().get(`/api/v1/suppliers/${supplier.id}`).set(auth);
    expect(detail.body.data.udhaarBalancePaisa).toBe('7400000');

    const again = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'SUPPLIER_UDHAAR', supplierId: supplier.id, amountPaisa: '100', date: '2026-10-02' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OPENING_LOCKED');
    expect(await prismaAdmin.supplierLedgerEntry.count({ where: { tenantId, supplierId: supplier.id } })).toBe(1);
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId, action: 'opening_balance.create' } });
    expect(audit.details).toMatchObject({ kind: 'SUPPLIER_UDHAAR', name: 'Opening Test Traders', amountPaisa: '7400000' });

    const list = await api().get('/api/v1/opening-balances').set(auth);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ createdBy: { name: SEED.malik.owner.name } });
  });

  it('cash in hand per munshi, store stock with rate, worker peshgi', async () => {
    const s = seeded();
    const tenantId = s.malik.id;
    const auth = await malikOwner();
    // Cash in hand → OPENING entry in Rafaqat's cash account (counted in the balance)
    const cash = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'CASH_IN_HAND', holderUserId: s.users.rafaqatMalik.id, amountPaisa: '840000', date: '2026-10-01' });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    const entry = await prismaAdmin.cashEntry.findFirstOrThrow({ where: { tenantId, type: 'OPENING' } });
    expect(entry).toMatchObject({ amountPaisa: 840000n, status: 'POSTED' });
    const accounts = await api().get('/api/v1/cash-accounts').set(auth);
    const rafaqat = accounts.body.data.items.find((x: { id: string }) => x.id === entry.accountId);
    expect(rafaqat.balancePaisa).toBe('840000');
    const owner = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'CASH_IN_HAND', holderUserId: s.users.khalid.id, amountPaisa: '100', date: '2026-10-01' });
    expect(owner.body.error.code).toBe('INVALID_HOLDER');

    // Store stock → OPENING_IN at the Central Store at the given rate
    const cement = await prismaAdmin.material.findFirstOrThrow({ where: { tenantId, name: 'Cement OPC' } });
    const stock = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'STORE_STOCK', materialId: cement.id, quantity: 120, ratePaisa: '145000', date: '2026-10-01' });
    expect(stock.status, JSON.stringify(stock.body)).toBe(201);
    expect(stock.body.data).toMatchObject({ quantity: 120, ratePaisa: '145000', amountPaisa: '17400000', entity: { unit: 'bag' } });
    const mv = await prismaAdmin.stockMovement.findFirstOrThrow({ where: { tenantId, type: 'OPENING_IN' }, include: { location: true } });
    expect(mv).toMatchObject({ valuePaisa: 17400000n, unitCostPaisa: 145000n, location: { systemKey: 'CENTRAL_STORE' } });
    const store = await api().get(`/api/v1/stores/${mv.locationId}/stock`).set(auth);
    expect(store.status).toBe(200);
    expect(JSON.stringify(store.body)).toContain('17400000'); // the store value includes the opening stock

    // Worker peshgi → outstanding advance on the worker's project
    const dha = s.projects.dha.id;
    const worker = await prismaAdmin.worker.create({ data: { tenantId, name: 'Opening Peshgi Worker', type: 'MAZDOOR', dailyRatePaisa: 160000n } });
    const notOnTeam = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'WORKER_PESHGI', workerId: worker.id, projectId: dha, amountPaisa: '500000', date: '2026-10-01' });
    expect(notOnTeam.body.error.code).toBe('WORKER_NOT_ASSIGNED');
    expect(await prismaAdmin.openingBalance.count({ where: { tenantId, kind: 'WORKER_PESHGI' } })).toBe(0);
    expect((await api().post(`/api/v1/projects/${dha}/labor/workers`).set(auth).send({ workerId: worker.id, startDate: '2026-09-01' })).status).toBe(201);
    const peshgi = await api().post('/api/v1/opening-balances').set(auth).send({ kind: 'WORKER_PESHGI', workerId: worker.id, projectId: dha, amountPaisa: '500000', date: '2026-10-01' });
    expect(peshgi.status, JSON.stringify(peshgi.body)).toBe(201);
    expect(peshgi.body.data).toMatchObject({ refType: 'ADVANCE', project: { id: dha } });
    expect(await prismaAdmin.advance.findUniqueOrThrow({ where: { id: peshgi.body.data.refId } })).toMatchObject({ amountPaisa: 500000n, paidFrom: 'OFFICE_CASH', workerId: worker.id });

    expect((await api().get('/api/v1/opening-balances?kind=STORE_STOCK').set(auth)).body.data).toHaveLength(1);
  });

  it('needs company.opening.manage (a PM is refused by default)', async () => {
    const res = await api().get('/api/v1/opening-balances').set(await malikPm());
    expect(res.status).toBe(403);
    expect(res.body.error.details.permission).toBe('company.opening.manage');
  });
});

/** Row counts of everything the demo touches, for one company. */
async function footprint(tenantId: string) {
  const w = { where: { tenantId } };
  const counter = await prismaAdmin.tenantCounter.findMany({ ...w, orderBy: { key: 'asc' } });
  return {
    projects: await prismaAdmin.project.count(w),
    clients: await prismaAdmin.client.count(w),
    workers: await prismaAdmin.worker.count(w),
    suppliers: await prismaAdmin.supplier.count(w),
    projectWorkers: await prismaAdmin.projectWorker.count(w),
    attendance: await prismaAdmin.attendance.count(w),
    purchases: await prismaAdmin.purchase.count(w),
    purchaseItems: await prismaAdmin.purchaseItem.count(w),
    stockMovements: await prismaAdmin.stockMovement.count(w),
    stockLocations: await prismaAdmin.stockLocation.count(w),
    supplierLedger: await prismaAdmin.supplierLedgerEntry.count(w),
    cashAccounts: await prismaAdmin.cashAccount.count(w),
    cashEntries: await prismaAdmin.cashEntry.count(w),
    invoices: await prismaAdmin.invoice.count(w),
    invoiceLines: await prismaAdmin.invoiceLine.count(w),
    notifications: await prismaAdmin.notification.count(w),
    attachments: await prismaAdmin.attachment.count(w),
    shortages: await prismaAdmin.shortage.count(w),
    counters: counter.map((c) => `${c.key}=${c.value}`),
  };
}

describe('demo data', () => {
  it('creates one tagged demo project outside the plan limit, and DELETE leaves nothing behind', async () => {
    const tenantId = seeded().ahmed.id;
    const auth = await ahmedOwner();
    const before = await footprint(tenantId);
    const usage = (await api().get('/api/v1/subscription').set(auth)).body.data.usage;

    const res = await api().post('/api/v1/demo').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ project: { code: 'DEMO-001', isDemo: true }, counts: { workers: 4, hazri: 24, purchases: 1, kharcha: 4, invoices: 1 } });
    const projectId = res.body.data.project.id;

    const list = await api().get('/api/v1/projects').set(auth);
    expect(list.body.data.find((p: { id: string }) => p.id === projectId)).toMatchObject({ isDemo: true, status: 'ACTIVE' });
    expect((await api().get('/api/v1/subscription').set(auth)).body.data.usage.activeProjects).toEqual(usage.activeProjects);
    const checklist = (await api().get('/api/v1/onboarding/checklist').set(auth)).body.data;
    expect(checklist.demo).toMatchObject({ id: projectId, code: 'DEMO-001' });
    expect(checklist.counts.workers).toBe(before.workers); // demo workers don't tick the step

    // Real-looking numbers: supplier udhaar, site stock, kharcha, a draft invoice; no document number used
    const purchase = await prismaAdmin.purchase.findFirstOrThrow({ where: { tenantId, projectId } });
    expect(purchase).toMatchObject({ number: 'DEMO-PUR-1', status: 'RECEIVED' });
    expect(await prismaAdmin.stockMovement.count({ where: { tenantId, location: { projectId } } })).toBeGreaterThan(0);
    expect(await prismaAdmin.invoice.findFirst({ where: { tenantId, projectId } })).toMatchObject({ status: 'DRAFT', number: null });
    const live = (await prismaAdmin.tenantCounter.findMany({ where: { tenantId }, orderBy: { key: 'asc' } })).map((c) => `${c.key}=${c.value}`);
    expect(live.filter((c) => !c.endsWith('=0'))).toEqual(before.counters.filter((c) => !c.endsWith('=0'))); // the purchase number was given back

    expect((await api().post('/api/v1/demo').set(auth)).body.error.code).toBe('DEMO_EXISTS');

    const removed = await api().delete('/api/v1/demo').set(auth);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.data).toMatchObject({ removed: true, projectId });
    const after = await footprint(tenantId);
    expect({ ...after, counters: after.counters.filter((c) => !c.endsWith('=0')) }).toEqual({ ...before, counters: before.counters.filter((c) => !c.endsWith('=0')) });
    expect(await prismaAdmin.auditLog.count({ where: { tenantId, action: { in: ['demo.create', 'demo.delete'] } } })).toBe(2);
    expect((await api().delete('/api/v1/demo').set(auth)).body.error.code).toBe('DEMO_NOT_FOUND');
  });

  it('refuses to remove the demo while real data uses it (409 DEMO_IN_USE), then removes it', async () => {
    const tenantId = seeded().malik.id;
    const auth = await malikOwner();
    expect((await api().post('/api/v1/demo').set(auth)).status).toBe(201);
    const demoWorker = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId, isDemo: true } });
    const dha = seeded().projects.dha.id;
    const assigned = await api().post(`/api/v1/projects/${dha}/labor/workers`).set(auth).send({ workerId: demoWorker.id });
    expect(assigned.status).toBe(201);
    const refused = await api().delete('/api/v1/demo').set(auth);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'DEMO_IN_USE', details: { uses: ['DEMO_WORKER_ON_REAL_PROJECT'] } });
    expect(await prismaAdmin.project.count({ where: { tenantId, isDemo: true } })).toBe(1);

    expect((await api().delete(`/api/v1/project-workers/${assigned.body.data.id}`).set(auth)).status).toBe(200);
    expect((await api().delete('/api/v1/demo').set(auth)).status).toBe(200);
    expect(await prismaAdmin.worker.count({ where: { tenantId, isDemo: true } })).toBe(0);
  });

  it('is owner-only', async () => {
    const res = await api().post('/api/v1/demo').set(await malikPm());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });
});
