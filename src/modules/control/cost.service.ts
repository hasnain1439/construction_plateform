/**
 * Step 14 · cost control: cost variance by bucket vs the estimate to date, burn rate (cost % of
 * contract) vs physical progress by month, and the projected margin at completion.
 *
 *   estimate to date   each APPROVED estimate line's amount × its stage's progress (lines without a
 *                      stage — overheads / contingency — × physical progress)
 *   actual             cost engine rows (billing/projectCost.service.ts), regrouped:
 *                      MATERIALS ← MATERIALS · LABOUR ← LABOR_WAGES · SUBCONTRACT ← SUBCONTRACT ·
 *                      EQUIPMENT ← EQUIPMENT · OVERHEADS ← SITE_OVERHEAD · LOSSES ← LOSSES
 *   projected margin   BAC = estimate total + approved change cost; EV = BAC × physical progress;
 *                      CPI = EV ÷ AC (0.5–1.5; 1 when progress < 10 % or nothing spent);
 *                      EAC = AC + (BAC − EV) ÷ CPI; margin = revised contract − EAC.
 *                      Without an APPROVED estimate: EAC = AC ÷ progress (progress ≥ 10 %).
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import { BUCKET_OF, costRows, type CostRow, type PnlBucket } from '../billing/projectCost.service.js';
import { moneyOf } from '../billing/receivables.service.js';
import { approvedChangesOf, type ApprovedChanges } from './changeOrders.hook.js';
import { bigPct, controlCaller, controlProject, controlSettings, moneyView, p1, paisaOf, ref, str, today, type ControlSettings, type MoneyView } from './control.shared.js';
import { CONTROL_BUCKETS, loadApprovedEstimate, type ControlBucket, type EstimateData } from './estimate.js';
import { loadPlan, loadUpdates, physicalProgress, plannedProgress, progressAsOf, type ProgressBasis, type ProjectPlan } from './plan.js';

/** P&L bucket → control bucket. */
const ACTUAL_BUCKET: Record<PnlBucket, ControlBucket> = {
  MATERIALS: 'MATERIALS',
  LABOR_WAGES: 'LABOUR',
  SUBCONTRACT: 'SUBCONTRACT',
  EQUIPMENT: 'EQUIPMENT',
  SITE_OVERHEAD: 'OVERHEADS',
  LOSSES: 'LOSSES',
};

/** Projected margin needs this much physical progress before performance (CPI) counts. */
export const MIN_PROGRESS_FOR_CPI = 10;
export const CPI_MIN = 0.5;
export const CPI_MAX = 1.5;

export interface CostContext {
  project: Project;
  estimate: EstimateData | null;
  plan: ProjectPlan | null;
  progress: { percent: number; basis: ProgressBasis; stages: Map<string, number> };
  rows: CostRow[];
  actualPaisa: bigint;
  contractPaisa: bigint;
  changes: ApprovedChanges;
}

/**
 * Contract of the receivables (`moneyOf`). A revised contract (`revisedContractPaisa` /
 * `revisedContract`) is the contract with the approved changes already in it (inContract). The
 * real `moneyOf` returns `contract` = `originalContract` + `approvedChanges`: the projection then
 * uses the original contract + those approved changes. Either way they are never added twice.
 */
export function contractOf(m: { contract: bigint } & Record<string, unknown>, changes: ApprovedChanges): { contractPaisa: bigint; changes: ApprovedChanges } {
  const revised = m['revisedContract'] ?? m['revisedContractPaisa'];
  if (typeof revised === 'bigint' || (typeof revised === 'string' && /^-?\d+$/.test(revised))) return { contractPaisa: BigInt(revised), changes: { ...changes, inContract: true } };
  // Receivables moneyOf(): `contract` = original + approved changes (Step 15) → split it back so the
  // projection shows the original contract + the approved changes and the price counts once.
  const original = m['originalContract'];
  const approved = m['approvedChanges'];
  if (typeof original === 'bigint' && typeof approved === 'bigint') return { contractPaisa: original, changes: { ...changes, pricePaisa: approved, inContract: false } };
  return { contractPaisa: m.contract, changes };
}

