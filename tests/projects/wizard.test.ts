import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

let phoneSeq = 0;
async function draft(auth: Record<string, string>) {
  phoneSeq += 1;
  const res = await api()
    .post('/api/v1/projects')
    .set(auth)
    .send({
      name: 'Wizard test house',
      newClient: { name: 'Test Client', phone: `0300-55500${String(phoneSeq).padStart(2, '0')}` },
      siteAddress: 'Plot 5, Sector C',
      city: 'Lahore',
      startDate: '2026-11-01',
      endDate: '2027-09-30',
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}
const stages = (...p: number[]) => p.map((percent, i) => ({ label: `Stage ${i + 1}`, percent }));
const category = (code: string) => prismaAdmin.qualityCategory.findFirstOrThrow({ where: { tenantId: seeded().malik.id, code } });

describe('access', () => {
  it('a PM cannot edit a project they are not assigned to (404); an assigned PM can', async () => {
    const id = await draft(await owner());
    const body = { name: 'Renamed' };
    expect((await api().patch(`/api/v1/projects/${id}/basic`).set(await pm()).send(body)).status).toBe(404);
    expect((await api().patch(`/api/v1/projects/${id}/contract`).set(await pm()).send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '100' })).status).toBe(404);
    const dha = seeded().projects.dha.id;
    expect((await api().patch(`/api/v1/projects/${dha}/basic`).set(await pm()).send(body)).status).toBe(200);
  });

  it('supply presets are readable by every role', async () => {
    const res = await api().get('/api/v1/supply-presets').set(bearer((await loginMunshi(seeded().malik.id)).accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { contractType: string }) => p.contractType)).toEqual(['FULL', 'GREY_OWNER_FINISHING', 'LABOR_ONLY']);
    const grey = res.body.data[1].rules;
    expect(grey.filter((r: { suppliedBy: string }) => r.suppliedBy === 'CONTRACTOR').map((r: { categoryKey: string }) => r.categoryKey)).toEqual([
      'CEMENT',
      'BRICKS',
      'STEEL',
      'SAND_BAJRI',
      'PIPES',
    ]);
  });
});

describe('tab 1 + team', () => {
  it('basic edit checks the code and dates; team replaces PM / Munshis with matching roles (THEKEDAR only)', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const dha = await prismaAdmin.project.findUniqueOrThrow({ where: { id: seeded().projects.dha.id } });
    expect((await api().patch(`/api/v1/projects/${id}/basic`).set(auth).send({ code: dha.code })).body.error.code).toBe('PROJECT_CODE_TAKEN');
    expect((await api().patch(`/api/v1/projects/${id}/basic`).set(auth).send({ startDate: '2028-01-01' })).body.error.code).toBe('INVALID_DATES');

    const { users } = seeded();
    const bad = await api().put(`/api/v1/projects/${id}/team`).set(auth).send({ munshiIds: [users.bilal.id] });
    expect(bad.body.error.code).toBe('INVALID_MUNSHI');
    const ok = await api().put(`/api/v1/projects/${id}/team`).set(auth).send({ pmId: users.bilal.id, munshiIds: [users.rafaqatMalik.id] });
    expect(ok.body.data.team).toEqual({ pm: { id: users.bilal.id, name: 'Bilal Ahmed' }, munshis: [{ id: users.rafaqatMalik.id, name: 'Rafaqat Ali' }] });
    const cleared = await api().put(`/api/v1/projects/${id}/team`).set(auth).send({ pmId: null });
    expect(cleared.body.data.team).toMatchObject({ pm: null, munshis: [{ id: users.rafaqatMalik.id }] });
    expect((await api().put(`/api/v1/projects/${id}/team`).set(await pm()).send({ pmId: null })).status).toBe(403);
  });
});

