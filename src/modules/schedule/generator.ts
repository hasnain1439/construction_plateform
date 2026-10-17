/**
 * Schedule generator — pure, no database: APPROVED estimate lines (quantities per build stage) +
 * rulebook productivity / curing → stages and milestones with effort (team-days), dependencies
 * (curing = FS lag) and material quotas. Dates are made by the scheduler (scheduler.ts).
 *
 * Effort per milestone (÷ teams, rounded up, at least 1 day), net quantities (before wastage):
 *   EXCAVATION   excavation cft ÷ productivityExcavationCftPerDay
 *   FOUNDATION   bricks ÷ productivityBricksPerDay + steel kg ÷ productivitySteelKgPerDay + concrete cft ÷ productivityConcreteCftPerDay
 *   PLINTH_FILL  plinth filling cft ÷ productivityExcavationCftPerDay
 *   WALLS        bricks ÷ productivityBricksPerDay (blocks ÷ productivityBlocksPerDay)
 *   SLAB         shuttering sq ft ÷ productivityShutteringSqftPerDay + steel ÷ … + concrete ÷ … (casting ≥ 1 day)
 *   MUMTY        walls + slab as above; WATERPROOFING roof sq ft ÷ (2 × plaster output) + roof filling cft ÷ excavation output
 *   MEP          covered sq ft ÷ MEP_SQFT_PER_DAY (schedule default, 300)
 *   PLASTER      plaster sq ft ÷ productivityPlasterSqftPerDay
 *   TILES        floor + wall tiles sq ft ÷ productivityTileSqftPerDay
 *   PAINT        painted sq ft (gallons × coverage ÷ coats) ÷ productivityPaintSqftPerDay
 * Concrete cft = crush ÷ (concreteDryFactor × 2n / (1 + 3n)), n = rccMix (1 : n : 2n).
 * Stages without quantities use DEFAULT_EFFORT (flagged in `basis`).
 */
import { toBaseUnit } from '../estimate/engine.js';
import { isTemplateKey, MILESTONE_NAMES } from './milestoneNames.js';

