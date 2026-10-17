/**
 * Step 18 · reports built on the Phase 2 / 3 modules. Each one reads the owning module's numbers
 * (no second formula anywhere) and returns the Phase 1 report table, or — per project — a book of
 * several tables (reports.book.ts). Same JSON / CSV / Excel / PDF pipeline.
 *
 *   delay-analysis         schedule `delayBreakdown` (Step 13 + change-order days) + control `behindOf`
 *   variance               control: material variance, cost variance, projection (Step 14) — batched:
 *                          plan + estimate once per project, cost rows in one query for every project
 *   change-orders          the change-order register (Step 15) + the invoice that billed each one
 *   equipment-utilisation  the equipment ledger replayed day by day (Step 16) + charges + losses
 *   snags                  the snag list (Step 17): counts, ageing, assignees, cost attribution
 *
 * Who: finance.reports.view (route) + the module key (STEP18_REPORT_PERM), whose scope picks the
 * projects. Money follows the module's own field rule; the columns are LEFT OUT without it.
 */
import { assertPerm, fieldAccess, scopeAll, type FieldAccess } from '../../core/auth/access.js';
import type { Tx } from '../../core/db/withTenant.js';
import { Conflict } from '../../core/errors/AppError.js';
import { tr, type Lang } from '../../core/i18n/index.js';
import { day } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { ChangeOrderStatus, EquipmentCategory, Project, ProjectStatus } from '../../generated/prisma/client.js';
import { addDays, daysBetween, today } from '../billing/billing.shared.js';
import { invoicesOf } from '../change-orders/changeOrders.shared.js';
import { APPROVED_SET, changeOrderCode } from '../change-orders/totals.js';
import { bigPct, controlSettings, moneyView, p1, q3, type ControlSettings } from '../control/control.shared.js';
import { computeBurn, computeCostVariance, computeProjection, loadCostContext, loadCostContexts, type CostContext, type Projection } from '../control/cost.service.js';
import type { EstimateData } from '../control/estimate.js';
import { behindOf, loadPlan, physicalProgress, plannedProgress, type ProjectPlan } from '../control/plan.js';
import { computeMaterialVariance, type VarianceResult } from '../control/variance.service.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { findProjectFor, projectScope } from '../projects/access.js';
import { delayBreakdown } from '../schedule/insights.service.js';
import { stoppageDays } from '../schedule/stoppages.service.js';
import type { ReadActor } from '../dashboard/dashboard.shared.js';
import type { ReportBook, ReportSection, SummaryItem } from './reports.book.js';
import type { Cell, Report, ReportColumn } from './reports.export.js';
import type { BookName, BookQuery, ReportQuery } from './reports.schema.js';

type Built = Omit<Report, 'generatedAt' | 'filters'>;
type BuiltBook = Omit<ReportBook, 'generatedAt' | 'filters'>;
type Row = Record<string, Cell>;

export interface Step18Ctx {
  tx: Tx;
  a: ReadActor;
  q: ReportQuery;
  projectName: string;
  /** Language of text the builders write into cells (top reasons). JSON = en. */
  lang: Lang;
}

const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });
const s = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
const sum = (rows: Row[], key: string) => rows.reduce((t, r) => t + BigInt(r[key] ?? 0), 0n).toString();
const num = (rows: Row[], key: string) => q3(rows.reduce((t, r) => t + Number(r[key] ?? 0), 0));
/** Totals row: money / qty / int summed, the rest null (`skip` too). */
function totalsOf(columns: ReportColumn[], rows: Row[], skip: string[] = []): Row {
  return Object.fromEntries(columns.map((c) => [c.key, skip.includes(c.key) ? null : c.type === 'money' ? sum(rows, c.key) : c.type === 'qty' || c.type === 'int' ? num(rows, c.key) : null]));
}
/** Karachi calendar day of an instant (PKT is UTC+5 all year). */
const pktDay = (at: Date) => new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const asOfText = () => `as of ${day(today())}`;
const fields = (): FieldAccess => fieldAccess();

const NON_DRAFT: ProjectStatus[] = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED', 'READ_ONLY'];
const RUNNING: ProjectStatus[] = ['ACTIVE', 'CLOSEOUT'];