describe('tab 2 — contract', () => {
  it('stages must total 100 → 400 PERCENT_TOTAL_INVALID {total}; one retention max', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const base = { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1000000000' };
    const short = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ ...base, billingStages: stages(50, 45) });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatchObject({ code: 'PERCENT_TOTAL_INVALID', details: { total: 95 } });
    const twoRet = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ ...base, billingStages: [{ label: 'A', percent: 90 }, { label: 'R1', percent: 5, isRetention: true }, { label: 'R2', percent: 5, isRetention: true }] });
    expect(twoRet.body.error.code).toBe('RETENTION_STAGE_INVALID');
    const noValue = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE' });
    expect(noValue.body.error.code).toBe('CONTRACT_VALUE_REQUIRED');
  });

  it('applies the preset with the default quality category, the default template, and splits amounts to the rupee', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const std = await category('A_STD');
    const res = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1850000000' });
    expect(res.status).toBe(200);
    const p = res.body.data;
    const cement = p.supplyRules.find((r: { categoryKey: string }) => r.categoryKey === 'CEMENT');
    const tiles = p.supplyRules.find((r: { categoryKey: string }) => r.categoryKey === 'TILES_FLOORING');
    expect(cement).toMatchObject({ suppliedBy: 'CONTRACTOR', qualityCategory: { id: std.id, code: 'A_STD' } });
    expect(tiles).toMatchObject({ suppliedBy: 'OWNER', qualityCategory: null });
    // Company default template = Residential standard (8 stages)
    expect(p.billingStages.map((s: { percent: number }) => s.percent)).toEqual([15, 15, 20, 15, 10, 10, 10, 5]);
    expect(p.billingStages[0].amountPaisa).toBe('277500000');
    expect(p.billingStages[7]).toMatchObject({ isRetention: true, amountPaisa: '92500000' });
    expect(p.wizardCompletedSteps).toEqual([1, 2]);

    const thirds = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1000050', billingStages: stages(33.33, 33.33, 33.34) });
    // 10,000.50 × 33.33 % = 3,333.17 → 3,333; last stage absorbs the rest
    expect(thirds.body.data.billingStages.map((s: { amountPaisa: string }) => s.amountPaisa)).toEqual(['333300', '333300', '333450']);

    // PM without financials: stage amounts omitted
    await api().put(`/api/v1/projects/${id}/team`).set(auth).send({ pmId: seeded().users.bilal.id });
    const asPm = await api().get(`/api/v1/projects/${id}`).set(await pm());
    expect(asPm.body.data.billingStages[0]).not.toHaveProperty('amountPaisa');
    expect(asPm.body.data.contract).not.toHaveProperty('contractTotalPaisa');
  });

  it('labour-only needs a rate; stage amounts = rate × covered area once coverage is known', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const noRate = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ contractType: 'LABOR_ONLY', billingModel: 'RUNNING_BILLS' });
    expect(noRate.body.error.code).toBe('RATE_REQUIRED');

    const res = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ contractType: 'LABOR_ONLY', billingModel: 'RUNNING_BILLS', ratePerSqftPaisa: '45000', billingStages: [{ label: 'Running bills', percent: 95 }, { label: 'Retention', percent: 5, isRetention: true }] });
    expect(res.body.data.supplyRules.every((r: { suppliedBy: string }) => r.suppliedBy === 'OWNER')).toBe(true);
    expect(res.body.data.billingStages.map((s: { amountPaisa: string }) => s.amountPaisa)).toEqual(['0', '0']);
    expect(res.body.data.contract).toMatchObject({ ratePerSqftPaisa: '45000', contractValuePaisa: null, contractTotalPaisa: null });

    const cov = await api().patch(`/api/v1/projects/${id}/coverage`).set(auth).send({ coveredAreaSqft: 2000, boundaryWall: false });
    // Rs 450 × 2,000 sq ft = Rs 9,00,000
    expect(cov.body.data.contract.contractTotalPaisa).toBe('90000000');
    expect(cov.body.data.billingStages.map((s: { amountPaisa: string }) => s.amountPaisa)).toEqual(['85500000', '4500000']);
  });

  it('supply rule overrides: owner rows take no category, contractor rows need one, locked rows cannot change', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const plus = await category('A_PLUS');
    const base = { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '500000000' };
    const ownerWithCat = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ ...base, supplyRules: [{ categoryKey: 'PAINT', suppliedBy: 'OWNER', qualityCategoryId: plus.id }] });
    expect(ownerWithCat.status).toBe(400);
    expect(ownerWithCat.body.error.code).toBe('QUALITY_CATEGORY_NOT_ALLOWED');
    const contractorNoCat = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ ...base, supplyRules: [{ categoryKey: 'PAINT', suppliedBy: 'CONTRACTOR' }] });
    expect(contractorNoCat.body.error.code).toBe('QUALITY_CATEGORY_REQUIRED');

    const ok = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ ...base, supplyRules: [{ categoryKey: 'PAINT', suppliedBy: 'OWNER' }, { categoryKey: 'STEEL', suppliedBy: 'CONTRACTOR', qualityCategoryId: plus.id }] });
    expect(ok.status).toBe(200);
    const rule = (k: string) => ok.body.data.supplyRules.find((r: { categoryKey: string }) => r.categoryKey === k);
    expect(rule('PAINT')).toMatchObject({ suppliedBy: 'OWNER', qualityCategory: null });
    expect(rule('STEEL').qualityCategory.code).toBe('A_PLUS');
    expect(rule('CEMENT').qualityCategory.code).toBe('A_STD');

    await prismaAdmin.projectSupplyRule.updateMany({ where: { projectId: id, categoryKey: 'STEEL' }, data: { lockedAt: new Date() } });
    const locked = await api().patch(`/api/v1/projects/${id}/contract`).set(auth).send({ ...base, supplyRules: [{ categoryKey: 'STEEL', suppliedBy: 'OWNER' }] });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('SUPPLY_RULE_LOCKED');
  });

  it('templateId copies a payment template’s stages', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const commercial = await prismaAdmin.paymentScheduleTemplate.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Commercial' } });
    const res = await api()
      .patch(`/api/v1/projects/${id}/contract`)
      .set(auth)
      .send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1000000000', templateId: commercial.id });
    expect(res.body.data.billingStages.map((s: { percent: number }) => s.percent)).toEqual([10, 20, 20, 20, 20, 5, 5]);
  });
});

