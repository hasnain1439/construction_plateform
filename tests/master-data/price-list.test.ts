import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const category = (code: string) => prismaAdmin.qualityCategory.findFirstOrThrow({ where: { tenantId: seeded().malik.id, code } });
const materialId = async (name: string) =>
  (await prismaAdmin.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId: seeded().malik.id, name } } })).id;

type Item = { material: { name: string }; ratePaisa: string | null; specification: string | null; lastUpdatedBy: { name: string } | null };
const itemOf = (items: Item[], name: string) => items.find((i) => i.material.name === name)!;

describe('quality categories', () => {
  it('lists the three seeded categories (THEKEDAR / PM); MUNSHI → 403', async () => {
    const res = await api().get('/api/v1/quality-categories').set(await pm());
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { code: string }) => c.code)).toEqual(['A_PLUS', 'A_STD', 'B_ECO']);
    expect(res.body.data[1]).toMatchObject({ isDefault: true, ratedMaterials: 8 });
    expect((await api().get('/api/v1/quality-categories').set(bearer((await loginMunshi(seeded().malik.id)).accessToken))).status).toBe(403);
  });

  it('create with copyRatesFromCategoryId copies current rates; code is validated; duplicate → 409', async () => {
    const auth = await owner();
    const aPlus = await category('A_PLUS');
    const bad = await api().post('/api/v1/quality-categories').set(auth).send({ name: 'Lux', code: 'lux' });
    expect(bad.status).toBe(400);

    const res = await api().post('/api/v1/quality-categories').set(auth).send({ name: 'A Luxury', code: 'A_LUX', copyRatesFromCategoryId: aPlus.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'A_LUX', isDefault: false, copiedRates: 8, sortOrder: 4 });

    const list = await api().get(`/api/v1/price-list?categoryId=${res.body.data.id}`).set(auth);
    expect(itemOf(list.body.data.items, 'Cement OPC')).toMatchObject({ ratePaisa: '155000', specification: 'DG Khan / Bestway' });

    const dup = await api().post('/api/v1/quality-categories').set(auth).send({ name: 'Another', code: 'A_LUX' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CATEGORY_EXISTS');
  });

  it('duplicate copies the current rates of the source', async () => {
    const auth = await owner();
    const eco = await category('B_ECO');
    const res = await api().post(`/api/v1/quality-categories/${eco.id}/duplicate`).set(auth).send({ name: 'B Economy 2027', code: 'B_ECO27' });
    expect(res.status).toBe(201);
    expect(res.body.data.copiedRates).toBe(8);
    expect(await prismaAdmin.materialRate.count({ where: { categoryId: res.body.data.id } })).toBe(8);
  });

  it('exactly one default: making B the default clears A; the default cannot be unset or archived', async () => {
    const auth = await owner();
    const [std, eco] = [await category('A_STD'), await category('B_ECO')];
    expect((await api().patch(`/api/v1/quality-categories/${std.id}`).set(auth).send({ isDefault: false })).status).toBe(400);

    const res = await api().patch(`/api/v1/quality-categories/${eco.id}`).set(auth).send({ isDefault: true, description: 'Budget jobs' });
    expect(res.status).toBe(200);
    const defaults = await prismaAdmin.qualityCategory.findMany({ where: { tenantId: seeded().malik.id, isDefault: true } });
    expect(defaults.map((c) => c.code)).toEqual(['B_ECO']);

    const archiveDefault = await api().post(`/api/v1/quality-categories/${eco.id}/archive`).set(auth);
    expect(archiveDefault.status).toBe(400);
    expect(archiveDefault.body.error.code).toBe('CATEGORY_IS_DEFAULT');
  });

  it('archive hides the category unless it is the last active one', async () => {
    const auth = await owner();
    const [aPlus, std] = [await category('A_PLUS'), await category('A_STD')];
    expect((await api().post(`/api/v1/quality-categories/${aPlus.id}/archive`).set(auth)).body.data.isArchived).toBe(true);
    expect((await api().get('/api/v1/quality-categories').set(auth)).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/quality-categories?includeArchived=true').set(auth)).body.data).toHaveLength(3);

    // Leave only A_STD active, then it can't go (it's the default and the last one)
    const eco = await category('B_ECO');
    await api().post(`/api/v1/quality-categories/${eco.id}/archive`).set(auth);
    await prismaAdmin.qualityCategory.update({ where: { id: std.id }, data: { isDefault: false } });
    const last = await api().post(`/api/v1/quality-categories/${std.id}/archive`).set(auth);
    expect(last.body.error.code).toBe('LAST_ACTIVE_CATEGORY');
  });
});

describe('price list', () => {
  it('defaults to the default category, shows current rates with who set them, excludes hidden; MUNSHI → 403', async () => {
    const res = await api().get('/api/v1/price-list').set(await pm());
    expect(res.status).toBe(200);
    expect(res.body.data.category.code).toBe('A_STD');
    expect(res.body.data.items).toHaveLength(40);
    expect(itemOf(res.body.data.items, 'Cement OPC')).toMatchObject({ ratePaisa: '145000', specification: 'Lucky / Maple Leaf', lastUpdatedBy: { name: 'Khalid Malik' } });
    expect(itemOf(res.body.data.items, 'Marble')).toMatchObject({ ratePaisa: null, lastUpdatedBy: null });

    await prismaAdmin.material.updateMany({ where: { tenantId: seeded().malik.id, name: 'Marble' }, data: { isHidden: true } });
    expect((await api().get('/api/v1/price-list').set(await pm())).body.data.items).toHaveLength(39);

    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().get('/api/v1/price-list').set(munshi)).status).toBe(403);
    expect((await api().get(`/api/v1/price-list/history?materialId=${await materialId('Cement OPC')}`).set(munshi)).status).toBe(403);
  });

  it('PUT writes a history row only for changed rates; PM → 403', async () => {
    const auth = await owner();
    const std = await category('A_STD');
    const [cement, bricks, marble] = [await materialId('Cement OPC'), await materialId('Clay bricks Class-1'), await materialId('Marble')];
    const body = {
      categoryId: std.id,
      rates: [
        { materialId: cement, ratePaisa: '145000' }, // same rate, spec carried → unchanged
        { materialId: bricks, ratePaisa: 1800 }, // changed
        { materialId: marble, ratePaisa: '35000', specification: 'Ziarat white' }, // new
      ],
    };
    expect((await api().put('/api/v1/price-list').set(await pm()).send(body)).status).toBe(403);

    const before = await prismaAdmin.materialRate.count({ where: { categoryId: std.id } });
    const res = await api().put('/api/v1/price-list').set(auth).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: 2, unchanged: 1 });
    expect(await prismaAdmin.materialRate.count({ where: { categoryId: std.id } })).toBe(before + 2);

    // Changing only the specification is a change too
    const spec = await api().put('/api/v1/price-list').set(auth).send({ categoryId: std.id, rates: [{ materialId: cement, ratePaisa: '145000', specification: 'Lucky only' }] });
    expect(spec.body.data).toMatchObject({ changed: 1, unchanged: 0 });

    const audit = await prismaAdmin.auditLog.findFirst({ where: { action: 'price_list.update' }, orderBy: { createdAt: 'asc' } });
    expect(audit?.details).toMatchObject({ category: 'A_STD', changed: 2, unchanged: 1 });

    const unknown = await api().put('/api/v1/price-list').set(auth).send({ categoryId: std.id, rates: [{ materialId: '0199a8c0-0000-7000-8000-000000000999', ratePaisa: 1 }] });
    expect(unknown.body.error.code).toBe('INVALID_MATERIAL');
  });

  it('bulk-percent rounds to the nearest rupee and respects the material filter', async () => {
    const auth = await owner();
    const std = await category('A_STD');
    const [cement, bricks] = [await materialId('Cement OPC'), await materialId('Clay bricks Class-1')];
    const res = await api().post('/api/v1/price-list/bulk-percent').set(auth).send({ categoryId: std.id, percent: 7, materialIds: [cement, bricks] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: 2, unchanged: 0 });
    const items = (await api().get('/api/v1/price-list').set(auth)).body.data.items;
    expect(itemOf(items, 'Cement OPC').ratePaisa).toBe('155200'); // 1,450 × 1.07 = 1,551.5 → 1,552
    expect(itemOf(items, 'Clay bricks Class-1').ratePaisa).toBe('1800'); // 17 × 1.07 = 18.19 → 18
    expect(itemOf(items, 'Steel Grade-60 #4').ratePaisa).toBe('28500000'); // untouched

    const group = await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code: 'STEEL' } });
    const steel = await api().post('/api/v1/price-list/bulk-percent').set(auth).send({ categoryId: std.id, percent: -10, groupId: group.id });
    expect(steel.body.data.changed).toBe(1);
    expect((await api().post('/api/v1/price-list/bulk-percent').set(auth).send({ categoryId: std.id, percent: 150 })).status).toBe(400);
  });

  it('current rate = latest effectiveFrom ≤ now; history lists every row newest first', async () => {
    const { malik, users } = seeded();
    const auth = await owner();
    const std = await category('A_STD');
    const cement = await materialId('Cement OPC');
    // A rate that only takes effect tomorrow
    await prismaAdmin.materialRate.create({
      data: { tenantId: malik.id, materialId: cement, categoryId: std.id, ratePaisa: 160000n, effectiveFrom: new Date(Date.now() + 86_400_000), createdById: users.khalid.id },
    });
    const items = (await api().get('/api/v1/price-list').set(auth)).body.data.items;
    expect(itemOf(items, 'Cement OPC').ratePaisa).toBe('145000');

    const history = await api().get(`/api/v1/price-list/history?materialId=${cement}&categoryId=${std.id}`).set(await pm());
    expect(history.status).toBe(200);
    expect(history.body.data.history.map((h: { ratePaisa: string }) => h.ratePaisa)).toEqual(['160000', '145000', '140000']);
    expect(history.body.data.history[1]).toMatchObject({ category: { code: 'A_STD' }, changedBy: { name: 'Khalid Malik' } });
    const all = await api().get(`/api/v1/price-list/history?materialId=${cement}`).set(auth);
    expect(all.body.data.history).toHaveLength(5);
  });
});
