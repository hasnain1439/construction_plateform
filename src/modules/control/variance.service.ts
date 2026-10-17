/**
 * Step 14 · material variance per project (and per milestone): estimated (APPROVED estimate
 * quantities through the milestone quotas, prorated by the work done) vs delivered vs used vs in
 * stock vs counted loss, and the rupee impact split into quantity and price variance.
 *
 *   estimatedToDate  Σ quota × actual milestone progress
 *   consumed         used (usage entries) + counted loss (− Σ stock-count adjustments)
 *   varianceQty      consumed − estimatedToDate          variancePercent = ÷ estimatedToDate
 *   quantity impact  varianceQty × estimate rate          (rate = Σ line amount ÷ Σ line qty, material unit)
 *   price impact     (actual average cost − estimate rate) × consumed
 *                    (average cost = Σ value ÷ Σ qty of contractor stock received at the site)
 * Owner-supplied materials: quantities only. Rupee keys need fields.rates.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import type { Project, StockMovementType } from '../../generated/prisma/client.js';
import { controlCaller, controlProject, controlSettings, moneyView, p1, paisaOf, q3, ref, str, today, type ControlSettings } from './control.shared.js';
import { loadApprovedEstimate, type EstimateData } from './estimate.js';
import { actualProgress, loadPlan, physicalProgress, type ProjectPlan } from './plan.js';
import type { MaterialVarianceQuery } from './control.schema.js';

const DELIVERED: StockMovementType[] = ['RECEIPT_IN', 'PURCHASE_IN', 'OWNER_DELIVERY_IN', 'PURCHASE_RETURN_OUT', 'CORRECTION'];
const BOUGHT: StockMovementType[] = ['RECEIPT_IN', 'PURCHASE_IN', 'PURCHASE_RETURN_OUT', 'CORRECTION'];

export type VarianceStatus = 'OVER' | 'UNDER' | 'ON_TRACK' | 'UNPLANNED' | 'NOT_STARTED' | 'NO_SCHEDULE';

export interface VarianceRow {
  key: string;
  materialId: string | null;
  material: { id: string; name: string; unit: string } | null;
  estimateKey: string | null;
  description: string;
  unit: string;
  ownerSupplied: boolean;
  estimatedTotalQty: number;
  estimatedToDateQty: number | null;
  deliveredQty: number | null;
  usedQty: number;
  lossQty: number | null;
  inStockQty: number | null;
  consumedQty: number;
  varianceQty: number | null;
  variancePercent: number | null;
  status: VarianceStatus;
  estimateRatePaisa: bigint | null;
  actualAvgCostPaisa: bigint | null;
  quantityImpactPaisa: bigint | null;
  priceImpactPaisa: bigint | null;
  impactPaisa: bigint | null;
}

export interface VarianceResult {
  rows: VarianceRow[];
  progress: { percent: number; basis: 'ESTIMATE_VALUE' | 'EFFORT' | 'NONE' };
  hasSchedule: boolean;
  estimate: EstimateData | null;
  plan: ProjectPlan | null;
}

type Acc = Omit<VarianceRow, 'status' | 'varianceQty' | 'variancePercent' | 'consumedQty' | 'estimateRatePaisa' | 'actualAvgCostPaisa' | 'quantityImpactPaisa' | 'priceImpactPaisa' | 'impactPaisa'> & {
  boughtQty: number;
  boughtValue: bigint;
  anyContractorStock: boolean;
};

export function statusOf(r: { estimatedTotalQty: number; estimatedToDateQty: number | null; consumedQty: number; variancePercent: number | null }, thresholdPercent: number, hasSchedule: boolean): VarianceStatus {
  if (r.estimatedTotalQty <= 0) return r.consumedQty > 0 ? 'UNPLANNED' : 'NOT_STARTED';
  if (!hasSchedule || r.estimatedToDateQty === null) return 'NO_SCHEDULE';
  if (r.estimatedToDateQty <= 0) return r.consumedQty > 0 ? 'OVER' : 'NOT_STARTED';
  const pct = r.variancePercent ?? 0;
  if (pct > thresholdPercent) return 'OVER';
  if (pct < -thresholdPercent) return 'UNDER';
  return 'ON_TRACK';
}

/**
 * Raw material variance (bigint money, nothing stripped). `milestoneId`: that milestone's quotas
 * and linked usage only (site-level delivered / stock / loss are null).
 */
