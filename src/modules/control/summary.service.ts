/**
 * Step 14 · company control summary (dashboard card): per ACTIVE / CLOSEOUT project in the
 * caller's control.view scope — physical vs planned progress, behind / late milestones, material
 * overuse, exhausted quotas, open alerts, and (money permissions) spent % of contract and the
 * projected margin.
 */
import { assertPerm } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import type { Money } from '../billing/receivables.service.js';
import { projectScope } from '../projects/access.js';
import { estimateOf, materialOveruse, planOf, quotaExhausted } from './alerts/rules/builtin.js';
import type { RuleContext } from './alerts/registry.js';
import { visibleAlerts } from './alerts.service.js';
import { bigPct, CONTROL_VIEW, controlCaller, controlSettings, moneyView, p1, ref, str, today, type ControlCaller, type ControlSettings } from './control.shared.js';
import { computeProjection, loadCostContexts, loadPlans, type CostContext, type Projection } from './cost.service.js';
import { behindOf, physicalProgress, plannedProgress, type ProjectPlan } from './plan.js';

export interface ProjectControl {
  project: Project;
  hasSchedule: boolean;
  progressPercent: number;
  plannedProgressPercent: number;
  behindMilestones: number;
  lateMilestones: number;
  overuseMaterials: number;
  quotasExhausted: number;
  spentPercent: number | null;
  gapPoints: number | null;
  projection: Projection;
}

/**
 * Control numbers of one project (no permission checks — callers decide what to show).
 * `pre` = its cost context from a batch (`loadCostContexts`, the summary); else loaded here.
 */
export async function projectControl(tx: Tx, tenantId: string, project: Project, settings: ControlSettings, pre?: CostContext): Promise<ProjectControl> {
  const date = today();
  const ctx: RuleContext = { tx, tenantId, project, settings, today: date, now: new Date(), memo: new Map() };
  if (pre) {
    ctx.memo.set('plan', pre.plan);
    ctx.memo.set('estimate', pre.estimate);
    ctx.memo.set('cost', pre);
  }
  const plan = await planOf(ctx);
  const estimate = await estimateOf(ctx);
  const cost = pre ?? (await loadCostContexts(tx, tenantId, [project], { plans: new Map([[project.id, plan]]), estimates: new Map([[project.id, estimate]]) })).get(project.id)!;
  const planned = plan ? physicalProgress(plan.milestones, estimate?.stageValues ?? null, (m) => plannedProgress(m, date, plan.cal)).percent : 0;
  const behind = plan ? plan.milestones.map((m) => behindOf(m, date, plan.cal, settings)) : [];
  const revised = cost.contractPaisa + (cost.changes.inContract ? 0n : cost.changes.pricePaisa);
  const spent = bigPct(cost.actualPaisa, revised);
  return {
    project,
    hasSchedule: Boolean(plan),
    progressPercent: p1(cost.progress.percent),
    plannedProgressPercent: p1(planned),
    behindMilestones: behind.filter((b) => b.behind).length,
    lateMilestones: behind.filter((b) => b.late).length,
    overuseMaterials: (await materialOveruse.evaluate!(ctx)).length,
    quotasExhausted: (await quotaExhausted.evaluate!(ctx)).length,
    spentPercent: spent === null ? null : p1(spent),
    gapPoints: spent === null || !plan ? null : p1(spent - cost.progress.percent),
    projection: computeProjection(cost),
  };
}

export async function scopedControlProjects(tx: Tx, c: ControlCaller): Promise<Project[]> {
  return tx.project.findMany({ where: { tenantId: c.tenantId, status: { in: ['ACTIVE', 'CLOSEOUT'] }, ...projectScope(c, CONTROL_VIEW) }, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] });
}

export async function summary() {
  const c = controlCaller();
  assertPerm(CONTROL_VIEW, c);
  const money = moneyView(c.fields);
  return withTenant(
    c.tenantId,
    async (tx) => {
      const settings = await controlSettings(tx, c.tenantId);
      const projects = await scopedControlProjects(tx, c);
      const alerts = await visibleAlerts(tx, c, { status: 'OPEN', projectId: { in: projects.map((p) => p.id) } });
      const contexts = await loadCostContexts(tx, c.tenantId, projects);
      const rows = [];
      for (const p of projects) {
        const x = await projectControl(tx, c.tenantId, p, settings, contexts.get(p.id));
        const mine = alerts.filter((a) => a.projectId === p.id);
        rows.push({
          project: { ...ref(p), status: p.status },
          hasSchedule: x.hasSchedule,
          progressPercent: x.progressPercent,
          plannedProgressPercent: x.plannedProgressPercent,
          behindMilestones: x.behindMilestones,
          lateMilestones: x.lateMilestones,
          overuseMaterials: x.overuseMaterials,
          quotasExhausted: x.quotasExhausted,
          openAlerts: { critical: mine.filter((a) => a.severity === 'CRITICAL').length, warning: mine.filter((a) => a.severity === 'WARNING').length, info: mine.filter((a) => a.severity === 'INFO').length },
          ...(money.spent ? { spentPercent: x.spentPercent, gapPoints: x.gapPoints } : {}),
          ...(money.margin
            ? { projectedMarginPercent: x.projection.projectedMarginPercent, projectedMarginPaisa: x.projection.projectedMarginPaisa === null ? null : str(x.projection.projectedMarginPaisa) }
            : {}),
        });
      }
      const byRule: Record<string, number> = {};
      for (const a of alerts) byRule[a.rule] = (byRule[a.rule] ?? 0) + 1;
      return {
        asOf: today(),
        thresholds: settings,
        projects: rows,
        alerts: { open: alerts.length, critical: alerts.filter((a) => a.severity === 'CRITICAL').length, warning: alerts.filter((a) => a.severity === 'WARNING').length, info: alerts.filter((a) => a.severity === 'INFO').length, byRule },
      };
    },
    { timeout: 60_000 },
  );
}

/**
 * Ids of the projects with at least one behind-plan / late milestone (dashboard "delayed").
 * `plans` = plans the caller already loaded (`loadPlans`); the rest are loaded here.
 */
export async function delayedProjectIds(tx: Tx, tenantId: string, projectIds: string[], plans?: Map<string, ProjectPlan | null>): Promise<Set<string>> {
  const out = new Set<string>();
  if (!projectIds.length) return out;
  const settings = await controlSettings(tx, tenantId);
  const date = today();
  const missing = projectIds.filter((id) => !plans?.has(id));
  const loaded = await loadPlans(tx, tenantId, missing);
  for (const id of projectIds) {
    const plan = plans?.get(id) ?? loaded.get(id) ?? null;
    if (plan?.milestones.some((m) => behindOf(m, date, plan.cal, settings).behind)) out.add(id);
  }
  return out;
}

/** Physical progress + projected margin of a project (dashboard project rows). */
export async function progressAndMargin(tx: Tx, tenantId: string, project: Project): Promise<{ progressPercent: number; projection: Projection }> {
  return (await progressAndMargins(tx, tenantId, [project])).get(project.id)!;
}

/** Step 18 · progress + projected margin of several projects in one batch (`loadCostContexts`). */
export async function progressAndMargins(
  tx: Tx,
  tenantId: string,
  projects: Project[],
  pre: { plans?: Map<string, ProjectPlan | null>; money?: Map<string, Money> } = {},
): Promise<Map<string, { progressPercent: number; projection: Projection }>> {
  const contexts = await loadCostContexts(tx, tenantId, projects, pre);
  return new Map([...contexts].map(([id, cost]) => [id, { progressPercent: p1(cost.progress.percent), projection: computeProjection(cost) }]));
}
