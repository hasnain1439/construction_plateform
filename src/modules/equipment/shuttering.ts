/**
 * Shuttering demand planner — pure maths (no database), so every rule is unit-tested
 * (tests/equipment/shuttering.unit.test.ts). The service (shuttering.service.ts) loads the data.
 *
 *   1. Area of each slab milestone (GF / F1 / F2 / F3 slab, mumty roof) from the APPROVED estimate:
 *        BOQ                — the stage's shuttering labour line trace (slab soffit + sunshade + beam sides
 *                             of the detailed roof data); a "beams + columns" frame line (% method)
 *                             counts as slab × beamSidesPercent (it also holds the column faces)
 *        ESTIMATE_FOOTPRINT — floor footprint of the estimate basis + beam sides (slab × beamSidesPercent)
 *        COVERED_AREA       — covered area ÷ slab floors + beam sides
 *   2. plates = ceil(area ÷ plate coverage × (1 + spare %)); props = ceil(plates × props per plate).
 *   3. Plates are held from the start of the slab work until it is struck:
 *        holdFrom  = actualStart ?? plannedStart
 *        holdUntil = (actualEnd ?? plannedEnd, never before today while the work runs) + curing lag
 *                    (milestone curingDays, else defaultStrikeDays)
 *      DONE milestones hold nothing.
 *   4. Weekly need = the highest day of the week (plates struck from one slab go onto the next).
 *   5. Supply: company view = every owned unit + rented units on hand (an ACTIVE rental counts until its
 *      expectedEndDate; an overdue one still counts — the units are there); project view = owned at the
 *      site + at the yard, rented at the site.
 *   6. Suggestions per project shortfall (peak over the horizon): EXTEND_RENTAL for the site's own rentals
 *      that end while it is still short, TRANSFER from the yard, then from sites that need fewer from that
 *      week on (units on hand now), then RENT the rest; RETURN_RENTAL for rented units no site needs (never
 *      at a site that is short).
 *
 * Every constant here is an assumption for the civil engineer to review.
 */

export const SLAB_MILESTONES: Record<SlabStage, { key: string; level: 'GROUND' | 'FIRST' | 'SECOND' | 'THIRD' | 'MUMTY' }> = {
  GF_STRUCTURE: { key: 'GF_STRUCTURE.SLAB', level: 'GROUND' },
  F1_STRUCTURE: { key: 'F1_STRUCTURE.SLAB', level: 'FIRST' },
  F2_STRUCTURE: { key: 'F2_STRUCTURE.SLAB', level: 'SECOND' },
  F3_STRUCTURE: { key: 'F3_STRUCTURE.SLAB', level: 'THIRD' },
  MUMTY_ROOF: { key: 'MUMTY_ROOF.STRUCTURE', level: 'MUMTY' },
};
export type SlabStage = 'GF_STRUCTURE' | 'F1_STRUCTURE' | 'F2_STRUCTURE' | 'F3_STRUCTURE' | 'MUMTY_ROOF';
export const SLAB_STAGES = Object.keys(SLAB_MILESTONES) as SlabStage[];
export const SLAB_MILESTONE_KEYS = SLAB_STAGES.map((s) => SLAB_MILESTONES[s].key);

/** Planner defaults (engineer review). Props per plate and spare % are company settings. */
export const SHUTTERING_DEFAULTS = {
  /** A 2 × 3 ft steel plate. Used when no owned plate has coverageSqftPerUnit. */
  plateCoverageSqft: 6,
  /** Beam sides as % of the slab soffit when the estimate has no beam detail. */
  beamSidesPercent: 20,
  /** Days the slab stays propped after casting when the milestone has no curing lag. */
  defaultStrikeDays: 14,
  propsPerPlate: 0.75,
  sparePercent: 5,
  weeks: 8,
} as const;

export type Category = 'SHUTTERING_PLATE' | 'PROP';
export const CATEGORIES: Category[] = ['SHUTTERING_PLATE', 'PROP'];

export interface PlannerParams {
  plateCoverageSqft: number;
  propsPerPlate: number;
  sparePercent: number;
  beamSidesPercent: number;
  defaultStrikeDays: number;
}

