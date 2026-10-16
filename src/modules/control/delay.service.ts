/**
 * Step 14 · delay analysis: the Step 13 delay breakdown (original / revised / projected end,
 * owner / excusable / contractor days with reasons) + each milestone's planned vs actual progress
 * (behind points, late days) + one timeline of what happened (stoppages, plan versions, site
 * updates). No money.
 */
import { withTenant } from '../../core/db/withTenant.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import { delayBreakdown } from '../schedule/insights.service.js';
import { stoppageDays } from '../schedule/stoppages.service.js';
import { controlCaller, controlProject, controlSettings, ref, today } from './control.shared.js';
import { behindOf, isFinished, loadPlan } from './plan.js';

const day = (d: Date) => formatDateOnly(d);
const TIMELINE_MAX = 100;

export async function delayAnalysis(projectId: string) {
  const c = controlCaller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await controlProject(tx, c, projectId);
    const settings = await controlSettings(tx, c.tenantId);
    const plan = await loadPlan(tx, c.tenantId, project.id);
    const date = today();
    const base = { project: { ...ref(project), status: project.status }, asOf: date, thresholdPoints: settings.behindPlanAlertPoints, graceDays: settings.lateFinishGraceDays };
    if (!plan) return { ...base, hasSchedule: false, delays: null, milestones: [], timeline: [], summary: { behind: 0, late: 0, finished: 0, total: 0 } };

    const delays = await delayBreakdown(tx, c.tenantId, project);
    const milestones = plan.milestones.map((m) => {
      const b = behindOf(m, date, plan.cal, settings);
      return {
        id: m.id,
        key: m.key,
        name: m.name,
        stageKey: m.stageKey,
        status: m.status,
        plannedStart: m.plannedStart,
        plannedEnd: m.plannedEnd,
        baselineStart: m.baselineStart,
        baselineEnd: m.baselineEnd,
        varianceDays: m.baselineEnd ? Math.round((Date.parse(m.plannedEnd) - Date.parse(m.baselineEnd)) / 86_400_000) : 0,
        actualStart: m.actualStart,
        actualEnd: m.actualEnd,
        progressPercent: b.actualProgressPercent,
        plannedProgressPercent: b.plannedProgressPercent,
        behindPoints: b.behindPoints,
        late: b.late,
        lateDays: b.lateDays,
        behind: b.behind,
      };
    });

    const names = new Map(plan.milestones.map((m) => [m.id, m.name]));
    const stoppages = await tx.stoppageDay.findMany({ where: { tenantId: c.tenantId, projectId: project.id, status: { in: ['APPROVED', 'PENDING'] } }, orderBy: { createdAt: 'desc' }, take: TIMELINE_MAX });
    const versions = await tx.schedulePlanVersion.findMany({ where: { tenantId: c.tenantId, scheduleId: plan.scheduleId }, orderBy: { version: 'desc' }, take: TIMELINE_MAX });
    const updates = await tx.milestoneUpdate.findMany({ where: { tenantId: c.tenantId, projectId: project.id }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: TIMELINE_MAX });
    type Event = { date: string; at: number; kind: 'STOPPAGE' | 'PLAN_VERSION' | 'MILESTONE_UPDATE'; title: string; detail: string | null; category: string | null; status: string | null; days: number | null; refId: string; plannedEnd: string | null; progressPercent: number | null };
    const events: Event[] = [
      ...stoppages.map((s) => {
        const dates = s.dates.map(day).sort();
        return { date: dates[0]!, at: s.createdAt.getTime(), kind: 'STOPPAGE' as const, title: s.reason, detail: s.note, category: s.category, status: s.status, days: stoppageDays(dates, plan.cal), refId: s.id, plannedEnd: null, progressPercent: null };
      }),
      ...versions.map((v) => ({ date: day(v.createdAt), at: v.createdAt.getTime(), kind: 'PLAN_VERSION' as const, title: v.reason, detail: v.note, category: null, status: `v${v.version}`, days: null, refId: v.id, plannedEnd: day(v.plannedEnd), progressPercent: null })),
      ...updates.map((u) => ({
        date: day(u.date),
        at: u.createdAt.getTime(),
        kind: 'MILESTONE_UPDATE' as const,
        title: names.get(u.milestoneId) ?? '',
        detail: u.note,
        category: null,
        status: u.status,
        days: null,
        refId: u.milestoneId,
        plannedEnd: null,
        progressPercent: isFinished(u.status) ? 100 : u.progressPercent,
      })),
    ];
    const timeline = events
      .sort((a, b) => (a.date === b.date ? b.at - a.at : a.date < b.date ? 1 : -1))
      .slice(0, TIMELINE_MAX)
      .map(({ at: _at, ...e }) => {
        void _at;
        return e;
      });

    return {
      ...base,
      hasSchedule: true,
      delays,
      milestones,
      timeline,
      summary: { behind: milestones.filter((m) => m.behind).length, late: milestones.filter((m) => m.late).length, finished: plan.milestones.filter((m) => isFinished(m.status)).length, total: milestones.length },
    };
  });
}