export async function computeMaterialVariance(
  tx: Tx,
  tenantId: string,
  project: Pick<Project, 'id'>,
  settings: Pick<ControlSettings, 'overuseAlertPercent'>,
  opts: { milestoneId?: string | undefined; plan?: ProjectPlan | null; estimate?: EstimateData | null } = {},
): Promise<VarianceResult> {
  const plan = opts.plan !== undefined ? opts.plan : await loadPlan(tx, tenantId, project.id);
  const estimate = opts.estimate !== undefined ? opts.estimate : await loadApprovedEstimate(tx, tenantId, project.id);
  const progress = plan ? physicalProgress(plan.milestones, estimate?.stageValues ?? null) : { percent: 0, basis: 'NONE' as const };
  const milestone = opts.milestoneId ? (plan?.milestones.find((m) => m.id === opts.milestoneId) ?? null) : null;
  if (opts.milestoneId && !milestone) throw new BadRequest('INVALID_MILESTONE', 'That milestone is not part of this project’s schedule');
  const perMilestone = Boolean(milestone);

  const rows = new Map<string, Acc>();
  const blank = (key: string, materialId: string | null, unit: string, description: string, estimateKey: string | null, ownerSupplied: boolean): Acc => ({
    key,
    materialId,
    material: null,
    estimateKey,
    description,
    unit,
    ownerSupplied,
    estimatedTotalQty: 0,
    estimatedToDateQty: plan ? 0 : null,
    deliveredQty: perMilestone ? null : 0,
    usedQty: 0,
    lossQty: perMilestone ? null : 0,
    inStockQty: perMilestone ? null : 0,
    boughtQty: 0,
    boughtValue: 0n,
    anyContractorStock: false,
  });

  // Materials of the company (names / units)
  const site = perMilestone ? null : await tx.stockLocation.findFirst({ where: { tenantId, type: 'SITE', projectId: project.id }, select: { id: true } });
  const moves = site
    ? await tx.stockMovement.groupBy({ by: ['materialId', 'type', 'ownerSupplied'], where: { tenantId, locationId: site.id }, _sum: { quantity: true, valuePaisa: true } })
    : [];
  const linked = milestone
    ? await tx.materialUsageItem.findMany({ where: { tenantId, usage: { projectId: project.id, milestoneId: milestone.id } }, select: { materialId: true, qty: true, ownerSupplied: true } })
    : [];
  const quotaIds = (plan?.milestones ?? []).flatMap((m) => m.quotas.map((q) => q.materialId)).filter((x): x is string => Boolean(x));
  const estIds = estimate ? [...estimate.rates.keys()] : [];
  const ids = [...new Set([...moves.map((m) => m.materialId), ...linked.map((l) => l.materialId), ...quotaIds, ...estIds])];
  const mats = new Map((ids.length ? await tx.material.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, unit: true } }) : []).map((m) => [m.id, m]));

  const rowFor = (materialId: string | null, unit: string, description: string, estimateKey: string | null, ownerSupplied: boolean) => {
    const mat = materialId ? mats.get(materialId) : undefined;
    const key = materialId && (!mat || mat.unit === unit) ? materialId : `${materialId ?? estimateKey ?? description}@${unit}`;
    let r = rows.get(key);
    if (!r) {
      r = blank(key, materialId, mat && mat.unit === unit ? mat.unit : unit, mat?.name ?? description, estimateKey, ownerSupplied);
      if (mat && mat.unit === unit) r.material = { id: mat.id, name: mat.name, unit: mat.unit };
      rows.set(key, r);
    }
    if (!r.estimateKey && estimateKey) r.estimateKey = estimateKey;
    return r;
  };

  // Estimate side
  if (plan) {
    for (const m of milestone ? [milestone] : plan.milestones) {
      const done = actualProgress(m) / 100;
      for (const qt of m.quotas) {
        const r = rowFor(qt.materialId, qt.unit, qt.description, qt.material, qt.ownerSupplied);
        r.estimatedTotalQty += qt.plannedQty;
        r.estimatedToDateQty = (r.estimatedToDateQty ?? 0) + qt.plannedQty * done;
        r.ownerSupplied = r.ownerSupplied && qt.ownerSupplied;
      }
    }
  } else if (estimate) {
    for (const [materialId, rate] of estimate.rates) {
      const mat = mats.get(materialId);
      if (!mat) continue;
      rowFor(materialId, mat.unit, mat.name, null, false).estimatedTotalQty += rate.quantity;
    }
  }

  // Site side
  for (const g of moves) {
    const mat = mats.get(g.materialId);
    if (!mat) continue;
    const r = rowFor(g.materialId, mat.unit, mat.name, null, g.ownerSupplied);
    const qty = Number(g._sum.quantity ?? 0);
    const value = g._sum.valuePaisa ?? 0n;
    r.inStockQty = (r.inStockQty ?? 0) + qty;
    if (DELIVERED.includes(g.type)) r.deliveredQty = (r.deliveredQty ?? 0) + qty;
    if (g.type === 'USAGE_OUT') r.usedQty += -qty;
    if (g.type === 'COUNT_ADJUSTMENT') r.lossQty = (r.lossQty ?? 0) - qty;
    if (!g.ownerSupplied) {
      r.anyContractorStock = true;
      r.ownerSupplied = false;
      if (BOUGHT.includes(g.type)) {
        r.boughtQty += qty;
        r.boughtValue += value;
      }
    }
  }
  for (const l of linked) {
    const mat = mats.get(l.materialId);
    if (!mat) continue;
    const r = rowFor(l.materialId, mat.unit, mat.name, null, l.ownerSupplied);
    r.usedQty += Number(l.qty);
  }
  // Price for the milestone view: the site's average cost
  if (perMilestone && rows.size) {
    const siteRow = await tx.stockLocation.findFirst({ where: { tenantId, type: 'SITE', projectId: project.id }, select: { id: true } });
    if (siteRow) {
      const bought = await tx.stockMovement.groupBy({ by: ['materialId'], where: { tenantId, locationId: siteRow.id, ownerSupplied: false, type: { in: BOUGHT } }, _sum: { quantity: true, valuePaisa: true } });
      for (const b of bought) {
        const r = rows.get(b.materialId);
        if (!r) continue;
        r.boughtQty += Number(b._sum.quantity ?? 0);
        r.boughtValue += b._sum.valuePaisa ?? 0n;
        r.anyContractorStock = true;
      }
    }
  }

  const out: VarianceRow[] = [...rows.values()].map((r) => {
    const consumed = q3(r.usedQty + (r.lossQty ?? 0));
    const estToDate = r.estimatedToDateQty === null ? null : q3(r.estimatedToDateQty);
    const varianceQty = estToDate === null ? null : q3(consumed - estToDate);
    const variancePercent = estToDate !== null && estToDate > 0 && varianceQty !== null ? p1((varianceQty / estToDate) * 100) : null;
    const owner = r.ownerSupplied && !r.anyContractorStock;
    const rate = !owner && r.materialId && r.material ? (estimate?.rates.get(r.materialId)?.ratePaisa ?? null) : null;
    const avg = !owner && r.boughtQty > 0 ? Number(r.boughtValue) / r.boughtQty : null;
    const quantityImpact = rate !== null && varianceQty !== null ? paisaOf(varianceQty * rate) : null;
    const priceImpact = rate !== null && avg !== null ? paisaOf((avg - rate) * consumed) : null;
    const impact = quantityImpact === null && priceImpact === null ? null : (quantityImpact ?? 0n) + (priceImpact ?? 0n);
    const row = {
      key: r.key,
      materialId: r.materialId,
      material: r.material,
      estimateKey: r.estimateKey,
      description: r.description,
      unit: r.unit,
      ownerSupplied: owner,
      estimatedTotalQty: q3(r.estimatedTotalQty),
      estimatedToDateQty: estToDate,
      deliveredQty: r.deliveredQty === null ? null : q3(r.deliveredQty),
      usedQty: q3(r.usedQty),
      lossQty: r.lossQty === null ? null : q3(r.lossQty),
      inStockQty: r.inStockQty === null ? null : q3(r.inStockQty),
      consumedQty: consumed,
      varianceQty,
      variancePercent,
      estimateRatePaisa: rate === null ? null : paisaOf(rate),
      actualAvgCostPaisa: avg === null ? null : paisaOf(avg),
      quantityImpactPaisa: quantityImpact,
      priceImpactPaisa: priceImpact,
      impactPaisa: impact,
    };
    return { ...row, status: statusOf(row, settings.overuseAlertPercent, Boolean(plan)) };
  });
  const order: Record<VarianceStatus, number> = { OVER: 0, UNPLANNED: 1, UNDER: 2, ON_TRACK: 3, NO_SCHEDULE: 4, NOT_STARTED: 5 };
  out.sort((a, b) => order[a.status] - order[b.status] || Number((b.impactPaisa ?? 0n) - (a.impactPaisa ?? 0n)) || a.description.localeCompare(b.description));
  return { rows: out, progress: { percent: progress.percent, basis: progress.basis }, hasSchedule: Boolean(plan), estimate, plan };
}

