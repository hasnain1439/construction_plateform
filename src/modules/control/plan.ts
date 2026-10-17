/**
 * Step 14 · the schedule as the control views need it: milestones with planned / actual progress,
 * stage progress and the project's physical progress (value- or effort-weighted), also as of a
 * past date (milestone update history) for the burn-rate chart. No money in here — stage values
 * come from the estimate (estimate.ts) and are only used as weights.
 *
 *   actual progress   100 when DONE / CURING, else progressPercent
 *   planned progress  0 before plannedStart, 100 from plannedEnd, else working days elapsed ÷
 *                     working days of the window (company calendar + approved stoppage days)
 *   stage progress    workDays-weighted actual progress of the stage's milestones
 *   physical progress Σ stage value × stage progress ÷ Σ stage value (ESTIMATE_VALUE), else
 *                     workDays-weighted over every milestone (EFFORT); NONE without a schedule
 */
import type { Tx } from '../../core/db/withTenant.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import type { MilestoneStatus } from '../../generated/prisma/client.js';
import { diffDays, type WorkCalendar } from '../schedule/calendar.js';
import { baselineMap, loadCalendar } from '../schedule/schedule.shared.js';
import { p1 } from './control.shared.js';

const day = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);

export interface PlanQuota {
  materialId: string | null;
  material: string;
  description: string;
  unit: string;
  plannedQty: number;
  ownerSupplied: boolean;
}

export interface PlanMilestone {
  id: string;
  key: string;
  name: string;
  stageKey: string;
  sortOrder: number;
  workDays: number;
  plannedStart: string;
  plannedEnd: string;
  baselineStart: string | null;
  baselineEnd: string | null;
  status: MilestoneStatus;
  progressPercent: number;
  actualStart: string | null;
  actualEnd: string | null;
  quotas: PlanQuota[];
}

export interface ProjectPlan {
  scheduleId: string;
  startDate: string;
  milestones: PlanMilestone[];
  cal: WorkCalendar;
}

export async function loadPlan(tx: Tx, tenantId: string, projectId: string): Promise<ProjectPlan | null> {
  const s = await tx.schedule.findFirst({ where: { tenantId, projectId }, select: { id: true, startDate: true } });
  if (!s) return null;
  const rows = await tx.milestone.findMany({
    where: { tenantId, scheduleId: s.id },
    include: { stage: { select: { stageKey: true } }, quotas: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  });
  const baseline = await baselineMap(tx, s.id);
  const { cal } = await loadCalendar(tx, tenantId, projectId);
  return {
    scheduleId: s.id,
    startDate: day(s.startDate)!,
    cal,
    milestones: rows.map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      stageKey: m.stage.stageKey,
      sortOrder: m.sortOrder,
      workDays: Number(m.workDays),
      plannedStart: day(m.plannedStart)!,
      plannedEnd: day(m.plannedEnd)!,
      baselineStart: baseline.get(m.key)?.plannedStart ?? null,
      baselineEnd: baseline.get(m.key)?.plannedEnd ?? null,
      status: m.status,
      progressPercent: m.progressPercent,
      actualStart: day(m.actualStart),
      actualEnd: day(m.actualEnd),
      quotas: m.quotas.map((q) => ({ materialId: q.materialId, material: q.material, description: q.description, unit: q.unit, plannedQty: Number(q.plannedQty), ownerSupplied: q.ownerSupplied })),
    })),
  };
}

export const isFinished = (status: MilestoneStatus) => status === 'DONE' || status === 'CURING';

/** 0–100. */
export const actualProgress = (m: Pick<PlanMilestone, 'status' | 'progressPercent'>) => (isFinished(m.status) ? 100 : m.progressPercent);

/** 0–100 (1 dp): share of the planned window's working days elapsed by `date` (inclusive). */
export function plannedProgress(m: Pick<PlanMilestone, 'plannedStart' | 'plannedEnd'>, date: string, cal: WorkCalendar): number {
  if (date < m.plannedStart) return 0;
  if (date >= m.plannedEnd) return 100;
  const total = cal.workingDaysIn(m.plannedStart, m.plannedEnd);
  if (total <= 0) return 100;
  return p1(Math.min(100, (cal.workingDaysIn(m.plannedStart, date) / total) * 100));
}

export interface BehindInfo {
  plannedProgressPercent: number;
  actualProgressPercent: number;
  behindPoints: number;
  late: boolean;
  lateDays: number;
  /** the MILESTONE_BEHIND_PLAN condition */
  behind: boolean;
}

