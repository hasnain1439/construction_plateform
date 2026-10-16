/**
 * Step 14 · control API on the Malik & Sons demo + the Step 14 seed (prisma/seedControl.ts:
 * DHA's material history with cement 6 % over on the ground-floor slab, the first-floor slab
 * promised within 5 team-days). Variance maths on the seed (hand-checked below), price vs
 * quantity variance, cost variance + projected margin, burn rate vs progress, delay analysis,
 * alert thresholds + dedupe, recipients by permission, on-write triggers, PKR gating, settings.
 *
 * DHA cement, by hand (APPROVED estimate Rev 1, quotas in bags):
 *   estimated to date 366.148 = the quotas of the done / curing milestones × 100 % + the
 *     first-floor slab quota × 20 %
 *   used 431.016 = the seed's site records (quota × work done, × 1.06 on the GF slab) 378.016
 *     + the stock demo's last three days 20 + 15 + 18 = 53;   counted loss 0
 *   delivered 568.016 = 190 (GP-0142, 10 short) + 378.016 (site purchases);  in stock 137
 *   variance 431.016 − 366.148 = 64.868 bags = 17.7 % > 10 % → OVER (WARNING: < 2 × 10 %)
 *   quantity impact 64.868 × Rs 1,450 (estimate rate) = Rs 94,058.60 → 9,405,860 paisa
 *   price impact (average Rs 1,470.31 − Rs 1,450) × 431.016 bags ≈ Rs 8,753.82 → 875,382 paisa
 *     (average = (190 × 1,453.02 + 378.016 × 1,479) ÷ 568.016 — GP-0142 at the store average,
 *     the site purchases at 1,450 × 1.02)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { recipientsFor } from '../../src/modules/control/alerts/engine.js';
import { spendAheadOfProgress } from '../../src/modules/control/alerts/rules/builtin.js';
import { runControlAlerts } from '../../src/jobs/controlAlerts.js';
import { api, bearer, grantFinancials, loginMobile, loginMunshi, SEED, useFreshDatabase, withSeedSnapshot } from '../helpers.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  await withSeedSnapshot('malik_control', seeded());
});

type Auth = Record<string, string>;
const owner = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const dha = () => seeded().projects.dha.id;
const get = async (auth: Auth, path: string) => {
  const res = await api().get(path).set(auth);
  expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.body.data;
};
const pmUser = () => prismaAdmin.user.findFirstOrThrow({ where: { tenantId: seeded().malik.id, phone: SEED.malik.pm.phone } });
type Item = { description: string; materialId: string; estimatedTotalQty: number; estimatedToDateQty: number; deliveredQty: number | null; usedQty: number; lossQty: number | null; inStockQty: number | null; consumedQty: number; varianceQty: number; variancePercent: number | null; status: string; estimateRatePaisa?: string | null; actualAvgCostPaisa?: string | null; quantityImpactPaisa?: string | null; priceImpactPaisa?: string | null; impactPaisa?: string | null };
type Alert = { id: string; rule: string; severity: string; status: string; title: string; body: string; occurrences: number; details: Record<string, unknown> };
const NO_PAISA = /Paisa/;

describe('material variance', () => {
  it('estimated (prorated) vs delivered vs used vs stock vs loss on the seed — cement is over', async () => {
    const d = await get(await owner(), `/api/v1/projects/${dha()}/control/material-variance`);
    expect(d.hasSchedule).toBe(true);
    expect(d.thresholdPercent).toBe(10);
    const cement = (d.items as Item[]).find((i) => i.description === 'Cement OPC')!;
    expect(cement).toMatchObject({ estimatedToDateQty: 366.148, usedQty: 431.016, lossQty: 0, deliveredQty: 568.016, inStockQty: 137, consumedQty: 431.016, varianceQty: 64.868, variancePercent: 17.7, status: 'OVER' });
    expect(cement.estimateRatePaisa).toBe('145000');
    expect(cement.quantityImpactPaisa).toBe('9405860');
    expect(cement.priceImpactPaisa).toBe('875382');
    expect(BigInt(cement.impactPaisa!)).toBe(9405860n + 875382n);
    // stock identity: delivered − used − loss = in stock (nothing sent away from the site)
    expect(cement.deliveredQty! - cement.usedQty - cement.lossQty!).toBeCloseTo(cement.inStockQty!, 3);
    // independent check of "estimated to date" from the milestone quotas
    const quotas = await prismaAdmin.milestoneQuota.findMany({ where: { tenantId: seeded().malik.id, materialId: cement.materialId, milestone: { projectId: dha() } }, include: { milestone: true } });
    const due = quotas.reduce((s, q) => s + Number(q.plannedQty) * ((q.milestone.status === 'DONE' || q.milestone.status === 'CURING' ? 100 : q.milestone.progressPercent) / 100), 0);
    expect(cement.estimatedToDateQty).toBeCloseTo(due, 2);
    expect(d.counts.over).toBe(1);
    expect(d.totals.impactPaisa).toBe((d.items as Item[]).reduce((s, i) => s + BigInt(i.impactPaisa ?? '0'), 0n).toString());
  });

  it('splits the rupee impact into quantity and price variance', async () => {
    const items = (await get(await owner(), `/api/v1/projects/${dha()}/control/material-variance`)).items as Item[];
    const steel = items.find((i) => i.description === 'Steel Grade-60 #4')!;
    const bricks = items.find((i) => i.description === 'Clay bricks Class-1')!;
    // steel: 3 % over (on track) and bought 4 % above the estimate rate → both parts positive
    expect(steel.status).toBe('ON_TRACK');
    expect(Number(steel.quantityImpactPaisa)).toBeCloseTo(steel.varianceQty * Number(steel.estimateRatePaisa), -2);
    expect(Number(steel.priceImpactPaisa)).toBeCloseTo((Number(steel.actualAvgCostPaisa) - Number(steel.estimateRatePaisa)) * steel.consumedQty, -2);
    expect(Number(steel.priceImpactPaisa)).toBeGreaterThan(0);
    // bricks: bought at the estimate rate → no price variance, only quantity
    expect(bricks.actualAvgCostPaisa).toBe(bricks.estimateRatePaisa);
    expect(bricks.priceImpactPaisa).toBe('0');
    expect(BigInt(bricks.quantityImpactPaisa!)).toBe(BigInt(Math.round(bricks.varianceQty * Number(bricks.estimateRatePaisa))));
  });

  it('per milestone: that milestone’s quota × its progress vs usage linked to it', async () => {
    const auth = await owner();
    const all = await get(auth, `/api/v1/projects/${dha()}/control/material-variance`);
    const slab = (all.milestones as Array<{ id: string; key: string }>).find((m) => m.key === 'GF_STRUCTURE.SLAB')!;
    const d = await get(auth, `/api/v1/projects/${dha()}/control/material-variance?milestoneId=${slab.id}`);
    expect(d.milestone).toMatchObject({ key: 'GF_STRUCTURE.SLAB', progressPercent: 100 });
    const cement = (d.items as Item[]).find((i) => i.description === 'Cement OPC')!;
    // the slab used its quota × 1.06 → +6 % (on track at 10 %); site-level figures are not split by milestone
    expect(cement.variancePercent).toBeCloseTo(6, 0);
    expect(cement.status).toBe('ON_TRACK');
    expect(cement).toMatchObject({ deliveredQty: null, inStockQty: null, lossQty: null });
    const other = await prismaAdmin.project.findFirstOrThrow({ where: { tenantId: seeded().malik.id, id: { not: dha() }, status: 'ACTIVE' } });
    const bad = await api().get(`/api/v1/projects/${other.id}/control/material-variance?milestoneId=${slab.id}`).set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_MILESTONE');
  });
});

describe('cost variance, burn rate, projected margin', () => {
  it('buckets add up to the cost to date; estimate to date follows stage progress; EAC from earned value', async () => {
    const auth = await owner();
    const d = await get(auth, `/api/v1/projects/${dha()}/control/cost-variance`);
    expect(d.progress.basis).toBe('ESTIMATE_VALUE');
    const buckets = d.buckets as Array<{ bucket: string; estimateToDatePaisa: string; actualPaisa: string; variancePaisa: string }>;
    expect(buckets.map((b) => b.bucket)).toEqual(['MATERIALS', 'LABOUR', 'SUBCONTRACT', 'EQUIPMENT', 'OVERHEADS', 'LOSSES', 'CONTINGENCY']);
    const actual = buckets.reduce((s, b) => s + BigInt(b.actualPaisa), 0n);
    expect(actual.toString()).toBe(d.totals.actualPaisa);
    for (const b of buckets) expect(BigInt(b.variancePaisa)).toBe(BigInt(b.actualPaisa) - BigInt(b.estimateToDatePaisa));
    const pnl = (await get(auth, `/api/v1/finance/pnl?projectId=${dha()}`)).projects[0];
    expect(d.totals.actualPaisa).toBe(pnl.costToDatePaisa);
    // done stages are fully "due"; the estimate to date never exceeds the estimate
    const gf = (d.stages as Array<{ stageKey: string; progressPercent: number; estimatePaisa: string; estimateToDatePaisa: string }>).find((s) => s.stageKey === 'GF_STRUCTURE')!;
    expect(gf.progressPercent).toBe(100);
    expect(gf.estimateToDatePaisa).toBe(gf.estimatePaisa);
    // projection: EAC = AC + (BAC − EV) ÷ CPI, margin = revised contract − EAC
    const p = d.projection;
    const ac = Number(p.actualToDatePaisa);
    const bac = Number(p.budgetAtCompletionPaisa);
    const ev = Number(p.earnedValuePaisa);
    expect(Math.abs(ev - (bac * d.progress.percent) / 100)).toBeLessThanOrEqual(bac * 0.0005); // progress is shown to 1 dp
    expect(p.costPerformanceIndex).toBeCloseTo(Math.min(1.5, Math.max(0.5, ev / ac)), 3);
    expect(Number(p.estimateAtCompletionPaisa)).toBeCloseTo(ac + (bac - ev) / p.costPerformanceIndex, -3);
    expect(BigInt(p.projectedMarginPaisa)).toBe(BigInt(p.revisedContractPaisa) - BigInt(p.estimateAtCompletionPaisa));
    // the P&L shows the same projected margin (no more "Phase 2" null)
    expect(pnl.projectedMarginPercent).toBe(p.projectedMarginPercent);
    expect(pnl.projectedMarginPaisa).toBe(p.projectedMarginPaisa);
    expect(pnl.projectedMarginBasis).toBe('EARNED_VALUE');
  });

  it('burn rate: cumulative cost % of contract vs physical progress per month', async () => {
    const d = await get(await owner(), `/api/v1/projects/${dha()}/control/burn-rate`);
    const months = d.months as Array<{ month: string; progressPercent: number; costPaisa: string; cumulativeCostPaisa: string; spentPercent: number; gapPoints: number; ahead: boolean }>;
    expect(months[0]!.month).toBe('2026-03'); // the schedule start
    let cum = 0n;
    for (const [i, m] of months.entries()) {
      cum += BigInt(m.costPaisa);
      expect(m.cumulativeCostPaisa).toBe(cum.toString());
      expect(m.spentPercent).toBeCloseTo(Number((cum * 10000n) / BigInt(d.contractPaisa)) / 100, 1);
      expect(m.gapPoints).toBeCloseTo(m.spentPercent - m.progressPercent, 0);
      expect(m.ahead).toBe(m.gapPoints > d.thresholdPoints);
      if (i > 0) expect(m.progressPercent).toBeGreaterThanOrEqual(months[i - 1]!.progressPercent);
    }
    const cost = await get(await owner(), `/api/v1/projects/${dha()}/control/cost-variance`);
    expect(months.at(-1)!.cumulativeCostPaisa).toBe(cost.totals.actualPaisa);
    expect(d.current.progressPercent).toBe(cost.progress.percent);
  });
});

describe('delay analysis', () => {
  it('Step 13 delay breakdown + planned vs actual per milestone + a timeline', async () => {
    const d = await get(await owner(), `/api/v1/projects/${dha()}/control/delay-analysis`);
    expect(d.hasSchedule).toBe(true);
    expect(d.delays).toMatchObject({ days: expect.objectContaining({ excusable: 2 }) });
    const slab = (d.milestones as Array<{ key: string; behind: boolean; behindPoints: number; progressPercent: number; plannedProgressPercent: number }>).find((m) => m.key === 'F1_STRUCTURE.SLAB')!;
    expect(slab).toMatchObject({ behind: true, progressPercent: 20 });
    expect(slab.behindPoints).toBeGreaterThanOrEqual(15);
    expect(slab.behindPoints).toBeCloseTo(slab.plannedProgressPercent - 20, 1);
    expect(d.summary.behind).toBe(1);
    const kinds = new Set((d.timeline as Array<{ kind: string; title: string }>).map((e) => `${e.kind}:${e.title}`));
    expect(kinds.has('STOPPAGE:RAIN')).toBe(true);
    expect(kinds.has('PLAN_VERSION:MILESTONE_EDITED')).toBe(true);
    // a project without a schedule
    const other = await prismaAdmin.project.findFirstOrThrow({ where: { tenantId: seeded().malik.id, id: { not: dha() }, status: 'ACTIVE' } });
    expect(await get(await owner(), `/api/v1/projects/${other.id}/control/delay-analysis`)).toMatchObject({ hasSchedule: false, delays: null, milestones: [] });
  });
});

describe('alert engine', () => {
  it('the seed opened cement overuse (WARNING) and the slab behind plan (CRITICAL), notified by permission', async () => {
    const auth = await owner();
    const items = (await get(auth, `/api/v1/projects/${dha()}/control/alerts`)).items as Alert[];
    const overuse = items.find((a) => a.rule === 'MATERIAL_OVERUSE')!;
    const behind = items.find((a) => a.rule === 'MILESTONE_BEHIND_PLAN')!;
    expect(overuse).toMatchObject({ severity: 'WARNING', status: 'OPEN', occurrences: 1 });
    expect(overuse.details).toMatchObject({ variancePercent: 17.7, thresholdPercent: 10 });
    expect(behind).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    for (const a of items) expect(JSON.stringify(a)).not.toMatch(/Rs\.?\s*\d|Paisa/);
    // recipients: the owner and the PM of the project (control.view); never the Munshi
    const notes = await prismaAdmin.notification.findMany({ where: { tenantId: seeded().malik.id, type: 'CONTROL_ALERT', refId: overuse.id }, include: { user: { select: { role: true } } } });
    expect(notes.map((n) => n.user.role).sort()).toEqual(['PM', 'THEKEDAR']);
    // the dashboard lists them; DHA counts as delayed
    const dash = await get(auth, '/api/v1/dashboard/overview');
    expect((dash.alerts as Array<{ source: string; type: string }>).filter((a) => a.source === 'CONTROL_ALERT').map((a) => a.type).sort()).toEqual(['MATERIAL_OVERUSE', 'MILESTONE_BEHIND_PLAN']);
    expect(dash.kpis.activeProjects.delayed).toBe(1);
  });

  it('dedupe: running again updates the open alerts without notifying twice', async () => {
    const auth = await owner();
    const before = await prismaAdmin.notification.count({ where: { tenantId: seeded().malik.id, type: 'CONTROL_ALERT' } });
    const run = await api().post('/api/v1/control/alerts/run').set(auth).send({ projectId: dha() });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.data).toMatchObject({ projects: 1, opened: 0, updated: 2, resolved: 0, notified: 0 });
    const job = await runControlAlerts(new Date(), { tenantId: seeded().malik.id });
    expect(job).toMatchObject({ opened: 0, notified: 0, failed: 0 });
    expect(await prismaAdmin.notification.count({ where: { tenantId: seeded().malik.id, type: 'CONTROL_ALERT' } })).toBe(before);
    expect(await prismaAdmin.controlAlert.count({ where: { tenantId: seeded().malik.id } })).toBe(2);
    const audit = await prismaAdmin.auditLog.findFirst({ where: { tenantId: seeded().malik.id, action: 'control.alerts_run' } });
    expect(audit).not.toBeNull();
  });

  it('thresholds: a higher overuse % resolves the alert, a lower one reopens it as CRITICAL and notifies again', async () => {
    const auth = await owner();
    const put = (body: Record<string, unknown>) => api().put('/api/v1/control/settings').set(auth).send(body);
    expect((await put({ overuseAlertPercent: 20, behindPlanAlertPoints: 50 })).status).toBe(200);
    let r = (await api().post('/api/v1/control/alerts/run').set(auth).send({ projectId: dha() })).body.data;
    expect(r).toMatchObject({ opened: 0, resolved: 2 });
    expect((await get(auth, `/api/v1/projects/${dha()}/control/alerts`)).items).toEqual([]);
    expect(((await get(auth, `/api/v1/projects/${dha()}/control/alerts?status=RESOLVED`)).items as Alert[]).length).toBe(2);
    // 5 %: cement 17.7 % reopens (≥ 2 × 5 % → CRITICAL); bricks 7.5 % and sand 6.4 % open for the first time
    expect((await put({ overuseAlertPercent: 5 })).status).toBe(200);
    r = (await api().post('/api/v1/control/alerts/run').set(auth).send({ projectId: dha(), rules: ['MATERIAL_OVERUSE'] })).body.data;
    expect(r).toMatchObject({ opened: 3, resolved: 0 });
    expect(r.notified).toBeGreaterThan(0);
    const overuse = ((await get(auth, `/api/v1/projects/${dha()}/control/alerts`)).items as Alert[]).find((a) => a.rule === 'MATERIAL_OVERUSE')!;
    expect(overuse).toMatchObject({ severity: 'CRITICAL', occurrences: 2 });
    // the material variance view uses the same threshold
    expect((await get(auth, `/api/v1/projects/${dha()}/control/material-variance`)).thresholdPercent).toBe(5);
    // switched off → nothing runs
    expect((await put({ controlAlertsEnabled: false })).status).toBe(200);
    expect((await api().post('/api/v1/control/alerts/run').set(auth).send({})).body.error.code).toBe('ALERTS_DISABLED');
  });

  it('on-write trigger: usage that uses up a milestone quota opens QUOTA_EXHAUSTED for the office, never the Munshi', async () => {
    const m = await munshi();
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha(), key: 'F1_STRUCTURE.SLAB' }, include: { quotas: true } });
    const cementId = (await prismaAdmin.material.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Cement OPC' } })).id;
    const quota = slab.quotas.find((q) => q.materialId === cementId)!;
    const linked = await prismaAdmin.materialUsageItem.aggregate({ where: { materialId: cementId, usage: { milestoneId: slab.id } }, _sum: { qty: true } });
    const need = Math.ceil(Number(quota.plannedQty) - Number(linked._sum.qty ?? 0));
    // enough cement on site for it
    const { stockIn, siteOf } = await import('../inventory/fixtures.js');
    await stockIn(seeded().malik.id, (await siteOf(seeded().malik.id, dha())).id, cementId, need + 5, 145000n);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    const res = await api().post(`/api/v1/projects/${dha()}/material-usage`).set(m).send({ usageDate: today, milestoneId: slab.id, items: [{ materialId: cementId, qty: need }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const alert = await prismaAdmin.controlAlert.findFirstOrThrow({ where: { tenantId: seeded().malik.id, rule: 'QUOTA_EXHAUSTED' } });
    expect(alert).toMatchObject({ status: 'OPEN', refId: slab.id, dedupeKey: `QUOTA_EXHAUSTED:${slab.id}:${cementId}` });
    const notes = await prismaAdmin.notification.findMany({ where: { refId: alert.id }, include: { user: { select: { role: true } } } });
    expect(notes.map((n) => n.user.role).sort()).toEqual(['PM', 'THEKEDAR']);
    // the Munshi has no control access at all
    expect((await api().get(`/api/v1/projects/${dha()}/control/alerts`).set(m)).status).toBe(403);
  });

  it('money rules reach only users with the money permissions (recipients by permission)', async () => {
    const tenantId = seeded().malik.id;
    const project = dha();
    const bilal = await pmUser();
    const ids = await withTenant(tenantId, (tx) => recipientsFor(tx, tenantId, project, spendAheadOfProgress));
    expect(ids).not.toContain(bilal.id); // PM template: control.view but no fields.amounts / contract
    await grantFinancials(tenantId, bilal.id);
    const after = await withTenant(tenantId, (tx) => recipientsFor(tx, tenantId, project, spendAheadOfProgress));
    expect(after).toContain(bilal.id);
  });

  it('lists the rule registry with the Step 16 hook pending', async () => {
    const rules = (await get(await owner(), '/api/v1/control/alerts/rules')) as Array<{ rule: string; status: string; source: string; threshold: { value: unknown } | null }>;
    const by = new Map(rules.map((r) => [r.rule, r]));
    expect(by.get('EQUIPMENT_IDLE')).toMatchObject({ status: 'PENDING_PLUGIN' });
    expect(by.get('MATERIAL_OVERUSE')).toMatchObject({ status: 'ACTIVE', threshold: { setting: 'overuseAlertPercent', value: 10 } });
    expect(by.get('MISSING_DAILY_LOG')).toMatchObject({ source: 'EXTERNAL', threshold: { value: '18:00' } });
    expect(by.get('STAGE_READY_UNBILLED')).toMatchObject({ source: 'EXTERNAL' });
    const bad = await api().post('/api/v1/control/alerts/run').set(await owner()).send({ rules: ['EQUIPMENT_IDLE'] });
    expect(bad.body.error.code).toBe('UNKNOWN_RULE');
  });
});

describe('permissions and rupee gating', () => {
  it('PM: quantities, progress, delays, material rates (fields.rates) — no cost money, no projected margin', async () => {
    const auth = await pm();
    const mv = await get(auth, `/api/v1/projects/${dha()}/control/material-variance`);
    expect((mv.items as Item[])[0]!.estimateRatePaisa).toBeDefined(); // PM template has fields.rates
    const cv = await get(auth, `/api/v1/projects/${dha()}/control/cost-variance`);
    expect(JSON.stringify(cv)).not.toMatch(NO_PAISA);
    expect(cv.projection).toBeUndefined();
    expect(cv.buckets[0]).toEqual({ bucket: 'MATERIALS', status: expect.any(String) });
    const br = await get(auth, `/api/v1/projects/${dha()}/control/burn-rate`);
    expect(JSON.stringify(br)).not.toMatch(NO_PAISA);
    expect(br.months[0].spentPercent).toBeUndefined();
    expect(br.months[0].progressPercent).toBeDefined();
    const sum = await get(auth, '/api/v1/control/summary');
    expect(sum.projects[0].spentPercent).toBeUndefined();
    expect(sum.projects[0].projectedMarginPercent).toBeUndefined();
    // cannot change thresholds or run the engine
    expect((await api().put('/api/v1/control/settings').set(auth).send({ overuseAlertPercent: 5 })).status).toBe(403);
    expect((await api().post('/api/v1/control/alerts/run').set(auth).send({})).status).toBe(403);
  });

  it('without fields.rates: no rupee keys anywhere in material variance', async () => {
    const bilal = await pmUser();
    const deny = await api().put(`/api/v1/users/${bilal.id}/permission-overrides`).set(await owner()).send({ overrides: [{ key: 'fields.rates', effect: 'DENY' }] });
    expect(deny.status, JSON.stringify(deny.body)).toBe(200);
    const mv = await get(await pm(), `/api/v1/projects/${dha()}/control/material-variance`);
    expect(JSON.stringify(mv)).not.toMatch(NO_PAISA);
    expect(mv.totals).toBeUndefined();
    expect((mv.items as Item[]).find((i) => i.description === 'Cement OPC')).toMatchObject({ varianceQty: 64.868, status: 'OVER' });
  });

  it('PM with the financial bundle sees cost money, spent % and the projected margin', async () => {
    await grantFinancials(seeded().malik.id, (await pmUser()).id);
    const auth = await pm();
    const cv = await get(auth, `/api/v1/projects/${dha()}/control/cost-variance`);
    expect(cv.totals.actualPaisa).toMatch(/^\d+$/);
    expect(cv.projection.projectedMarginPercent).toEqual(expect.any(Number));
    const br = await get(auth, `/api/v1/projects/${dha()}/control/burn-rate`);
    expect(br.contractPaisa).toBe('1850000000');
    expect(br.current.spentPercent).toEqual(expect.any(Number));
  });

  it('the Munshi has no control routes; thresholds validate and are audited', async () => {
    const m = await munshi();
    for (const p of ['material-variance', 'cost-variance', 'burn-rate', 'delay-analysis']) expect((await api().get(`/api/v1/projects/${dha()}/control/${p}`).set(m)).status).toBe(403);
    expect((await api().get('/api/v1/control/summary').set(m)).status).toBe(403);
    const auth = await owner();
    const bad = await api().put('/api/v1/control/settings').set(auth).send({ quotaAlertPercent: 300 });
    expect(bad.status).toBe(400);
    const ok = await api().put('/api/v1/control/settings').set(auth).send({ spendAheadAlertPoints: 12, lateFinishGraceDays: 5 });
    expect(ok.body.data).toMatchObject({ spendAheadAlertPoints: 12, lateFinishGraceDays: 5, overuseAlertPercent: 10 });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: seeded().malik.id, action: 'control.settings_update' } });
    expect(audit.details).toMatchObject({ before: { spendAheadAlertPoints: 10, lateFinishGraceDays: 3 }, after: { spendAheadAlertPoints: 12, lateFinishGraceDays: 5 } });
    // the owner's company settings ("Alerts & Limits") carry them too
    const s = await get(auth, '/api/v1/company/settings');
    expect(s).toMatchObject({ spendAheadAlertPoints: 12, behindPlanAlertPoints: 15, quotaAlertPercent: 100, controlAlertsEnabled: true });
    const patch = await api().patch('/api/v1/company/settings').set(auth).send({ behindPlanAlertPoints: 20 });
    expect(patch.status).toBe(200);
    expect((await get(auth, '/api/v1/control/settings')).behindPlanAlertPoints).toBe(20);
  });

  it('company summary: progress, behind, overuse and open alerts per project', async () => {
    const d = await get(await owner(), '/api/v1/control/summary');
    const row = (d.projects as Array<{ project: { id: string }; behindMilestones: number; overuseMaterials: number; openAlerts: { critical: number; warning: number }; projectedMarginPercent: number }>).find((p) => p.project.id === dha())!;
    expect(row).toMatchObject({ behindMilestones: 1, overuseMaterials: 1, openAlerts: { critical: 1, warning: 1 } });
    expect(row.projectedMarginPercent).toEqual(expect.any(Number));
    expect(d.alerts).toMatchObject({ open: 2, byRule: { MATERIAL_OVERUSE: 1, MILESTONE_BEHIND_PLAN: 1 } });
  });
});
