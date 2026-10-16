/**
 * Step 11 · estimation rulebook: platform versions (admin), company overrides within safe ranges,
 * region resolution, and that the database v1 equals the code definition (rulebookDefs.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { builtInValues, RULEBOOK_PARAMS } from '../../src/modules/estimate/rulebookDefs.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const admin = async () => bearer((await loginAdmin()).accessToken);
type Param = { key: string; value: number; source: string; platformValue: number; companyValue: number | null; safeMin: number; safeMax: number; reviewStatus: string };
const param = (body: { data: { parameters: Param[] } }, key: string) => body.data.parameters.find((p) => p.key === key)!;

describe('rulebook v1 data', () => {
  it('both regions are PUBLISHED v1 with exactly the code values, every one pending engineer review', async () => {
    for (const region of ['PUNJAB_KP', 'KARACHI_SINDH'] as const) {
      const rb = await prismaAdmin.rulebook.findUniqueOrThrow({ where: { region_version: { region, version: 1 } }, include: { parameters: true } });
      expect(rb.status).toBe('PUBLISHED');
      const db = Object.fromEntries(rb.parameters.map((p) => [p.key, Number(p.value)]));
      expect(db).toEqual(builtInValues(region));
      expect(rb.parameters.every((p) => p.reviewStatus === 'PENDING_ENGINEER_REVIEW')).toBe(true);
      expect(rb.parameters).toHaveLength(RULEBOOK_PARAMS.length);
    }
  });

  it('the migration inserts the same v1 values (regenerate the migration data when rulebookDefs.ts changes)', () => {
    const sql = readFileSync('prisma/migrations/20261101090000_estimation_rulebook/migration.sql', 'utf8');
    const ids = { PUNJAB_KP: '01920000-0000-7000-8000-00000000b001', KARACHI_SINDH: '01920000-0000-7000-8000-00000000b002' } as const;
    for (const d of RULEBOOK_PARAMS) {
      for (const region of ['PUNJAB_KP', 'KARACHI_SINDH'] as const) {
        const row = sql.split('\n').find((l) => l.startsWith(`(gen_random_uuid(), '${ids[region]}', '${d.key}',`));
        expect(row, `${region} ${d.key}`).toBeDefined();
        expect(row, `${region} ${d.key}`).toContain(`, ${d.value[region]}, ${d.safeMin}, ${d.safeMax}, 'PENDING_ENGINEER_REVIEW'`);
      }
    }
  });
});

describe('company rulebook', () => {
  it('GET /rulebook: the company region, platform + company values; Karachi companies get the block rulebook', async () => {
    const res = await api().get('/api/v1/rulebook').set(await owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ region: 'PUNJAB_KP', rulebook: { version: 1, status: 'PUBLISHED' } });
    expect(param(res.body, 'contingencyPercent')).toMatchObject({ platformValue: 5, companyValue: 7, value: 7, source: 'COMPANY' }); // seeded
    expect(param(res.body, 'bricksPerCft')).toMatchObject({ value: 13.5, source: 'RULEBOOK', safeMin: 12, safeMax: 15, reviewStatus: 'PENDING_ENGINEER_REVIEW' });
    expect(param(res.body, 'blockMasonry').value).toBe(0);

    const valley = bearer((await loginMobile(SEED.valley.owner.phone, SEED.valley.owner.password)).accessToken);
    const k = await api().get('/api/v1/rulebook').set(valley);
    expect(k.body.data.region).toBe('KARACHI_SINDH');
    expect(param(k.body, 'blockMasonry').value).toBe(1);
    expect(param(k.body, 'externalWallThicknessIn').value).toBe(6);
  });

  it('PUT overrides: safe range (400 OUT_OF_SAFE_RANGE), unknown keys (400), upsert + audit, reaches the live estimate; DELETE goes back', async () => {
    const auth = await owner();
    const out = await api().put('/api/v1/rulebook/overrides').set(auth).send({ overrides: [{ key: 'bricksPerCft', value: 20 }] });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatchObject({ code: 'OUT_OF_SAFE_RANGE', details: { key: 'bricksPerCft', value: 20, safeMin: 12, safeMax: 15 } });
    expect((await api().put('/api/v1/rulebook/overrides').set(auth).send({ overrides: [{ key: 'bogus', value: 1 }] })).body.error.code).toBe('UNKNOWN_PARAMETER');
    expect((await api().put('/api/v1/rulebook/overrides').set(auth).send({ overrides: [{ key: 'blockMasonry', value: 0.5 }] })).body.error.code).toBe('OUT_OF_SAFE_RANGE');

    const res = await api().put('/api/v1/rulebook/overrides').set(auth).send({ overrides: [{ key: 'slabThicknessIn', value: 6, note: 'Our standard' }, { key: 'paintCoats', value: 3 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(param(res.body, 'slabThicknessIn')).toMatchObject({ value: 6, source: 'COMPANY', companyValue: 6 });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'rulebook.override_set', tenantId: seeded().malik.id } });
    expect(audit.details).toMatchObject({ changes: [{ key: 'slabThicknessIn', value: 6, previous: null, platformValue: 5 }, { key: 'paintCoats', value: 3 }] });
    expect((await api().get('/api/v1/rulebook/overrides').set(auth)).body.data.map((o: { key: string }) => o.key)).toEqual(['contingencyPercent', 'paintCoats', 'slabThicknessIn']);

    // The company value is the new default of every project estimate (the project can still override it)
    const live = (await api().get(`/api/v1/projects/${seeded().projects.dha.id}/estimate`).set(auth)).body.data;
    expect(live.settings.slabThicknessIn).toBe(6);
    expect(live.defaults.slabThicknessIn).toBe(6);
    expect(live.boq.parameters.paintCoats).toEqual({ value: 3, source: 'COMPANY' });

    const del = await api().delete('/api/v1/rulebook/overrides/slabThicknessIn').set(auth);
    expect(del.status).toBe(200);
    expect(param(del.body, 'slabThicknessIn')).toMatchObject({ value: 5, source: 'RULEBOOK' });
    expect((await api().delete('/api/v1/rulebook/overrides/slabThicknessIn').set(auth)).body.error.code).toBe('OVERRIDE_NOT_FOUND');
    expect(await prismaAdmin.auditLog.count({ where: { action: 'rulebook.override_delete' } })).toBe(1);
  });

  it('PM reads but cannot change; overrides of one company never reach another', async () => {
    const p = await pm();
    expect((await api().get('/api/v1/rulebook').set(p)).status).toBe(200);
    const put = await api().put('/api/v1/rulebook/overrides').set(p).send({ overrides: [{ key: 'paintCoats', value: 3 }] });
    expect(put.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'rulebook.override.manage' } });
    const ahmed = bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);
    expect(param((await api().get('/api/v1/rulebook').set(ahmed)).body, 'contingencyPercent')).toMatchObject({ value: 5, source: 'RULEBOOK', companyValue: null });
  });
});

describe('platform admin: rulebook versions', () => {
  it('create a DRAFT v2, edit within the safe range, publish → companies of the region use it; published values are frozen', async () => {
    const h = await admin();
    const list = await api().get('/api/v1/admin/rulebooks?region=PUNJAB_KP').set(h);
    expect(list.body.data).toEqual([expect.objectContaining({ version: 1, status: 'PUBLISHED', parameterCount: RULEBOOK_PARAMS.length, pendingReview: RULEBOOK_PARAMS.length })]);

    const created = await api().post('/api/v1/admin/rulebooks').set(h).send({ region: 'PUNJAB_KP', notes: 'Engineer review round 1' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const v2 = created.body.data;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT', publishedAt: null });
    expect(v2.parameters).toHaveLength(RULEBOOK_PARAMS.length);

    const url = `/api/v1/admin/rulebooks/${v2.id}/parameters/bricksPerCft`;
    const bad = await api().patch(url).set(h).send({ value: 11 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('OUT_OF_SAFE_RANGE');
    expect((await api().patch(url).set(h).send({ safeMin: 14, safeMax: 13 })).body.error.code).toBe('INVALID_RANGE');
    const ok = await api().patch(url).set(h).send({ value: 13, reviewStatus: 'REVIEWED' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.parameters.find((p: { key: string }) => p.key === 'bricksPerCft')).toMatchObject({ value: 13, reviewStatus: 'REVIEWED' });

    // still DRAFT → companies keep v1
    expect(param((await api().get('/api/v1/rulebook').set(await owner())).body, 'bricksPerCft').value).toBe(13.5);
    const pub = await api().post(`/api/v1/admin/rulebooks/${v2.id}/publish`).set(h).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'PUBLISHED', publishedAt: expect.any(String) });
    const company = (await api().get('/api/v1/rulebook').set(await owner())).body;
    expect(company.data.rulebook.version).toBe(2);
    expect(param(company, 'bricksPerCft')).toMatchObject({ value: 13, reviewStatus: 'REVIEWED' });
    // Karachi companies are untouched
    const valley = bearer((await loginMobile(SEED.valley.owner.phone, SEED.valley.owner.password)).accessToken);
    expect((await api().get('/api/v1/rulebook').set(valley)).body.data.rulebook.version).toBe(1);

    expect((await api().patch(url).set(h).send({ value: 14 })).body.error.code).toBe('RULEBOOK_PUBLISHED');
    expect((await api().patch(url).set(h).send({ reviewStatus: 'PENDING_ENGINEER_REVIEW' })).status).toBe(200); // review status any time
    expect((await api().delete(`/api/v1/admin/rulebooks/${v2.id}`).set(h)).body.error.code).toBe('RULEBOOK_PUBLISHED');
    expect((await api().post(`/api/v1/admin/rulebooks/${v2.id}/publish`).set(h).send({})).body.error.code).toBe('RULEBOOK_PUBLISHED');

    // a DRAFT can be deleted
    const v3 = (await api().post('/api/v1/admin/rulebooks').set(h).send({ region: 'PUNJAB_KP' })).body.data;
    expect(v3.parameters.find((p: { key: string }) => p.key === 'bricksPerCft').value).toBe(13); // copied from the latest
    expect((await api().delete(`/api/v1/admin/rulebooks/${v3.id}`).set(h)).body.data).toEqual({ deleted: true });
    expect((await api().post('/api/v1/admin/rulebooks').set(h).send({ region: 'PUNJAB_KP', copyFromId: '01920000-0000-7000-8000-00000000b002' })).body.error.code).toBe('INVALID_SOURCE');

    const actions = (await prismaAdmin.auditLog.findMany({ where: { action: { startsWith: 'admin.rulebook' } }, select: { action: true } })).map((a) => a.action).sort();
    expect(actions).toEqual(['admin.rulebook_created', 'admin.rulebook_created', 'admin.rulebook_deleted', 'admin.rulebook_parameter_updated', 'admin.rulebook_parameter_updated', 'admin.rulebook_published']);
  });

  it('company tokens cannot reach the admin routes', async () => {
    expect((await api().get('/api/v1/admin/rulebooks').set(await owner())).status).toBe(401);
  });
});
