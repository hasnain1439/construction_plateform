import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const ahmedOwner = async () => bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);

describe('clients', () => {
  it('lists the seeded clients with search and pagination (THEKEDAR, PM)', async () => {
    const auth = await pm();
    const res = await api().get('/api/v1/clients?limit=4').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 6, limit: 4, totalPages: 2 });
    expect(res.body.data[0]).toMatchObject({ name: 'Ahmed Raza', phone: '+923331234567', projectsCount: expect.any(Number) });

    const byPhone = await api().get('/api/v1/clients?search=0300-555').set(auth);
    expect(byPhone.body.data.map((c: { name: string }) => c.name)).toEqual(['Dr. Sana Iqbal']);
    const byName = await api().get('/api/v1/clients?search=naz').set(auth);
    expect(byName.body.data.map((c: { name: string }) => c.name)).toEqual(['Farah Naz']);
  });

  it('creates with a normalised phone; duplicate phone → 409 CLIENT_PHONE_TAKEN', async () => {
    const auth = await owner();
    const res = await api().post('/api/v1/clients').set(auth).send({ name: 'Bilal Chaudhry', phone: '0301 7778899', email: 'Bilal@Example.pk' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ phone: '+923017778899', email: 'bilal@example.pk' });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'client.create', entityId: res.body.data.id } })).toBe(1);

    const dup = await api().post('/api/v1/clients').set(await pm()).send({ name: 'Someone', phone: '+92 333 1234567' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CLIENT_PHONE_TAKEN');
  });

  it('detail and PATCH; moving onto another client’s phone → 409', async () => {
    const auth = await owner();
    const farah = seeded().clients['Farah Naz']!;
    const detail = await api().get(`/api/v1/clients/${farah.id}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ name: 'Farah Naz', projects: expect.any(Array) });

    const patched = await api().patch(`/api/v1/clients/${farah.id}`).set(auth).send({ address: 'Model Town, Lahore', email: null });
    expect(patched.body.data).toMatchObject({ address: 'Model Town, Lahore', email: null });
    const clash = await api().patch(`/api/v1/clients/${farah.id}`).set(auth).send({ phone: '03005556677' });
    expect(clash.body.error.code).toBe('CLIENT_PHONE_TAKEN');
    expect((await api().get('/api/v1/clients/0199a8c0-0000-7000-8000-000000000999').set(auth)).status).toBe(404);
  });

  it('MUNSHI → 403 on every client route', async () => {
    const auth = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().get('/api/v1/clients').set(auth)).status).toBe(403);
    expect((await api().post('/api/v1/clients').set(auth).send({ name: 'X Y', phone: '03001112233' })).status).toBe(403);
  });

  it('RLS: Ahmed sees none of Malik’s clients and cannot read or change them', async () => {
    const auth = await ahmedOwner();
    // Ahmed only has its own client
    expect((await api().get('/api/v1/clients').set(auth)).body.data.map((c: { name: string }) => c.name)).toEqual(['Tariq Mehmood']);
    const sana = seeded().clients['Dr. Sana Iqbal']!;
    expect((await api().get(`/api/v1/clients/${sana.id}`).set(auth)).status).toBe(404);
    expect((await api().patch(`/api/v1/clients/${sana.id}`).set(auth).send({ name: 'Hacked' })).status).toBe(404);
    // The same phone is free in another company
    expect((await api().post('/api/v1/clients').set(auth).send({ name: 'Sana Iqbal', phone: '03005556677' })).status).toBe(201);
    expect(await withTenant(seeded().ahmed.id, (tx) => tx.client.count({ where: { tenantId: seeded().malik.id } }))).toBe(0);
  });
});
