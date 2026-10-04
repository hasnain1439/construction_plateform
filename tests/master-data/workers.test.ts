import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async () => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const ahmedOwner = async () => bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);

describe('workers', () => {
  it('every role lists workers; filters and pagination work', async () => {
    const auth = await munshi();
    const all = await api().get('/api/v1/workers?limit=100').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(14);
    const active = await api().get('/api/v1/workers?isActive=true&limit=100').set(auth);
    expect(active.body.meta.total).toBe(13);
    const mistris = await api().get('/api/v1/workers?type=MISTRI').set(auth);
    expect(mistris.body.data.map((w: { name: string }) => w.name)).toEqual(['Ustad Akram', 'Ustad Nadeem', 'Ustad Rasheed']);
    const akram = mistris.body.data[0];
    expect(akram).toMatchObject({ dailyRatePaisa: '300000', phone: '+923001110001' });
    const search = await api().get('/api/v1/workers?search=0300-1110003').set(auth);
    expect(search.body.data.map((w: { name: string }) => w.name)).toEqual(['Shahid']);
  });

  it('MUNSHI adds a worker; the daily rate defaults from the labour rate for the type', async () => {
    const res = await api().post('/api/v1/workers').set(await munshi()).send({ name: 'Kashif', type: 'MAZDOOR', phone: '0300-1110099' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Kashif', type: 'MAZDOOR', phone: '+923001110099', dailyRatePaisa: '160000', isActive: true });

    const custom = await api().post('/api/v1/workers').set(await owner()).send({ name: 'Ustad Fazal', type: 'MISTRI_TILES', dailyRatePaisa: '350000' });
    expect(custom.body.data.dailyRatePaisa).toBe('350000');

    const other = await api().post('/api/v1/workers').set(await owner()).send({ name: 'Driver Imtiaz', type: 'OTHER' });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('DAILY_RATE_REQUIRED');
    expect(await prismaAdmin.auditLog.count({ where: { action: 'worker.create' } })).toBe(2);
  });

  it('phone is unique within the company → 409 WORKER_PHONE_TAKEN', async () => {
    const auth = await pm();
    const dup = await api().post('/api/v1/workers').set(auth).send({ name: 'Someone', type: 'MAZDOOR', phone: '03001110003' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WORKER_PHONE_TAKEN');

    const naveed = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Naveed' } });
    const patch = await api().patch(`/api/v1/workers/${naveed.id}`).set(auth).send({ phone: '03001110001' });
    expect(patch.body.error.code).toBe('WORKER_PHONE_TAKEN');

    // Another company may use the same number
    const ahmed = await api().post('/api/v1/workers').set(await ahmedOwner()).send({ name: 'Shahid', type: 'MAZDOOR', phone: '03001110003' });
    expect(ahmed.status).toBe(201);
  });

  it('PATCH / deactivate / activate (THEKEDAR, PM); MUNSHI → 403', async () => {
    const zafar = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Zafar' } });
    expect((await api().post(`/api/v1/workers/${zafar.id}/deactivate`).set(await munshi())).status).toBe(403);
    expect((await api().patch(`/api/v1/workers/${zafar.id}`).set(await munshi()).send({ name: 'Zafar Iqbal' })).status).toBe(403);

    const auth = await pm();
    const patched = await api().patch(`/api/v1/workers/${zafar.id}`).set(auth).send({ name: 'Zafar Iqbal', dailyRatePaisa: '170000', phone: null });
    expect(patched.body.data).toMatchObject({ name: 'Zafar Iqbal', dailyRatePaisa: '170000', phone: null });
    expect((await api().post(`/api/v1/workers/${zafar.id}/deactivate`).set(auth)).body.data.isActive).toBe(false);
    expect((await api().get('/api/v1/workers?isActive=false').set(auth)).body.meta.total).toBe(2);
    expect((await api().post(`/api/v1/workers/${zafar.id}/activate`).set(auth)).body.data.isActive).toBe(true);
  });
});

describe('sub-contractors', () => {
  it('every role lists; office roles create; duplicate name → 409', async () => {
    const list = await api().get('/api/v1/subcontractors?trade=SHUTTERING').set(await munshi());
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(['Ustad Sharif Shuttering']);
    expect((await api().get('/api/v1/subcontractors').set(await munshi())).body.meta.total).toBe(6);

    const body = { name: 'Khan Paint House', trade: 'PAINT', phone: '042-35112233' };
    expect((await api().post('/api/v1/subcontractors').set(await munshi()).send(body)).status).toBe(403);
    const res = await api().post('/api/v1/subcontractors').set(await pm()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ trade: 'PAINT', phone: '+924235112233' });
    const dup = await api().post('/api/v1/subcontractors').set(await owner()).send({ ...body, name: 'Rehman Tile Team' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SUBCONTRACTOR_EXISTS');
    expect((await api().post('/api/v1/subcontractors').set(await owner()).send({ ...body, name: 'X Team', trade: 'MISTRI' })).status).toBe(400);
  });

  it('PATCH / deactivate / activate', async () => {
    const auth = await pm();
    const sub = await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Ali Electric Works' } });
    expect((await api().patch(`/api/v1/subcontractors/${sub.id}`).set(auth).send({ notes: 'DB + wiring' })).body.data.notes).toBe('DB + wiring');
    expect((await api().post(`/api/v1/subcontractors/${sub.id}/deactivate`).set(auth)).body.data.isActive).toBe(false);
    expect((await api().post(`/api/v1/subcontractors/${sub.id}/activate`).set(auth)).body.data.isActive).toBe(true);
  });
});

describe('tenant isolation (RLS)', () => {
  it('Ahmed gets only the copied defaults — none of Malik’s rates, suppliers, workers or sub-contractors', async () => {
    const auth = await ahmedOwner();
    expect((await api().get('/api/v1/workers').set(auth)).body.meta.total).toBe(0);
    expect((await api().get('/api/v1/subcontractors').set(auth)).body.meta.total).toBe(0);
    expect((await api().get('/api/v1/suppliers').set(auth)).body.meta.total).toBe(0);
    const prices = await api().get('/api/v1/price-list').set(auth);
    expect(prices.body.data.items.every((i: { ratePaisa: string | null }) => i.ratePaisa === null)).toBe(true);
    expect((await api().get('/api/v1/materials').set(auth)).body.data).toHaveLength(40);
    expect((await api().get('/api/v1/payment-templates').set(auth)).body.data).toHaveLength(1);
  });

  it('Ahmed cannot read or change Malik’s materials, rates, suppliers or workers', async () => {
    const { malik } = seeded();
    const auth = await ahmedOwner();
    const cement = await prismaAdmin.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId: malik.id, name: 'Cement OPC' } } });
    const supplier = await prismaAdmin.supplier.findFirstOrThrow({ where: { tenantId: malik.id } });
    const worker = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: malik.id } });
    const sub = await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId: malik.id } });
    const malikStd = await prismaAdmin.qualityCategory.findFirstOrThrow({ where: { tenantId: malik.id, code: 'A_STD' } });

    expect((await api().patch(`/api/v1/materials/${cement.id}`).set(auth).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().post(`/api/v1/materials/${cement.id}/hide`).set(auth)).status).toBe(404);
    expect((await api().get(`/api/v1/price-list/history?materialId=${cement.id}`).set(auth)).status).toBe(404);
    expect((await api().get(`/api/v1/price-list?categoryId=${malikStd.id}`).set(auth)).status).toBe(404);
    expect((await api().put('/api/v1/price-list').set(auth).send({ categoryId: malikStd.id, rates: [{ materialId: cement.id, ratePaisa: 1 }] })).status).toBe(404);
    expect((await api().get(`/api/v1/suppliers/${supplier.id}`).set(auth)).status).toBe(404);
    expect((await api().put(`/api/v1/suppliers/${supplier.id}/rates`).set(auth).send({ rates: [{ materialId: cement.id, ratePaisa: 1 }] })).status).toBe(404);
    expect((await api().patch(`/api/v1/workers/${worker.id}`).set(auth).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().post(`/api/v1/subcontractors/${sub.id}/deactivate`).set(auth)).status).toBe(404);

    // Nothing changed
    expect((await prismaAdmin.material.findUniqueOrThrow({ where: { id: cement.id } })).name).toBe('Cement OPC');
    expect((await prismaAdmin.worker.findUniqueOrThrow({ where: { id: worker.id } })).name).toBe(worker.name);

    // At the database level too: Ahmed's RLS context sees zero Malik rows
    const seen = await withTenant(seeded().ahmed.id, async (tx) => ({
      materials: await tx.material.count({ where: { tenantId: malik.id } }),
      rates: await tx.materialRate.count({ where: { tenantId: malik.id } }),
      suppliers: await tx.supplier.count({ where: { tenantId: malik.id } }),
      supplierRates: await tx.supplierRate.count({ where: { tenantId: malik.id } }),
      workers: await tx.worker.count({ where: { tenantId: malik.id } }),
      subcontractors: await tx.subcontractor.count({ where: { tenantId: malik.id } }),
      templates: await tx.paymentScheduleTemplate.count({ where: { tenantId: malik.id } }),
      laborRates: await tx.laborRate.count({ where: { tenantId: malik.id } }),
      categories: await tx.qualityCategory.count({ where: { tenantId: malik.id } }),
    }));
    expect(Object.values(seen).every((n) => n === 0)).toBe(true);
  });
});
