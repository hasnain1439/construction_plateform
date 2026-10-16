/**
 * Read models of a schedule: delay breakdown, Milestones & Quotas (planned vs used per material)
 * and "Aaj" (today's / upcoming / late milestones for the site). Permission schedule.plan.view.
 * Quantities only — never money.
 *
 * Delays
 *   originalEnd  = project end date (contract), else the baseline end
 *   revisedEnd   = originalEnd + APPROVED OWNER + EXCUSABLE stoppage working days + change-order days
 *   projectedEnd = remaining effort from today at the current pace (scheduler PROJECT mode)
 *   contractor   = working days projectedEnd is past revisedEnd (contractor stoppages + slow progress)
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import { caller } from '../projects/access.js';
import { addDays, diffDays } from './calendar.js';
import { DELAY_CATEGORIES } from './schedule.schema.js';
import { day, dtoContext, loadCalendar, loadMilestones, milestoneDto, planEnd, projection, projectFor, qty, scheduleNotFound, today, type MilestoneDto } from './schedule.shared.js';
import { stoppageDays } from './stoppages.service.js';
import { approvedChangeItems } from '../change-orders/totals.js'; // Step 15

async function scheduleFor(tx: Tx, projectId: string) {
  const s = await tx.schedule.findFirst({ where: { projectId } });
  if (!s) throw scheduleNotFound();
  return s;
}

// ─── Delays ─────────────────────────────────────────────────────────────────

export async function delaysTx(tx: Tx, c: { tenantId: string; userId: string; role: 'THEKEDAR' | 'PM' | 'MUNSHI' }, projectId: string) {
  const project = await projectFor(tx, c as never, projectId, 'schedule.plan.view');
  return delayBreakdown(tx, c.tenantId, project);
}

/** The delay breakdown of a project the caller may already see (Step 14 delay analysis reuses it). */
export async function delayBreakdown(tx: Tx, tenantId: string, project: Pick<Project, 'id' | 'endDate'>) {
  const c = { tenantId };
  const s = await scheduleFor(tx, project.id);
  const info = await loadCalendar(tx, c.tenantId, project.id);
  const rows = await loadMilestones(tx, s.id);
  const baseline = await tx.scheduleBaseline.findFirst({ where: { scheduleId: s.id }, select: { plannedEnd: true } });
  const todayStr = today();
  const proj = projection(rows, info.cal, day(s.startDate)!, todayStr);
  const plannedEnd = rows.length ? planEnd(rows.map((m) => ({ plannedEnd: day(m.plannedEnd)! }))) : null;
  const baselineEnd = day(baseline?.plannedEnd);
  const originalEnd = day(project.endDate) ?? baselineEnd ?? plannedEnd!;

  const stoppages = await tx.stoppageDay.findMany({ where: { tenantId: c.tenantId, projectId: project.id, status: { in: ['APPROVED', 'PENDING'] } }, orderBy: { createdAt: 'asc' } });
  const reasons = Object.fromEntries(DELAY_CATEGORIES.map((k) => [k, [] as Array<{ stoppageId: string | null; reason: string; dates: string[]; days: number; note: string | null }>]));
  const days = { OWNER: 0, EXCUSABLE: 0, CONTRACTOR: 0 };
  const pending = [];
  for (const r of stoppages) {
    const dates = r.dates.map((d) => day(d)!).sort();
    const n = stoppageDays(dates, info.cal);
    if (r.status === 'PENDING') {
      pending.push({ stoppageId: r.id, reason: r.reason, category: r.category, dates, days: n });
      continue;
    }
    days[r.category] += n;
    reasons[r.category]!.push({ stoppageId: r.id, reason: r.reason, dates, days: n, note: r.note });
  }
  // Step 15: approved change orders are owner-caused time (Schedule.changeOrderDays = Σ their days).
  const changeOrders = s.changeOrderDays;
  const coItems = await approvedChangeItems(tx, c.tenantId, project.id);
  const coReasons = coItems
    .filter((i) => i.daysImpact > 0)
    .map((i) => ({ stoppageId: null, changeOrderId: i.id, reason: 'CHANGE_ORDER', dates: [] as string[], days: i.daysImpact, note: `${i.code} · ${i.title}` }));
  const revisedEnd = info.cal.addWorkingDays(originalEnd, days.OWNER + days.EXCUSABLE + changeOrders);
  const projectedEnd = proj.end ?? plannedEnd ?? originalEnd;
  const late = projectedEnd > revisedEnd ? info.cal.workingDaysBetween(revisedEnd, projectedEnd) : 0;
  const ahead = projectedEnd < revisedEnd ? info.cal.workingDaysBetween(projectedEnd, revisedEnd) : 0;
  const contractor = late;
  const slow = Math.max(0, contractor - days.CONTRACTOR);
  if (slow > 0) reasons['CONTRACTOR']!.push({ stoppageId: null, reason: 'SLOW_PROGRESS', dates: [], days: slow, note: `Progress ${proj.progressPercent}% at ${Math.round(proj.pace * 100)}% of the planned pace` });
  return {
    originalEnd,
    baselineEnd,
    plannedEnd,
    revisedEnd,
    projectedEnd,
    pace: proj.pace,
    progressPercent: proj.progressPercent,
    days: { owner: days.OWNER, excusable: days.EXCUSABLE, contractor, changeOrders, total: days.OWNER + days.EXCUSABLE + contractor + changeOrders },
    aheadDays: ahead,
    calendarDaysLate: Math.max(0, diffDays(originalEnd, projectedEnd)),
    categories: DELAY_CATEGORIES.map((category) => ({
      category,
      days: category === 'CONTRACTOR' ? contractor : category === 'OWNER' ? days.OWNER + changeOrders : days[category],
      reasons: category === 'OWNER' ? [...reasons[category]!, ...coReasons] : reasons[category]!,
    })),
    pending,
    changeOrders: { days: changeOrders, items: coItems },
  };
}

