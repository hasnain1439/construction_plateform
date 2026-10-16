/**
 * Project estimate (BoQ) API: GET /projects/:id/estimate, PUT /projects/:id/estimate/settings.
 * The numbers themselves are checked in tests/unit/estimateEngine.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { createDraft, createReadyDraft } from '../projects/fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

const STRIP = {
  type: 'STRIP',
  excavationDepthFt: 5,
  footingWidthFt: 3,
  footingThicknessIn: 9,
  plinthHeightFt: 2,
  dpcThicknessIn: 1.5,
  masonry: 'BRICK',
  pccMix: '1:4:8',
  pccThicknessIn: 3,
};

type Line = { id: string; kind: string; material: string | null; amountPaisa?: string | null; rateStatus?: string | null; quantity: number };
type Material = { material: string; quantity: number; amountPaisa?: string | null; rateStatus?: string; ratePaisa?: string | null; materialName: string | null };

describe('GET /projects/:id/estimate', () => {
  it('seeded DHA project: four stages, priced from the price list, cost + margin for the owner', async () => {
    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const res = await api().get(`/api/v1/projects/${dha}/estimate`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const e = res.body.data;
    expect(e.stages.map((s: { stage: string }) => s.stage)).toEqual(['FOUNDATION', 'WALLS', 'RCC', 'PLASTER']);
    // No foundation on the seeded project → warned, foundation stage empty
    expect(e.warnings.map((w: { code: string }) => w.code)).toContain('FOUNDATION_MISSING');
    expect(e.stages[0].lines).toEqual([]);
    // Three floors (ground, first, mumty), FRAMED → frame lines on floors with rooms
    expect(e.basis).toMatchObject({ structureType: 'FRAMED', coveredAreaSqft: 3950, coveredAreaSource: 'PROJECT', foundationWallLengthAuto: true });
    const rcc = e.stages[2].lines as Line[];
    expect(rcc.some((l) => l.id === 'RCC.GROUND.frame.volume')).toBe(true);
    // Malik "A Standard" rates: cement 1,450, bricks 17, steel 2,85,000 / ton, Chenab sand 70, Margalla crush 180
    const mats = Object.fromEntries((e.materials as Material[]).map((m) => [m.material, m]));
    expect(mats['cement']).toMatchObject({ materialName: 'Cement OPC', ratePaisa: '145000', rateStatus: 'OK' });
    expect(mats['steel']).toMatchObject({ materialName: 'Steel Grade-60 #4', ratePaisa: '28500000', rateUnit: 'ton', rateStatus: 'OK' });
    expect(mats['bricks']).toMatchObject({ ratePaisa: '1700', rateStatus: 'OK' });
    // the summary amount = Σ of its lines
    const cementLines = e.stages.flatMap((s: { lines: Line[] }) => s.lines).filter((l: Line) => l.material === 'cement');
    expect(BigInt(mats['cement']!.amountPaisa!)).toBe(cementLines.reduce((a: bigint, l: Line) => a + BigInt(l.amountPaisa!), 0n));
    // owner sees cost, contract (1,85,00,000) and margin
    expect(e.cost.contractTotalPaisa).toBe('1850000000');
    expect(BigInt(e.cost.totalPaisa)).toBe(BigInt(e.cost.materialsPaisa) + BigInt(e.cost.labourPaisa));
    expect(BigInt(e.cost.marginPaisa)).toBe(1850000000n - BigInt(e.cost.totalPaisa));
    expect(typeof e.cost.marginPercent).toBe('number');
    // default piece-rate labour (brick masonry, plaster, shuttering, steel fixing all seeded)
    expect(e.labour.method).toBe('PIECE_RATES');
    expect(e.labour.lines.map((l: { item: string }) => l.item)).toEqual(['BRICK_MASONRY', 'PLASTER', 'SHUTTERING', 'STEEL_FIXING']);
    expect(e.settings.slabThicknessIn).toBe(5);
    expect(e.customised).toEqual([]);
  });

  it('foundation materials without a rate are flagged and left out of the total', async () => {
    const auth = await owner();
    const p = await createReadyDraft(auth);
    const plot = await api()
      .patch(`/api/v1/projects/${p.id}/plot-structure`)
      .set(auth)
      .send({ plotUnit: 'MARLA', plotSize: 5, frontFt: 25, depthFt: 45, structureType: 'LOAD_BEARING', hasBasement: false, floors: [{ level: 'GROUND', ceilingHeightFt: 11 }], foundation: STRIP });
    expect(plot.status, JSON.stringify(plot.body)).toBe(200);
    const res = await api().get(`/api/v1/projects/${p.id}/estimate`).set(auth);
    expect(res.status).toBe(200);
    const e = res.body.data;
    const missing = e.warnings.find((w: { code: string }) => w.code === 'RATES_MISSING');
    expect(missing).toMatchObject({ materials: ['waterproofing', 'termite'] });
    const foundation = e.stages[0];
    const termite = (foundation.lines as Line[]).find((l) => l.material === 'termite')!;
    expect(termite).toMatchObject({ rateStatus: 'RATE_MISSING', amountPaisa: null });
    expect(foundation.missingRates).toBe(2);
    const priced = (foundation.lines as Line[]).filter((l) => l.amountPaisa).reduce((a, l) => a + BigInt(l.amountPaisa!), 0n);
    expect(BigInt(foundation.materialsPaisa)).toBe(priced);
    // A company rate for a "Termite chemical" material is picked up by name
    const mat = await api().post('/api/v1/materials').set(auth).send({ groupId: await groupId('WATERPROOFING'), name: 'Termite chemical (deemak)', unit: 'litre', supplyCategory: 'GREY_STRUCTURE' });
    expect(mat.status, JSON.stringify(mat.body)).toBe(201);
    const cat = (await api().get('/api/v1/quality-categories').set(auth)).body.data.find((c: { isDefault: boolean }) => c.isDefault);
    expect((await api().put('/api/v1/price-list').set(auth).send({ categoryId: cat.id, rates: [{ materialId: mat.body.data.id, ratePaisa: '120000' }] })).status).toBe(200);
    const again = (await api().get(`/api/v1/projects/${p.id}/estimate`).set(auth)).body.data;
    expect(again.warnings.find((w: { code: string }) => w.code === 'RATES_MISSING').materials).toEqual(['waterproofing']);
    expect((again.materials as Material[]).find((m) => m.material === 'termite')).toMatchObject({ materialName: 'Termite chemical (deemak)', ratePaisa: '120000', rateStatus: 'OK' });
  });

  it('a project without rooms or foundation answers with warnings, not an error', async () => {
    const auth = await owner();
    const { id } = await createDraft(auth);
    const res = await api().get(`/api/v1/projects/${id}/estimate`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const codes = res.body.data.warnings.map((w: { code: string }) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['NO_FLOORS', 'FOUNDATION_MISSING', 'STRUCTURE_TYPE_ASSUMED', 'COVERED_AREA_ESTIMATED', 'CONTRACT_VALUE_MISSING']));
    expect(res.body.data.materials).toEqual([]);
    expect(res.body.data.cost.totalPaisa).toBe('0');
    expect(res.body.data.cost.perSqftPaisa).toBeNull();

    // The wizard's Estimate step adjusts assumptions on the draft before activation.
    const put = await api().put(`/api/v1/projects/${id}/estimate/settings`).set(auth).send({ slabThicknessIn: 6 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.customised).toEqual(['slabThicknessIn']);
    expect(put.body.data.warnings.map((w: { code: string }) => w.code)).toContain('NO_FLOORS');
  });

  it('permissions: Munshi 403; PM sees assigned projects only, rates but no contract / margin; Accountant reads, cannot change', async () => {
    const t = seeded().malik.id;
    const dha = seeded().projects.dha.id;
    const munshi = bearer((await loginMunshi(t)).accessToken);
    const denied = await api().get(`/api/v1/projects/${dha}/estimate`).set(munshi);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'projects.estimate.view' } });

    const p = await pm();
    const mine = await api().get(`/api/v1/projects/${dha}/estimate`).set(p);
    expect(mine.status).toBe(200);
    expect(mine.body.data.cost.totalPaisa).toBeDefined();
    expect(mine.body.data.cost.contractTotalPaisa).toBeUndefined();
    expect(mine.body.data.cost.marginPaisa).toBeUndefined();
    expect((await api().get(`/api/v1/projects/${seeded().projects.bahria.id}/estimate`).set(p)).status).toBe(404);

    // Bilal becomes an Accountant: every project, read only, no margin (no fields.profit)
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    expect((await api().patch(`/api/v1/users/${seeded().users.bilal.id}/role`).set(o).send({ roleId: roles.find((r) => r.key === 'ACCOUNTANT')!.id })).status).toBe(200);
    const acc = await api().get(`/api/v1/projects/${seeded().projects.bahria.id}/estimate`).set(p);
    expect(acc.status).toBe(200);
    expect(acc.body.data.cost.contractTotalPaisa).toBe('3400000000');
    expect(acc.body.data.cost.marginPaisa).toBeUndefined();
    const put = await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(p).send({ slabThicknessIn: 6 });
    expect(put.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'projects.estimate.manage' } });
  });

  it('without fields.rates the quantities stay, every rate and amount goes', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    expect((await api().put(`/api/v1/users/${bilal}/permission-overrides`).set(o).send({ overrides: [{ key: 'fields.rates', effect: 'DENY' }] })).status).toBe(200);
    const res = await api().get(`/api/v1/projects/${seeded().projects.dha.id}/estimate`).set(await pm());
    expect(res.status).toBe(200);
    const e = res.body.data;
    expect(e.cost).toBeUndefined();
    expect(e.materials[0].quantity).toBeGreaterThan(0);
    expect(e.materials[0].ratePaisa).toBeUndefined();
    expect(e.stages[2].lines[0].amountPaisa).toBeUndefined();
    expect(e.stages[2].materialsPaisa).toBeUndefined();
    expect(e.labour.totalPaisa).toBeUndefined();
  });
});

describe('PUT /projects/:id/estimate/settings', () => {
  it('validates ranges, stores only the changes, recomputes; {} resets; audited', async () => {
    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const before = (await api().get(`/api/v1/projects/${dha}/estimate`).set(auth)).body.data;

    const bad = await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(auth).send({ slabThicknessIn: 12, wastagePercent: -1, rccMix: '1:3:6', bogus: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const res = await api()
      .put(`/api/v1/projects/${dha}/estimate/settings`)
      .set(auth)
      .send({ slabThicknessIn: 6, wastagePercent: 5, foundationWallLengthFt: 300, labourRatePerSqftPaisa: '45000' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // wastage 5 is the default → not stored
    expect(res.body.data.customised).toEqual(['foundationWallLengthFt', 'labourRatePerSqftPaisa', 'slabThicknessIn']);
    expect(res.body.data.settings).toMatchObject({ slabThicknessIn: 6, wastagePercent: 5, foundationWallLengthFt: 300 });
    expect(res.body.data.basis).toMatchObject({ foundationWallLengthFt: 300, foundationWallLengthAuto: false });
    const slab = (s: { stages: Array<{ lines: Line[] }> }) => s.stages[2]!.lines.find((l) => l.id === 'RCC.GROUND.slab.volume')!.quantity;
    expect(slab(res.body.data)).toBeCloseTo((slab(before) * 6) / 5, 1);
    // labour per sq ft: 3,950 × Rs 450
    expect(res.body.data.labour).toMatchObject({ method: 'PER_SQFT', totalPaisa: String(3950 * 45000) });
    const row = await prismaAdmin.project.findUniqueOrThrow({ where: { id: dha }, select: { estimateSettings: true } });
    expect(row.estimateSettings).toEqual({ slabThicknessIn: 6, foundationWallLengthFt: 300, labourRatePerSqftPaisa: '45000' });
    expect((await api().get(`/api/v1/projects/${dha}/estimate`).set(auth)).body.data.settings.slabThicknessIn).toBe(6);

    const reset = await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(auth).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.data.customised).toEqual([]);
    expect(reset.body.data.settings).toEqual(reset.body.data.defaults);
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: dha }, select: { estimateSettings: true } })).estimateSettings).toBeNull();

    const audits = await prismaAdmin.auditLog.findMany({ where: { action: 'project.estimate_settings_update', entityId: dha }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.details)).toEqual([
      { code: 'MSB-2026-012', changed: ['foundationWallLengthFt', 'labourRatePerSqftPaisa', 'slabThicknessIn'], reset: false },
      { code: 'MSB-2026-012', changed: ['foundationWallLengthFt', 'labourRatePerSqftPaisa', 'slabThicknessIn'], reset: true },
    ]);
  });

  it('a handed-over project is locked; out-of-scope projects are 404', async () => {
    const auth = await owner();
    const locked = await api().put(`/api/v1/projects/${seeded().projects.valencia.id}/estimate/settings`).set(auth).send({ slabThicknessIn: 6 });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('PROJECT_LOCKED');
    // still readable
    expect((await api().get(`/api/v1/projects/${seeded().projects.valencia.id}/estimate`).set(auth)).status).toBe(200);
    const p = await pm();
    expect((await api().put(`/api/v1/projects/${seeded().projects.bahria.id}/estimate/settings`).set(p).send({})).status).toBe(404);
    expect((await api().put(`/api/v1/projects/${seeded().projects.dha.id}/estimate/settings`).set(p).send({ parapetHeightFt: 0 })).status).toBe(200);
  });
});

async function groupId(code: string) {
  const g = await prismaAdmin.materialGroup.findUniqueOrThrow({ where: { code } });
  return g.id;
}
