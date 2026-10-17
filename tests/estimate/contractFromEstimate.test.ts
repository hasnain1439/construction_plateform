/**
 * Contract value optional until activation + "contract value from this estimate":
 * PATCH /projects/:id/contract (DRAFT without a value), review / activation, GET /estimate
 * `contractSuggestion`, POST /projects/:id/contract/from-estimate, company margin defaults.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { suggestContractValue, suggestLabourRate } from '../../src/modules/estimate/contractValue.js';
import { contractSuggestion, type BoqBasis } from '../../src/modules/estimate/estimate.service.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';
import { createDraft } from '../projects/fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);
type Auth = Record<string, string>;

async function patch(auth: Auth, id: string, path: string, body: object) {
  const res = await api().patch(`/api/v1/projects/${id}/${path}`).set(auth).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.data;
}

/** Tabs 1–5 with the contract saved WITHOUT a value. */
async function draftWithoutValue(auth: Auth, contract: Record<string, unknown> = { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' }) {
  const p = await createDraft(auth);
  const saved = await patch(auth, p.id, 'contract', contract);
  const plot = await patch(auth, p.id, 'plot-structure', {
    plotUnit: 'MARLA',
    plotSize: 5,
    frontFt: 25,
    depthFt: 45,
    structureType: 'FRAMED',
    hasBasement: false,
    floors: [{ level: 'GROUND', ceilingHeightFt: 11 }],
  });
  await patch(auth, p.id, 'coverage', { coveredAreaSqft: 1000, boundaryWall: false });
  const room = await api().post(`/api/v1/floors/${plot.floors[0].id}/rooms`).set(auth).send({ type: 'TV_LOUNGE', lengthFt: 30, widthFt: 28 });
  expect(room.status).toBe(201);
  return { ...p, saved };
}

const estimateOf = async (auth: Auth, id: string) => {
  const res = await api().get(`/api/v1/projects/${id}/estimate`).set(auth);
  expect(res.status).toBe(200);
  return res.body.data;
};
const fromEstimate = (auth: Auth, id: string, body: object = {}) => api().post(`/api/v1/projects/${id}/contract/from-estimate`).set(auth).send(body);

describe('contract value optional while DRAFT', () => {
  it('a draft saves tab 2 without a value (stage amounts 0); review blocks activation with CONTRACT_VALUE_MISSING (tab 2)', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    expect(p.saved.contract).toMatchObject({ contractType: 'GREY_OWNER_FINISHING', contractValuePaisa: null, contractTotalPaisa: null });
    expect(p.saved.billingStages.length).toBeGreaterThan(0);
    expect(p.saved.billingStages.every((s: { amountPaisa: string }) => s.amountPaisa === '0')).toBe(true);
    expect(p.saved.wizardCompletedSteps).toContain(2);

    const review = (await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).body.data;
    expect(review.ready).toBe(false);
    expect(review.errors).toEqual([{ tab: 2, code: 'CONTRACT_VALUE_MISSING', message: 'Enter the contract value' }]);
    const blocked = await api().post(`/api/v1/projects/${p.id}/activate`).set(auth);
    expect(blocked.status).toBe(400);
    expect(codes(blocked.body.error.details.errors)).toEqual(['CONTRACT_VALUE_MISSING']);

    // Labour-only without a rate is fine too while DRAFT
    const lab = await patch(auth, p.id, 'contract', { contractType: 'LABOR_ONLY', billingModel: 'RUNNING_BILLS' });
    expect(lab.contract).toMatchObject({ ratePerSqftPaisa: null, contractTotalPaisa: null });
    const labReview = (await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).body.data;
    expect(labReview.errors).toEqual([{ tab: 2, code: 'CONTRACT_VALUE_MISSING', message: 'Enter the labour rate per sq ft' }]);
  });

  it('a value given later recomputes the stage amounts; null clears it while DRAFT; values are still validated', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    const set = await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1000000000' });
    expect(set.billingStages.map((s: { amountPaisa: string }) => s.amountPaisa)).toEqual(
      set.billingStages.map((s: { percent: number }) => String(BigInt(s.percent * 100) * 100000n)), // Rs 1 crore × % (whole percents)
    );
    // omitted = kept
    const kept = await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' });
    expect(kept.contract.contractValuePaisa).toBe('1000000000');
    // null = cleared (draft), amounts back to 0
    const cleared = await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: null });
    expect(cleared.contract.contractValuePaisa).toBeNull();
    expect(cleared.billingStages.every((s: { amountPaisa: string }) => s.amountPaisa === '0')).toBe(true);
    const bad = await api().patch(`/api/v1/projects/${p.id}/contract`).set(auth).send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '12.5' });
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('an ACTIVE project cannot lose its value (CONTRACT_VALUE_REQUIRED / RATE_REQUIRED)', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1000000000' });
    expect((await api().post(`/api/v1/projects/${p.id}/activate`).set(auth)).status).toBe(200);

    const nulled = await api().patch(`/api/v1/projects/${p.id}/contract`).set(auth).send({ contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: null });
    expect(nulled.status).toBe(400);
    expect(nulled.body.error.code).toBe('CONTRACT_VALUE_REQUIRED');
    // changing the type drops the old value → must send the new one
    const typeChange = await api().patch(`/api/v1/projects/${p.id}/contract`).set(auth).send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE' });
    expect(typeChange.body.error.code).toBe('CONTRACT_VALUE_REQUIRED');
    const toLabour = await api().patch(`/api/v1/projects/${p.id}/contract`).set(auth).send({ contractType: 'LABOR_ONLY', billingModel: 'RUNNING_BILLS' });
    expect(toLabour.body.error.code).toBe('RATE_REQUIRED');
    const runningNoRate = await api().patch(`/api/v1/projects/${p.id}/contract`).set(auth).send({ contractType: 'GREY_OWNER_FINISHING', billingModel: 'RUNNING_BILLS' });
    expect(runningNoRate.body.error.code).toBe('RATE_REQUIRED');
    // unchanged type with the value omitted keeps it
    expect((await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' })).contract.contractValuePaisa).toBe('1000000000');
  });

  it('a user without fields.contract can save a first contract (value hidden, not required)', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    const p = await createDraft(o);
    await api().put(`/api/v1/projects/${p.id}/team`).set(o).send({ pmId: bilal });
    // the PM template has no fields.contract
    const res = await api().patch(`/api/v1/projects/${p.id}/contract`).set(await pm()).send({ contractType: 'FULL', billingModel: 'STAGE_SCHEDULE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.contract).not.toHaveProperty('contractValuePaisa');
    expect(res.body.data.billingStages[0]).not.toHaveProperty('amountPaisa');
  });
});