describe('tab 3 — plot & structure, tab 4 — coverage', () => {
  const plot = (floors: Array<{ level: string; ceilingHeightFt: number }>, extra: Record<string, unknown> = {}) => ({
    plotUnit: 'MARLA',
    plotSize: 10,
    frontFt: 35,
    depthFt: 65,
    structureType: 'FRAMED',
    hasBasement: false,
    floors,
    ...extra,
  });

  it('creates floors, rejects a basement without hasBasement, and guards floors that have rooms', async () => {
    const auth = await owner();
    const id = await draft(auth);
    expect((await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot([{ level: 'BASEMENT', ceilingHeightFt: 10 }, { level: 'GROUND', ceilingHeightFt: 11 }]))).status).toBe(400);
    expect((await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot([{ level: 'FIRST', ceilingHeightFt: 10 }]))).status).toBe(400);
    expect((await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot([{ level: 'GROUND', ceilingHeightFt: 11 }], { hasBasement: true }))).status).toBe(400);

    const res = await api()
      .patch(`/api/v1/projects/${id}/plot-structure`)
      .set(auth)
      .send(plot([{ level: 'GROUND', ceilingHeightFt: 11 }, { level: 'FIRST', ceilingHeightFt: 10 }, { level: 'MUMTY', ceilingHeightFt: 9 }]));
    expect(res.status).toBe(200);
    expect(res.body.data.floors.map((f: { level: string; name: string }) => `${f.level}:${f.name}`)).toEqual(['GROUND:Ground floor', 'FIRST:First floor', 'MUMTY:Mumty']);
    expect(res.body.data.calculations).toMatchObject({ plotAreaSqft: 2250, frontageAreaSqft: 2275, plotAreaMismatch: false });

    // A room on the first floor → removing that floor needs force
    const first = await prismaAdmin.floor.findFirstOrThrow({ where: { projectId: id, level: 'FIRST' } });
    await prismaAdmin.room.create({
      data: { tenantId: seeded().malik.id, projectId: id, floorId: first.id, type: 'BEDROOM', name: 'Bedroom', lengthFt: 14, widthFt: 12, heightFt: 10 },
    });
    const twoFloors = plot([{ level: 'GROUND', ceilingHeightFt: 11 }, { level: 'MUMTY', ceilingHeightFt: 9 }]);
    const blocked = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(twoFloors);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'FLOOR_HAS_ROOMS', details: { levels: ['FIRST'] } });
    const forced = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send({ ...twoFloors, force: true });
    expect(forced.body.data.floors).toHaveLength(2);
    expect(await prismaAdmin.room.count({ where: { projectId: id } })).toBe(0);
  });

  it('kanal plots, and a front × depth mismatch over 10 % is flagged', async () => {
    const auth = await owner();
    const id = await draft(auth);
    const res = await api()
      .patch(`/api/v1/projects/${id}/plot-structure`)
      .set(auth)
      .send(plot([{ level: 'GROUND', ceilingHeightFt: 11 }], { plotUnit: 'KANAL', plotSize: 1, marlaStandard: 272.25, frontFt: 50, depthFt: 90 }));
    expect(res.body.data.plot.marlaStandard).toBe(272.25);
    expect(res.body.data.calculations).toMatchObject({ plotAreaSqft: 5445, frontageAreaSqft: 4500, plotAreaMismatch: true });
  });

  it('coverage requires the boundary details when there is a boundary wall', async () => {
    const auth = await owner();
    const id = await draft(auth);
    expect((await api().patch(`/api/v1/projects/${id}/coverage`).set(auth).send({ coveredAreaSqft: 3950, boundaryWall: true })).status).toBe(400);
    expect((await api().patch(`/api/v1/projects/${id}/coverage`).set(auth).send({ coveredAreaSqft: 0, boundaryWall: false })).status).toBe(400);
    const res = await api()
      .patch(`/api/v1/projects/${id}/coverage`)
      .set(auth)
      .send({ coveredAreaSqft: 3950, semiCoveredSqft: 180, openAreaSqft: 420, boundaryWall: true, boundaryLengthFt: 200, boundaryHeightFt: 7, boundaryThickness: 'IN_9', boundaryPlasterSides: 2 });
    expect(res.body.data.coverage).toMatchObject({ coveredAreaSqft: 3950, semiCoveredSqft: 180, boundaryLengthFt: 200, boundaryThickness: 'IN_9', boundaryPlasterSides: 2 });
    expect(res.body.data.wizardCompletedSteps).toEqual([1, 4]);
  });
});
