/**
 * Step 11 · saved estimates: generate / regenerate / line overrides / approve (locks, supersedes) /
 * compare / rates outdated after a price-list change / owner shopping list / PDFs / permissions.
 * Seed: Malik's DHA Phase 6 · 10 Marla has Rev 1 APPROVED (contingency 5 %) and Rev 2 DRAFT
 * (company contingency 7 %, one brick line overridden) — prisma/seedEstimate.ts.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

type Line = { id: string; lineKey: string; kind: string; section: string; stageKey: string | null; suppliedBy: string; quantityWithWastage: number; effectiveQuantity: number; amountPaisa?: string | null; ratePaisa?: string | null; materialId: string | null; override: unknown; trace: string[] };
type Detail = { id: string; revision: number; status: string; ratesOutdated: boolean; totalPaisa?: string; directCostPaisa?: string; overheadPaisa?: string; contingencyPaisa?: string; sections: Array<{ section: string; lines: Line[]; amountPaisa?: string }>; parameters: Record<string, { value: number; source: string }> };
const lines = (d: Detail) => d.sections.flatMap((s) => s.lines);
const revisions = async (auth: Record<string, string>, projectId: string) => (await api().get(`/api/v1/projects/${projectId}/estimates`).set(auth)).body.data as Array<Detail & { lineCount: number }>;
const get = async (auth: Record<string, string>, id: string) => (await api().get(`/api/v1/estimates/${id}`).set(auth)).body.data as Detail;

describe('seeded revisions (DHA Phase 6 · 10 Marla)', () => {
  it('Rev 2 DRAFT and Rev 1 APPROVED with their own rulebook values and the override', async () => {
    const auth = await owner();
    const list = await revisions(auth, seeded().projects.dha.id);
    expect(list.map((e) => [e.revision, e.status])).toEqual([
      [2, 'DRAFT'],
      [1, 'APPROVED'],
    ]);
    const [rev2, rev1] = [await get(auth, list[0]!.id), await get(auth, list[1]!.id)];
    expect(rev1.parameters['contingencyPercent']).toEqual({ value: 5, source: 'RULEBOOK' });
    expect(rev2.parameters['contingencyPercent']).toEqual({ value: 7, source: 'COMPANY' });
    const overridden = lines(rev2).filter((l) => l.override);
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({ lineKey: 'MASONRY.GF_STRUCTURE.bricks', override: { note: expect.stringContaining('Site count'), by: { name: SEED.malik.pm.name } } });
    // totals: direct + overheads + contingency
    expect(BigInt(rev2.totalPaisa!)).toBe(BigInt(rev2.directCostPaisa!) + BigInt(rev2.overheadPaisa!) + BigInt(rev2.contingencyPaisa!));
    // GREY_OWNER_FINISHING: tiles / paint are the owner's (no rate), every section present
    const tiles = lines(rev2).find((l) => l.lineKey === 'FLOORING_TILES.FINISHING.floorTiles')!;
    expect(tiles).toMatchObject({ suppliedBy: 'OWNER', ratePaisa: null, amountPaisa: null });
    // (the seeded DHA project has no foundation details yet, so no excavation section)
    expect(rev2.sections.map((s) => s.section)).toEqual(expect.arrayContaining(['CONCRETE', 'STEEL', 'MASONRY', 'PLASTER', 'ROOF_WATERPROOFING', 'FLOORING_TILES', 'PAINT', 'MEP_ROUGH_IN', 'GREY_LABOUR', 'EQUIPMENT_SHUTTERING', 'SITE_OVERHEADS', 'CONTINGENCY']));
  });
});

describe('generate → override → approve', () => {
  it('generates DRAFT Rev 1, one draft at a time, audited; the live preview matches', async () => {
    const auth = await owner();
    const johar = seeded().projects.johar.id;
    const res = await api().post(`/api/v1/projects/${johar}/estimates`).set(auth).send({ note: 'First cut' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const e = res.body.data as Detail & { note: string; rulebook: { region: string; version: number } };
    expect(e).toMatchObject({ revision: 1, status: 'DRAFT', ratesOutdated: false, note: 'First cut', rulebook: { region: 'PUNJAB_KP', version: 1 } });
    // the live GET /estimate shows the same BoQ total as a preview
    const live = (await api().get(`/api/v1/projects/${johar}/estimate`).set(auth)).body.data;
    expect(live.boq.totalPaisa).toBe(e.totalPaisa);
    expect(live.boq.rulebook).toMatchObject({ region: 'PUNJAB_KP', version: 1 });
    expect(live.boq.sections.flatMap((s: { lines: Line[] }) => s.lines).length).toBe(lines(e).length);

    const again = await api().post(`/api/v1/projects/${johar}/estimates`).set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ESTIMATE_DRAFT_EXISTS', details: { estimateId: e.id } });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'estimate.generate', entityId: e.id } })).toBe(1);
  });

  it('line overrides need a note, recompute the totals, can be cleared; overheads are not editable; owner lines take no rate', async () => {
    const auth = await owner();
    const [rev2] = await revisions(auth, seeded().projects.dha.id);
    const d = await get(auth, rev2!.id);
    const cement = lines(d).find((l) => l.lineKey === 'CONCRETE.GF_STRUCTURE.cement')!;
    const url = `/api/v1/estimates/${d.id}/lines/${cement.id}`;

    const noNote = await api().patch(url).set(auth).send({ quantity: 500 });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.code).toBe('NOTE_REQUIRED');
    expect((await api().patch(url).set(auth).send({})).body.error.code).toBe('VALIDATION_ERROR');

    const res = await api().patch(url).set(auth).send({ quantity: 500, ratePaisa: '140000', note: 'Dealer rate, measured' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body.data as Detail;
    const changed = lines(after).find((l) => l.id === cement.id)!;
    // 500 bags × Rs 1,400 = Rs 7,00,000
    expect(changed).toMatchObject({ effectiveQuantity: 500, amountPaisa: '70000000', override: { quantity: 500, ratePaisa: '140000', note: 'Dealer rate, measured' } });
    const delta = 70_000_000n - BigInt(cement.amountPaisa!);
    expect(BigInt(after.directCostPaisa!)).toBe(BigInt(d.directCostPaisa!) + delta);
    // overheads follow: 3 % of the new direct cost (half-up)
    const direct = BigInt(after.directCostPaisa!);
    expect(BigInt(after.overheadPaisa!)).toBe((direct * 3n + 50n) / 100n);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'estimate.line_override', entityId: d.id } })).toBe(1);

    const cleared = await api().patch(url).set(auth).send({ quantity: null, ratePaisa: null });
    expect(cleared.status).toBe(200);
    expect(lines(cleared.body.data).find((l) => l.id === cement.id)).toMatchObject({ override: null, amountPaisa: cement.amountPaisa });
    expect(cleared.body.data.totalPaisa).toBe(d.totalPaisa);

    const contingency = lines(d).find((l) => l.kind === 'PERCENT')!;
    expect((await api().patch(`/api/v1/estimates/${d.id}/lines/${contingency.id}`).set(auth).send({ quantity: 1, note: 'x' })).body.error.code).toBe('LINE_NOT_EDITABLE');
    const ownerLine = lines(d).find((l) => l.suppliedBy === 'OWNER')!;
    expect((await api().patch(`/api/v1/estimates/${d.id}/lines/${ownerLine.id}`).set(auth).send({ ratePaisa: '100', note: 'x' })).body.error.code).toBe('OWNER_SUPPLIED_NO_RATE');
    // the owner may still correct the owner's quantity
    expect((await api().patch(`/api/v1/estimates/${d.id}/lines/${ownerLine.id}`).set(auth).send({ quantity: 10, note: 'Owner already has some' })).status).toBe(200);
  });

  it('approve locks the revision and supersedes the previous APPROVED one (only the owner / Administrator)', async () => {
    const [rev2, rev1] = await revisions(await owner(), seeded().projects.dha.id);
    const denied = await api().post(`/api/v1/estimates/${rev2!.id}/approve`).set(await pm()).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'estimate.revision.approve' } });

    const auth = await owner();
    const res = await api().post(`/api/v1/estimates/${rev2!.id}/approve`).set(auth).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', approvedBy: { name: SEED.malik.owner.name } });
    expect((await get(auth, rev1!.id)).status).toBe('SUPERSEDED');
    expect(await prismaAdmin.estimate.count({ where: { projectId: seeded().projects.dha.id, status: 'APPROVED' } })).toBe(1);

    const line = lines(res.body.data)[0]!;
    const locked = await api().patch(`/api/v1/estimates/${rev2!.id}/lines/${line.id}`).set(auth).send({ quantity: 1, note: 'late change' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('ESTIMATE_LOCKED');
    expect((await api().post(`/api/v1/estimates/${rev2!.id}/regenerate`).set(auth).send({})).body.error.code).toBe('ESTIMATE_LOCKED');
    expect((await api().post(`/api/v1/estimates/${rev2!.id}/approve`).set(auth).send({})).body.error.code).toBe('ESTIMATE_NOT_DRAFT');

    // a new revision is possible again (Rev 3), starting from today's rulebook and rates
    const rev3 = await api().post(`/api/v1/projects/${seeded().projects.dha.id}/estimates`).set(auth).send({});
    expect(rev3.status).toBe(201);
    expect(rev3.body.data.revision).toBe(3);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'estimate.approve', entityId: rev2!.id } })).toBe(1);
  });

  it('a price-list change marks DRAFT estimates rates-outdated (approved ones never); approve needs confirmation; regenerate refreshes and keeps overrides', async () => {
    const auth = await owner();
    const [rev2, rev1] = await revisions(auth, seeded().projects.dha.id);
    const d = await get(auth, rev2!.id);
    const cement = lines(d).find((l) => l.lineKey === 'CONCRETE.GF_STRUCTURE.cement')!;
    const cat = (await api().get('/api/v1/quality-categories').set(auth)).body.data.find((c: { isDefault: boolean }) => c.isDefault);
    const put = await api().put('/api/v1/price-list').set(auth).send({ categoryId: cat.id, rates: [{ materialId: cement.materialId, ratePaisa: '160000' }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    expect((await get(auth, rev2!.id)).ratesOutdated).toBe(true);
    const approved = await get(auth, rev1!.id);
    expect(approved.ratesOutdated).toBe(false);
    expect(lines(approved).find((l) => l.lineKey === 'CONCRETE.GF_STRUCTURE.cement')!.ratePaisa).toBe('145000'); // frozen

    const blocked = await api().post(`/api/v1/estimates/${rev2!.id}/approve`).set(auth).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RATES_OUTDATED');

    const regen = await api().post(`/api/v1/estimates/${rev2!.id}/regenerate`).set(auth).send({});
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    const r = regen.body.data as Detail;
    expect(r).toMatchObject({ id: rev2!.id, revision: 2, status: 'DRAFT', ratesOutdated: false });
    expect(lines(r).find((l) => l.lineKey === 'CONCRETE.GF_STRUCTURE.cement')!.ratePaisa).toBe('160000');
    expect(lines(r).find((l) => l.lineKey === 'MASONRY.GF_STRUCTURE.bricks')!.override).toMatchObject({ note: expect.stringContaining('Site count') });

    // confirmed approval of an outdated draft works too
    await api().put('/api/v1/price-list').set(auth).send({ categoryId: cat.id, rates: [{ materialId: cement.materialId, ratePaisa: '165000' }] });
    const confirmed = await api().post(`/api/v1/estimates/${rev2!.id}/approve`).set(auth).send({ confirmOutdatedRates: true });
    expect(confirmed.status).toBe(200);
    // QA-A-23: an approved revision is never "rates outdated"
    expect(confirmed.body.data.ratesOutdated).toBe(false);
  });

  it('QA-A-23: a price change of an owner-supplied material does not mark a draft rates-outdated', async () => {
    const auth = await owner();
    const p = seeded().projects.dha.id;
    const [latest] = await revisions(auth, p);
    const draft = latest!.status === 'DRAFT' ? latest! : ((await api().post(`/api/v1/projects/${p}/estimates`).set(auth).send({})).body.data as Detail);
    const all = lines(await get(auth, draft.id));
    const ownerLine = all.find((l) => l.suppliedBy === 'OWNER' && l.materialId && !all.some((x) => x.materialId === l.materialId && x.suppliedBy === 'CONTRACTOR'));
    expect(ownerLine, 'an owner-only material on the draft').toBeDefined();
    const cat = (await api().get('/api/v1/quality-categories').set(auth)).body.data.find((c: { isDefault: boolean }) => c.isDefault);
    expect((await api().put('/api/v1/price-list').set(auth).send({ categoryId: cat.id, rates: [{ materialId: ownerLine!.materialId, ratePaisa: '17500' }] })).status).toBe(200);
    expect((await get(auth, draft.id)).ratesOutdated).toBe(false);
  });
});

describe('compare, shopping list, PDFs', () => {
  it('compares two revisions line by line with the totals difference', async () => {
    const auth = await owner();
    const [rev2, rev1] = await revisions(auth, seeded().projects.dha.id);
    const res = await api().get(`/api/v1/estimates/${rev1!.id}/compare/${rev2!.id}`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = res.body.data;
    expect(c.a.revision).toBe(1);
    expect(c.b.revision).toBe(2);
    const contingency = c.lines.find((l: { lineKey: string }) => l.lineKey === 'CONTINGENCY.ALL.contingency');
    expect(contingency).toMatchObject({ change: 'CHANGED', quantityA: 5, quantityB: 7, quantityDelta: 2 });
    const bricks = c.lines.find((l: { lineKey: string }) => l.lineKey === 'MASONRY.GF_STRUCTURE.bricks');
    expect(bricks.change).toBe('CHANGED');
    expect(bricks.quantityB).toBeGreaterThan(bricks.quantityA);
    expect(c.totals.deltaPaisa).toBe((BigInt(c.totals.totalPaisaB) - BigInt(c.totals.totalPaisaA)).toString());
    expect(BigInt(c.totals.deltaPaisa)).toBeGreaterThan(0n);
    expect(c.sections.find((s: { section: string }) => s.section === 'CONTINGENCY').deltaPaisa).not.toBe('0');

    // revisions of different projects
    const johar = (await api().post(`/api/v1/projects/${seeded().projects.johar.id}/estimates`).set(auth).send({})).body.data;
    const bad = await api().get(`/api/v1/estimates/${rev1!.id}/compare/${johar.id}`).set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('DIFFERENT_PROJECTS');
  });

  it('owner shopping list: owner-supplied items with quantity, unit and needed-by stage — never a rate', async () => {
    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const res = await api().get(`/api/v1/projects/${dha}/owner-shopping-list`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.data;
    expect(s).toMatchObject({ source: 'APPROVED', revision: 1 });
    const tiles = s.items.find((i: { material: string }) => i.material === 'floorTiles');
    expect(tiles).toMatchObject({ unit: 'sqft', neededBy: 'FINISHING', stages: [{ stageKey: 'FINISHING', quantity: tiles.quantity }] });
    expect(JSON.stringify(s)).not.toMatch(/ratePaisa|amountPaisa/);
    // a specific revision, and the live preview for a project without estimates
    const [rev2] = await revisions(auth, dha);
    expect((await api().get(`/api/v1/projects/${dha}/owner-shopping-list?estimateId=${rev2!.id}`).set(auth)).body.data).toMatchObject({ source: 'ESTIMATE', revision: 2 });
    const valencia = (await api().get(`/api/v1/projects/${seeded().projects.valencia.id}/owner-shopping-list`).set(auth)).body.data;
    expect(valencia).toMatchObject({ source: 'PREVIEW', estimateId: null });
  });

  it('PDFs: internal BoQ (money only with fields.rates) and the owner shopping list (never money)', async () => {
    const calls: string[] = [];
    setPdfRenderer({ async render(html) { calls.push(html); return Buffer.from('%PDF-1.4 test'); } });
    try {
      const auth = await owner();
      const [rev2] = await revisions(auth, seeded().projects.dha.id);
      const pdf = await api().get(`/api/v1/estimates/${rev2!.id}/pdf?lang=en`).set(auth);
      expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
      expect(pdf.body.data).toMatchObject({ url: expect.any(String), whatsappText: expect.stringContaining('Rev 2') });
      expect(calls[0]).toContain('ESTIMATE (BoQ)');
      expect(calls[0]).toContain('Contingency');
      expect(calls[0]).toContain('Rs ');
      const ur = await api().get(`/api/v1/estimates/${rev2!.id}/pdf?lang=ur`).set(auth);
      expect(ur.status).toBe(200);
      expect(calls[1]).toContain('dir="rtl"');

      const list = await api().get(`/api/v1/projects/${seeded().projects.dha.id}/owner-shopping-list/pdf?lang=roman`).set(auth);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.data.whatsappText).toContain('aap ne lena hai');
      // QA-A-09: every item, with the "To buy" quantity rounded up as on the page
      const shop = (await api().get(`/api/v1/projects/${seeded().projects.dha.id}/owner-shopping-list`).set(auth)).body.data as { items: Array<{ description: string; quantity: number }> };
      expect(shop.items.length).toBeGreaterThan(0);
      for (const i of shop.items) expect(list.body.data.whatsappText).toContain(`• ${i.description} — ${Math.ceil(i.quantity - 1e-9).toLocaleString('en-PK')} `);
      expect(calls[2]).toContain('Lena hai');
      expect(calls[2]).toContain('MAALIK KI KHAREEDARI LIST');
      expect(calls[2]).not.toContain('Rs ');
    } finally {
      setPdfRenderer(null);
    }
  });
});

describe('access', () => {
  it('Munshi never; PM on assigned projects (404 elsewhere); without fields.rates no money at all', async () => {
    const auth = await owner();
    const [rev2] = await revisions(auth, seeded().projects.dha.id);
    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().get(`/api/v1/estimates/${rev2!.id}`).set(munshi)).body.error).toMatchObject({ code: 'PERMISSION_DENIED' });

    const bahriaEstimate = (await api().post(`/api/v1/projects/${seeded().projects.bahria.id}/estimates`).set(auth).send({})).body.data;
    const p = await pm();
    expect((await api().get(`/api/v1/estimates/${bahriaEstimate.id}`).set(p)).body.error.code).toBe('ESTIMATE_NOT_FOUND');
    const mine = await api().get(`/api/v1/estimates/${rev2!.id}`).set(p);
    expect(mine.status).toBe(200);
    expect(mine.body.data.totalPaisa).toBeDefined();
    expect(mine.body.data.contractTotalPaisa).toBeUndefined(); // no fields.contract
    expect(mine.body.data.marginPaisa).toBeUndefined();

    const bilal = seeded().users.bilal.id;
    expect((await api().put(`/api/v1/users/${bilal}/permission-overrides`).set(auth).send({ overrides: [{ key: 'fields.rates', effect: 'DENY' }] })).status).toBe(200);
    const blind = await api().get(`/api/v1/estimates/${rev2!.id}`).set(p);
    expect(blind.status).toBe(200);
    expect(JSON.stringify(blind.body.data)).not.toMatch(/Paisa/);
    expect(lines(blind.body.data)[0]!.effectiveQuantity).toBeGreaterThan(0);
    // a rate override needs fields.rates
    const line = lines(blind.body.data).find((l) => l.suppliedBy === 'CONTRACTOR' && l.kind === 'MATERIAL')!;
    const denied = await api().patch(`/api/v1/estimates/${rev2!.id}/lines/${line.id}`).set(p).send({ ratePaisa: '1', note: 'x' });
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'fields.rates' } });
  });

  it('project-level rulebook overrides must stay in the safe range', async () => {
    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const out = await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(auth).send({ contingencyPercent: 40 });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatchObject({ code: 'OUT_OF_SAFE_RANGE', details: { key: 'contingencyPercent', value: 40, safeMin: 0, safeMax: 15 } });
    // inside the zod range but outside the engineer-safe range
    expect((await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(auth).send({ waterproofingKgPerBag: 0 })).body.error.code).toBe('OUT_OF_SAFE_RANGE');
    const ok = await api().put(`/api/v1/projects/${dha}/estimate/settings`).set(auth).send({ contingencyPercent: 10, paintCoats: 3 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.customised).toEqual(['contingencyPercent', 'paintCoats']);
    expect(ok.body.data.boq.parameters.contingencyPercent).toEqual({ value: 10, source: 'PROJECT' });
  });
});
