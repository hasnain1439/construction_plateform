import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async () => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const materialId = async (name: string, tenantId = seeded().malik.id) =>
  (await prismaAdmin.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } })).id;
const groupId = async (code: string) => (await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code } })).id;

describe('GET /materials and /material-groups', () => {
  it('every role reads materials, and the rows never carry rates', async () => {
    const auth = await munshi();
    const groups = await api().get('/api/v1/material-groups').set(auth);
    expect(groups.status).toBe(200);
    expect(groups.body.data).toHaveLength(12);
    expect(groups.body.data[0]).toMatchObject({ code: expect.any(String), section: expect.stringMatching(/CIVIL|FINISHING/), sortOrder: expect.any(Number) });

    const res = await api().get('/api/v1/materials').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(40);
    const cement = res.body.data.find((m: { name: string }) => m.name === 'Cement OPC');
    expect(Object.keys(cement).sort()).toEqual(['altUnits', 'group', 'id', 'isHidden', 'name', 'source', 'supplyCategory', 'unit', 'unitDetail']);
    expect(JSON.stringify(res.body)).not.toMatch(/rate|paisa|specification/i);
  });

  it('filters by group, search and supply category', async () => {
    const auth = await owner();
    const steel = await api().get(`/api/v1/materials?groupId=${await groupId('STEEL')}`).set(auth);
    expect(steel.body.data).toHaveLength(5);
    const sand = await api().get('/api/v1/materials?search=SAND').set(auth);
    expect(sand.body.data.map((m: { name: string }) => m.name).sort()).toEqual(['Chenab sand', 'Ravi sand']);
    const finishing = await api().get('/api/v1/materials?supplyCategory=FINISHING').set(auth);
    expect(finishing.body.data.every((m: { supplyCategory: string }) => m.supplyCategory === 'FINISHING')).toBe(true);
  });
});

describe('material changes', () => {
  it('PM adds a company material; duplicate name → 409 MATERIAL_EXISTS; MUNSHI → 403', async () => {
    const auth = await pm();
    const body = { groupId: await groupId('CEMENT'), name: 'Cement Fauji 40kg', unit: 'bag', unitDetail: '1 bag = 40 kg' };
    const res = await api().post('/api/v1/materials').set(auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Cement Fauji 40kg', source: 'COMPANY', supplyCategory: 'GREY_STRUCTURE', group: { code: 'CEMENT' } });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'material.create', entityId: res.body.data.id } })).toBe(1);

    const dup = await api().post('/api/v1/materials').set(auth).send({ ...body, name: 'Cement OPC' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('MATERIAL_EXISTS');
    expect((await api().post('/api/v1/materials').set(await munshi()).send(body)).status).toBe(403);
  });

  it('editing marks the row customised; unit is locked for catalog materials and materials with rates', async () => {
    const auth = await owner();
    const cement = await materialId('Cement OPC');
    const locked = await api().patch(`/api/v1/materials/${cement}`).set(auth).send({ unit: 'kg' });
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe('UNIT_LOCKED');

    const renamed = await api().patch(`/api/v1/materials/${cement}`).set(auth).send({ name: 'Cement OPC (Lucky)' });
    expect(renamed.status).toBe(200);
    expect((await prismaAdmin.material.findUniqueOrThrow({ where: { id: cement } })).isCustomised).toBe(true);

    // Company material: unit editable until it gets a rate
    const custom = await api().post('/api/v1/materials').set(auth).send({ groupId: await groupId('OTHER'), name: 'Jaali', unit: 'sqft' });
    const id = custom.body.data.id;
    expect((await api().patch(`/api/v1/materials/${id}`).set(auth).send({ unit: 'rft' })).body.data.unit).toBe('rft');
    const std = await prismaAdmin.qualityCategory.findFirstOrThrow({ where: { tenantId: seeded().malik.id, code: 'A_STD' } });
    await api().put('/api/v1/price-list').set(auth).send({ categoryId: std.id, rates: [{ materialId: id, ratePaisa: '25000' }] });
    const lockedNow = await api().patch(`/api/v1/materials/${id}`).set(auth).send({ unit: 'sqft' });
    expect(lockedNow.body.error.code).toBe('UNIT_LOCKED');
  });

  it('hide / show (THEKEDAR); hidden rows only with includeHidden for office roles', async () => {
    const auth = await owner();
    const tank = await materialId('Water tank');
    expect((await api().post(`/api/v1/materials/${tank}/hide`).set(await pm())).status).toBe(403);
    const hidden = await api().post(`/api/v1/materials/${tank}/hide`).set(auth);
    expect(hidden.body.data.isHidden).toBe(true);

    expect((await api().get('/api/v1/materials').set(auth)).body.data).toHaveLength(39);
    expect((await api().get('/api/v1/materials?includeHidden=true').set(auth)).body.data).toHaveLength(40);
    expect((await api().get('/api/v1/materials?includeHidden=true').set(await munshi())).body.data).toHaveLength(39);

    const shown = await api().post(`/api/v1/materials/${tank}/show`).set(auth);
    expect(shown.body.data.isHidden).toBe(false);
    expect(await prismaAdmin.auditLog.count({ where: { entityId: tank, action: { in: ['material.hide', 'material.show'] } } })).toBe(2);
  });

  it('delete: only company materials without rates; otherwise 409 MATERIAL_IN_USE', async () => {
    const auth = await owner();
    const platform = await api().delete(`/api/v1/materials/${await materialId('Marble')}`).set(auth);
    expect(platform.status).toBe(409);
    expect(platform.body.error.code).toBe('MATERIAL_IN_USE');

    const make = async (name: string) =>
      (await api().post('/api/v1/materials').set(auth).send({ groupId: await groupId('OTHER'), name, unit: 'nos' })).body.data.id as string;
    const used = await make('Scaffolding pipe');
    const std = await prismaAdmin.qualityCategory.findFirstOrThrow({ where: { tenantId: seeded().malik.id, code: 'A_STD' } });
    await api().put('/api/v1/price-list').set(auth).send({ categoryId: std.id, rates: [{ materialId: used, ratePaisa: 50000 }] });
    const inUse = await api().delete(`/api/v1/materials/${used}`).set(auth);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('MATERIAL_IN_USE');

    const free = await make('Spare nails');
    expect((await api().delete(`/api/v1/materials/${free}`).set(auth)).status).toBe(200);
    expect(await prismaAdmin.material.count({ where: { id: free } })).toBe(0);
  });
});