describe('running bills on a FULL / GREY contract', () => {
  it('keeps ratePerSqftPaisa as the billing rate; review error RUNNING_BILLS_RATE_MISSING without it; dropped for stage schedules', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth, { contractType: 'GREY_OWNER_FINISHING', billingModel: 'RUNNING_BILLS', contractValuePaisa: '1000000000' });
    expect(p.saved.contract).toMatchObject({ contractValuePaisa: '1000000000', ratePerSqftPaisa: null, contractTotalPaisa: '1000000000' });
    let review = (await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).body.data;
    expect(review.errors).toEqual([{ tab: 2, code: 'RUNNING_BILLS_RATE_MISSING', message: 'Running bills need a rate per sq ft' }]);

    const withRate = await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'RUNNING_BILLS', ratePerSqftPaisa: '150000' });
    // the rate is a billing rate only: the contract total stays the contract value
    expect(withRate.contract).toMatchObject({ contractValuePaisa: '1000000000', ratePerSqftPaisa: '150000', contractTotalPaisa: '1000000000' });
    review = (await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).body.data;
    expect(review.errors).toEqual([]);

    // activated → progress can be billed at that rate
    expect((await api().post(`/api/v1/projects/${p.id}/activate`).set(auth)).status).toBe(200);
    const progress = await api().get(`/api/v1/projects/${p.id}/billing-progress`).set(auth);
    expect(progress.status, JSON.stringify(progress.body)).toBe(200);
    expect(progress.body.data.ratePerSqftPaisa).toBe('150000');

    // switching to a stage schedule drops the billing rate
    const staged = await patch(auth, p.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' });
    expect(staged.contract.ratePerSqftPaisa).toBeNull();
  });
});