export async function loadCostContext(tx: Tx, tenantId: string, project: Project, pre: { plan?: ProjectPlan | null; estimate?: EstimateData | null } = {}): Promise<CostContext> {
  const plan = pre.plan !== undefined ? pre.plan : await loadPlan(tx, tenantId, project.id);
  const estimate = pre.estimate !== undefined ? pre.estimate : await loadApprovedEstimate(tx, tenantId, project.id);
  const progress = plan ? physicalProgress(plan.milestones, estimate?.stageValues ?? null) : { percent: 0, basis: 'NONE' as const, stages: new Map<string, number>() };
  const rows = await costRows(tx, tenantId, { projectIds: [project.id] });
  const m = await moneyOf(tx, tenantId, project);
  return {
    project,
    estimate,
    plan,
    progress,
    rows,
    actualPaisa: rows.reduce((a, r) => a + r.amountPaisa, 0n),
    ...contractOf(m, await approvedChangesOf(tx, tenantId, project.id)),
  };
}

// ─── Projected margin ───────────────────────────────────────────────────────

export interface Projection {
  contractPaisa: bigint;
  approvedChangesPaisa: bigint;
  revisedContractPaisa: bigint;
  budgetAtCompletionPaisa: bigint | null;
  actualToDatePaisa: bigint;
  earnedValuePaisa: bigint | null;
  costPerformanceIndex: number | null;
  estimateAtCompletionPaisa: bigint | null;
  remainingCostPaisa: bigint | null;
  projectedMarginPaisa: bigint | null;
  projectedMarginPercent: number | null;
  basis: 'EARNED_VALUE' | 'PROGRESS_ONLY' | 'NOT_ENOUGH_PROGRESS' | 'NO_CONTRACT';
  note: string;
}

export function computeProjection(ctx: Pick<CostContext, 'estimate' | 'progress' | 'actualPaisa' | 'contractPaisa' | 'changes'>): Projection {
  const revised = ctx.contractPaisa + (ctx.changes.inContract ? 0n : ctx.changes.pricePaisa);
  const ac = ctx.actualPaisa;
  const p = Math.min(100, Math.max(0, ctx.progress.percent));
  let bac: bigint | null = null;
  let ev: bigint | null = null;
  let cpi: number | null = null;
  let eac: bigint | null = null;
  let basis: Projection['basis'];
  let note: string;
  if (ctx.estimate) {
    bac = ctx.estimate.totalPaisa + ctx.changes.costPaisa;
    ev = paisaOf((Number(bac) * p) / 100);
    const usable = p >= MIN_PROGRESS_FOR_CPI && ac > 0n && ev > 0n;
    cpi = usable ? Math.min(CPI_MAX, Math.max(CPI_MIN, Number(ev) / Number(ac))) : 1;
    cpi = Math.round(cpi * 1000) / 1000;
    eac = ac + paisaOf(Number(bac - ev) / cpi);
    basis = 'EARNED_VALUE';
    note = usable
      ? `Cost to date + the rest of the approved estimate (Rev ${ctx.estimate.revision}) adjusted by performance so far (CPI ${cpi}).`
      : `Cost to date + the rest of the approved estimate (Rev ${ctx.estimate.revision}); performance counts after ${MIN_PROGRESS_FOR_CPI}% progress.`;
  } else if (p >= MIN_PROGRESS_FOR_CPI && ac > 0n) {
    eac = paisaOf((Number(ac) * 100) / p);
    basis = 'PROGRESS_ONLY';
    note = 'No approved estimate: cost to date ÷ physical progress.';
  } else {
    basis = 'NOT_ENOUGH_PROGRESS';
    note = `Needs an approved estimate or at least ${MIN_PROGRESS_FOR_CPI}% progress.`;
  }
  let margin: bigint | null = null;
  let marginPct: number | null = null;
  if (revised <= 0n) {
    basis = 'NO_CONTRACT';
    note = 'The project has no contract value yet.';
  } else if (eac !== null) {
    margin = revised - eac;
    marginPct = bigPct(margin, revised);
    marginPct = marginPct === null ? null : p1(marginPct);
  }
  return {
    contractPaisa: ctx.contractPaisa,
    approvedChangesPaisa: ctx.changes.pricePaisa,
    revisedContractPaisa: revised,
    budgetAtCompletionPaisa: bac,
    actualToDatePaisa: ac,
    earnedValuePaisa: ev,
    costPerformanceIndex: cpi,
    estimateAtCompletionPaisa: eac,
    remainingCostPaisa: eac === null ? null : eac - ac,
    projectedMarginPaisa: margin,
    projectedMarginPercent: marginPct,
    basis,
    note,
  };
}