export const STAGE_KEYS = ['FOUNDATION_PLINTH', 'GF_STRUCTURE', 'F1_STRUCTURE', 'F2_STRUCTURE', 'F3_STRUCTURE', 'MUMTY_ROOF', 'PLASTER_MEP', 'FINISHING'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_NAMES: Record<StageKey, string> = {
  FOUNDATION_PLINTH: 'Foundation & plinth',
  GF_STRUCTURE: 'Ground floor structure',
  F1_STRUCTURE: 'First floor structure',
  F2_STRUCTURE: 'Second floor structure',
  F3_STRUCTURE: 'Third floor structure',
  MUMTY_ROOF: 'Mumty & roof',
  PLASTER_MEP: 'Plaster & MEP rough-in',
  FINISHING: 'Finishing',
};

const FLOOR_NAMES: Partial<Record<StageKey, string>> = { GF_STRUCTURE: 'Ground floor', F1_STRUCTURE: 'First floor', F2_STRUCTURE: 'Second floor', F3_STRUCTURE: 'Third floor' };
const STRUCTURE_STAGES: StageKey[] = ['GF_STRUCTURE', 'F1_STRUCTURE', 'F2_STRUCTURE', 'F3_STRUCTURE'];

/** Schedule defaults that are not (yet) rulebook values. */
export const MEP_SQFT_PER_DAY = 300;
export const MEP_TO_PLASTER_LAG_DAYS = 7;
export const DEFAULT_EFFORT: Record<string, number> = { EXCAVATION: 4, FOUNDATION: 14, PLINTH_FILL: 5, MEP: 12, PLASTER: 30, TILES: 15, PAINT: 12, WATERPROOFING: 3 };

/** Rulebook keys the generator reads (with the v1 defaults when missing). */
export const SCHEDULE_PARAM_DEFAULTS: Record<string, number> = {
  productivityExcavationCftPerDay: 500,
  productivityBricksPerDay: 1500,
  productivityBlocksPerDay: 400,
  productivityConcreteCftPerDay: 400,
  productivityShutteringSqftPerDay: 300,
  productivitySteelKgPerDay: 400,
  productivityPlasterSqftPerDay: 250,
  productivityTileSqftPerDay: 120,
  productivityPaintSqftPerDay: 600,
  curingDaysSlab: 14,
  curingDaysColumns: 7,
  curingDaysPlaster: 7,
  concreteDryFactor: 1.54,
  rccMix: 2,
  slabThicknessIn: 5,
  paintCoats: 2,
  paintCoverageSqftPerGallon: 350,
};

export interface GenLine {
  lineKey: string;
  section: string;
  stageKey: string | null;
  kind: string;
  material: string | null;
  materialId: string | null;
  description: string;
  unit: string;
  /** Net quantity (before wastage) — drives the effort. */
  quantity: number;
  /** override ?? with wastage — drives the quota. */
  effectiveQuantity: number;
  suppliedBy: 'CONTRACTOR' | 'OWNER';
}

export interface GenMaterial {
  id: string;
  name: string;
  unit: string;
  altUnits: Array<{ unit: string; factor: number }>;
}

export interface GenInput {
  lines: GenLine[];
  params: Record<string, number>;
  teams: number;
  /** Company materials by id (quota units). */
  materials: Map<string, GenMaterial>;
  coveredAreaSqft: number;
}

export interface GenQuota {
  materialId: string | null;
  material: string;
  description: string;
  unit: string;
  plannedQty: number;
  ownerSupplied: boolean;
}

export interface GenMilestone {
  key: string;
  stageKey: StageKey;
  name: string;
  sortOrder: number;
  workDays: number;
  curingDays: number;
  basis: string[];
  deps: Array<{ key: string; type: 'FS' | 'SS'; lagDays: number }>;
  quotas: GenQuota[];
}

export interface GenResult {
  stages: Array<{ stageKey: StageKey; name: string; sortOrder: number }>;
  milestones: GenMilestone[];
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isSteel = (m: string | null) => m !== null && /^steel(\d+)?$/.test(m);

/** Section → milestone (suffix) per stage, for quotas. */
function quotaTarget(stageKey: StageKey, section: string, present: Set<string>): string {
  const pick = (...suffixes: string[]) => suffixes.map((s) => `${stageKey}.${s}`).find((k) => present.has(k));
  let key: string | undefined;
  if (stageKey === 'FOUNDATION_PLINTH') key = section === 'EXCAVATION_EARTHWORK' ? pick('PLINTH_FILL', 'FOUNDATION') : pick('FOUNDATION');
  else if (STRUCTURE_STAGES.includes(stageKey)) key = section === 'MASONRY' ? pick('WALLS', 'SLAB') : pick('SLAB', 'WALLS');
  else if (stageKey === 'MUMTY_ROOF') key = section === 'ROOF_WATERPROOFING' ? pick('WATERPROOFING', 'STRUCTURE') : pick('STRUCTURE', 'WATERPROOFING');
  else if (stageKey === 'PLASTER_MEP') key = section === 'MEP_ROUGH_IN' ? pick('MEP', 'PLASTER') : pick('PLASTER', 'MEP');
  else if (stageKey === 'FINISHING') key = section === 'PAINT' ? pick('PAINT', 'TILES') : pick('TILES', 'PAINT');
  return key ?? [...present].filter((k) => k.startsWith(`${stageKey}.`)).at(-1)!;
}

export function generate(input: GenInput): GenResult {
  const P = (k: string) => input.params[k] ?? SCHEDULE_PARAM_DEFAULTS[k]!;
  const teams = Math.max(1, Math.min(6, Math.round(input.teams || 1)));
  const at = (stageKey: StageKey) => input.lines.filter((l) => l.stageKey === stageKey);
  const sumOf = (ls: GenLine[], pred: (l: GenLine) => boolean) => ls.filter(pred).reduce((a, l) => a + l.quantity, 0);
  const hasQty = (stageKey: StageKey) => at(stageKey).some((l) => l.kind !== 'PERCENT' && l.section !== 'EQUIPMENT_SHUTTERING' && l.quantity > 0);

  const effortOf = (parts: Array<{ qty: number; per: number; what: string; unit: string; min?: number }>, fallback: number | null, basis: string[]) => {
    let total = 0;
    for (const p of parts) {
      if (!(p.qty > 0) || !(p.per > 0)) continue;
      const days = Math.max(p.min ?? 0, p.qty / p.per);
      total += days;
      basis.push(`${p.what}: ${fmt(p.qty)} ${p.unit} ÷ ${fmt(p.per)} ${p.unit} per team-day = ${fmt(days)} days`);
    }
    if (total <= 0) {
      if (fallback === null) return 0;
      basis.push(`No quantities in the estimate — default ${fallback} team-days (pending engineer review)`);
      return fallback;
    }
    const days = Math.max(1, Math.ceil(total / teams - 1e-9));
    basis.push(teams > 1 ? `${fmt(total)} team-days ÷ ${teams} teams → ${days} days` : `→ ${days} days`);
    return days;
  };

  const concreteCft = (ls: GenLine[], basis?: string[]) => {
    const n = P('rccMix');
    const dry = P('concreteDryFactor');
    const crush = sumOf(ls, (l) => l.kind === 'MATERIAL' && l.section === 'CONCRETE' && l.material === 'crush');
    if (crush > 0) {
      const cft = crush / (dry * ((2 * n) / (1 + 3 * n)));
      basis?.push(`Concrete ≈ crush ${fmt(crush)} cft ÷ (${dry} dry × ${fmt((2 * n) / (1 + 3 * n))}) = ${fmt(cft)} cft`);
      return cft;
    }
    const cement = sumOf(ls, (l) => l.kind === 'MATERIAL' && l.section === 'CONCRETE' && l.material === 'cement');
    if (cement > 0) {
      const cft = (cement * 1.25 * (1 + 3 * n)) / dry;
      basis?.push(`Concrete ≈ cement ${fmt(cement)} bags × 1.25 cft × ${1 + 3 * n} ÷ ${dry} dry = ${fmt(cft)} cft`);
      return cft;
    }
    return 0;
  };
  const steelKg = (ls: GenLine[]) => sumOf(ls, (l) => l.kind === 'MATERIAL' && isSteel(l.material) && l.unit === 'kg');
  const bricks = (ls: GenLine[]) => sumOf(ls, (l) => l.kind === 'MATERIAL' && l.material === 'bricks');
  const blocks = (ls: GenLine[]) => sumOf(ls, (l) => l.kind === 'MATERIAL' && l.material === 'blocks');
  const labour = (ls: GenLine[], item: string) => sumOf(ls, (l) => l.kind === 'LABOUR' && l.material === item);
  const lump = (ls: GenLine[], key: string) => sumOf(ls, (l) => l.kind === 'LUMP_SUM' && l.lineKey.endsWith(`.${key}`));

  const stages: GenResult['stages'] = [];
  const milestones: GenMilestone[] = [];
  const add = (stageKey: StageKey, suffix: string, name: string, workDays: number, curingDays: number, basis: string[], deps: GenMilestone['deps']) => {
    if (!stages.some((s) => s.stageKey === stageKey)) stages.push({ stageKey, name: STAGE_NAMES[stageKey], sortOrder: STAGE_KEYS.indexOf(stageKey) + 1 });
    const key = `${stageKey}.${suffix}`;
    // QA-B-26: the generated name is the template's English name (milestoneNames.ts), so apps can translate by key.
    const m: GenMilestone = { key, stageKey, name: isTemplateKey(key) ? MILESTONE_NAMES[key] : name, sortOrder: milestones.length + 1, workDays, curingDays, basis, deps, quotas: [] };
    milestones.push(m);
    return m;
  };
  const after = (m: GenMilestone | null, lag = m?.curingDays ?? 0): GenMilestone['deps'] => (m ? [{ key: m.key, type: 'FS', lagDays: lag }] : []);

  const slabParts = (ls: GenLine[], basis: string[]) => {
    const conc = concreteCft(ls, basis);
    const shutter = labour(ls, 'SHUTTERING') || (conc > 0 ? (conc * 12) / P('slabThicknessIn') : 0);
    return [
      { qty: shutter, per: P('productivityShutteringSqftPerDay'), what: 'Shuttering', unit: 'sq ft' },
      { qty: steelKg(ls), per: P('productivitySteelKgPerDay'), what: 'Steel fixing', unit: 'kg' },
      { qty: conc, per: P('productivityConcreteCftPerDay'), what: 'Concrete casting', unit: 'cft', min: 1 },
    ];
  };
  const brickParts = (ls: GenLine[]) => [
    { qty: bricks(ls), per: P('productivityBricksPerDay'), what: 'Brickwork', unit: 'bricks' },
    { qty: blocks(ls), per: P('productivityBlocksPerDay'), what: 'Blockwork', unit: 'blocks' },
  ];

  // 1. Foundation & plinth (always)
  const fl = at('FOUNDATION_PLINTH');
  const foundationQty = hasQty('FOUNDATION_PLINTH');
  let prev: GenMilestone | null = null;
  {
    const b1: string[] = [];
    const exc = effortOf([{ qty: lump(fl, 'excavation'), per: P('productivityExcavationCftPerDay'), what: 'Excavation', unit: 'cft' }], foundationQty ? null : DEFAULT_EFFORT['EXCAVATION']!, b1);
    const excavation = exc > 0 ? add('FOUNDATION_PLINTH', 'EXCAVATION', 'Excavation (khudai)', exc, 0, b1, []) : null;
    const b2: string[] = [];
    const fEff = effortOf(
      [...brickParts(fl), { qty: steelKg(fl), per: P('productivitySteelKgPerDay'), what: 'Steel fixing', unit: 'kg' }, { qty: concreteCft(fl, b2), per: P('productivityConcreteCftPerDay'), what: 'Concrete', unit: 'cft', min: 1 }],
      DEFAULT_EFFORT['FOUNDATION']!,
      b2,
    );
    const foundation = add('FOUNDATION_PLINTH', 'FOUNDATION', 'Foundation & DPC', fEff, P('curingDaysColumns'), b2, after(excavation, 0));
    const b3: string[] = [];
    const pEff = effortOf([{ qty: lump(fl, 'plinthFilling'), per: P('productivityExcavationCftPerDay'), what: 'Plinth filling', unit: 'cft' }], foundationQty ? null : DEFAULT_EFFORT['PLINTH_FILL']!, b3);
    prev = pEff > 0 ? add('FOUNDATION_PLINTH', 'PLINTH_FILL', 'Plinth filling (bharai)', pEff, 0, b3, after(foundation)) : foundation;
  }
  let lastCuring = prev.key === 'FOUNDATION_PLINTH.FOUNDATION' ? prev.curingDays : 0;

  // 2. Structure floors
  for (const st of STRUCTURE_STAGES) {
    if (!hasQty(st)) continue;
    const ls = at(st);
    const floor = FLOOR_NAMES[st]!;
    const bw: string[] = [];
    const wEff = effortOf(brickParts(ls), null, bw);
    const walls: GenMilestone | null = wEff > 0 ? add(st, 'WALLS', `${floor} — columns & brickwork`, wEff, P('curingDaysColumns'), bw, after(prev, lastCuring)) : null;
    const bs: string[] = [];
    const sEff = effortOf(slabParts(ls, bs), null, bs);
    const slab: GenMilestone | null = sEff > 0 ? add(st, 'SLAB', `${floor} — roof slab (lenter)`, sEff, P('curingDaysSlab'), bs, walls ? after(walls) : after(prev, lastCuring)) : null;
    const lastOf: GenMilestone | null = slab ?? walls;
    if (lastOf) {
      prev = lastOf;
      lastCuring = lastOf.curingDays;
    }
  }

  // 3. Mumty & roof
  let roof: GenMilestone | null = null;
  if (hasQty('MUMTY_ROOF')) {
    const ls = at('MUMTY_ROOF');
    const b: string[] = [];
    const eff = effortOf([...brickParts(ls), ...slabParts(ls, b)], null, b);
    const structure = eff > 0 ? add('MUMTY_ROOF', 'STRUCTURE', 'Mumty walls & roof slab', eff, P('curingDaysSlab'), b, after(prev, lastCuring)) : null;
    if (structure) {
      prev = structure;
      lastCuring = structure.curingDays;
    }
    const bw: string[] = [];
    const roofArea = labour(ls, 'WATERPROOFING') || lump(ls, 'roofWaterproofing');
    const wEff = effortOf(
      [
        { qty: roofArea, per: 2 * P('productivityPlasterSqftPerDay'), what: 'Roof waterproofing', unit: 'sq ft' },
        { qty: lump(ls, 'roofEarthFill'), per: P('productivityExcavationCftPerDay'), what: 'Roof earth filling', unit: 'cft' },
      ],
      DEFAULT_EFFORT['WATERPROOFING']!,
      bw,
    );
    roof = add('MUMTY_ROOF', 'WATERPROOFING', 'Roof waterproofing & filling', wEff, 0, bw, after(prev, lastCuring));
  }

  // 4. Plaster & MEP (always)
  const pl = at('PLASTER_MEP');
  const bm: string[] = [];
  const covered = lump(pl, 'electrical') || input.coveredAreaSqft;
  const mepEff = effortOf([{ qty: covered, per: MEP_SQFT_PER_DAY, what: 'MEP rough-in (covered area)', unit: 'sq ft' }], DEFAULT_EFFORT['MEP']!, bm);
  const mep = add('PLASTER_MEP', 'MEP', 'Electrical & plumbing rough-in', mepEff, 0, bm, after(prev, lastCuring));
  const bp: string[] = [];
  const plasterSqft = labour(pl, 'PLASTER');
  const plEff = effortOf([{ qty: plasterSqft, per: P('productivityPlasterSqftPerDay'), what: 'Plaster', unit: 'sq ft' }], DEFAULT_EFFORT['PLASTER']!, bp);
  const plaster = add('PLASTER_MEP', 'PLASTER', 'Plaster (inside & outside)', plEff, P('curingDaysPlaster'), bp, [{ key: mep.key, type: 'SS', lagDays: MEP_TO_PLASTER_LAG_DAYS }]);

  // 5. Finishing (always)
  const fin = at('FINISHING');
  const bt: string[] = [];
  const tiles = sumOf(fin, (l) => l.kind === 'MATERIAL' && (l.material === 'floorTiles' || l.material === 'wallTiles')) || labour(fin, 'TILE_LAYING');
  const tEff = effortOf([{ qty: tiles, per: P('productivityTileSqftPerDay'), what: 'Floor + wall tiles', unit: 'sq ft' }], DEFAULT_EFFORT['TILES']!, bt);
  const tileM = add('FINISHING', 'TILES', 'Flooring & wall tiles', tEff, 0, bt, after(plaster));
  const bpt: string[] = [];
  const gallons = sumOf(fin, (l) => l.kind === 'MATERIAL' && l.material === 'paint');
  const painted = gallons > 0 ? (gallons * P('paintCoverageSqftPerGallon')) / Math.max(1, P('paintCoats')) : labour(fin, 'PAINT');
  if (gallons > 0) bpt.push(`Painted area ≈ ${fmt(gallons)} gallons × ${P('paintCoverageSqftPerGallon')} sq ft ÷ ${P('paintCoats')} coats = ${fmt(painted)} sq ft`);
  const pEff = effortOf([{ qty: painted, per: P('productivityPaintSqftPerDay'), what: 'Paint (all coats)', unit: 'sq ft' }], DEFAULT_EFFORT['PAINT']!, bpt);
  add('FINISHING', 'PAINT', 'Paint', pEff, 0, bpt, [...after(tileM, 0), ...(roof ? after(roof, 0) : [])]);

  // Quotas: MATERIAL lines of each stage → the milestone of their section, in the material's own unit.
  const present = new Set(milestones.map((m) => m.key));
  const byKey = new Map(milestones.map((m) => [m.key, m]));
  for (const l of input.lines) {
    if (l.kind !== 'MATERIAL' || !l.stageKey || !(STAGE_KEYS as readonly string[]).includes(l.stageKey) || !(l.effectiveQuantity > 0)) continue;
    const stageKey = l.stageKey as StageKey;
    if (!milestones.some((m) => m.stageKey === stageKey)) continue;
    const m = byKey.get(quotaTarget(stageKey, l.section, present))!;
    const mat = l.materialId ? input.materials.get(l.materialId) : undefined;
    const converted = mat ? toBaseUnit(l.effectiveQuantity, l.unit, mat.unit, mat.altUnits) : null;
    const unit = converted !== null && mat ? mat.unit : l.unit;
    const qty = converted ?? l.effectiveQuantity;
    const ownerSupplied = l.suppliedBy === 'OWNER';
    const existing = m.quotas.find((q) => (q.materialId ?? q.material) === (l.materialId ?? l.material) && q.ownerSupplied === ownerSupplied && q.unit === unit);
    if (existing) existing.plannedQty = r3(existing.plannedQty + qty);
    else m.quotas.push({ materialId: l.materialId, material: l.material ?? 'other', description: mat?.name ?? l.description, unit, plannedQty: r3(qty), ownerSupplied });
  }
  return { stages: stages.sort((a, b) => a.sortOrder - b.sortOrder), milestones };
}

/** Billing stage label → schedule stage it belongs to (auto-link on generate). */
export function stageOfBillingLabel(label: string): StageKey | null {
  const l = label.toLowerCase();
  if (/retention|agreement|mobili[sz]ation|advance/.test(l)) return null;
  if (/foundation|plinth|bunyaad/.test(l)) return 'FOUNDATION_PLINTH';
  if (/ground/.test(l)) return 'GF_STRUCTURE';
  if (/first/.test(l)) return 'F1_STRUCTURE';
  if (/second/.test(l)) return 'F2_STRUCTURE';
  if (/third/.test(l)) return 'F3_STRUCTURE';
  if (/mumty|roof/.test(l)) return 'MUMTY_ROOF';
  if (/plaster|mep|rough/.test(l)) return 'PLASTER_MEP';
  if (/tile|flooring|finish|paint|handover/.test(l)) return 'FINISHING';
  return null;
}