const moneyKeys = ['estimateRatePaisa', 'actualAvgCostPaisa', 'quantityImpactPaisa', 'priceImpactPaisa', 'impactPaisa'] as const;
const nstr = (v: bigint | null) => (v === null ? null : str(v));

export async function materialVariance(projectId: string, query: MaterialVarianceQuery) {
  const c = controlCaller();
  const money = moneyView(c.fields);
  return withTenant(c.tenantId, async (tx) => {
    const project = await controlProject(tx, c, projectId);
    const settings = await controlSettings(tx, c.tenantId);
    const v = await computeMaterialVariance(tx, c.tenantId, project, settings, { milestoneId: query.milestoneId });
    const milestone = query.milestoneId ? v.plan!.milestones.find((m) => m.id === query.milestoneId)! : null;
    const count = (s: VarianceStatus) => v.rows.filter((r) => r.status === s).length;
    const total = (k: 'quantityImpactPaisa' | 'priceImpactPaisa' | 'impactPaisa') => v.rows.reduce((a, r) => a + (r[k] ?? 0n), 0n);
    return {
      project: { ...ref(project), status: project.status },
      milestone: milestone ? { id: milestone.id, key: milestone.key, name: milestone.name, stageKey: milestone.stageKey, status: milestone.status, progressPercent: actualProgress(milestone) } : null,
      asOf: today(),
      estimate: v.estimate ? { id: v.estimate.id, revision: v.estimate.revision } : null,
      hasSchedule: v.hasSchedule,
      progress: { percent: milestone ? actualProgress(milestone) : p1(v.progress.percent), basis: v.progress.basis },
      thresholdPercent: settings.overuseAlertPercent,
      items: v.rows.map((r) => {
        const { key: _key, ...rest } = r;
        void _key;
        const base = Object.fromEntries(Object.entries(rest).filter(([k]) => !(moneyKeys as readonly string[]).includes(k)));
        return money.rates ? { ...base, ...Object.fromEntries(moneyKeys.map((k) => [k, nstr(r[k])])) } : base;
      }),
      counts: { over: count('OVER'), under: count('UNDER'), onTrack: count('ON_TRACK'), unplanned: count('UNPLANNED'), notStarted: count('NOT_STARTED') + count('NO_SCHEDULE') },
      ...(money.rates ? { totals: { quantityImpactPaisa: str(total('quantityImpactPaisa')), priceImpactPaisa: str(total('priceImpactPaisa')), impactPaisa: str(total('impactPaisa')) } } : {}),
      milestones: (v.plan?.milestones ?? []).map((m) => ({ id: m.id, key: m.key, name: m.name, stageKey: m.stageKey, status: m.status, progressPercent: actualProgress(m) })),
    };
  });
}
