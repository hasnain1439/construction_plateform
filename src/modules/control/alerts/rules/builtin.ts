/**
 * Step 14 · the built-in control rules: material overuse, milestone behind plan / late, quota
 * exhausted, spend ahead of progress. Texts and details never carry money.
 */
import { day } from '../../../../core/pdf/templates.js';
import { usedQuantities } from '../../../schedule/schedule.shared.js';
import { loadCostContext, type CostContext } from '../../cost.service.js';
import { bigPct, p1, q3 } from '../../control.shared.js';
import { loadApprovedEstimate, type EstimateData } from '../../estimate.js';
import { behindOf, isFinished, loadPlan, type ProjectPlan } from '../../plan.js';
import { computeMaterialVariance, type VarianceResult } from '../../variance.service.js';
import type { AlertRule, Finding, RuleContext } from '../registry.js';

async function memo<T>(ctx: RuleContext, key: string, load: () => Promise<T>): Promise<T> {
  if (!ctx.memo.has(key)) ctx.memo.set(key, await load());
  return ctx.memo.get(key) as T;
}
export const planOf = (ctx: RuleContext) => memo<ProjectPlan | null>(ctx, 'plan', () => loadPlan(ctx.tx, ctx.tenantId, ctx.project.id));
export const estimateOf = (ctx: RuleContext) => memo<EstimateData | null>(ctx, 'estimate', () => loadApprovedEstimate(ctx.tx, ctx.tenantId, ctx.project.id));
const varianceOf = (ctx: RuleContext) =>
  memo<VarianceResult>(ctx, 'variance', async () => computeMaterialVariance(ctx.tx, ctx.tenantId, ctx.project, ctx.settings, { plan: await planOf(ctx), estimate: await estimateOf(ctx) }));
const costOf = (ctx: RuleContext) => memo<CostContext>(ctx, 'cost', async () => loadCostContext(ctx.tx, ctx.tenantId, ctx.project, { plan: await planOf(ctx), estimate: await estimateOf(ctx) }));

const CONTROL_VIEW = 'control.view';

export const materialOveruse: AlertRule = {
  rule: 'MATERIAL_OVERUSE',
  source: 'CONTROL',
  trigger: 'DAILY_AND_ON_WRITE',
  severity: 'WARNING',
  permission: CONTROL_VIEW,
  moneyPermissions: [],
  thresholdSetting: 'overuseAlertPercent',
  renotifyHours: 7 * 24,
  dedupeKey: 'MATERIAL_OVERUSE:<projectId>:<materialId>',
  actionUrl: (projectId) => `/projects/${projectId}/control/material-variance`,
  description: 'A material is used (with counted losses) more than the overuse % above what the estimate allows for the work done so far.',
  async evaluate(ctx) {
    const thr = ctx.settings.overuseAlertPercent;
    const v = await varianceOf(ctx);
    const out: Finding[] = [];
    for (const r of v.rows) {
      if (!r.materialId || !r.estimatedToDateQty || r.estimatedToDateQty <= 0 || r.variancePercent === null || r.variancePercent <= thr) continue;
      out.push({
        dedupeKey: `MATERIAL_OVERUSE:${ctx.project.id}:${r.materialId}`,
        refType: 'MATERIAL',
        refId: r.materialId,
        severity: r.variancePercent >= 2 * thr ? 'CRITICAL' : 'WARNING',
        text: { key: 'controlMaterialOveruse', params: { project: ctx.project.name, material: r.description, percent: r.variancePercent, used: r.consumedQty, planned: r.estimatedToDateQty, unit: r.unit } },
        details: { materialId: r.materialId, material: r.description, unit: r.unit, estimatedToDateQty: r.estimatedToDateQty, consumedQty: r.consumedQty, varianceQty: r.varianceQty, variancePercent: r.variancePercent, thresholdPercent: thr },
      });
    }
    return out;
  },
};