const nstr = (v: bigint | null) => (v === null ? null : str(v));
export const projectionDto = (p: Projection) => ({
  contractPaisa: str(p.contractPaisa),
  approvedChangesPaisa: str(p.approvedChangesPaisa),
  revisedContractPaisa: str(p.revisedContractPaisa),
  budgetAtCompletionPaisa: nstr(p.budgetAtCompletionPaisa),
  actualToDatePaisa: str(p.actualToDatePaisa),
  earnedValuePaisa: nstr(p.earnedValuePaisa),
  costPerformanceIndex: p.costPerformanceIndex,
  estimateAtCompletionPaisa: nstr(p.estimateAtCompletionPaisa),
  remainingCostPaisa: nstr(p.remainingCostPaisa),
  projectedMarginPaisa: nstr(p.projectedMarginPaisa),
  projectedMarginPercent: p.projectedMarginPercent,
  basis: p.basis,
  note: p.note,
});

/** Projected margin of a project (P&L, dashboard, summary). */
export async function projectionFor(tx: Tx, tenantId: string, project: Project): Promise<Projection> {
  return computeProjection(await loadCostContext(tx, tenantId, project));
}

// ─── Cost variance ──────────────────────────────────────────────────────────

export type BucketStatus = 'OVER' | 'UNDER' | 'ON_TRACK' | 'NO_ESTIMATE';

export interface BucketRow {
  bucket: ControlBucket;
  estimateTotalPaisa: bigint;
  estimateToDatePaisa: bigint;
  actualPaisa: bigint;
  variancePaisa: bigint;
  variancePercent: number | null;
  status: BucketStatus;
}

function bucketStatus(bucket: ControlBucket, est: bigint, toDate: bigint, actual: bigint, thr: number): { pct: number | null; status: BucketStatus } {
  if (bucket === 'CONTINGENCY') return { pct: null, status: 'ON_TRACK' };
  if (toDate <= 0n) return { pct: null, status: actual > 0n ? (est > 0n ? 'OVER' : 'NO_ESTIMATE') : 'ON_TRACK' };
  const pct = p1((Number(actual - toDate) / Number(toDate)) * 100);
  return { pct, status: pct > thr ? 'OVER' : pct < -thr ? 'UNDER' : 'ON_TRACK' };
}