export function behindOf(m: PlanMilestone, date: string, cal: WorkCalendar, t: { behindPlanAlertPoints: number; lateFinishGraceDays: number }): BehindInfo {
  const actual = actualProgress(m);
  const planned = plannedProgress(m, date, cal);
  const finished = isFinished(m.status);
  const behindPoints = finished ? 0 : p1(Math.max(0, planned - actual));
  const lateDays = !finished && m.plannedEnd < date ? diffDays(m.plannedEnd, date) : 0;
  return {
    plannedProgressPercent: planned,
    actualProgressPercent: actual,
    behindPoints,
    late: lateDays > 0,
    lateDays,
    behind: !finished && (behindPoints >= t.behindPlanAlertPoints || lateDays > t.lateFinishGraceDays),
  };
}

export type ProgressPick = (m: PlanMilestone) => number;

/** Stage key → workDays-weighted progress (0–100) of its milestones. */
export function stageProgress(ms: PlanMilestone[], pick: ProgressPick = actualProgress): Map<string, number> {
  const acc = new Map<string, { w: number; done: number }>();
  for (const m of ms) {
    const a = acc.get(m.stageKey) ?? { w: 0, done: 0 };
    const w = m.workDays > 0 ? m.workDays : 1;
    a.w += w;
    a.done += (w * pick(m)) / 100;
    acc.set(m.stageKey, a);
  }
  return new Map([...acc].map(([k, a]) => [k, a.w > 0 ? (a.done / a.w) * 100 : 0]));
}

export type ProgressBasis = 'ESTIMATE_VALUE' | 'EFFORT' | 'NONE';

/** Physical progress (0–100, unrounded) — value-weighted by the estimate's stage amounts when there are any. */
export function physicalProgress(ms: PlanMilestone[], stageValues: Map<string, bigint> | null, pick: ProgressPick = actualProgress): { percent: number; basis: ProgressBasis; stages: Map<string, number> } {
  const stages = stageProgress(ms, pick);
  if (!ms.length) return { percent: 0, basis: 'NONE', stages };
  if (stageValues) {
    let total = 0;
    let done = 0;
    for (const [stageKey, p] of stages) {
      const v = Number(stageValues.get(stageKey) ?? 0n);
      total += v;
      done += (v * p) / 100;
    }
    if (total > 0) return { percent: (done / total) * 100, basis: 'ESTIMATE_VALUE', stages };
  }
  let w = 0;
  let done = 0;
  for (const m of ms) {
    const x = m.workDays > 0 ? m.workDays : 1;
    w += x;
    done += (x * pick(m)) / 100;
  }
  return { percent: w > 0 ? (done / w) * 100 : 0, basis: 'EFFORT', stages };
}

// ─── History ────────────────────────────────────────────────────────────────

export interface UpdateRow {
  milestoneId: string;
  date: string;
  status: MilestoneStatus;
  progressPercent: number;
  at: number;
}

export async function loadUpdates(tx: Tx, tenantId: string, milestoneIds: string[]): Promise<UpdateRow[]> {
  if (!milestoneIds.length) return [];
  const rows = await tx.milestoneUpdate.findMany({
    where: { tenantId, milestoneId: { in: milestoneIds } },
    select: { milestoneId: true, date: true, status: true, progressPercent: true, createdAt: true },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({ milestoneId: r.milestoneId, date: day(r.date)!, status: r.status, progressPercent: r.progressPercent, at: r.createdAt.getTime() }));
}

/**
 * Actual progress of each milestone as of `date` (the last update dated on or before it; none →
 * 0). Milestones whose current progress has no update behind it (made before updates were
 * logged) keep their current value once their actual start (or plan start) has passed.
 */
export function progressAsOf(updates: UpdateRow[], date: string, current: PlanMilestone[]): ProgressPick {
  const last = new Map<string, UpdateRow>();
  const any = new Set<string>();
  for (const u of updates) {
    any.add(u.milestoneId);
    if (u.date <= date) last.set(u.milestoneId, u);
  }
  const byId = new Map(current.map((m) => [m.id, m]));
  return (m) => {
    const u = last.get(m.id);
    if (u) return isFinished(u.status) ? 100 : u.progressPercent;
    if (any.has(m.id)) return 0;
    const cur = byId.get(m.id) ?? m;
    const started = cur.actualStart ?? cur.plannedStart;
    if (started > date) return 0;
    if (isFinished(cur.status) && cur.actualEnd && cur.actualEnd > date) return cur.progressPercent;
    return actualProgress(cur);
  };
}