// ─── Dates (YYYY-MM-DD, UTC maths) ──────────────────────────────────────────

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY);
const maxDate = (a: string, b: string) => (a > b ? a : b);
/** The Monday on or before `d`. */
export function weekStartOf(d: string): string {
  const dow = new Date(ms(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}

// ─── 1. Area ────────────────────────────────────────────────────────────────

export type AreaSource = 'BOQ' | 'ESTIMATE_FOOTPRINT' | 'COVERED_AREA';
export interface SlabArea {
  slabSqft: number;
  beamSqft: number;
  totalSqft: number;
  source: AreaSource;
}

export interface AreaInput {
  /** Trace lines of the stage's GREY_LABOUR.<stage>.SHUTTERING estimate line (null = no such line). */
  boqTrace: string[] | null;
  /** Floor footprint from the estimate basis (null = floor not in the basis). */
  footprintSqft: number | null;
  /** Covered area (estimate, else project) and how many slab floors share it. */
  coveredAreaSqft: number | null;
  slabFloors: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** "Ground floor · slab: Slab soffit 1250 sq ft = 1250 sqft" → element + sq ft. */
const TRACE = /· (slab|sunshade|beams|beams \+ columns): .*= (-?\d+(?:\.\d+)?) sqft\s*$/;

export function parseShutteringTrace(trace: string[]): { slab: number; beams: number; frame: number } | null {
  let slab = 0;
  let beams = 0;
  let frame = 0;
  let found = false;
  for (const line of trace) {
    const m = TRACE.exec(line);
    if (!m) continue;
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'slab' || m[1] === 'sunshade') {
      slab += v;
      found = true;
    } else if (m[1] === 'beams') beams += v;
    else frame += v;
  }
  return found ? { slab, beams, frame } : null;
}

export function slabArea(input: AreaInput, beamSidesPercent: number): SlabArea | null {
  const pct = beamSidesPercent / 100;
  const parsed = input.boqTrace ? parseShutteringTrace(input.boqTrace) : null;
  if (parsed && parsed.slab > 0) {
    const beams = parsed.beams > 0 ? parsed.beams : parsed.frame > 0 ? parsed.slab * pct : 0;
    return { slabSqft: r2(parsed.slab), beamSqft: r2(beams), totalSqft: r2(parsed.slab + beams), source: 'BOQ' };
  }
  if (input.footprintSqft && input.footprintSqft > 0) {
    const s = input.footprintSqft;
    return { slabSqft: r2(s), beamSqft: r2(s * pct), totalSqft: r2(s * (1 + pct)), source: 'ESTIMATE_FOOTPRINT' };
  }
  if (input.coveredAreaSqft && input.coveredAreaSqft > 0 && input.slabFloors > 0) {
    const s = input.coveredAreaSqft / input.slabFloors;
    return { slabSqft: r2(s), beamSqft: r2(s * pct), totalSqft: r2(s * (1 + pct)), source: 'COVERED_AREA' };
  }
  return null;
}

// ─── 2. Plates / props ──────────────────────────────────────────────────────

const ceil = (n: number) => Math.ceil(n - 1e-9);

/**
 * Example (hand-checked): 1,000 sq ft slab + 20 % beam sides = 1,200 sq ft; ÷ 6 sq ft per plate = 200;
 * + 5 % spare = 210 plates; × 0.75 props per plate = 157.5 → 158 props.
 */
export function platesFor(totalSqft: number, p: Pick<PlannerParams, 'plateCoverageSqft' | 'sparePercent' | 'propsPerPlate'>): { plates: number; props: number } {
  if (!(totalSqft > 0) || !(p.plateCoverageSqft > 0)) return { plates: 0, props: 0 };
  const plates = ceil((totalSqft / p.plateCoverageSqft) * (1 + p.sparePercent / 100));
  return { plates, props: ceil(plates * p.propsPerPlate) };
}

/** Qty-weighted coverage of the plates the company owns (null = none has a coverage). */
export function weightedCoverage(items: Array<{ qty: number; coverageSqftPerUnit: number | null }>): number | null {
  let qty = 0;
  let area = 0;
  for (const i of items) {
    if (i.coverageSqftPerUnit === null || !(i.coverageSqftPerUnit > 0)) continue;
    const q = Math.max(i.qty, 0) || 0;
    qty += q;
    area += q * i.coverageSqftPerUnit;
  }
  if (qty > 0) return r2(area / qty);
  const withCoverage = items.filter((i) => i.coverageSqftPerUnit !== null && i.coverageSqftPerUnit > 0);
  return withCoverage.length ? r2(withCoverage.reduce((s, i) => s + i.coverageSqftPerUnit!, 0) / withCoverage.length) : null;
}

// ─── 3. Hold window ─────────────────────────────────────────────────────────

export interface MilestoneWindowInput {
  status: 'PLANNED' | 'IN_PROGRESS' | 'CURING' | 'DONE' | 'BLOCKED';
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  curingDays: number;
}

/** Days the plates are held: [from, until] inclusive; null = holds nothing (DONE). */
export function holdWindow(m: MilestoneWindowInput, today: string, defaultStrikeDays: number): { from: string; until: string } | null {
  if (m.status === 'DONE') return null;
  const from = m.actualStart ?? m.plannedStart;
  let end = m.actualEnd ?? m.plannedEnd;
  if (!m.actualEnd && (m.status === 'IN_PROGRESS' || m.status === 'BLOCKED')) end = maxDate(end, today);
  const lag = m.curingDays > 0 ? m.curingDays : defaultStrikeDays;
  const until = addDays(end, lag);
  if (m.status === 'CURING' && until < today) return null; // struck already
  return { from, until: maxDate(until, from) };
}

// ─── 4–6. Weekly plan ───────────────────────────────────────────────────────

export interface PlanDemand {
  projectId: string;
  milestoneId: string;
  from: string;
  until: string;
  qty: Record<Category, number>;
}

export interface PlanSupply {
  category: Category;
  equipmentId: string;
  locationId: string;
  locationType: 'STORE' | 'TRANSIT' | 'SITE';
  /** The site's project (null for the yard / transit). */
  projectId: string | null;
  rentalId: string | null;
  /** ACTIVE rental's expected end (null = open-ended or owned). */
  rentalEnd: string | null;
  qty: number;
}

export interface WeekRow {
  weekStart: string;
  weekEnd: string;
  needed: number;
  ownedAvailable: number;
  onRent: number;
  available: number;
  shortfall: number;
  surplus: number;
  demand: Array<{ projectId: string; milestoneId: string; qty: number }>;
}

export type SuggestionType = 'RENT' | 'TRANSFER' | 'RETURN_RENTAL' | 'EXTEND_RENTAL';
export interface Suggestion {
  type: SuggestionType;
  category: Category;
  equipmentId: string | null;
  qty: number;
  fromWeek: string;
  toWeek: string;
  /** TRANSFER source / RETURN_RENTAL holder location. */
  fromLocationId: string | null;
  fromProjectId: string | null;
  /** TRANSFER from a site: the last week the moved units are still in use there (null = idle now). */
  idleAfterWeek: string | null;
  toProjectId: string | null;
  rentalId: string | null;
}

export interface PlanInput {
  today: string;
  from: string;
  weeks: number;
  /** Project view: the one project; null = company view. */
  projectId: string | null;
  demands: PlanDemand[];
  supply: PlanSupply[];
  /** The yard's equipment location (TRANSFER source for yard stock). */
  yardLocationId: string | null;
  /** Equipment to name in a RENT suggestion per category (the main owned item), if any. */
  rentEquipment: Partial<Record<Category, string>>;
}

export interface PlanOutput {
  series: Array<{ category: Category; weeks: WeekRow[] }>;
  suggestions: Suggestion[];
}

export function weekStarts(from: string, weeks: number): string[] {
  const start = weekStartOf(from);
  return Array.from({ length: weeks }, (_, i) => addDays(start, i * 7));
}

/** Units on hand that still count in a week (rented ones until their expected end; overdue ones stay). */
const counts = (s: PlanSupply, weekStart: string, today: string) => !s.rentalId || s.rentalEnd === null || s.rentalEnd >= weekStart || s.rentalEnd < today;

/** Highest daily demand per week, per project and for the projects together (+ who makes it). */
function weeklyNeed(demands: PlanDemand[], weeks: string[], category: Category) {
  const perProject = new Map<string, number[]>();
  const total: number[] = [];
  const detail: Array<Array<{ projectId: string; milestoneId: string; qty: number }>> = [];
  weeks.forEach((ws, wi) => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    let best = 0;
    const byProject = new Map<string, number>();
    for (const d of days) {
      let dayTotal = 0;
      const dayProject = new Map<string, number>();
      for (const m of demands) {
        if (m.from <= d && d <= m.until && m.qty[category] > 0) {
          dayTotal += m.qty[category];
          dayProject.set(m.projectId, (dayProject.get(m.projectId) ?? 0) + m.qty[category]);
        }
      }
      best = Math.max(best, dayTotal);
      for (const [p, q] of dayProject) byProject.set(p, Math.max(byProject.get(p) ?? 0, q));
    }
    total[wi] = best;
    for (const [p, q] of byProject) {
      const arr = perProject.get(p) ?? weeks.map(() => 0);
      arr[wi] = q;
      perProject.set(p, arr);
    }
    detail[wi] = demands
      .filter((m) => m.qty[category] > 0 && m.from <= addDays(ws, 6) && m.until >= ws)
      .map((m) => ({ projectId: m.projectId, milestoneId: m.milestoneId, qty: m.qty[category] }));
  });
  return { perProject, total, detail };
}

export function planShuttering(input: PlanInput): PlanOutput {
  const weeks = weekStarts(input.from, input.weeks);
  const series: PlanOutput['series'] = [];
  const suggestions: Suggestion[] = [];
  for (const category of CATEGORIES) {
    const supply = input.supply.filter((s) => s.category === category && s.qty > 0);
    const need = weeklyNeed(input.demands, weeks, category);
    // Project view: the site's own units + owned units at the yard
    const scoped = input.projectId ? supply.filter((s) => s.projectId === input.projectId || (s.locationType === 'STORE' && !s.rentalId)) : supply;
    const neededOf = (wi: number) => (input.projectId ? (need.perProject.get(input.projectId)?.[wi] ?? 0) : need.total[wi]!);
    const rows: WeekRow[] = weeks.map((ws, wi) => {
      const live = scoped.filter((s) => counts(s, ws, input.today));
      const owned = live.filter((s) => !s.rentalId).reduce((x, s) => x + s.qty, 0);
      const rented = live.filter((s) => s.rentalId).reduce((x, s) => x + s.qty, 0);
      const needed = neededOf(wi);
      const available = owned + rented;
      return {
        weekStart: ws,
        weekEnd: addDays(ws, 6),
        needed,
        ownedAvailable: r3(owned),
        onRent: r3(rented),
        available: r3(available),
        shortfall: r3(Math.max(0, needed - available)),
        surplus: r3(Math.max(0, available - needed)),
        demand: need.detail[wi]!.filter((d) => !input.projectId || d.projectId === input.projectId),
      };
    });
    series.push({ category, weeks: rows });
    const all = suggest(category, weeks, need.perProject, supply, input);
    suggestions.push(...(input.projectId ? all.filter((s) => s.toProjectId === input.projectId || s.fromProjectId === input.projectId) : all));
  }
  return { series, suggestions };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The item with the most units among `rows` (null = none). */
function mainEquipment(rows: PlanSupply[]): string | null {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.equipmentId, (by.get(r.equipmentId) ?? 0) + r.qty);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function suggest(category: Category, weeks: string[], perProject: Map<string, number[]>, supply: PlanSupply[], input: PlanInput): Suggestion[] {
  const out: Suggestion[] = [];
  const zero = weeks.map(() => 0);
  const siteRows = (p: string) => supply.filter((s) => s.locationType === 'SITE' && s.projectId === p);
  const sites = new Set<string>([...perProject.keys(), ...supply.filter((s) => s.locationType === 'SITE' && s.projectId).map((s) => s.projectId!)]);
  const atSite = new Map([...sites].map((p) => [p, siteRows(p).reduce((x, s) => x + s.qty, 0)]));
  // Units at the site per week (a rental stops counting after its expected end)
  const haveWeekly = new Map([...sites].map((p) => [p, weeks.map((ws) => siteRows(p).filter((s) => counts(s, ws, input.today)).reduce((x, s) => x + s.qty, 0))]));
  const movedOut = new Map<string, number>();
  const yardOwned = supply.filter((s) => s.locationType === 'STORE' && !s.rentalId);
  const yardRented = supply.filter((s) => s.locationType === 'STORE' && s.rentalId);
  let yardFree = yardOwned.reduce((x, s) => x + s.qty, 0) + yardRented.reduce((x, s) => x + s.qty, 0);
  let yardOwnedLeft = yardOwned.reduce((x, s) => x + s.qty, 0);

  const shortOf = (need: number[], have: number[]) => {
    const short = need.map((n, i) => n - have[i]!);
    const idx = short.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    return { qty: Math.max(0, ...short), first: idx[0] ?? -1, last: idx[idx.length - 1] ?? -1 };
  };

  // Shortfalls per project, earliest first
  const deficits = [...perProject.entries()]
    .map(([p, need]) => ({ p, need, ...shortOf(need, haveWeekly.get(p) ?? zero) }))
    .filter((d) => d.qty > 0 && d.first >= 0)
    .sort((a, b) => a.first - b.first || b.qty - a.qty || a.p.localeCompare(b.p));
  const short = new Set(deficits.map((d) => d.p));

  for (const d of deficits) {
    // 0. the site's own rentals that end while it is still short: extend them
    const have = [...(haveWeekly.get(d.p) ?? zero)];
    const ending = siteRows(d.p)
      .filter((s) => s.rentalId && s.rentalEnd !== null && s.rentalEnd >= input.today && s.rentalEnd < addDays(weeks[d.last]!, 6))
      .sort((a, b) => a.rentalEnd!.localeCompare(b.rentalEnd!));
    for (const r of ending) {
      const after = weeks.map((ws, i) => (ws > r.rentalEnd! ? i : -1)).filter((i) => i >= 0);
      const gap = Math.max(0, ...after.map((i) => d.need[i]! - have[i]!));
      const qty = Math.min(r.qty, gap);
      if (qty <= 0) continue;
      for (const i of after) have[i] = have[i]! + qty;
      const lastShort = after.filter((i) => d.need[i]! > have[i]! - qty).pop() ?? after[after.length - 1]!;
      out.push({
        type: 'EXTEND_RENTAL',
        category,
        equipmentId: r.equipmentId,
        qty: r3(qty),
        fromWeek: weeks[after[0]!]!,
        toWeek: weeks[lastShort]!,
        fromLocationId: r.locationId,
        fromProjectId: d.p,
        idleAfterWeek: null,
        toProjectId: d.p,
        rentalId: r.rentalId,
      });
    }
    const left = shortOf(d.need, have);
    if (left.qty <= 0) continue;
    let remaining = left.qty;
    const fromWeek = weeks[left.first]!;
    const toWeek = weeks[left.last]!;
    const first = left.first;
    // a. the yard
    if (remaining > 0 && yardFree > 0) {
      const take = Math.min(remaining, yardFree);
      yardFree -= take;
      yardOwnedLeft = Math.max(0, yardOwnedLeft - take);
      remaining -= take;
      out.push({
        type: 'TRANSFER',
        category,
        equipmentId: mainEquipment([...yardOwned, ...yardRented]),
        qty: r3(take),
        fromWeek,
        toWeek,
        fromLocationId: input.yardLocationId,
        fromProjectId: null,
        idleAfterWeek: null,
        toProjectId: d.p,
        rentalId: null,
      });
    }
    // b. sites holding more than they need from that week on (units on hand now; a moved rental can be extended)
    const donors = [...sites]
      .filter((q) => q !== d.p && !short.has(q))
      .map((q) => {
        const need = perProject.get(q) ?? zero;
        const have = (atSite.get(q) ?? 0) - (movedOut.get(q) ?? 0);
        return { q, need, have, spare: have - Math.max(0, ...need.slice(first)) };
      })
      .filter((x) => x.spare > 0)
      .sort((a, b) => b.spare - a.spare || a.q.localeCompare(b.q));
    for (const donor of donors) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, donor.spare);
      remaining -= take;
      movedOut.set(donor.q, (movedOut.get(donor.q) ?? 0) + take);
      let idleAfter: string | null = null;
      for (let i = first - 1; i >= 0; i--) {
        if (donor.need[i]! > donor.have - take) {
          idleAfter = weeks[i]!;
          break;
        }
      }
      const rows = siteRows(donor.q);
      out.push({
        type: 'TRANSFER',
        category,
        equipmentId: mainEquipment(rows),
        qty: r3(take),
        fromWeek,
        toWeek,
        fromLocationId: rows[0]?.locationId ?? null,
        fromProjectId: donor.q,
        idleAfterWeek: idleAfter,
        toProjectId: d.p,
        rentalId: null,
      });
    }
    // c. rent the rest
    if (remaining > 0) {
      out.push({
        type: 'RENT',
        category,
        equipmentId: input.rentEquipment[category] ?? mainEquipment(supply),
        qty: r3(remaining),
        fromWeek,
        toWeek,
        fromLocationId: null,
        fromProjectId: null,
        idleAfterWeek: null,
        toProjectId: d.p,
        rentalId: null,
      });
    }
  }

  // Rented units nobody needs: at sites (above the highest remaining need; never at a site that is short), then at the yard
  for (const q of [...sites].filter((p) => !short.has(p)).sort()) {
    const need = perProject.get(q) ?? zero;
    const have = (atSite.get(q) ?? 0) - (movedOut.get(q) ?? 0);
    let excess = have - Math.max(0, ...need);
    const rentals = siteRows(q)
      .filter((s) => s.rentalId)
      .sort((a, b) => (b.rentalId! > a.rentalId! ? 1 : -1));
    const lastUse = need.reduce((acc, n, i) => (n > 0 ? i : acc), -1);
    const fromWeek = weeks[Math.min(lastUse + 1, weeks.length - 1)]!;
    for (const r of rentals) {
      if (excess <= 0) break;
      const qty = Math.min(excess, r.qty);
      excess -= qty;
      out.push({ type: 'RETURN_RENTAL', category, equipmentId: r.equipmentId, qty: r3(qty), fromWeek, toWeek: fromWeek, fromLocationId: r.locationId, fromProjectId: q, idleAfterWeek: lastUse >= 0 ? weeks[lastUse]! : null, toProjectId: null, rentalId: r.rentalId });
    }
  }
  let yardRentedLeft = Math.max(0, yardFree - yardOwnedLeft);
  for (const r of yardRented) {
    if (yardRentedLeft <= 0) break;
    const qty = Math.min(yardRentedLeft, r.qty);
    yardRentedLeft -= qty;
    out.push({ type: 'RETURN_RENTAL', category, equipmentId: r.equipmentId, qty: r3(qty), fromWeek: weeks[0]!, toWeek: weeks[0]!, fromLocationId: r.locationId, fromProjectId: null, idleAfterWeek: null, toProjectId: null, rentalId: r.rentalId });
  }
  return mergeSuggestions(out);
}

/** Same type / route / rental / item → one suggestion (qty added). */
function mergeSuggestions(list: Suggestion[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of list) {
    const same = out.find(
      (o) => o.type === s.type && o.category === s.category && o.equipmentId === s.equipmentId && o.fromLocationId === s.fromLocationId && o.toProjectId === s.toProjectId && o.rentalId === s.rentalId && o.fromWeek === s.fromWeek,
    );
    if (same) same.qty = r3(same.qty + s.qty);
    else out.push({ ...s });
  }
  return out;
}