/** Projects the caller may see with the module key `perm` (scope), in `statuses`. */
function scopedProjects(c: Step18Ctx, perm: string, statuses: ProjectStatus[]): Promise<Project[]> {
  return c.tx.project.findMany({
    where: { tenantId: c.a.tenantId, ...projectScope(c.a, perm), status: { in: statuses }, ...(c.q.projectId ? { id: c.q.projectId } : {}) },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
}

// ─── 1. Delay analysis ──────────────────────────────────────────────────────

type Breakdown = Awaited<ReturnType<typeof delayBreakdown>>;

/** Reasons (stoppage reason / CHANGE_ORDER / SLOW_PROGRESS) summed over the categories, most days first. */
function reasonsOf(d: Breakdown): Array<{ reason: string; category: string; days: number }> {
  const out = new Map<string, { reason: string; category: string; days: number }>();
  for (const cat of d.categories) {
    for (const r of cat.reasons) {
      const k = `${cat.category}:${r.reason}`;
      const x = out.get(k) ?? { reason: r.reason, category: cat.category, days: 0 };
      x.days += r.days;
      out.set(k, x);
    }
  }
  return [...out.values()].filter((r) => r.days > 0).sort((a, b) => b.days - a.days || a.reason.localeCompare(b.reason));
}

const reasonText = (lang: Lang, reasons: Array<{ reason: string; days: number }>) => reasons.slice(0, 3).map((r) => `${tr(lang, `report.v.reason.${r.reason}` as Parameters<typeof tr>[1])} ${r.days}`).join(' · ') || null;

export async function delayAnalysisReport(c: Step18Ctx): Promise<Built> {
  const projects = await scopedProjects(c, 'control.view', NON_DRAFT);
  const scheduled = new Set((await c.tx.schedule.findMany({ where: { tenantId: c.a.tenantId, projectId: { in: projects.map((p) => p.id) } }, select: { projectId: true } })).map((x) => x.projectId));
  const settings = await controlSettings(c.tx, c.a.tenantId);
  const date = today();
  const rows: Row[] = [];
  const extra: Array<{ projectId: string; code: string; categories: Array<{ category: string; days: number }>; reasons: Array<{ reason: string; category: string; days: number }> }> = [];
  for (const p of projects.filter((x) => scheduled.has(x.id))) {
    const d = await delayBreakdown(c.tx, c.a.tenantId, p);
    const plan = (await loadPlan(c.tx, c.a.tenantId, p.id))!;
    const b = plan.milestones.map((m) => behindOf(m, date, plan.cal, settings));
    const reasons = reasonsOf(d);
    rows.push({
      code: p.code,
      name: p.name,
      status: p.status,
      originalEnd: d.originalEnd,
      revisedEnd: d.revisedEnd,
      projectedEnd: d.projectedEnd,
      progressPercent: d.progressPercent,
      ownerDays: d.days.owner,
      excusableDays: d.days.excusable,
      contractorDays: d.days.contractor,
      changeOrderDays: d.days.changeOrders,
      totalDays: d.days.total,
      calendarDaysLate: d.calendarDaysLate,
      aheadDays: d.aheadDays,
      lateMilestones: b.filter((x) => x.late).length,
      behindMilestones: b.filter((x) => x.behind).length,
      topReasons: reasonText(c.lang, reasons),
    });
    extra.push({ projectId: p.id, code: p.code, categories: d.categories.map((x) => ({ category: x.category, days: x.days })), reasons });
  }
  const columns = [
    col('code', 'Code'),
    col('name', 'Project'),
    col('status', 'Status'),
    col('originalEnd', 'Original end', 'date'),
    col('revisedEnd', 'Revised end', 'date'),
    col('projectedEnd', 'Projected end', 'date'),
    col('progressPercent', 'Progress', 'percent'),
    col('ownerDays', 'Owner days', 'int'),
    col('excusableDays', 'Excusable days', 'int'),
    col('contractorDays', 'Contractor days', 'int'),
    col('changeOrderDays', 'Change-order days', 'int'),
    col('totalDays', 'Total delay days', 'int'),
    col('calendarDaysLate', 'Days late (calendar)', 'int'),
    col('aheadDays', 'Days ahead', 'int'),
    col('lateMilestones', 'Late milestones', 'int'),
    col('behindMilestones', 'Behind milestones', 'int'),
    col('topReasons', 'Top reasons'),
  ];
  return {
    name: 'delay-analysis',
    title: 'Delay Analysis',
    subtitle: `${c.projectName} · ${asOfText()}`,
    columns,
    rows,
    totals: totalsOf(columns, rows, ['progressPercent']),
    notes: [
      'Working days. Owner = owner-caused stoppages (change-order days are their own column); excusable = rain, smog bans, holidays; contractor = the delay not covered by them (slow progress + contractor stoppages).',
      'Revised end = original end + owner + excusable + change-order days; projected end = today’s pace. Projects without a schedule are left out.',
    ],
    extra: { projects: extra },
  };
}

export async function delayAnalysisBook(c: Step18Ctx, project: Project): Promise<BuiltBook> {
  const plan = await loadPlan(c.tx, c.a.tenantId, project.id);
  if (!plan) throw new Conflict('NO_SCHEDULE', 'This project has no schedule yet — generate it from the approved estimate first');
  const settings = await controlSettings(c.tx, c.a.tenantId);
  const date = today();
  const d = await delayBreakdown(c.tx, c.a.tenantId, project);
  const summary: SummaryItem[] = [
    { key: 'originalEnd', label: 'Original end', type: 'date', value: d.originalEnd },
    { key: 'baselineEnd', label: 'Baseline end', type: 'date', value: d.baselineEnd },
    { key: 'plannedEnd', label: 'Planned end', type: 'date', value: d.plannedEnd },
    { key: 'revisedEnd', label: 'Revised end', type: 'date', value: d.revisedEnd },
    { key: 'projectedEnd', label: 'Projected end', type: 'date', value: d.projectedEnd },
    { key: 'progressPercent', label: 'Progress', type: 'percent', value: d.progressPercent },
    { key: 'ownerDays', label: 'Owner days', type: 'int', value: d.days.owner },
    { key: 'excusableDays', label: 'Excusable days', type: 'int', value: d.days.excusable },
    { key: 'contractorDays', label: 'Contractor days', type: 'int', value: d.days.contractor },
    { key: 'changeOrderDays', label: 'Change-order days', type: 'int', value: d.days.changeOrders },
    { key: 'totalDays', label: 'Total delay days', type: 'int', value: d.days.total },
    { key: 'calendarDaysLate', label: 'Days late (calendar)', type: 'int', value: d.calendarDaysLate },
    { key: 'aheadDays', label: 'Days ahead', type: 'int', value: d.aheadDays },
  ];
  const categories: ReportSection = {
    key: 'categories',
    title: 'Delay by category',
    columns: [col('delayCategory', 'Category'), col('days', 'Days', 'int'), col('reasons', 'Reasons')],
    rows: d.categories.map((x) => {
      const byReason = new Map<string, number>();
      for (const r of x.reasons) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.days);
      return { delayCategory: x.category, days: x.days, reasons: reasonText(c.lang, [...byReason].map(([reason, days]) => ({ reason, days })).sort((a, b) => b.days - a.days)) };
    }),
    totals: null,
  };
  categories.totals = { delayCategory: null, days: categories.rows.reduce((t, r) => t + Number(r['days'] ?? 0), 0), reasons: null };

  const stoppages = await c.tx.stoppageDay.findMany({ where: { tenantId: c.a.tenantId, projectId: project.id, status: { in: ['APPROVED', 'PENDING'] } }, orderBy: { createdAt: 'asc' } });
  const stopRows = stoppages
    .map((x) => {
      const dates = x.dates.map((dd) => ymd(dd)!).sort();
      return { from: dates[0] ?? null, to: dates.at(-1) ?? null, days: stoppageDays(dates, plan.cal), reason: x.reason, delayCategory: x.category, stoppageStatus: x.status, note: x.note } as Row;
    })
    .sort((a, b) => String(a['from']).localeCompare(String(b['from'])));
  const stopCols = [col('from', 'From', 'date'), col('to', 'To', 'date'), col('days', 'Days', 'int'), col('reason', 'Reason'), col('delayCategory', 'Category'), col('stoppageStatus', 'Status'), col('note', 'Note')];
  const coRows: Row[] = d.changeOrders.items.map((i) => ({ code: i.code, title: i.title, approvedOn: i.approvedOn, days: i.daysImpact }));
  const coCols = [col('code', 'Code'), col('title', 'Title'), col('approvedOn', 'Approved on', 'date'), col('days', 'Days', 'int')];
  const msRows: Row[] = [];
  for (const m of plan.milestones) {
    const b = behindOf(m, date, plan.cal, settings);
    if (!b.late && !b.behind && !(m.baselineEnd && m.plannedEnd > m.baselineEnd)) continue;
    msRows.push({
      milestone: m.name,
      stage: m.stageKey,
      milestoneStatus: m.status,
      baselineEnd: m.baselineEnd,
      plannedEnd: m.plannedEnd,
      actualEnd: m.actualEnd,
      varianceDays: m.baselineEnd ? daysBetween(m.baselineEnd, m.plannedEnd) : 0,
      progressPercent: b.actualProgressPercent,
      plannedProgressPercent: b.plannedProgressPercent,
      behindPoints: b.behindPoints,
      lateDays: b.lateDays,
    });
  }
  const msCols = [
    col('milestone', 'Milestone'),
    col('stage', 'Stage'),
    col('milestoneStatus', 'Status'),
    col('baselineEnd', 'Baseline end', 'date'),
    col('plannedEnd', 'Planned end', 'date'),
    col('actualEnd', 'Actual end', 'date'),
    col('varianceDays', 'Slipped (days)', 'int'),
    col('progressPercent', 'Progress', 'percent'),
    col('plannedProgressPercent', 'Planned progress', 'percent'),
    col('behindPoints', 'Behind (points)', 'qty'),
    col('lateDays', 'Late (days)', 'int'),
  ];
  return {
    name: 'delay-analysis-project',
    title: 'Delay Analysis',
    subtitle: `${project.code} ${project.name} · ${asOfText()}`,
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    summary,
    sections: [
      categories,
      { key: 'stoppages', title: 'Stoppages', columns: stopCols, rows: stopRows, totals: { ...Object.fromEntries(stopCols.map((x) => [x.key, null])), days: num(stopRows.filter((r) => r['stoppageStatus'] === 'APPROVED'), 'days') }, notes: ['Total = approved stoppage days (pending ones are listed but do not count yet).'] },
      { key: 'changeOrders', title: 'Change-order days', columns: coCols, rows: coRows, totals: { code: null, title: null, approvedOn: null, days: num(coRows, 'days') } },
      { key: 'milestones', title: 'Late or slipped milestones', columns: msCols, rows: msRows, totals: null },
    ],
    notes: ['Working days on the company calendar. Revised end = original end + owner + excusable + change-order days.'],
    extra: { categories: d.categories.map((x) => ({ category: x.category, days: x.days })), reasons: reasonsOf(d) },
  };
}

// ─── 2. Variance ────────────────────────────────────────────────────────────

interface ProjectVariance {
  project: Project;
  plan: ProjectPlan | null;
  estimate: EstimateData | null;
  cost: CostContext;
  material: VarianceResult;
  costVariance: ReturnType<typeof computeCostVariance>;
  projection: Projection;
  plannedPercent: number;
  revisedPaisa: bigint;
  spentPercent: number | null;
}

/** Control numbers of one project from its cost context (`loadCostContexts`: every project at once). */
async function varianceOf(tx: Tx, tenantId: string, cost: CostContext, settings: ControlSettings): Promise<ProjectVariance> {
  const { project, plan, estimate } = cost;
  const material = await computeMaterialVariance(tx, tenantId, project, settings, { plan, estimate });
  const revised = cost.contractPaisa + (cost.changes.inContract ? 0n : cost.changes.pricePaisa);
  const spent = bigPct(cost.actualPaisa, revised);
  const date = today();
  return {
    project,
    plan,
    estimate,
    cost,
    material,
    costVariance: computeCostVariance(cost, settings),
    projection: computeProjection(cost),
    plannedPercent: plan ? p1(physicalProgress(plan.milestones, estimate?.stageValues ?? null, (x) => plannedProgress(x, date, plan.cal)).percent) : 0,
    revisedPaisa: revised,
    spentPercent: spent === null ? null : p1(spent),
  };
}

export async function varianceReport(c: Step18Ctx): Promise<Built> {
  const money = moneyView(fields());
  const projects = await scopedProjects(c, 'control.view', RUNNING);
  const settings = await controlSettings(c.tx, c.a.tenantId);
  const contexts = await loadCostContexts(c.tx, c.a.tenantId, projects);
  const rows: Row[] = [];
  for (const p of projects) {
    const v = await varianceOf(c.tx, c.a.tenantId, contexts.get(p.id)!, settings);
    const count = (st: string) => v.material.rows.filter((r) => r.status === st).length;
    const t = v.costVariance.totals;
    rows.push({
      code: p.code,
      name: p.name,
      status: p.status,
      progressPercent: p1(v.cost.progress.percent),
      plannedProgressPercent: v.plannedPercent,
      materialsOver: count('OVER'),
      materialsUnder: count('UNDER'),
      materialsUnplanned: count('UNPLANNED'),
      ...(money.rates ? { materialImpact: s(v.material.rows.reduce((x, r) => x + (r.impactPaisa ?? 0n), 0n)) } : {}),
      ...(money.cost ? { costEstimateToDate: s(t.estimateToDatePaisa), costActual: s(t.actualPaisa), costVariance: s(t.variancePaisa), costVariancePercent: t.variancePercent } : {}),
      ...(money.spent ? { spentPercent: v.spentPercent, gapPoints: v.spentPercent === null || !v.plan ? null : p1(v.spentPercent - v.cost.progress.percent) } : {}),
      ...(money.contract ? { revisedContract: s(v.revisedPaisa) } : {}),
      ...(money.margin ? { estimateAtCompletion: s(v.projection.estimateAtCompletionPaisa), projectedMargin: s(v.projection.projectedMarginPaisa), projectedMarginPercent: v.projection.projectedMarginPercent } : {}),
    });
  }
  const columns = [
    col('code', 'Code'),
    col('name', 'Project'),
    col('status', 'Status'),
    col('progressPercent', 'Progress', 'percent'),
    col('plannedProgressPercent', 'Planned progress', 'percent'),
    col('materialsOver', 'Materials over', 'int'),
    col('materialsUnder', 'Materials under', 'int'),
    col('materialsUnplanned', 'Materials not in estimate', 'int'),
    ...(money.rates ? [col('materialImpact', 'Material impact', 'money')] : []),
    ...(money.cost ? [col('costEstimateToDate', 'Estimate to date', 'money'), col('costActual', 'Actual cost', 'money'), col('costVariance', 'Cost variance', 'money'), col('costVariancePercent', 'Cost variance %', 'percent')] : []),
    ...(money.spent ? [col('spentPercent', 'Spent % of contract', 'percent'), col('gapPoints', 'Spend − progress (points)', 'qty')] : []),
    ...(money.contract ? [col('revisedContract', 'Revised contract', 'money')] : []),
    ...(money.margin ? [col('estimateAtCompletion', 'Estimate at completion', 'money'), col('projectedMargin', 'Projected margin', 'money'), col('projectedMarginPercent', 'Projected margin %', 'percent')] : []),
  ];
  return {
    name: 'variance',
    title: 'Variance',
    subtitle: `${c.projectName} · ${asOfText()}`,
    columns,
    rows,
    totals: totalsOf(columns, rows, ['progressPercent', 'plannedProgressPercent', 'gapPoints']),
    notes: [
      `Materials over / under: consumed vs the estimate prorated for the work done, beyond ±${settings.overuseAlertPercent}%. Positive variance = costs more than the estimate.`,
      'Cost variance = actual cost − the approved estimate to date (each line × its stage’s progress). Projected margin = revised contract − estimate at completion (earned value).',
    ],
  };
}

/** Money keys of a material variance row the caller may see. */
const MAT_MONEY = ['estimateRate', 'actualAvgCost', 'quantityImpact', 'priceImpact', 'impact'] as const;

export async function varianceBook(c: Step18Ctx, project: Project): Promise<BuiltBook> {
  const money = moneyView(fields());
  const settings = await controlSettings(c.tx, c.a.tenantId);
  const v = await varianceOf(c.tx, c.a.tenantId, await loadCostContext(c.tx, c.a.tenantId, project), settings);
  const burn = await computeBurn(c.tx, c.a.tenantId, v.cost, settings);
  const pr = v.projection;
  const summary: SummaryItem[] = [
    { key: 'progressPercent', label: 'Progress', type: 'percent', value: p1(v.cost.progress.percent) },
    { key: 'progressBasis', label: 'Progress basis', type: 'text', value: v.cost.progress.basis },
    { key: 'plannedProgressPercent', label: 'Planned progress', type: 'percent', value: v.plannedPercent },
    ...(money.cost
      ? [
          { key: 'costEstimateToDate', label: 'Estimate to date', type: 'money' as const, value: s(v.costVariance.totals.estimateToDatePaisa) },
          { key: 'costActual', label: 'Actual cost', type: 'money' as const, value: s(v.costVariance.totals.actualPaisa) },
          { key: 'costVariance', label: 'Cost variance', type: 'money' as const, value: s(v.costVariance.totals.variancePaisa) },
        ]
      : []),
    ...(money.spent ? [{ key: 'spentPercent', label: 'Spent % of contract', type: 'percent' as const, value: v.spentPercent }] : []),
    ...(money.contract ? [{ key: 'revisedContract', label: 'Revised contract', type: 'money' as const, value: s(v.revisedPaisa) }] : []),
    ...(money.margin
      ? [
          { key: 'estimateAtCompletion', label: 'Estimate at completion', type: 'money' as const, value: s(pr.estimateAtCompletionPaisa) },
          { key: 'projectedMargin', label: 'Projected margin', type: 'money' as const, value: s(pr.projectedMarginPaisa) },
          { key: 'projectedMarginPercent', label: 'Projected margin %', type: 'percent' as const, value: pr.projectedMarginPercent },
          { key: 'projectionBasis', label: 'Projection basis', type: 'text' as const, value: pr.basis },
        ]
      : []),
  ];
  const matCols = [
    col('material', 'Material'),
    col('unit', 'Unit'),
    col('estimatedTotalQty', 'Estimated (total)', 'qty'),
    col('estimatedToDateQty', 'Estimated to date', 'qty'),
    col('deliveredQty', 'Delivered', 'qty'),
    col('usedQty', 'Used', 'qty'),
    col('lossQty', 'Counted loss', 'qty'),
    col('inStockQty', 'In stock', 'qty'),
    col('consumedQty', 'Consumed', 'qty'),
    col('varianceQty', 'Variance', 'qty'),
    col('variancePercent', 'Variance %', 'percent'),
    col('varianceStatus', 'Status'),
    ...(money.rates
      ? [col('estimateRate', 'Estimate rate', 'money'), col('actualAvgCost', 'Average cost', 'money'), col('quantityImpact', 'Quantity impact', 'money'), col('priceImpact', 'Price impact', 'money'), col('impact', 'Impact', 'money')]
      : []),
  ];
  const matRows: Row[] = v.material.rows.map((r) => ({
    material: r.description,
    unit: r.unit,
    estimatedTotalQty: r.estimatedTotalQty,
    estimatedToDateQty: r.estimatedToDateQty,
    deliveredQty: r.deliveredQty,
    usedQty: r.usedQty,
    lossQty: r.lossQty,
    inStockQty: r.inStockQty,
    consumedQty: r.consumedQty,
    varianceQty: r.varianceQty,
    variancePercent: r.variancePercent,
    varianceStatus: r.status,
    ...(money.rates ? { estimateRate: s(r.estimateRatePaisa), actualAvgCost: s(r.actualAvgCostPaisa), quantityImpact: s(r.quantityImpactPaisa), priceImpact: s(r.priceImpactPaisa), impact: s(r.impactPaisa) } : {}),
  }));
  const bucketCols = [
    col('bucket', 'Bucket'),
    col('varianceStatus', 'Status'),
    ...(money.cost ? [col('estimateTotal', 'Estimate (total)', 'money'), col('estimateToDate', 'Estimate to date', 'money'), col('actual', 'Actual cost', 'money'), col('variance', 'Variance', 'money'), col('variancePercent', 'Variance %', 'percent')] : []),
  ];
  const bucketRows: Row[] = v.costVariance.buckets.map((b) => ({
    bucket: b.bucket,
    varianceStatus: b.status,
    ...(money.cost ? { estimateTotal: s(b.estimateTotalPaisa), estimateToDate: s(b.estimateToDatePaisa), actual: s(b.actualPaisa), variance: s(b.variancePaisa), variancePercent: b.variancePercent } : {}),
  }));
  const burnCols = [
    col('month', 'Month'),
    col('progressPercent', 'Progress', 'percent'),
    ...(money.amounts ? [col('cost', 'Cost', 'money'), col('cumulativeCost', 'Cumulative cost', 'money')] : []),
    ...(money.spent ? [col('spentPercent', 'Spent % of contract', 'percent'), col('gapPoints', 'Spend − progress (points)', 'qty')] : []),
  ];
  const burnRows: Row[] = burn.months.map((m) => ({
    month: m.month,
    progressPercent: m.progressPercent,
    ...(money.amounts ? { cost: s(m.costPaisa), cumulativeCost: s(m.cumulativeCostPaisa) } : {}),
    ...(money.spent ? { spentPercent: m.spentPercent, gapPoints: m.gapPoints } : {}),
  }));
  return {
    name: 'variance-project',
    title: 'Variance',
    subtitle: `${project.code} ${project.name} · ${asOfText()}${v.estimate ? ` · estimate Rev ${v.estimate.revision}` : ' · no approved estimate'}`,
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    summary,
    sections: [
      { key: 'materials', title: 'Material variance', columns: matCols, rows: matRows, totals: money.rates ? { ...Object.fromEntries(matCols.map((x) => [x.key, null])), quantityImpact: sum(matRows, 'quantityImpact'), priceImpact: sum(matRows, 'priceImpact'), impact: sum(matRows, 'impact') } : null },
      { key: 'costBuckets', title: 'Cost variance by bucket', columns: bucketCols, rows: bucketRows, totals: money.cost ? { ...totalsOf(bucketCols, bucketRows, ['variancePercent']), variancePercent: v.costVariance.totals.variancePercent } : null },
      { key: 'burn', title: 'Burn rate vs progress', columns: burnCols, rows: burnRows, totals: null },
    ],
    notes: [`Material status: beyond ±${settings.overuseAlertPercent}% of the estimate prorated for the work done.`],
  };
}

// ─── 3. Change order register ───────────────────────────────────────────────

export async function changeOrderRegister(c: Step18Ctx): Promise<Built> {
  const f = fields();
  const seesPrice = f.rates || f.amounts;
  const projects = await scopedProjects(c, 'changeorder.view', NON_DRAFT);
  const code = new Map(projects.map((p) => [p.id, p.code]));
  const cos = await c.tx.changeOrder.findMany({
    where: {
      tenantId: c.a.tenantId,
      projectId: { in: projects.map((p) => p.id) },
      ...(c.q.status ? { status: c.q.status as ChangeOrderStatus } : {}),
      ...(c.q.type ? { type: c.q.type } : {}),
      ...(c.q.from || c.q.to ? { createdAt: { ...(c.q.from ? { gte: pktDayStart(c.q.from) } : {}), ...(c.q.to ? { lt: pktDayEnd(c.q.to) } : {}) } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
  });
  const invoices = await invoicesOf(
    c.tx,
    c.a.tenantId,
    cos.map((x) => x.id),
  );
  const list = cos
    .map((x) => ({
      project: code.get(x.projectId)!,
      code: changeOrderCode(x.number),
      title: x.title,
      coType: x.type,
      coStatus: x.status,
      ...(seesPrice ? { total: s(x.totalPaisa) } : {}),
      days: x.daysImpact,
      proofType: x.proofType,
      invoice: invoices.get(x.id)?.number ?? null,
      createdOn: pktDay(x.createdAt),
      approvedOn: ymd(x.approvedOn),
    }))
    .sort((a, b) => a.project.localeCompare(b.project) || a.code.localeCompare(b.code));
  const rows: Row[] = list;
  const columns = [
    col('project', 'Project'),
    col('code', 'Code'),
    col('title', 'Title'),
    col('coType', 'Type'),
    col('coStatus', 'Status'),
    ...(seesPrice ? [col('total', 'Total', 'money')] : []),
    col('days', 'Days', 'int'),
    col('proofType', 'Proof'),
    col('invoice', 'Billed on invoice'),
    col('createdOn', 'Created', 'date'),
    col('approvedOn', 'Approved on', 'date'),
  ];
  const approved: Row[] = list.filter((r) => APPROVED_SET.includes(r.coStatus));
  const byStatus: Record<string, number> = {};
  for (const r of list) byStatus[r.coStatus] = (byStatus[r.coStatus] ?? 0) + 1;
  return {
    name: 'change-orders',
    title: 'Change Order Register',
    subtitle: `${c.projectName} · ${c.q.from || c.q.to ? `${c.q.from ? day(c.q.from) : 'Start'} – ${day(c.q.to ?? today())}` : asOfText()}`,
    columns,
    rows,
    totals: { ...Object.fromEntries(columns.map((x) => [x.key, null])), ...(seesPrice ? { total: sum(approved, 'total') } : {}), days: num(approved, 'days') },
    notes: ['Totals count approved change orders only (approved, in progress, completed, billed). A deduction’s total is negative.'],
    extra: { byStatus, approvedCount: approved.length, ...(seesPrice ? { approvedTotalPaisa: sum(approved, 'total') } : {}) },
  };
}

// ─── 4. Equipment utilisation ───────────────────────────────────────────────

interface Daily {
  owned: number[];
  onSite: number[];
  idle: number[];
  rented: number[];
}

export async function equipmentUtilisation(c: Step18Ctx): Promise<Built> {
  const f = fields();
  const t = c.a.tenantId;
  const to = c.q.to ?? today();
  const from = c.q.from ?? addDays(to, -29);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // Sites the caller may see (null = every site); with projectId only that project's site.
  const all = scopeAll('equipment.view', c.a);
  const visibleProjects = all ? null : new Set((await c.tx.project.findMany({ where: { tenantId: t, ...projectScope(c.a, 'equipment.view') }, select: { id: true } })).map((p) => p.id));
  const siteOk = (projectId: string | null) => (c.q.projectId ? projectId === c.q.projectId : !visibleProjects || (projectId !== null && visibleProjects.has(projectId)));
  const projectFilter = c.q.projectId ? { projectId: c.q.projectId } : visibleProjects ? { projectId: { in: [...visibleProjects] } } : {};

  const equipment = await c.tx.equipment.findMany({ where: { tenantId: t, ...(c.q.category ? { category: c.q.category as EquipmentCategory } : {}) }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
  const ids = equipment.map((e) => e.id);
  const moves = ids.length
    ? await c.tx.equipmentMovement.findMany({
        where: { tenantId: t, equipmentId: { in: ids }, occurredAt: { lt: pktDayEnd(to) } },
        select: { equipmentId: true, rentalId: true, quantity: true, occurredAt: true, location: { select: { type: true, projectId: true } } },
      })
    : [];
  // Per equipment: opening balances + per-day deltas of each bucket, then the end-of-day balances.
  const daily = new Map<string, Daily>(ids.map((id) => [id, { owned: days.map(() => 0), onSite: days.map(() => 0), idle: days.map(() => 0), rented: days.map(() => 0) }]));
  for (const m of moves) {
    const dd = pktDay(m.occurredAt);
    const start = dd < from ? 0 : dayIndex.get(dd)!;
    const q = Number(m.quantity);
    const site = m.location.type === 'SITE';
    const x = daily.get(m.equipmentId)!;
    const add = (arr: number[]) => {
      arr[start] = (arr[start] ?? 0) + q;
    };
    if (m.rentalId === null) {
      add(x.owned);
      if (site && siteOk(m.location.projectId)) add(x.onSite);
      if (!site) add(x.idle);
    } else if ((site && siteOk(m.location.projectId)) || (!site && !c.q.projectId && all)) add(x.rented);
  }
  for (const x of daily.values()) for (const arr of [x.owned, x.onSite, x.idle, x.rented]) for (let i = 1; i < arr.length; i++) arr[i] = arr[i - 1]! + arr[i]!;

  const charges = ids.length
    ? await c.tx.equipmentCharge.groupBy({ by: ['equipmentId', 'kind'], where: { tenantId: t, equipmentId: { in: ids }, date: { gte: dateOnly(from), lte: dateOnly(to) }, ...projectFilter }, _sum: { amountPaisa: true } })
    : [];
  const losses = ids.length
    ? await c.tx.equipmentLoss.groupBy({ by: ['equipmentId'], where: { tenantId: t, equipmentId: { in: ids }, reportedAt: { gte: pktDayStart(from), lt: pktDayEnd(to) }, ...projectFilter }, _sum: { qty: true, valuePaisa: true } })
    : [];
  const charge = (id: string, kind: 'INTERNAL_HIRE' | 'RENTAL') => charges.filter((x) => x.equipmentId === id && x.kind === kind).reduce((s2, x) => s2 + (x._sum.amountPaisa ?? 0n), 0n);

  const group = c.q.group ?? 'item';
  const keyOf = (e: (typeof equipment)[number]) => (group === 'category' ? e.category : e.id);
  const groups = new Map<string, { items: typeof equipment; daily: Daily; hire: bigint; rent: bigint; lossQty: number; lossValue: bigint }>();
  for (const e of equipment) {
    const k = keyOf(e);
    const g = groups.get(k) ?? { items: [], daily: { owned: days.map(() => 0), onSite: days.map(() => 0), idle: days.map(() => 0), rented: days.map(() => 0) }, hire: 0n, rent: 0n, lossQty: 0, lossValue: 0n };
    const x = daily.get(e.id)!;
    for (const b of ['owned', 'onSite', 'idle', 'rented'] as const) x[b].forEach((v, i) => (g.daily[b][i]! += v));
    g.items.push(e);
    g.hire += charge(e.id, 'INTERNAL_HIRE');
    g.rent += charge(e.id, 'RENTAL');
    const l = losses.find((y) => y.equipmentId === e.id);
    g.lossQty += Number(l?._sum.qty ?? 0);
    g.lossValue += l?._sum.valuePaisa ?? 0n;
    groups.set(k, g);
  }
  const total = (arr: number[]) => q3(arr.reduce((a, b) => a + Math.max(0, b), 0));
  const rows: Row[] = [];
  for (const g of groups.values()) {
    const d = g.daily;
    const owned = total(d.owned);
    const onSite = total(d.onSite);
    const rented = total(d.rented);
    if (!owned && !rented && !g.hire && !g.rent && !g.lossQty) continue;
    const e = g.items[0]!;
    rows.push({
      ...(group === 'item' ? { equipment: e.name, code: e.code, category: e.category, unit: e.unit } : { category: e.category, items: g.items.length }),
      owned: q3(d.owned.at(-1) ?? 0),
      daysOnSite: d.onSite.filter((v) => v > 0).length,
      daysIdle: d.idle.filter((v) => v > 0).length,
      unitDaysOnSite: onSite,
      unitDaysIdle: total(d.idle),
      utilisationPercent: owned > 0 ? p1((onSite / owned) * 100) : null,
      rentedUnitDays: rented,
      ...(f.rates ? { hireCharges: s(g.hire), rent: s(g.rent) } : {}),
      lostQty: q3(g.lossQty),
      ...(f.rates ? { lossValue: s(g.lossValue) } : {}),
    });
  }
  const columns = [
    ...(group === 'item' ? [col('equipment', 'Equipment'), col('code', 'Code'), col('category', 'Category'), col('unit', 'Unit')] : [col('category', 'Category'), col('items', 'Items', 'int')]),
    col('owned', 'Owned (end of period)', 'qty'),
    col('daysOnSite', 'Days on site', 'int'),
    col('daysIdle', 'Days idle', 'int'),
    col('unitDaysOnSite', 'Unit-days on site', 'qty'),
    col('unitDaysIdle', 'Unit-days idle', 'qty'),
    col('utilisationPercent', 'Utilisation', 'percent'),
    col('rentedUnitDays', 'Rented unit-days', 'qty'),
    ...(f.rates ? [col('hireCharges', 'Hire charged to projects', 'money'), col('rent', 'Rent', 'money')] : []),
    col('lostQty', 'Lost / damaged', 'qty'),
    ...(f.rates ? [col('lossValue', 'Loss value', 'money')] : []),
  ];
  return {
    name: 'equipment-utilisation',
    title: 'Equipment Utilisation',
    subtitle: `${c.projectName} · ${day(from)} – ${day(to)} (${days.length} days)`,
    columns,
    rows,
    totals: totalsOf(columns, rows, ['owned', 'daysOnSite', 'daysIdle', 'utilisationPercent', 'items', 'lostQty', 'unitDaysOnSite', 'unitDaysIdle', 'rentedUnitDays']),
    notes: [
      'End-of-day balances from the equipment ledger (Karachi days). On site = owned units at a project site; idle = owned units in the yard or in transit. Utilisation = unit-days on site ÷ owned unit-days.',
      'Hire = internal hire charged to projects; rent = yard rent of rented items; losses = missing / damaged reported in the period.',
    ],
    extra: { from, to, days: days.length },
  };
}

// ─── 5. Snag summary ────────────────────────────────────────────────────────

const SNAG_AGES = ['0-7', '8-30', '31+'] as const;
const ageBucket = (n: number) => (n <= 7 ? '0-7' : n <= 30 ? '8-30' : '31+');
const ATTRIBUTION = { REWORK: 'rework', SUBCONTRACTOR_DEDUCTION: 'subcontractorDeduction', CHANGE_ORDER: 'changeOrder' } as const;

async function loadSnags(c: Step18Ctx, projectIds: string[], q: { from?: string | undefined; to?: string | undefined }) {
  return c.tx.snag.findMany({
    where: { tenantId: c.a.tenantId, projectId: { in: projectIds }, ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: pktDayStart(q.from) } : {}), ...(q.to ? { lt: pktDayEnd(q.to) } : {}) } } : {}) },
    include: { worker: { select: { name: true } }, subcontractor: { select: { name: true } } },
    orderBy: [{ projectId: 'asc' }, { number: 'asc' }],
  });
}
type SnagRow = Awaited<ReturnType<typeof loadSnags>>[number];
const snagCode = (n: number) => `SN-${String(n).padStart(3, '0')}`;
const openDays = (x: SnagRow, date: string) => Math.max(0, daysBetween(pktDay(x.createdAt), date));
const overdue = (x: SnagRow, date: string) => x.status === 'OPEN' && x.targetDate !== null && ymd(x.targetDate)! < date;

function snagCounts(list: SnagRow[], date: string, amounts: boolean): Row {
  const open = list.filter((x) => x.status === 'OPEN');
  const ages = Object.fromEntries(SNAG_AGES.map((k) => [`age_${k}`, 0])) as Record<string, number>;
  for (const x of open) ages[`age_${ageBucket(openDays(x, date))}`]! += 1;
  const cost = (k: keyof typeof ATTRIBUTION) => s(list.filter((x) => x.costAttribution === k).reduce((t, x) => t + x.costAmountPaisa, 0n));
  return {
    total: list.length,
    open: open.length,
    fixed: list.filter((x) => x.status === 'FIXED').length,
    verified: list.filter((x) => x.status === 'VERIFIED').length,
    overdue: list.filter((x) => overdue(x, date)).length,
    ...ages,
    oldestOpenDays: open.length ? Math.max(...open.map((x) => openDays(x, date))) : null,
    defectPeriod: list.filter((x) => x.inDefectPeriod).length,
    defectOpen: list.filter((x) => x.inDefectPeriod && x.status === 'OPEN').length,
    ...(amounts ? { rework: cost('REWORK'), subcontractorDeduction: cost('SUBCONTRACTOR_DEDUCTION'), changeOrder: cost('CHANGE_ORDER') } : {}),
  };
}

const countColumns = (amounts: boolean): ReportColumn[] => [
  col('total', 'Snags', 'int'),
  col('open', 'Open', 'int'),
  col('fixed', 'Fixed', 'int'),
  col('verified', 'Verified', 'int'),
  col('overdue', 'Overdue', 'int'),
  ...SNAG_AGES.map((k) => col(`age_${k}`, `${k} days`, 'int')),
  col('oldestOpenDays', 'Oldest open (days)', 'int'),
  col('defectPeriod', 'Defect period', 'int'),
  col('defectOpen', 'Defect period open', 'int'),
  ...(amounts ? [col('rework', 'Rework cost', 'money'), col('subcontractorDeduction', 'Charged to sub-contractors', 'money'), col('changeOrder', 'To change orders', 'money')] : []),
];

export async function snagSummary(c: Step18Ctx): Promise<Built> {
  const amounts = fields().amounts;
  const projects = await scopedProjects(c, 'closeout.snag.view', NON_DRAFT);
  const snags = await loadSnags(
    c,
    projects.map((p) => p.id),
    c.q,
  );
  const date = today();
  const rows: Row[] = [];
  for (const p of projects) {
    const list = snags.filter((x) => x.projectId === p.id);
    if (!list.length) continue;
    rows.push({ code: p.code, name: p.name, status: p.status, ...snagCounts(list, date, amounts) });
  }
  const columns = [col('code', 'Code'), col('name', 'Project'), col('status', 'Status'), ...countColumns(amounts)];
  return {
    name: 'snags',
    title: 'Snag Summary',
    subtitle: `${c.projectName} · ${c.q.from || c.q.to ? `${c.q.from ? day(c.q.from) : 'Start'} – ${day(c.q.to ?? today())}` : asOfText()}`,
    columns,
    rows,
    totals: totalsOf(columns, rows, ['oldestOpenDays']),
    notes: ['Ageing = days open (open snags only); overdue = open past the target date. Cost attribution: rework = project cost, sub-contractor = deducted from their account, change order = billed to the owner.'],
  };
}

export async function snagBook(c: Step18Ctx, project: Project, q: BookQuery): Promise<BuiltBook> {
  const amounts = fields().amounts;
  const list = await loadSnags(c, [project.id], q);
  const date = today();
  const counts = snagCounts(list, date, amounts);
  const summary: SummaryItem[] = countColumns(amounts)
    .filter((x) => !x.key.startsWith('age_'))
    .map((x) => ({ key: x.key, label: x.label, type: x.type, value: counts[x.key] ?? null }));
  const assignee = (x: SnagRow) => (x.worker ? { kind: 'WORKER', name: x.worker.name } : x.subcontractor ? { kind: 'SUBCONTRACTOR', name: x.subcontractor.name } : { kind: 'NONE', name: null });
  const groups = new Map<string, { kind: string; name: string | null; list: SnagRow[] }>();
  for (const x of list) {
    const a = assignee(x);
    const k = `${a.kind}:${a.name ?? ''}`;
    const g = groups.get(k) ?? { ...a, list: [] };
    g.list.push(x);
    groups.set(k, g);
  }
  const byCols = [
    col('assignee', 'Assigned to'),
    col('assigneeKind', 'Type'),
    col('open', 'Open', 'int'),
    col('fixed', 'Fixed', 'int'),
    col('verified', 'Verified', 'int'),
    col('overdue', 'Overdue', 'int'),
    ...(amounts ? [col('cost', 'Cost attributed', 'money')] : []),
  ];
  const byRows: Row[] = [...groups.values()]
    .map((g) => ({
      assignee: g.name,
      assigneeKind: g.kind,
      open: g.list.filter((x) => x.status === 'OPEN').length,
      fixed: g.list.filter((x) => x.status === 'FIXED').length,
      verified: g.list.filter((x) => x.status === 'VERIFIED').length,
      overdue: g.list.filter((x) => overdue(x, date)).length,
      ...(amounts ? { cost: s(g.list.filter((x) => x.costAttribution !== 'NONE').reduce((t, x) => t + x.costAmountPaisa, 0n)) } : {}),
    }))
    .sort((a, b) => b.open - a.open || String(a.assignee ?? '').localeCompare(String(b.assignee ?? '')));
  const openCols = [col('code', 'Code'), col('location', 'Location'), col('description', 'Description'), col('assignee', 'Assigned to'), col('createdOn', 'Logged', 'date'), col('ageDays', 'Days open', 'int'), col('targetDate', 'Target date', 'date'), col('overdueDays', 'Overdue (days)', 'int')];
  const openRows: Row[] = list
    .filter((x) => x.status === 'OPEN')
    .map((x) => ({
      code: snagCode(x.number),
      location: x.location,
      description: x.description,
      assignee: assignee(x).name,
      createdOn: pktDay(x.createdAt),
      ageDays: openDays(x, date),
      targetDate: ymd(x.targetDate),
      overdueDays: overdue(x, date) ? daysBetween(ymd(x.targetDate)!, date) : null,
    }))
    .sort((a, b) => b.ageDays - a.ageDays);
  const defectCols = [col('code', 'Code'), col('description', 'Description'), col('snagStatus', 'Status'), col('createdOn', 'Logged', 'date'), col('verifiedOn', 'Verified', 'date'), ...(amounts ? [col('cost', 'Cost attributed', 'money')] : [])];
  const defectRows: Row[] = list
    .filter((x) => x.inDefectPeriod)
    .map((x) => ({ code: snagCode(x.number), description: x.description, snagStatus: x.status, createdOn: pktDay(x.createdAt), verifiedOn: x.verifiedAt ? pktDay(x.verifiedAt) : null, ...(amounts ? { cost: s(x.costAmountPaisa) } : {}) }));
  return {
    name: 'snags-project',
    title: 'Snag Summary',
    subtitle: `${project.code} ${project.name} · ${q.from || q.to ? `${q.from ? day(q.from) : 'Start'} – ${day(q.to ?? today())}` : asOfText()}`,
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    summary,
    sections: [
      { key: 'byAssignee', title: 'By assignee', columns: byCols, rows: byRows, totals: totalsOf(byCols, byRows) },
      { key: 'open', title: 'Open snags', columns: openCols, rows: openRows, totals: null },
      { key: 'defectPeriod', title: 'Defect-period snags', columns: defectCols, rows: defectRows, totals: amounts ? totalsOf(defectCols, defectRows) : null },
    ],
  };
}

// ─── Books ──────────────────────────────────────────────────────────────────

const BOOK_PERM: Record<BookName, string> = { 'delay-analysis': 'control.view', variance: 'control.view', snags: 'closeout.snag.view' };

/** The book of one project (the module key in scope, else 404). */
export async function buildBookFor(c: Omit<Step18Ctx, 'projectName'>, name: BookName, projectId: string, q: BookQuery): Promise<BuiltBook> {
  assertPerm(BOOK_PERM[name], c.a);
  const project = await findProjectFor(c.tx, c.a, projectId, BOOK_PERM[name]);
  const ctx: Step18Ctx = { ...c, projectName: `${project.code} ${project.name}` };
  if (name === 'delay-analysis') return delayAnalysisBook(ctx, project);
  if (name === 'variance') return varianceBook(ctx, project);
  return snagBook(ctx, project, q);
}