export function computeCostVariance(ctx: CostContext, settings: Pick<ControlSettings, 'overuseAlertPercent'>) {
  const est = new Map<ControlBucket, { total: bigint; toDate: bigint }>(CONTROL_BUCKETS.map((b) => [b, { total: 0n, toDate: 0n }]));
  const stages = new Map<string, { estimate: bigint; toDate: bigint }>();
  for (const l of ctx.estimate?.lines ?? []) {
    if (l.amountPaisa === null) continue;
    const stagePct = l.stageKey && ctx.progress.stages.has(l.stageKey) ? ctx.progress.stages.get(l.stageKey)! : ctx.progress.percent;
    const toDate = paisaOf((Number(l.amountPaisa) * stagePct) / 100);
    const b = est.get(l.bucket)!;
    b.total += l.amountPaisa;
    b.toDate += toDate;
    if (l.stageKey && l.kind !== 'PERCENT') {
      const s = stages.get(l.stageKey) ?? { estimate: 0n, toDate: 0n };
      s.estimate += l.amountPaisa;
      s.toDate += toDate;
      stages.set(l.stageKey, s);
    }
  }
  const actual = new Map<ControlBucket, bigint>(CONTROL_BUCKETS.map((b) => [b, 0n]));
  for (const r of ctx.rows) {
    const b = ACTUAL_BUCKET[BUCKET_OF[r.source]];
    actual.set(b, actual.get(b)! + r.amountPaisa);
  }
  const buckets: BucketRow[] = CONTROL_BUCKETS.map((bucket) => {
    const e = est.get(bucket)!;
    const a = actual.get(bucket)!;
    const s = bucketStatus(bucket, e.total, e.toDate, a, settings.overuseAlertPercent);
    return { bucket, estimateTotalPaisa: e.total, estimateToDatePaisa: e.toDate, actualPaisa: a, variancePaisa: a - e.toDate, variancePercent: s.pct, status: s.status };
  });
  const sum = (k: 'estimateTotalPaisa' | 'estimateToDatePaisa' | 'actualPaisa') => buckets.reduce((x, b) => x + b[k], 0n);
  const totals = { estimateTotalPaisa: sum('estimateTotalPaisa'), estimateToDatePaisa: sum('estimateToDatePaisa'), actualPaisa: sum('actualPaisa') };
  const lab = buckets.filter((b) => b.bucket === 'LABOUR' || b.bucket === 'SUBCONTRACT');
  const labTo = lab.reduce((x, b) => x + b.estimateToDatePaisa, 0n);
  const labAct = lab.reduce((x, b) => x + b.actualPaisa, 0n);
  const stageKeys = [...new Set([...(ctx.plan?.milestones ?? []).map((m) => m.stageKey), ...stages.keys()])];
  return {
    buckets,
    totals: { ...totals, variancePaisa: totals.actualPaisa - totals.estimateToDatePaisa, variancePercent: totals.estimateToDatePaisa > 0n ? p1((Number(totals.actualPaisa - totals.estimateToDatePaisa) / Number(totals.estimateToDatePaisa)) * 100) : null },
    labourCombined: { estimateToDatePaisa: labTo, actualPaisa: labAct, variancePaisa: labAct - labTo, variancePercent: labTo > 0n ? p1((Number(labAct - labTo) / Number(labTo)) * 100) : null },
    stages: stageKeys.map((stageKey) => ({ stageKey, progressPercent: p1(ctx.progress.stages.get(stageKey) ?? 0), estimatePaisa: stages.get(stageKey)?.estimate ?? 0n, estimateToDatePaisa: stages.get(stageKey)?.toDate ?? 0n })),
  };
}

const bucketDto = (b: BucketRow, money: MoneyView) => ({
  bucket: b.bucket,
  status: b.status,
  ...(money.cost
    ? { estimateTotalPaisa: str(b.estimateTotalPaisa), estimateToDatePaisa: str(b.estimateToDatePaisa), actualPaisa: str(b.actualPaisa), variancePaisa: str(b.variancePaisa), variancePercent: b.variancePercent }
    : {}),
});

export async function costVariance(projectId: string) {
  const c = controlCaller();
  const money = moneyView(c.fields);
  return withTenant(c.tenantId, async (tx) => {
    const project = await controlProject(tx, c, projectId);
    const settings = await controlSettings(tx, c.tenantId);
    const ctx = await loadCostContext(tx, c.tenantId, project);
    const v = computeCostVariance(ctx, settings);
    return {
      project: { ...ref(project), status: project.status },
      asOf: today(),
      estimate: ctx.estimate ? { id: ctx.estimate.id, revision: ctx.estimate.revision } : null,
      hasSchedule: Boolean(ctx.plan),
      progress: { percent: p1(ctx.progress.percent), basis: ctx.progress.basis },
      thresholdPercent: settings.overuseAlertPercent,
      buckets: v.buckets.map((b) => bucketDto(b, money)),
      ...(money.cost
        ? {
            totals: { estimateTotalPaisa: str(v.totals.estimateTotalPaisa), estimateToDatePaisa: str(v.totals.estimateToDatePaisa), actualPaisa: str(v.totals.actualPaisa), variancePaisa: str(v.totals.variancePaisa), variancePercent: v.totals.variancePercent },
            labourCombined: { estimateToDatePaisa: str(v.labourCombined.estimateToDatePaisa), actualPaisa: str(v.labourCombined.actualPaisa), variancePaisa: str(v.labourCombined.variancePaisa), variancePercent: v.labourCombined.variancePercent },
          }
        : {}),
      stages: v.stages.map((s) => ({ stageKey: s.stageKey, progressPercent: s.progressPercent, ...(money.cost ? { estimatePaisa: str(s.estimatePaisa), estimateToDatePaisa: str(s.estimateToDatePaisa) } : {}) })),
      ...(money.margin ? { projection: projectionDto(computeProjection(ctx)) } : {}),
    };
  });
}