export async function delays(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, (tx) => delaysTx(tx, c, projectId));
}

// ─── Milestones & Quotas ────────────────────────────────────────────────────

export async function quotas(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await projectFor(tx, c, projectId, 'schedule.plan.view');
    const s = await scheduleFor(tx, project.id);
    const rows = await loadMilestones(tx, s.id);
    const ctx = await dtoContext(tx, c.tenantId, s.id, rows);
    const ms = rows.map((m) => milestoneDto(m, ctx));
    const totals = new Map<string, { materialId: string | null; material: string; description: string; unit: string; plannedQty: number; usedQty: number }>();
    for (const m of ms) {
      for (const q of m.quotas) {
        const key = `${q.materialId ?? q.material}:${q.unit}`;
        const t = totals.get(key) ?? { materialId: q.materialId, material: q.material, description: q.description, unit: q.unit, plannedQty: 0, usedQty: 0 };
        t.plannedQty = qty(t.plannedQty + q.plannedQty);
        t.usedQty = qty(t.usedQty + q.usedQty);
        totals.set(key, t);
      }
    }
    // Usage on the project not linked to any milestone
    const free = await tx.materialUsage.findMany({ where: { tenantId: c.tenantId, projectId: project.id, milestoneId: null }, select: { items: { select: { materialId: true, qty: true, material: { select: { name: true, unit: true } } } } } });
    const unlinked = new Map<string, { materialId: string; name: string; unit: string; usedQty: number }>();
    for (const i of free.flatMap((u) => u.items)) {
      const x = unlinked.get(i.materialId) ?? { materialId: i.materialId, name: i.material.name, unit: i.material.unit, usedQty: 0 };
      x.usedQty = qty(x.usedQty + Number(i.qty));
      unlinked.set(i.materialId, x);
    }
    return {
      milestones: ms.map((m) => ({
        milestone: { id: m.id, key: m.key, name: m.name, stageKey: m.stageKey, status: m.status, progressPercent: m.progressPercent, plannedStart: m.plannedStart, plannedEnd: m.plannedEnd },
        quotas: m.quotas,
      })),
      materials: [...totals.values()].map((t) => ({
        ...t,
        remainingQty: qty(Math.max(0, t.plannedQty - t.usedQty)),
        usedPercent: t.plannedQty > 0 ? Math.round((t.usedQty / t.plannedQty) * 1000) / 10 : null,
        over: t.usedQty > t.plannedQty + 1e-9,
      })),
      unlinked: [...unlinked.values()],
    };
  });
}

// ─── Aaj (today) ────────────────────────────────────────────────────────────

export function todayLists(ms: MilestoneDto[], date: string) {
  const active = (m: MilestoneDto) => m.status === 'IN_PROGRESS' || m.status === 'CURING' || m.status === 'BLOCKED';
  const covers = (m: MilestoneDto) => m.status !== 'DONE' && m.plannedStart <= date && m.plannedEnd >= date;
  const todayList = ms.filter((m) => active(m) || covers(m));
  const upcoming = ms.filter((m) => m.status === 'PLANNED' && !covers(m) && m.plannedStart > date && m.plannedStart <= addDays(date, 7));
  const late = ms.filter((m) => m.status !== 'DONE' && m.status !== 'CURING' && m.plannedEnd < date);
  return { today: todayList, upcoming, late };
}

export async function todayView(projectId: string, query: { date?: string | undefined }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await projectFor(tx, c, projectId, 'schedule.plan.view');
    const s = await scheduleFor(tx, project.id);
    const rows = await loadMilestones(tx, s.id);
    const ctx = await dtoContext(tx, c.tenantId, s.id, rows);
    const date = query.date ?? today();
    return { date, ...todayLists(rows.map((m) => milestoneDto(m, ctx)), date) };
  });
}
