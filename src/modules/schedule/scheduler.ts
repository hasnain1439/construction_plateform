/**
 * Forward pass of the schedule — pure, no database.
 *
 * Every milestone's window comes from its effort (`workDays`, team-days), its dependencies
 * (FS: start ≥ predecessor end + 1 + lag; SS: start ≥ predecessor start + lag — lags are calendar
 * days, e.g. curing), an optional "start no earlier than", the schedule start and the working
 * calendar (weekly off days, holidays, Ramadan factor, approved stoppage days).
 *
 *   PLAN    the current plan: DONE / CURING milestones sit on their actual dates; IN_PROGRESS
 *           (or BLOCKED after starting) ones start on their actual start with their full effort —
 *           after a "re-plan from today" (`floor`) they also need the remaining effort from the floor;
 *           not-started ones never before the floor.
 *   PROJECT the projection: nothing happens before today, the remaining effort is done at the
 *           current `pace` (earned ÷ planned work, 0.5–1).
 */
import { addDays, maxDate, type WorkCalendar } from './calendar.js';

export type MilestoneStatusKey = 'PLANNED' | 'IN_PROGRESS' | 'CURING' | 'DONE' | 'BLOCKED';

export interface PlanDep {
  id: string;
  type: 'FS' | 'SS';
  lagDays: number;
}

export interface PlanItem {
  id: string;
  workDays: number;
  deps: PlanDep[];
  startNoEarlierThan: string | null;
  status: MilestoneStatusKey;
  progressPercent: number;
  actualStart: string | null;
  actualEnd: string | null;
  plannedStart: string;
  plannedEnd: string;
}

export interface PlanWindow {
  start: string;
  end: string;
  durationDays: number;
}

export interface PassOptions {
  mode: 'PLAN' | 'PROJECT';
  /** Schedule start (nothing before it). */
  start: string;
  /** PLAN: "re-plan from today" floor. */
  floor?: string | null;
  /** PROJECT: today. */
  today?: string;
  /** PROJECT: 0.5–1. */
  pace?: number;
}

export class DependencyCycleError extends Error {
  constructor(readonly ids: string[]) {
    super('The dependencies make a loop');
  }
}

export const isFinished = (s: MilestoneStatusKey) => s === 'DONE' || s === 'CURING';

/** Topological order (dependencies first); throws DependencyCycleError on a loop. Unknown deps are ignored. */
export function topoOrder(items: readonly PlanItem[]): PlanItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const state = new Map<string, 1 | 2>();
  const out: PlanItem[] = [];
  const visit = (i: PlanItem, path: string[]) => {
    const s = state.get(i.id);
    if (s === 2) return;
    if (s === 1) throw new DependencyCycleError([...path, i.id]);
    state.set(i.id, 1);
    for (const d of i.deps) {
      const p = byId.get(d.id);
      if (p) visit(p, [...path, i.id]);
    }
    state.set(i.id, 2);
    out.push(i);
  };
  for (const i of items) visit(i, []);
  return out;
}

export function forwardPass(items: readonly PlanItem[], cal: WorkCalendar, opts: PassOptions): Map<string, PlanWindow> {
  const out = new Map<string, PlanWindow>();
  const pace = opts.mode === 'PROJECT' ? Math.min(1, Math.max(0.5, opts.pace ?? 1)) : 1;
  const floor = opts.mode === 'PROJECT' ? (opts.today ?? null) : (opts.floor ?? null);
  for (const m of topoOrder(items)) {
    if (isFinished(m.status)) {
      const start = m.actualStart ?? m.plannedStart;
      const end = maxDate(start, m.actualEnd ?? m.plannedEnd);
      out.set(m.id, { start, end, durationDays: cal.workingDaysIn(start, end) });
      continue;
    }
    if (m.actualStart && (m.status === 'IN_PROGRESS' || m.status === 'BLOCKED')) {
      const start = m.actualStart;
      const remaining = (m.workDays * (100 - m.progressPercent)) / 100;
      let end: string;
      if (opts.mode === 'PROJECT') {
        const from = cal.nextWorking(maxDate(start, floor));
        end = remaining > 0 ? cal.walk(from, remaining / pace).end : maxDate(start, floor ?? start);
      } else {
        end = cal.walk(start, m.workDays).end;
        if (floor && floor > start) end = maxDate(end, remaining > 0 ? cal.walk(floor, remaining).end : floor);
      }
      out.set(m.id, { start, end, durationDays: cal.workingDaysIn(start, end) });
      continue;
    }
    let earliest = maxDate(opts.start, floor, m.startNoEarlierThan);
    for (const d of m.deps) {
      const p = out.get(d.id);
      if (!p) continue;
      earliest = maxDate(earliest, d.type === 'SS' ? addDays(p.start, d.lagDays) : addDays(p.end, 1 + d.lagDays));
    }
    const start = cal.nextWorking(earliest);
    const w = cal.walk(start, m.workDays / pace);
    out.set(m.id, { start, end: w.end, durationDays: w.durationDays });
  }
  return out;
}

/**
 * Pace of the work: earned (effort × progress) ÷ planned to date (effort × share of the planned
 * working days already passed), from the current plan. 1 when nothing was planned yet.
 */
export function paceOf(items: readonly PlanItem[], cal: WorkCalendar, today: string): { pace: number; earned: number; planned: number } {
  let earned = 0;
  let planned = 0;
  for (const m of items) {
    earned += isFinished(m.status) ? m.workDays : (m.workDays * m.progressPercent) / 100;
    if (m.plannedStart > today) continue;
    if (m.plannedEnd <= today) {
      planned += m.workDays;
      continue;
    }
    const total = cal.workingDaysIn(m.plannedStart, m.plannedEnd) || 1;
    planned += (m.workDays * cal.workingDaysIn(m.plannedStart, today)) / total;
  }
  const pace = planned > 0 ? Math.min(1, Math.max(0.5, earned / planned)) : 1;
  return { pace: Math.round(pace * 100) / 100, earned, planned };
}
