import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { createDraft } from './fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

const plot = (extra: Record<string, unknown> = {}) => ({
  plotUnit: 'MARLA',
  plotSize: 5,
  frontFt: 25,
  depthFt: 45,
  structureType: 'LOAD_BEARING',
  hasBasement: false,
  floors: [{ level: 'GROUND', ceilingHeightFt: 11 }],
  ...extra,
});

const strip = {
  type: 'STRIP',
  excavationDepthFt: 5,
  footingWidthFt: 3,
  footingThicknessIn: 9,
  plinthHeightFt: 2,
  dpcThicknessIn: 1.5,
  masonry: 'BRICK',
  pccMix: '1:4:8',
  pccThicknessIn: 3,
  soilType: 'MEDIUM',
};

const fieldsOf = (body: { error: { details?: { fields?: Array<{ field: string }> } } }) => (body.error.details?.fields ?? []).map((f) => f.field);

describe('foundation (bunyaad) — wizard tab 3', () => {
  it('saves a strip foundation with defaults, returns it on GET / review, and drops fields that do not apply', async () => {
    const auth = await owner();
    const { id } = await createDraft(auth);
    const res = await api()
      .patch(`/api/v1/projects/${id}/plot-structure`)
      .set(auth)
      // pile + RCC fields don't apply to a brick strip footing → stored as null
      .send(plot({ foundation: { ...strip, pileCount: 10, rccMix: '1:2:4', mainBarMm: 12, soilTestNote: 'ignored without a test' } }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const expected = {
      type: 'STRIP',
      excavationDepthFt: 5,
      footingWidthFt: 3,
      footingThicknessIn: 9,
      plinthHeightFt: 2,
      dpcThicknessIn: 1.5,
      footingCount: null,
      footingLengthFt: null,
      pileCount: null,
      pileDiameterIn: null,
      pileDepthFt: null,
      masonry: 'BRICK',
      pccMix: '1:4:8',
      pccThicknessIn: 3,
      rccMix: null,
      mainBarMm: null,
      termiteTreatment: true,
      dpcMaterial: 'PCC_WATERPROOF',
      soilType: 'MEDIUM',
      waterTableDepthFt: null,
      dewateringNeeded: false,
      soilTestDone: false,
      soilTestNote: null,
      notes: null,
    };
    expect(res.body.data.foundation).toEqual(expected);

    const got = await api().get(`/api/v1/projects/${id}`).set(auth);
    expect(got.body.data.foundation).toEqual(expected);
    const row = await prismaAdmin.project.findUniqueOrThrow({ where: { id }, select: { foundation: true } });
    expect(row.foundation).toEqual(expected);

    const review = await api().get(`/api/v1/projects/${id}/review`).set(auth);
    expect(review.body.data.summary.foundation).toEqual(expected);
    expect(review.body.data.warnings.map((w: { code: string }) => w.code)).not.toContain('FOUNDATION_MISSING');

    const log = await prismaAdmin.auditLog.findFirst({ where: { entityId: id, action: 'project.update_plot_structure' }, orderBy: { createdAt: 'desc' } });
    expect(log?.details).toMatchObject({ foundation: 'STRIP' });
  });

  it('isolated, raft and pile foundations keep their own fields; omitted = unchanged, null = cleared', async () => {
    const auth = await owner();
    const { id } = await createDraft(auth);
    const send = (foundation: unknown) => api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot({ structureType: 'FRAMED', foundation }));

    const isolated = await send({ ...strip, type: 'ISOLATED', footingThicknessIn: 12, footingWidthFt: 5, footingLengthFt: 5, footingCount: 12, rccMix: '1:2:4', mainBarMm: 12 });
    expect(isolated.status, JSON.stringify(isolated.body)).toBe(200);
    expect(isolated.body.data.foundation).toMatchObject({ type: 'ISOLATED', footingCount: 12, footingLengthFt: 5, footingWidthFt: 5, rccMix: '1:2:4', mainBarMm: 12, pileCount: null });

    const raft = await send({
      ...strip,
      type: 'RAFT',
      excavationDepthFt: 14,
      footingThicknessIn: 18,
      masonry: 'RCC_ONLY',
      pccThicknessIn: 4,
      rccMix: '1:1.5:3',
      mainBarMm: 16,
      dpcMaterial: 'BITUMEN',
      soilType: 'SOFT',
      waterTableDepthFt: 12,
      dewateringNeeded: true,
      soilTestDone: true,
      soilTestNote: 'SBC 1.2 tsf',
      notes: 'Basement planned later',
    });
    expect(raft.status, JSON.stringify(raft.body)).toBe(200);
    expect(raft.body.data.foundation).toMatchObject({
      type: 'RAFT',
      footingWidthFt: null,
      footingCount: null,
      footingLengthFt: null,
      rccMix: '1:1.5:3',
      mainBarMm: 16,
      dpcMaterial: 'BITUMEN',
      waterTableDepthFt: 12,
      dewateringNeeded: true,
      soilTestDone: true,
      soilTestNote: 'SBC 1.2 tsf',
      notes: 'Basement planned later',
    });

    const pile = await send({ ...strip, type: 'PILE', excavationDepthFt: 4, masonry: 'RCC_ONLY', pileCount: 24, pileDiameterIn: 18, pileDepthFt: 40, rccMix: '1:2:4', mainBarMm: 20 });
    expect(pile.status, JSON.stringify(pile.body)).toBe(200);
    expect(pile.body.data.foundation).toMatchObject({ type: 'PILE', pileCount: 24, pileDiameterIn: 18, pileDepthFt: 40, footingWidthFt: null });

    // Saving the tab again without `foundation` keeps it
    const kept = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot());
    expect(kept.body.data.foundation).toMatchObject({ type: 'PILE' });
    // null clears it
    const cleared = await send(null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.foundation).toBeNull();
    const row = await prismaAdmin.project.findUniqueOrThrow({ where: { id }, select: { foundation: true } });
    expect(row.foundation).toBeNull();
  });

  it('validates ranges and the fields each type needs', async () => {
    const auth = await owner();
    const { id } = await createDraft(auth);
    const send = (foundation: unknown) => api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send(plot({ foundation }));

    const ranges = await send({ ...strip, excavationDepthFt: 31, plinthHeightFt: 7, footingThicknessIn: 2 });
    expect(ranges.status).toBe(400);
    expect(ranges.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(ranges.body)).toEqual(expect.arrayContaining(['foundation.excavationDepthFt', 'foundation.plinthHeightFt', 'foundation.footingThicknessIn']));

    expect(fieldsOf((await send({ ...strip, type: 'BOX' })).body)).toContain('foundation.type');
    expect(fieldsOf((await send({ ...strip, footingWidthFt: undefined })).body)).toContain('foundation.footingWidthFt');
    expect(fieldsOf((await send({ ...strip, type: 'ISOLATED', footingThicknessIn: 12 })).body)).toEqual(
      expect.arrayContaining(['foundation.footingCount', 'foundation.footingLengthFt', 'foundation.rccMix', 'foundation.mainBarMm']),
    );
    expect(fieldsOf((await send({ ...strip, type: 'PILE', rccMix: '1:2:4', mainBarMm: 12 })).body)).toEqual(
      expect.arrayContaining(['foundation.pileCount', 'foundation.pileDiameterIn', 'foundation.pileDepthFt']),
    );
    // A brick strip footing needs no RCC, but an RCC-only one does
    expect(fieldsOf((await send({ ...strip, masonry: 'RCC_ONLY' })).body)).toEqual(expect.arrayContaining(['foundation.rccMix', 'foundation.mainBarMm']));
    expect(fieldsOf((await send({ ...strip, masonry: 'RCC_ONLY', rccMix: '1:2:4', mainBarMm: 14 })).body)).toContain('foundation.mainBarMm');
    expect(fieldsOf((await send({ ...strip, pccMix: '1:5:10' })).body)).toContain('foundation.pccMix');
    expect(fieldsOf((await send({ ...strip, type: 'ISOLATED', footingThicknessIn: 12, footingLengthFt: 5, footingCount: 2.5, rccMix: '1:2:4', mainBarMm: 12 })).body)).toContain(
      'foundation.footingCount',
    );
    // Excavation shallower than PCC + footing
    expect(fieldsOf((await send({ ...strip, excavationDepthFt: 1, footingThicknessIn: 12 })).body)).toContain('foundation.excavationDepthFt');

    // Nothing was saved
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id }, select: { foundation: true } })).foundation).toBeNull();
  });

  it('projects without a foundation still load: foundation null + a non-blocking review warning', async () => {
    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const got = await api().get(`/api/v1/projects/${dha}`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body.data.foundation).toBeNull();
    const review = await api().get(`/api/v1/projects/${dha}/review`).set(auth);
    expect(review.status).toBe(200);
    expect(review.body.data.summary.foundation).toBeNull();
    const missing = review.body.data.warnings.find((w: { code: string }) => w.code === 'FOUNDATION_MISSING');
    expect(missing).toMatchObject({ tab: 3 });
    expect(review.body.data.errors.map((e: { code: string }) => e.code)).not.toContain('FOUNDATION_MISSING');

    // Saving the existing plot tab without a foundation still works
    const p = await prismaAdmin.project.findUniqueOrThrow({ where: { id: dha }, include: { floors: true } });
    const res = await api()
      .patch(`/api/v1/projects/${dha}/plot-structure`)
      .set(auth)
      .send({
        plotUnit: p.plotUnit,
        plotSize: Number(p.plotSize),
        frontFt: Number(p.frontFt),
        depthFt: Number(p.depthFt),
        structureType: p.structureType,
        hasBasement: p.hasBasement,
        ...(p.hasBasement ? { basementHeightFt: Number(p.basementHeightFt) } : {}),
        floors: p.floors.map((f) => ({ level: f.level, ceilingHeightFt: Number(f.ceilingHeightFt) })),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.foundation).toBeNull();
  });

  it('needs projects.project.edit and an editable status; MUNSHI never sees it', async () => {
    const auth = await owner();
    const { id } = await createDraft(auth);
    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    const denied = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(munshi).send(plot({ foundation: strip }));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    // A PM not assigned to the project → 404
    expect((await api().patch(`/api/v1/projects/${id}/plot-structure`).set(await pm()).send(plot({ foundation: strip }))).status).toBe(404);

    // Assigned PM can save it
    const dha = seeded().projects.dha.id;
    const p = await prismaAdmin.project.findUniqueOrThrow({ where: { id: dha }, include: { floors: true } });
    const body = {
      plotUnit: p.plotUnit,
      plotSize: Number(p.plotSize),
      frontFt: Number(p.frontFt),
      depthFt: Number(p.depthFt),
      structureType: p.structureType,
      hasBasement: p.hasBasement,
      ...(p.hasBasement ? { basementHeightFt: Number(p.basementHeightFt) } : {}),
      floors: p.floors.map((f) => ({ level: f.level, ceilingHeightFt: Number(f.ceilingHeightFt) })),
      foundation: strip,
    };
    const ok = await api().patch(`/api/v1/projects/${dha}/plot-structure`).set(await pm()).send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.foundation).toMatchObject({ type: 'STRIP' });

    // The Munshi's basic project view has no foundation
    const munshiView = await api().get(`/api/v1/projects/${dha}`).set(munshi);
    expect(munshiView.status).toBe(200);
    expect(munshiView.body.data).not.toHaveProperty('foundation');

    // Locked after close-out, like every other structure field
    await prismaAdmin.project.update({ where: { id: dha }, data: { status: 'CLOSEOUT' } });
    const locked = await api().patch(`/api/v1/projects/${dha}/plot-structure`).set(auth).send({ ...body, foundation: { ...strip, plinthHeightFt: 3 } });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('PROJECT_LOCKED');
    expect(((await prismaAdmin.project.findUniqueOrThrow({ where: { id: dha }, select: { foundation: true } })).foundation as { plinthHeightFt: number }).plinthHeightFt).toBe(2);
  });
});