export const milestoneBehindPlan: AlertRule = {
  rule: 'MILESTONE_BEHIND_PLAN',
  source: 'CONTROL',
  trigger: 'DAILY_AND_ON_WRITE',
  severity: 'WARNING',
  permission: CONTROL_VIEW,
  moneyPermissions: [],
  thresholdSetting: 'behindPlanAlertPoints',
  renotifyHours: 7 * 24,
  dedupeKey: 'MILESTONE_BEHIND_PLAN:<milestoneId>',
  actionUrl: (projectId) => `/projects/${projectId}/control/delay`,
  description: 'A milestone that is not finished is behind its planned progress by the set points, or still open more than the grace days after its planned end.',
  async evaluate(ctx) {
    const plan = await planOf(ctx);
    if (!plan) return [];
    const out: Finding[] = [];
    for (const m of plan.milestones) {
      const b = behindOf(m, ctx.today, plan.cal, ctx.settings);
      if (!b.behind) continue;
      const lateNow = b.lateDays > ctx.settings.lateFinishGraceDays;
      out.push({
        dedupeKey: `MILESTONE_BEHIND_PLAN:${m.id}`,
        refType: 'MILESTONE',
        refId: m.id,
        severity: b.lateDays > 14 || b.behindPoints >= 2 * ctx.settings.behindPlanAlertPoints ? 'CRITICAL' : 'WARNING',
        text: lateNow
          ? { key: 'controlMilestoneLate', params: { project: ctx.project.name, milestone: m.name, date: day(m.plannedEnd), days: b.lateDays, actual: b.actualProgressPercent } }
          : { key: 'controlMilestoneBehind', params: { project: ctx.project.name, milestone: m.name, actual: b.actualProgressPercent, planned: b.plannedProgressPercent } },
        details: {
          milestoneId: m.id,
          milestone: m.name,
          key: m.key,
          plannedEnd: m.plannedEnd,
          progressPercent: b.actualProgressPercent,
          plannedProgressPercent: b.plannedProgressPercent,
          behindPoints: b.behindPoints,
          lateDays: b.lateDays,
          thresholdPoints: ctx.settings.behindPlanAlertPoints,
          graceDays: ctx.settings.lateFinishGraceDays,
        },
      });
    }
    return out;
  },
};

export const quotaExhausted: AlertRule = {
  rule: 'QUOTA_EXHAUSTED',
  source: 'CONTROL',
  trigger: 'DAILY_AND_ON_WRITE',
  severity: 'WARNING',
  permission: CONTROL_VIEW,
  moneyPermissions: [],
  thresholdSetting: 'quotaAlertPercent',
  renotifyHours: 30 * 24,
  dedupeKey: 'QUOTA_EXHAUSTED:<milestoneId>:<materialId>',
  actionUrl: (projectId) => `/projects/${projectId}/schedule/milestones`,
  description: 'Material used on a milestone reached the quota % of its planned quantity while the work is not finished.',
  async evaluate(ctx) {
    const plan = await planOf(ctx);
    if (!plan) return [];
    const open = plan.milestones.filter((m) => !isFinished(m.status) && m.quotas.some((q) => q.materialId && q.plannedQty > 0));
    if (!open.length) return [];
    const used = await usedQuantities(ctx.tx, ctx.tenantId, open.map((m) => m.id));
    const out: Finding[] = [];
    for (const m of open) {
      for (const qt of m.quotas) {
        if (!qt.materialId || qt.plannedQty <= 0) continue;
        const u = used.get(m.id)?.get(qt.materialId) ?? 0;
        if (u < (qt.plannedQty * ctx.settings.quotaAlertPercent) / 100) continue;
        out.push({
          dedupeKey: `QUOTA_EXHAUSTED:${m.id}:${qt.materialId}`,
          refType: 'MILESTONE',
          refId: m.id,
          severity: 'WARNING',
          text: { key: 'controlQuotaExhausted', params: { project: ctx.project.name, milestone: m.name, material: qt.description, used: q3(u), planned: q3(qt.plannedQty), unit: qt.unit } },
          details: { milestoneId: m.id, milestone: m.name, materialId: qt.materialId, material: qt.description, unit: qt.unit, plannedQty: q3(qt.plannedQty), usedQty: q3(u), usedPercent: p1((u / qt.plannedQty) * 100), progressPercent: m.progressPercent, thresholdPercent: ctx.settings.quotaAlertPercent },
        });
      }
    }
    return out;
  },
};

