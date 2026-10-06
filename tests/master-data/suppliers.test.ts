import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const supplierId = async (name: string) =>
  (await prismaAdmin.supplier.findUniqueOrThrow({ where: { tenantId_name: { tenantId: seeded().malik.id, name } } })).id;
const materialId = async (name: string) =>
  (await prismaAdmin.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId: seeded().malik.id, name } } })).id;

describe('suppliers', () => {
  it('lists with search / category / isActive filters and pagination', async () => {
    const auth = await pm();
    const all = await api().get('/api/v1/suppliers?limit=2').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(all.body.data[0]).not.toHaveProperty('balancePaisa');

    const cement = await api().get('/api/v1/suppliers?category=cement').set(auth);
    expect(cement.body.data.map((s: { name: string }) => s.name)).toEqual(['Al-Madina Cement Agency']);
    const kasur = await api().get('/api/v1/suppliers?search=kasur').set(auth);
    expect(kasur.body.data.map((s: { name: string }) => s.name)).toEqual(['Chaudhry Bricks Kiln']);
    const byPhone = await api().get('/api/v1/suppliers?search=0333-444').set(auth);
    expect(byPhone.body.data.map((s: { name: string }) => s.name)).toEqual(['Bilal Traders']);
  });

  it('detail shows the current agreed rates', async () => {
    const res = await api().get(`/api/v1/suppliers/${await supplierId('Al-Madina Cement Agency')}`).set(await owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Al-Madina Cement Agency', phone: '+924235761234', isActive: true });
    expect(res.body.data.rates).toEqual([expect.objectContaining({ material: expect.objectContaining({ name: 'Cement OPC' }), ratePaisa: '143000' })]);
  });

  it('PM creates with a landline; duplicate name → 409 SUPPLIER_EXISTS; MUNSHI → 403', async () => {
    const body = { name: 'Lahore Tiles Centre', category: 'Tiles', phone: '042-35880011', city: 'Lahore' };
    const res = await api().post('/api/v1/suppliers').set(await pm()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Lahore Tiles Centre', phone: '+924235880011', isActive: true });

    const dup = await api().post('/api/v1/suppliers').set(await owner()).send({ ...body, name: 'Bilal Traders' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SUPPLIER_EXISTS');

    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().post('/api/v1/suppliers').set(munshi).send(body)).status).toBe(403);
    // A munshi may list suppliers (urgent material from site cash) but never sees udhaar balances
    const list = await api().get('/api/v1/suppliers').set(munshi);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).not.toHaveProperty('udhaarBalancePaisa');
    expect((await api().get(`/api/v1/suppliers/${list.body.data[0].id}`).set(munshi)).status).toBe(403);
  });

  it('PATCH edits and clears fields; renaming onto another supplier → 409', async () => {
    const auth = await owner();
    const id = await supplierId('Bilal Traders');
    const res = await api().patch(`/api/v1/suppliers/${id}`).set(auth).send({ city: 'Sheikhupura', notes: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ city: 'Sheikhupura', notes: null });
    const clash = await api().patch(`/api/v1/suppliers/${id}`).set(auth).send({ name: 'Ittefaq Steel Traders' });
    expect(clash.body.error.code).toBe('SUPPLIER_EXISTS');
  });

  it('deactivate / activate (THEKEDAR only)', async () => {
    const id = await supplierId('Punjab Shuttering Yard');
    expect((await api().post(`/api/v1/suppliers/${id}/deactivate`).set(await pm())).status).toBe(403);
    const auth = await owner();
    expect((await api().post(`/api/v1/suppliers/${id}/deactivate`).set(auth)).body.data.isActive).toBe(false);
    expect((await api().get('/api/v1/suppliers?isActive=false').set(auth)).body.data).toHaveLength(1);
    expect((await api().post(`/api/v1/suppliers/${id}/activate`).set(auth)).body.data.isActive).toBe(true);
  });

  it('PUT rates appends history only for changed rates', async () => {
    const auth = await owner();
    const id = await supplierId('Al-Madina Cement Agency');
    const [opc, src] = [await materialId('Cement OPC'), await materialId('Cement SRC')];
    expect((await api().put(`/api/v1/suppliers/${id}/rates`).set(await pm()).send({ rates: [{ materialId: opc, ratePaisa: 1 }] })).status).toBe(403);

    const first = await api().put(`/api/v1/suppliers/${id}/rates`).set(auth).send({ rates: [{ materialId: opc, ratePaisa: '143000' }, { materialId: src, ratePaisa: '152000' }] });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ changed: 1, unchanged: 1 });

    const second = await api().put(`/api/v1/suppliers/${id}/rates`).set(auth).send({ rates: [{ materialId: opc, ratePaisa: '145000' }] });
    expect(second.body.data).toMatchObject({ changed: 1, unchanged: 0 });

    const rates = await api().get(`/api/v1/suppliers/${id}/rates`).set(await pm());
    expect(rates.status).toBe(200);
    expect(rates.body.data.current.map((r: { ratePaisa: string }) => r.ratePaisa)).toEqual(['145000', '152000']);
    expect(rates.body.data.history).toHaveLength(3);
    expect(rates.body.data.history[0]).toMatchObject({ ratePaisa: '145000', changedBy: { name: 'Khalid Malik' } });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'supplier.rates_update', entityId: id } })).toBe(2);
  });
});