describe('contract value from the estimate', () => {
  it('GET /estimate suggests cost × (1 + company margin 20 %), rounded to Rs 1,000; sources are shown', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    const e = await estimateOf(auth, p.id);
    const cost = BigInt(e.boqCost.totalPaisa);
    expect(cost).toBeGreaterThan(0n);
    expect(e.contractSuggestion).toMatchObject({
      kind: 'CONTRACT_VALUE',
      contractType: 'GREY_OWNER_FINISHING',
      basisPaisa: e.boqCost.totalPaisa,
      marginPercent: 20,
      marginSource: 'COMPANY',
      finishingApplies: false,
      finishingAllowancePercent: 0,
      companyMarginPercent: 20,
      companyFinishingAllowancePercent: 0,
      suggestedPaisa: String(suggestContractValue(cost, 20)),
      currentPaisa: null,
    });
    expect(BigInt(e.contractSuggestion.suggestedPaisa) % 100000n).toBe(0n);
  });

  it('applies the suggestion, recomputes stage amounts, clears CONTRACT_VALUE_MISSING, and is audited', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    const e = await estimateOf(auth, p.id);
    const res = await fromEstimate(auth, p.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.contract.contractValuePaisa).toBe(e.contractSuggestion.suggestedPaisa);
    const total = res.body.data.billingStages.reduce((a: bigint, s: { amountPaisa: string }) => a + BigInt(s.amountPaisa), 0n);
    expect(total).toBe(BigInt(e.contractSuggestion.suggestedPaisa));
    // contract type, billing model, stages unchanged
    expect(res.body.data.contract).toMatchObject({ contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' });
    expect(res.body.data.billingStages.map((s: { label: string }) => s.label)).toEqual(p.saved.billingStages.map((s: { label: string }) => s.label));

    const review = (await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).body.data;
    expect(codes(review.errors)).not.toContain('CONTRACT_VALUE_MISSING');
    expect(review.ready).toBe(true);

    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'project.contract_from_estimate', entityId: p.id } });
    expect(audit.details).toMatchObject({
      kind: 'CONTRACT_VALUE',
      costPaisa: e.boqCost.totalPaisa,
      marginPercent: 20,
      marginSource: 'COMPANY',
      finishingAllowancePercent: 0,
      valuePaisa: e.contractSuggestion.suggestedPaisa,
      previousPaisa: null,
    });
    // the company default leaves no project override
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: p.id } })).marginPercent).toBeNull();
  });

  it('an existing value is overwritten only with replace: true (409 CONTRACT_VALUE_EXISTS); a custom margin sticks on the project', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth, { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '500000000' });
    const e = await estimateOf(auth, p.id);
    const cost = BigInt(e.boqCost.totalPaisa);
    // The BoQ prices finishing (tiles, paint, finishing labour) → no finishing allowance on top (never counted twice)
    expect(e.contractSuggestion).toMatchObject({ finishingApplies: false, finishingAllowancePercent: 0, currentPaisa: '500000000' });

    const exists = await fromEstimate(auth, p.id, { marginPercent: 25, finishingAllowancePercent: 40 });
    expect(exists.status).toBe(409);
    expect(exists.body.error).toMatchObject({ code: 'CONTRACT_VALUE_EXISTS', details: { currentPaisa: '500000000', suggestedPaisa: String(suggestContractValue(cost, 25, 0)) } });

    const replaced = await fromEstimate(auth, p.id, { marginPercent: 25, finishingAllowancePercent: 40, replace: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.contract.contractValuePaisa).toBe(String(suggestContractValue(cost, 25, 0)));
    // the custom percentages are stored and shown as PROJECT (the stored allowance is kept for a BoQ without finishing)
    const after = await estimateOf(auth, p.id);
    expect(after.contractSuggestion).toMatchObject({ marginPercent: 25, marginSource: 'PROJECT', finishingAllowancePercent: 0, finishingSource: 'PROJECT' });
    expect(Number((await prismaAdmin.project.findUniqueOrThrow({ where: { id: p.id } })).finishingAllowancePercent)).toBe(40);
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'project.contract_from_estimate', entityId: p.id } });
    expect(audit.details).toMatchObject({ marginPercent: 25, marginSource: 'PROJECT', finishingAllowancePercent: 0, previousPaisa: '500000000' });
  });

  it('labour-only: sets the rate = labour × (1 + margin) ÷ covered sq ft, nearest Rs 5', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth, { contractType: 'LABOR_ONLY', billingModel: 'RUNNING_BILLS' });
    const e = await estimateOf(auth, p.id);
    const labour = BigInt(e.boqCost.totalPaisa);
    expect(labour).toBeGreaterThan(0n);
    expect(e.contractSuggestion).toMatchObject({ kind: 'RATE_PER_SQFT', basisPaisa: e.boqCost.totalPaisa, coveredAreaSqft: 1000, suggestedPaisa: String(suggestLabourRate(labour, 20, 1000)) });
    const res = await fromEstimate(auth, p.id);
    expect(res.status).toBe(200);
    expect(res.body.data.contract.ratePerSqftPaisa).toBe(e.contractSuggestion.suggestedPaisa);
    expect(BigInt(res.body.data.contract.ratePerSqftPaisa) % 500n).toBe(0n);
  });

  it('company settings: the default margin / finishing allowance drive the suggestion', async () => {
    const auth = await owner();
    expect((await api().patch('/api/v1/company/settings').set(auth).send({ defaultMarginPercent: 15, defaultFinishingAllowancePercent: 60 })).status).toBe(200);
    const p = await draftWithoutValue(auth, { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE' });
    const e = await estimateOf(auth, p.id);
    expect(e.contractSuggestion).toMatchObject({
      marginPercent: 15,
      marginSource: 'COMPANY',
      companyFinishingAllowancePercent: 60,
      // the BoQ prices finishing → the allowance does not apply
      finishingApplies: false,
      finishingAllowancePercent: 0,
      suggestedPaisa: String(suggestContractValue(BigInt(e.boqCost.totalPaisa), 15, 0)),
    });
  });

  it('the finishing allowance applies to a FULL contract only when the BoQ prices no finishing', () => {
    const company = { marginPercent: 20, finishingAllowancePercent: 30 };
    const project = { contractType: 'FULL' as const, contractValuePaisa: null, ratePerSqftPaisa: null, marginPercent: null, finishingAllowancePercent: null };
    const basis: BoqBasis = {
      source: 'LIVE',
      estimateId: null,
      revision: null,
      status: null,
      directCostPaisa: 900_000_00n,
      overheadPaisa: 50_000_00n,
      contingencyPaisa: 50_000_00n,
      totalPaisa: 1_000_000_00n,
      finishingPaisa: 0n,
      coveredAreaSqft: 1000,
    };
    expect(contractSuggestion(project, basis, company)).toMatchObject({ finishingApplies: true, finishingAllowancePercent: 30, suggestedPaisa: String(suggestContractValue(1_000_000_00n, 20, 30)) });
    expect(contractSuggestion(project, { ...basis, finishingPaisa: 1n }, company)).toMatchObject({ finishingApplies: false, finishingAllowancePercent: 0, suggestedPaisa: String(suggestContractValue(1_000_000_00n, 20, 0)) });
    expect(contractSuggestion({ ...project, contractType: 'GREY_OWNER_FINISHING' }, basis, company)).toMatchObject({ finishingApplies: false, basisPaisa: '100000000' });
    // labour-only: the BoQ total (the contractor's labour scope) per sq ft
    expect(contractSuggestion({ ...project, contractType: 'LABOR_ONLY' }, basis, company)).toMatchObject({ kind: 'RATE_PER_SQFT', suggestedPaisa: String(suggestLabourRate(1_000_000_00n, 20, 1000)) });
  });

  it('QA-A-01/02: the suggestion, boqCost and the saved BoQ revision use the same total (live → draft → approved; estimateId picks one)', async () => {
    const auth = await owner();
    const p = await draftWithoutValue(auth);
    // Before any revision: the live BoQ preview
    const live = await estimateOf(auth, p.id);
    expect(live.boqCost).toMatchObject({ source: 'LIVE', estimateId: null, totalPaisa: live.boq.totalPaisa, directCostPaisa: live.boq.directCostPaisa });
    expect(live.contractSuggestion).toMatchObject({ basisSource: 'LIVE', basisPaisa: live.boq.totalPaisa });
    // the BoQ total is more than the old grey-structure cost (overheads, contingency, earthwork …)
    expect(BigInt(live.boq.totalPaisa)).toBeGreaterThan(BigInt(live.cost.totalPaisa));

    // Generate Rev 1 and adjust a line → the revision total differs from the live preview
    const gen = await api().post(`/api/v1/projects/${p.id}/estimates`).set(auth).send({});
    expect(gen.status, JSON.stringify(gen.body)).toBe(201);
    const rev = gen.body.data;
    const line = rev.sections.flatMap((s: { lines: Array<{ id: string; kind: string; suppliedBy: string; amountPaisa: string | null }> }) => s.lines).find((l: { kind: string; suppliedBy: string; amountPaisa: string | null }) => l.kind === 'MATERIAL' && l.suppliedBy === 'CONTRACTOR' && l.amountPaisa);
    const adj = await api().patch(`/api/v1/estimates/${rev.id}/lines/${line.id}`).set(auth).send({ quantity: 1, note: 'QA' });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    const draft = (await api().get(`/api/v1/estimates/${rev.id}`).set(auth)).body.data;
    expect(draft.totalPaisa).not.toBe(live.boq.totalPaisa);

    const withDraft = await estimateOf(auth, p.id);
    expect(withDraft.boqCost).toMatchObject({ source: 'REVISION', estimateId: rev.id, revision: 1, status: 'DRAFT', totalPaisa: draft.totalPaisa, perSqftPaisa: draft.perSqftPaisa });
    expect(withDraft.contractSuggestion).toMatchObject({ basisSource: 'REVISION', estimateId: rev.id, basisPaisa: draft.totalPaisa, suggestedPaisa: String(suggestContractValue(BigInt(draft.totalPaisa), 20)) });

    // estimateId: null = the live preview; an unknown id → 404
    expect((await fromEstimate(auth, p.id, { estimateId: '01900000-0000-7000-8000-000000000000' })).body.error.code).toBe('ESTIMATE_NOT_FOUND');
    const fromLive = await fromEstimate(auth, p.id, { estimateId: null });
    expect(fromLive.status, JSON.stringify(fromLive.body)).toBe(200);
    expect(fromLive.body.data.contract.contractValuePaisa).toBe(String(suggestContractValue(BigInt(live.boq.totalPaisa), 20)));
    // the revision on screen
    const fromRev = await fromEstimate(auth, p.id, { estimateId: rev.id, replace: true });
    expect(fromRev.status).toBe(200);
    expect(fromRev.body.data.contract.contractValuePaisa).toBe(withDraft.contractSuggestion.suggestedPaisa);

    // the margin shown with the BoQ cost is the BoQ margin (same as the revision's)
    const after = await estimateOf(auth, p.id);
    const revAfter = (await api().get(`/api/v1/estimates/${rev.id}`).set(auth)).body.data;
    expect(after.boqCost).toMatchObject({ contractTotalPaisa: revAfter.contractTotalPaisa, marginPaisa: revAfter.marginPaisa, marginPercent: revAfter.marginPercent });
  });

  it('errors: no contract type → CONTRACT_MISSING; no cost → ESTIMATE_COST_MISSING; validation; locked', async () => {
    const auth = await owner();
    const bare = await createDraft(auth);
    expect((await fromEstimate(auth, bare.id)).body.error.code).toBe('CONTRACT_MISSING');
    await patch(auth, bare.id, 'contract', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE' });
    const noCost = await fromEstimate(auth, bare.id);
    expect(noCost.status).toBe(400);
    expect(noCost.body.error.code).toBe('ESTIMATE_COST_MISSING');
    expect((await fromEstimate(auth, bare.id, { marginPercent: 101 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await fromEstimate(auth, bare.id, { finishingAllowancePercent: 201 })).body.error.code).toBe('VALIDATION_ERROR');

    const p = await draftWithoutValue(auth);
    await prismaAdmin.project.update({ where: { id: p.id }, data: { status: 'HANDED_OVER' } });
    expect((await fromEstimate(auth, p.id)).body.error.code).toBe('PROJECT_LOCKED');
  });

  it('permissions: needs projects.project.edit + fields.contract + fields.rates; out of scope → 404', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    const p = await draftWithoutValue(o);
    await api().put(`/api/v1/projects/${p.id}/team`).set(o).send({ pmId: bilal });
    const asPm = await pm();
    // the PM template has fields.rates but not fields.contract → 403, and no suggestion in the estimate
    const denied = await fromEstimate(asPm, p.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'fields.contract' } });
    expect((await estimateOf(asPm, p.id)).contractSuggestion).toBeUndefined();

    // grant fields.contract → allowed on an assigned project
    expect((await api().put(`/api/v1/users/${bilal}/permission-overrides`).set(o).send({ overrides: [{ key: 'fields.contract', effect: 'ALLOW' }] })).status).toBe(200);
    expect((await fromEstimate(await pm(), p.id)).status).toBe(200);
    expect((await fromEstimate(await pm(), seeded().projects.bahria.id)).status).toBe(404);

    // without fields.rates (cost hidden) → 403
    expect(
      (await api().put(`/api/v1/users/${bilal}/permission-overrides`).set(o).send({ overrides: [{ key: 'fields.contract', effect: 'ALLOW' }, { key: 'fields.rates', effect: 'DENY' }] })).status,
    ).toBe(200);
    const noRates = await fromEstimate(await pm(), p.id, { replace: true });
    expect(noRates.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'fields.rates' } });
  });
});