export const spendAheadOfProgress: AlertRule = {
  rule: 'SPEND_AHEAD_OF_PROGRESS',
  source: 'CONTROL',
  trigger: 'DAILY_AND_ON_WRITE', // QA-B-10: also on milestone progress
  severity: 'WARNING',
  permission: CONTROL_VIEW,
  moneyPermissions: ['fields.amounts', 'fields.contract'],
  thresholdSetting: 'spendAheadAlertPoints',
  renotifyHours: 7 * 24,
  dedupeKey: 'SPEND_AHEAD_OF_PROGRESS:<projectId>',
  actionUrl: (projectId) => `/projects/${projectId}/control/burn-rate`,
  description: 'Cost to date as a % of the contract is ahead of the physical progress % by more than the set points.',
  async evaluate(ctx) {
    const plan = await planOf(ctx);
    if (!plan) return [];
    const c = await costOf(ctx);
    const revised = c.contractPaisa + (c.changes.inContract ? 0n : c.changes.pricePaisa);
    const spent = bigPct(c.actualPaisa, revised);
    if (spent === null) return [];
    const progress = p1(c.progress.percent);
    const gap = p1(spent - progress);
    const thr = ctx.settings.spendAheadAlertPoints;
    if (gap <= thr) return [];
    return [
      {
        dedupeKey: `SPEND_AHEAD_OF_PROGRESS:${ctx.project.id}`,
        refType: 'PROJECT',
        refId: ctx.project.id,
        severity: gap >= 2 * thr ? 'CRITICAL' : 'WARNING',
        text: { key: 'controlSpendAhead', params: { project: ctx.project.name, spent: p1(spent), progress } },
        details: { spentPercent: p1(spent), progressPercent: progress, gapPoints: gap, thresholdPoints: thr, progressBasis: c.progress.basis },
      },
    ];
  },
};

/** Hook — Step 16 part 2 registers the real rule with the same key (see ./index.ts). */
export const equipmentIdlePlaceholder: AlertRule = {
  rule: 'EQUIPMENT_IDLE',
  source: 'CONTROL',
  trigger: 'DAILY',
  severity: 'WARNING',
  permission: 'equipment.rental.manage',
  moneyPermissions: [],
  thresholdSetting: 'equipmentIdleDays',
  renotifyHours: 24,
  dedupeKey: 'EQUIPMENT_IDLE:<rentalId>',
  actionUrl: () => '/equipment/rentals',
  description: 'Rented equipment on a site with no linked milestone work for the set number of days (detection: equipment module, Step 16 — src/modules/equipment/idle.ts; its own equipment-idle job notifies).',
  placeholder: true,
  // Step 16 owns detection + notifications (job `equipment-idle` 09:00 PKT, alerts.equipmentIdle):
  // the engine only keeps the alert rows so the dashboard / summary / lists show them.
  notify: false,
};

export const missingDailyLog: AlertRule = {
  rule: 'MISSING_DAILY_LOG',
  source: 'EXTERNAL',
  trigger: 'EXTERNAL_JOB',
  severity: 'WARNING',
  permission: 'dailylog.log.view',
  moneyPermissions: [],
  thresholdSetting: 'missingLogAlertTime',
  renotifyHours: 24,
  dedupeKey: 'per project per day',
  actionUrl: (projectId) => `/projects/${projectId}/site/daily-logs`,
  description: 'No daily log and no hazri by the alert time (job every 15 minutes, jobs/missingLogs.ts) — to the owner and project PMs.',
};

export const stageReadyUnbilled: AlertRule = {
  rule: 'STAGE_READY_UNBILLED',
  source: 'EXTERNAL',
  trigger: 'EXTERNAL_JOB',
  severity: 'WARNING',
  permission: 'billing.invoice.view',
  moneyPermissions: ['fields.amounts'],
  thresholdSetting: null,
  renotifyHours: 24,
  dedupeKey: 'per payment stage',
  actionUrl: (projectId) => `/projects/${projectId}/billing/schedule`,
  description: 'A payment stage marked ready 3+ days ago without an invoice (daily billing job, jobs/billingOverdue.ts) — to the owner and PMs with billing.',
};