// ─── Burn rate vs progress ──────────────────────────────────────────────────

const monthOf = (date: string) => date.slice(0, 7);
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export interface BurnMonth {
  month: string;
  progressPercent: number;
  costPaisa: bigint;
  cumulativeCostPaisa: bigint;
  spentPercent: number | null;
  gapPoints: number | null;
  ahead: boolean;
}

export async function computeBurn(tx: Tx, tenantId: string, ctx: CostContext, settings: Pick<ControlSettings, 'spendAheadAlertPoints'>, date = today()) {
  const revised = ctx.contractPaisa + (ctx.changes.inContract ? 0n : ctx.changes.pricePaisa);
  const plan = ctx.plan;
  const updates = plan ? await loadUpdates(tx, tenantId, plan.milestones.map((m) => m.id)) : [];
  const costMonths = ctx.rows.map((r) => r.month).sort();
  const thisMonth = monthOf(date);
  const starts = [costMonths[0], plan ? monthOf(plan.startDate) : undefined, ctx.project.startDate ? monthOf(ctx.project.startDate.toISOString().slice(0, 10)) : undefined].filter((x): x is string => Boolean(x) && x! <= thisMonth);
  const first = starts.sort()[0] ?? thisMonth;
  const byMonth = new Map<string, bigint>();
  for (const r of ctx.rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0n) + r.amountPaisa);
  let cumulative = [...byMonth].filter(([m]) => m < first).reduce((a, [, v]) => a + v, 0n);
  const months: BurnMonth[] = monthsBetween(first, thisMonth).map((month) => {
    const end = month === thisMonth ? date : monthEnd(month);
    const progress = plan ? (month === thisMonth ? ctx.progress.percent : physicalProgress(plan.milestones, ctx.estimate?.stageValues ?? null, progressAsOf(updates, end, plan.milestones)).percent) : 0;
    const cost = byMonth.get(month) ?? 0n;
    cumulative += cost;
    const spent = bigPct(cumulative, revised);
    const gap = spent === null ? null : p1(spent - progress);
    return { month, progressPercent: p1(progress), costPaisa: cost, cumulativeCostPaisa: cumulative, spentPercent: spent === null ? null : p1(spent), gapPoints: gap, ahead: gap !== null && gap > settings.spendAheadAlertPoints };
  });
  const planned = plan ? physicalProgress(plan.milestones, ctx.estimate?.stageValues ?? null, (m) => plannedProgress(m, date, plan.cal)).percent : 0;
  const last = months[months.length - 1]!;
  return { revisedContractPaisa: revised, months, current: { progressPercent: last.progressPercent, plannedProgressPercent: p1(planned), spentPercent: last.spentPercent, gapPoints: last.gapPoints, ahead: last.ahead } };
}

export async function burnRate(projectId: string) {
  const c = controlCaller();
  const money = moneyView(c.fields);
  return withTenant(c.tenantId, async (tx) => {
    const project = await controlProject(tx, c, projectId);
    const settings = await controlSettings(tx, c.tenantId);
    const ctx = await loadCostContext(tx, c.tenantId, project);
    const b = await computeBurn(tx, c.tenantId, ctx, settings);
    const spentKeys = (x: { spentPercent: number | null; gapPoints: number | null; ahead: boolean }) => (money.spent ? { spentPercent: x.spentPercent, gapPoints: x.gapPoints, ahead: x.ahead } : {});
    return {
      project: { ...ref(project), status: project.status },
      asOf: today(),
      thresholdPoints: settings.spendAheadAlertPoints,
      progressBasis: ctx.progress.basis,
      hasSchedule: Boolean(ctx.plan),
      ...(money.contract ? { contractPaisa: str(b.revisedContractPaisa) } : {}),
      months: b.months.map((m) => ({ month: m.month, progressPercent: m.progressPercent, ...(money.amounts ? { costPaisa: str(m.costPaisa), cumulativeCostPaisa: str(m.cumulativeCostPaisa) } : {}), ...spentKeys(m) })),
      current: { progressPercent: b.current.progressPercent, plannedProgressPercent: b.current.plannedProgressPercent, ...spentKeys(b.current) },
    };
  });
}
