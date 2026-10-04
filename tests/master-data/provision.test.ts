import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { DEFAULT_LABOR_RATES, PLATFORM_MATERIALS } from '../../src/modules/master-data/catalog.js';
import { provisionMasterData } from '../../src/modules/master-data/provision.js';
import { api, bearer, device, loginAdmin, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const admin = async () => bearer((await loginAdmin()).accessToken);
const NONE = { materials: 0, categories: 0, laborRates: 0, templates: 0 };

async function masterDataOf(tenantId: string) {
  const [materials, categories, laborRates, templates] = await Promise.all([
    prismaAdmin.material.findMany({ where: { tenantId } }),
    prismaAdmin.qualityCategory.findMany({ where: { tenantId }, orderBy: { sortOrder: 'asc' } }),
    prismaAdmin.laborRate.count({ where: { tenantId } }),
    prismaAdmin.paymentScheduleTemplate.findMany({ where: { tenantId } }),
  ]);
  return { materials, categories, laborRates, templates };
}

function expectStarterSet(md: Awaited<ReturnType<typeof masterDataOf>>) {
  expect(md.materials).toHaveLength(PLATFORM_MATERIALS.length);
  expect(md.materials.every((m) => m.source === 'PLATFORM' && m.platformMaterialId && !m.isCustomised && !m.isHidden)).toBe(true);
  expect(md.categories.map((c) => c.code)).toEqual(['A_PLUS', 'A_STD', 'B_ECO']);
  expect(md.categories.filter((c) => c.isDefault).map((c) => c.code)).toEqual(['A_STD']);
  expect(md.laborRates).toBe(DEFAULT_LABOR_RATES.length);
  expect(md.templates).toHaveLength(1);
  expect(md.templates[0]).toMatchObject({ isDefault: true, billingModel: 'STAGE_SCHEDULE' });
}

describe('master data provisioning', () => {
  it('signup copies the catalog, 3 quality categories, labour rates and the default template', async () => {
    const res = await api().post('/api/v1/auth/signup').send({
      companyName: 'Fresh Start Builders',
      ownerName: 'Usman Tariq',
      phone: '03457654321',
      password: 'Builder#2026',
      region: 'PUNJAB_KP',
      client: 'mobile',
      device: device(),
    });
    expect(res.status).toBe(201);
    expectStarterSet(await masterDataOf(res.body.data.tenant.id));
  });

  it('admin create-company copies the same starter set', async () => {
    const res = await api()
      .post('/api/v1/admin/tenants')
      .set(await admin())
      .send({
        company: { name: 'Lahore Grand Builders', phone: '042-35000000', region: 'PUNJAB_KP' },
        owner: { name: 'Imran Qureshi', phone: '03452223334' },
        subscription: { mode: 'TRIAL', planCode: 'PROFESSIONAL' },
      });
    expect(res.status).toBe(201);
    expectStarterSet(await masterDataOf(res.body.data.tenant.id));
  });

  it('backfill is idempotent and fills a company that has nothing', async () => {
    const { ahmed } = seeded();
    // Seeded companies are already provisioned → nothing to add
    expect(await prismaAdmin.$transaction((tx) => provisionMasterData(tx, ahmed.id))).toEqual(NONE);

    // A company created before Step 4 (simulated by wiping its master data)
    const where = { where: { tenantId: ahmed.id } };
    await prismaAdmin.paymentScheduleTemplate.deleteMany(where);
    await prismaAdmin.materialRate.deleteMany(where);
    await prismaAdmin.supplierRate.deleteMany(where);
    await prismaAdmin.laborRate.deleteMany(where);
    await prismaAdmin.projectSupplyRule.deleteMany(where);
    await prismaAdmin.qualityCategory.deleteMany(where);
    await prismaAdmin.material.deleteMany(where);

    const first = await prismaAdmin.$transaction((tx) => provisionMasterData(tx, ahmed.id));
    expect(first).toEqual({ materials: PLATFORM_MATERIALS.length, categories: 3, laborRates: DEFAULT_LABOR_RATES.length, templates: 1 });
    expect(await prismaAdmin.$transaction((tx) => provisionMasterData(tx, ahmed.id))).toEqual(NONE);
    expectStarterSet(await masterDataOf(ahmed.id));
  });
});

describe('platform material catalog (admin)', () => {
  it('lists groups and materials with filters', async () => {
    const auth = await admin();
    const groups = await api().get('/api/v1/admin/material-groups').set(auth);
    expect(groups.status).toBe(200);
    expect(groups.body.data).toHaveLength(12);
    const steelGroup = groups.body.data.find((g: { code: string }) => g.code === 'STEEL');
    expect(steelGroup).toMatchObject({ section: 'CIVIL', materials: 5 });

    const steel = await api().get(`/api/v1/admin/materials?groupId=${steelGroup.id}`).set(auth);
    expect(steel.body.data).toHaveLength(5);
    expect(steel.body.data[0]).toMatchObject({ group: { code: 'STEEL' }, companies: 4 });

    const sand = await api().get('/api/v1/admin/materials?search=sand&supplyCategory=GREY_STRUCTURE').set(auth);
    expect(sand.body.data.map((m: { name: string }) => m.name).sort()).toEqual(['Chenab sand', 'Ravi sand']);
    expect((await api().get('/api/v1/admin/materials?isActive=false').set(auth)).body.data).toHaveLength(0);
  });

  it('a new platform material is pushed to every company, skipping same-name company materials', async () => {
    const { malik, ahmed } = seeded();
    const auth = await admin();
    const group = await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code: 'WATERPROOFING' } });
    // Ahmed already has its own material with this name
    await prismaAdmin.material.create({
      data: { tenantId: ahmed.id, groupId: group.id, name: 'Waterproof coating', unit: 'litre', supplyCategory: 'GREY_STRUCTURE', source: 'COMPANY' },
    });

    const res = await api()
      .post('/api/v1/admin/materials')
      .set(auth)
      .send({ groupId: group.id, name: 'Waterproof coating', unit: 'bucket', unitDetail: '20 kg', altUnits: [{ unit: 'kg', factor: 20 }], supplyCategory: 'GREY_STRUCTURE' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Waterproof coating', unit: 'bucket', pushedTo: 3 });

    const copies = await prismaAdmin.material.findMany({ where: { name: 'Waterproof coating' } });
    expect(copies).toHaveLength(4);
    expect(copies.find((m) => m.tenantId === ahmed.id)).toMatchObject({ source: 'COMPANY', unit: 'litre', platformMaterialId: null });
    expect(copies.find((m) => m.tenantId === malik.id)).toMatchObject({ source: 'PLATFORM', unit: 'bucket', unitDetail: '20 kg', platformMaterialId: res.body.data.id });

    const audit = await prismaAdmin.auditLog.findFirst({ where: { action: 'admin.catalog_material_created', entityId: res.body.data.id } });
    expect(audit?.details).toMatchObject({ pushedTo: 3 });

    const dup = await api().post('/api/v1/admin/materials').set(auth).send({ groupId: group.id, name: 'Waterproof coating', unit: 'bucket', supplyCategory: 'GREY_STRUCTURE' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PLATFORM_MATERIAL_EXISTS');
  });

  it('pushToTenants=false only adds it to the catalog', async () => {
    const group = await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code: 'PAINT' } });
    const res = await api()
      .post('/api/v1/admin/materials')
      .set(await admin())
      .send({ groupId: group.id, name: 'Weather shield', unit: 'gallon', supplyCategory: 'FINISHING', pushToTenants: false });
    expect(res.status).toBe(201);
    expect(res.body.data.pushedTo).toBe(0);
    expect(await prismaAdmin.material.count({ where: { name: 'Weather shield' } })).toBe(0);
  });

  it('edits propagate only to company copies that were never customised; unit is locked', async () => {
    const { malik, ahmed, valley } = seeded();
    const auth = await admin();
    const pm = await prismaAdmin.platformMaterial.findUniqueOrThrow({ where: { name: 'Chenab sand' } });
    // Malik renamed its copy → customised
    await prismaAdmin.material.updateMany({ where: { tenantId: malik.id, platformMaterialId: pm.id }, data: { name: 'Chenab sand (Malik)', isCustomised: true } });
    // Valley already has its own material with the new name → would clash
    const group = await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code: 'AGGREGATES' } });
    await prismaAdmin.material.create({
      data: { tenantId: valley.id, groupId: group.id, name: 'Chenab sand (washed)', unit: 'cft', supplyCategory: 'GREY_STRUCTURE', source: 'COMPANY' },
    });

    const locked = await api().patch(`/api/v1/admin/materials/${pm.id}`).set(auth).send({ unit: 'ton' });
    expect(locked.status).toBe(400);

    const res = await api()
      .patch(`/api/v1/admin/materials/${pm.id}`)
      .set(auth)
      .send({ name: 'Chenab sand (washed)', unitDetail: 'per cft, washed', altUnits: [{ unit: 'truck', factor: 0.001 }] });
    expect(res.status).toBe(200);
    // Ahmed + Old Town updated; Malik customised, Valley name clash
    expect(res.body.data).toMatchObject({ name: 'Chenab sand (washed)', unit: pm.unit, propagatedTo: 2 });

    const copies = await prismaAdmin.material.findMany({ where: { platformMaterialId: pm.id } });
    const of = (tenantId: string) => copies.find((m) => m.tenantId === tenantId)!;
    expect(of(malik.id)).toMatchObject({ name: 'Chenab sand (Malik)', isCustomised: true });
    expect(of(valley.id).name).toBe('Chenab sand');
    expect(of(ahmed.id)).toMatchObject({ name: 'Chenab sand (washed)', unitDetail: 'per cft, washed', altUnits: [{ unit: 'truck', factor: 0.001 }] });

    expect(await prismaAdmin.auditLog.count({ where: { action: 'admin.catalog_material_updated', entityId: pm.id } })).toBe(1);
    const missing = await api().patch('/api/v1/admin/materials/0199a8c0-0000-7000-8000-000000000999').set(auth).send({ name: 'Nothing here' });
    expect(missing.status).toBe(404);
  });
});
