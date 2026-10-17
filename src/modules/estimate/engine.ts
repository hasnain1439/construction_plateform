/**
 * Estimate (BoQ) engine — GREY STRUCTURE only: foundation, walls (brickwork), RCC, plaster.
 *
 * Pure: plain inputs in, quantities out — no database, no clock. `priceEstimate()` (below) adds
 * the money from a price book the service loads. Every number and rule is listed in README →
 * "How the estimate is calculated"; every line carries its formula (key + params + English text)
 * so the owner can check it.
 *
 * Units: feet / sq ft / cft, inches only in settings. Concrete & mortar are worked out by the
 * dry-volume method: dry = wet × factor (1.54 concrete, 1.33 mortar), split by the mix ratio,
 * cement cft ÷ 1.25 cft per 50 kg bag. Steel = concrete volume × % × 222 kg / cft (7,850 kg/m³).
 *
 * Wall-length approximation (rooms are clear inside sizes):
 *   Σ room perimeters P counts every internal wall twice (once from each side) and every external
 *   wall once, so P = E + 2·I  →  I = (P − E) / 2.
 *   E (external run) = perimeter of the floor footprint, taken as a rectangle with the plot's
 *   front : depth ratio: E = 2 × (√(F / r) + √(F × r)), r = depth / front (square when unknown),
 *   capped at P. Footprint F = the covered area shared over the floors by room area (rooms area
 *   × 1.15 when the covered area is not entered).
 *
 * DETAILED vs ESTIMATED: a floor whose rooms ALL have their four walls entered gets its walls,
 * plaster and lintels from the actual sides (detailed.ts); a floor with roof data gets its slab /
 * roof, beams and columns from the actual bars and sizes. Everything else uses the % / perimeter
 * method above. Every line says which one it used (`method`).
 */
import { BAR_MM, largestSpan, roofWarnings, type BarNo, type Roof, type RoofWarningCode } from '../projects/roof.js';
import type { Wall, WallSide } from '../projects/walls.js';
import {
  beamBars,
  chajjaBars,
  CHAJJA_THICKNESS_IN,
  columnBars,
  defaultColumnCount,
  detailedWalls,
  girders,
  groupBars,
  INFILL_MORTAR_IN,
  INFILL_MORTAR_MIX,
  INFILL_PER_SQFT,
  kgPerFt,
  lintelBars,
  meshBars,
  slabPanelBars,
  type BarRun,
  type WallsDetail,
} from './detailed.js';
import { ESTIMATE_DEFAULTS, mixParts, type EstimateSettings } from './settings.js';

// ─── Inputs ─────────────────────────────────────────────────────────────────

export type StructureKind = 'FRAMED' | 'LOAD_BEARING';
export type FloorLevelKey = 'BASEMENT' | 'GROUND' | 'FIRST' | 'SECOND' | 'THIRD' | 'MUMTY';
export type OpeningKind = 'DOOR' | 'WINDOW' | 'VENTILATOR';

export interface EstimateOpening {
  type: OpeningKind;
  widthFt: number;
  heightFt: number;
  quantity: number;
  /** Wall side the opening is in (null / missing = not placed). */
  side?: WallSide | null;
}

export interface EstimateRoom {
  id?: string;
  name?: string;
  /** Room type (KITCHEN, ATTACHED_BATH …) — the BoQ uses it for wall tiles. */
  type?: string | null;
  /** Four sides (null / missing = not entered). */
  walls?: Wall[] | null;
  lengthFt: number;
  widthFt: number;
  heightFt: number;
  isWet: boolean;
  openings: EstimateOpening[];
}

export interface EstimateFloor {
  level: FloorLevelKey;
  name: string;
  ceilingHeightFt: number;
  rooms: EstimateRoom[];
  /** Roof / slab over this floor (null / missing = not entered → % method). */
  roof?: Roof | null;
}

/** The subset of the project foundation (projects/foundation.ts) the engine reads. */
export interface EstimateFoundation {
  type: 'STRIP' | 'ISOLATED' | 'COMBINED' | 'RAFT' | 'PILE';
  excavationDepthFt: number;
  footingWidthFt: number | null;
  footingThicknessIn: number;
  plinthHeightFt: number;
  dpcThicknessIn: number;
  footingCount: number | null;
  footingLengthFt: number | null;
  pileCount: number | null;
  pileDiameterIn: number | null;
  pileDepthFt: number | null;
  masonry: 'BRICK' | 'STONE' | 'RCC_ONLY';
  pccMix: string;
  pccThicknessIn: number;
  rccMix: string | null;
  termiteTreatment: boolean;
  dpcMaterial: 'BITUMEN' | 'PCC_WATERPROOF';
}

export interface EstimateInput {
  plotAreaSqft: number | null;
  frontFt: number | null;
  depthFt: number | null;
  structureType: StructureKind | null;
  /** Total covered area of all floors (tab 4). */
  coveredAreaSqft: number | null;
  /** In wizard order (basement first). */
  floors: EstimateFloor[];
  foundation: EstimateFoundation | null;
}

// ─── Outputs ────────────────────────────────────────────────────────────────

export const STAGES = ['FOUNDATION', 'WALLS', 'RCC', 'PLASTER'] as const;
export type StageKey = (typeof STAGES)[number];

export const MATERIALS = [
  'cement',
  'bricks',
  'sand',
  'crush',
  'steel',
  'steel10',
  'steel12',
  'steel16',
  'steel20',
  'tIron',
  'roofTile',
  'precastPlank',
  'steelDeck',
  'waterproofing',
  'bitumen',
  'termite',
  'stone',
  'blocks',
] as const;
export type MaterialKey = (typeof MATERIALS)[number];
/** The unit every quantity of a material is given in. */
export const MATERIAL_UNITS: Record<MaterialKey, string> = {
  cement: 'bag',
  bricks: 'nos',
  blocks: 'nos',
  sand: 'cft',
  crush: 'cft',
  steel: 'kg',
  steel10: 'kg',
  steel12: 'kg',
  steel16: 'kg',
  steel20: 'kg',
  tIron: 'kg',
  roofTile: 'nos',
  precastPlank: 'sqft',
  steelDeck: 'sqft',
  waterproofing: 'kg',
  bitumen: 'kg',
  termite: 'litre',
  stone: 'cft',
};

export type ElementKey =
  | 'excavation'
  | 'pcc'
  | 'footing'
  | 'foundationMasonry'
  | 'dpc'
  | 'termite'
  | 'walls'
  | 'parapet'
  | 'slab'
  | 'chajja'
  | 'girders'
  | 'roofInfill'
  | 'screed'
  | 'earthFill'
  | 'planks'
  | 'deck'
  | 'topping'
  | 'frame'
  | 'beams'
  | 'columns'
  | 'lintels'
  | 'plasterInternal'
  | 'plasterCeiling'
  | 'plasterExternal'
  | 'plasterParapet';

/** WORK lines measure the work (volume / area / shuttering); MATERIAL lines are what to buy. */
export type Measure = 'VOLUME' | 'AREA' | 'SHUTTERING';

export interface Formula {
  key: string;
  params: Record<string, number | string>;
}

/** DETAILED = from the walls / roof the user entered; ESTIMATED = the % / perimeter rules of thumb. */
export type LineMethod = 'DETAILED' | 'ESTIMATED';

/** Steel bars by size: #3 → steel10 … #6 → steel20. */
export const steelKey = (bar: BarNo): MaterialKey => `steel${BAR_MM[bar]}` as MaterialKey;
export const STEEL_SIZE_KEYS: MaterialKey[] = ['steel10', 'steel12', 'steel16', 'steel20'];
export const isBarSteel = (m: MaterialKey | null) => m === 'steel' || (m !== null && STEEL_SIZE_KEYS.includes(m));

export interface EstimateLine {
  id: string;
  stage: StageKey;
  floor: { level: FloorLevelKey; name: string } | null;
  element: ElementKey;
  kind: 'WORK' | 'MATERIAL';
  measure: Measure | null;
  material: MaterialKey | null;
  /** Without wastage. */
  netQuantity: number;
  wastagePercent: number;
  /** With wastage — what to order. */
  quantity: number;
  unit: string;
  formula: Formula;
  formulaText: string;
  method: LineMethod;
}

export interface FloorBasis {
  level: FloorLevelKey;
  name: string;
  heightFt: number;
  rooms: number;
  roomAreaSqft: number;
  footprintSqft: number;
  roomPerimeterFt: number;
  externalWallFt: number;
  internalWallFt: number;
  doorsSqft: number;
  windowsSqft: number;
  /** DETAILED when every room has its walls entered. */
  wallsMethod: LineMethod;
  /** DETAILED when the floor has roof data. */
  roofMethod: LineMethod;
  /** Detailed walls only (else null). */
  walls: {
    partyWallFt: number;
    partyExistingFt: number;
    openFt: number;
    builtRunFt: number;
    byThickness: Array<{ thicknessIn: number; lengthFt: number; areaSqft: number; volumeCft: number; bricks: number }>;
  } | null;
  /** Roof summary (null without roof data). */
  roof: {
    type: Roof['type'];
    thicknessIn: number | null;
    largestSpanFt: number | null;
    steelBySize: Array<{ bar: number; mm: number; kg: number }>;
    bars: Array<{ use: string; bar: number; mm: number; count: number; lengthFt: number; label: string }>;
    beamRunFt: number | null;
    columnCount: number | null;
    columnCountAuto: boolean;
  } | null;
}

export type WarningCode =
  | 'NO_FLOORS'
  | 'NO_ROOMS'
  | 'FOUNDATION_MISSING'
  | 'STRUCTURE_TYPE_ASSUMED'
  | 'COVERED_AREA_ESTIMATED'
  | 'FOUNDATION_LENGTH_UNKNOWN'
  | 'ROOMS_BELOW_COVERED'
  | 'WALLS_PARTIAL'
  | 'WALLS_UNPAIRED'
  | RoofWarningCode;

export interface EngineWarning {
  code: WarningCode;
  message: string;
  /** Wizard tab to fix it in. */
  tab?: 3 | 4 | 5;
  params?: Record<string, number>;
  /** The floor it is about. */
  floor?: { level: FloorLevelKey; name: string };
}

export interface EstimateQuantities {
  basis: {
    structureType: StructureKind;
    structureTypeAssumed: boolean;
    coveredAreaSqft: number;
    coveredAreaSource: 'PROJECT' | 'ROOMS' | 'NONE';
    plotAreaSqft: number | null;
    aspectRatio: number;
    foundationWallLengthFt: number;
    foundationWallLengthAuto: boolean;
    /** Where the foundation wall run came from: the user's setting, the detailed ground-floor walls, or the perimeter method. */
    foundationWallLengthSource: 'SETTING' | 'WALLS' | 'ESTIMATED' | 'PLOT';
    /** Summary of the methods used: DETAILED everywhere, ESTIMATED everywhere, or MIXED. */
    methods: { walls: LineMethod | 'MIXED'; roof: LineMethod | 'MIXED' };
    floors: FloorBasis[];
  };
  lines: EstimateLine[];
  /** Per stage: material → quantity with wastage. */
  stageTotals: Record<StageKey, Partial<Record<MaterialKey, number>>>;
  /** Grand total per material (with wastage), in MATERIAL order. */
  totals: Array<{ material: MaterialKey; unit: string; netQuantity: number; quantity: number }>;
  /** Work quantities the labour estimate needs (net). */
  work: { bricks: number; plasterSqft: number; shutteringSqft: number; steelKg: number };
  warnings: EngineWarning[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** 7,850 kg/m³ ÷ 35.315 cft/m³ ≈ 222 kg per cft of steel. */
export const STEEL_KG_PER_CFT = 222;
/** Rooms are clear inside areas; without a covered area the footprint is rooms × 1.15 (walls, passages). */
export const FOOTPRINT_ALLOWANCE = 1.15;
/** Rooms adding up to less than this share of the covered area → walls / plaster are probably under-counted. */
export const ROOMS_COVERAGE_WARN_RATIO = 0.7;
/** Shuttering for beams + columns: sq ft per cft of frame concrete (9″×18″ beam ≈ 3.3, 9″×12″ column ≈ 4.7). */
export const FRAME_SHUTTERING_SQFT_PER_CFT = 4;
/** Brick / stone strip footing: the PCC projects 3″ on each side of the bottom brick course. */
export const PCC_PROJECTION_FT = 0.5;
/** DPC concrete mix (fixed). */
export const DPC_MIX = '1:2:4';
/** Non-strip foundations: wall trench = wall thickness + 6″ working space on each side. */
export const TRENCH_EXTRA_FT = 1;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const inFt = (inches: number) => inches / 12;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ─── Formula texts (English; the web app has its own translations of the same keys) ──

export const FORMULA_TEXT: Record<string, string> = {
  excavationTrench: 'Trench {length} ft × {width} ft wide × {depth} ft deep',
  excavationTrenchPads: 'Trench {length} ft × {width} ft × {depth} ft + {pads} pads × {padL} ft × {padW} ft × {depth} ft',
  excavationRaft: 'Raft area {area} sq ft × {depth} ft deep',
  pccTrench: 'Trench {length} ft × {width} ft × {thicknessIn}″',
  pccTrenchPads: 'Trench {length} ft × {width} ft × {thicknessIn}″ + {pads} pads × {padL} ft × {padW} ft × {thicknessIn}″',
  pccRaft: 'Raft area {area} sq ft × {thicknessIn}″',
  footingStrip: 'RCC strip {length} ft × {width} ft × {thicknessIn}″',
  footingPads: '{pads} pads × {padL} ft × {padW} ft × {thicknessIn}″',
  footingRaft: 'Raft {area} sq ft × {thicknessIn}″',
  footingPiles: '{piles} piles × π × ({diameterIn}″ ÷ 2)² × {depth} ft',
  masonryStepped: 'Stepped footing {length} ft × avg {avgWidth} ft × {footingIn}″ + wall {length} ft × {wallIn}″ × {height} ft (to plinth)',
  masonryWall: 'Wall {length} ft × {wallIn}″ × {height} ft (footing top to plinth)',
  dpc: '{length} ft × {wallIn}″ × {thicknessIn}″',
  termiteArea: 'Lowest-floor footprint {area} sq ft',
  walls: 'External {ext} ft × {height} ft × {extIn}″ − windows {windows} sq ft; internal {int} ft × {height} ft × {intIn}″ − doors {doors} sq ft',
  parapet: 'External run {length} ft × {height} ft × {wallIn}″',
  slab: 'Footprint {area} sq ft × {thicknessIn}″',
  slabShuttering: 'Slab soffit {area} sq ft',
  frame: '{percent}% of slab concrete {slab} cft',
  frameShuttering: '{volume} cft × {perCft} sq ft per cft',
  lintels: '{count} openings, Σ (width + {bearing} ft) = {length} ft × {widthIn}″ × {depthIn}″',
  lintelShuttering: '{length} ft × (bottom {widthIn}″ + 2 sides × {depthIn}″)',
  plasterInternal: 'Σ room walls 2 × (L + W) × H − openings',
  plasterCeiling: 'Σ room floor areas',
  plasterExternal: 'External run {length} ft × ({height} ft + slab {slabIn}″) − windows {windows} sq ft',
  plasterParapet: 'Both faces 2 × {length} ft × {height} ft',
  concreteCement: '{volume} cft × {dry} dry × {part}/{parts} ÷ {bagCft} cft per bag',
  concreteSand: '{volume} cft × {dry} dry × {part}/{parts}',
  concreteCrush: '{volume} cft × {dry} dry × {part}/{parts}',
  mortarCement: '{volume} cft × {mortar} mortar × {dry} dry × 1/{parts} ÷ {bagCft} cft per bag',
  mortarSand: '{volume} cft × {mortar} mortar × {dry} dry × {part}/{parts}',
  plasterCement: '{area} sq ft × {thicknessIn}″ × {dry} dry × 1/{parts} ÷ {bagCft} cft per bag',
  plasterSand: '{area} sq ft × {thicknessIn}″ × {dry} dry × {part}/{parts}',
  bricks: '{volume} cft × {perCft} bricks per cft',
  blocks: '{volume} cft ÷ {thicknessIn}″ = {area} sq ft of wall × {perSqft} blocks per sq ft',
  stone: '{volume} cft of stone masonry',
  steel: '{volume} cft × {percent}% × 222 kg per cft',
  waterproofing: '{bags} cement bags × {perBag} kg',
  bitumen: '{area} sq ft × {perSqft} kg',
  termite: '{area} sq ft × {perSqft} L',
  // Detailed (walls / roof entered)
  wallsDetailed: '{thicknessIn}″ walls: {length} ft run, net {area} sq ft (openings deducted) × {thicknessIn}″',
  parapetDetailed: 'External + party run {length} ft × {height} ft × {wallIn}″',
  bars: '#{bar} ({mm} mm): {count} bars, {length} ft × {kgPerFt} kg/ft',
  barsExtra: '#{bar} ({mm} mm): {count} bars, {length} ft × {kgPerFt} kg/ft + {extraPercent}% for {extraArea} sq ft outside the rooms',
  slabDetailed: 'Footprint {area} sq ft × {thicknessIn}″ (largest span {spanFt} ft)',
  chajja: 'Sunshade {length} ft × {width} ft × {thicknessIn}″',
  chajjaShuttering: 'Sunshade soffit {length} ft × {width} ft',
  girders: '{count} garders {section}, Σ {length} ft × {kgPerFt} kg/ft',
  girdersExtra: '{count} garders {section}, Σ {length} ft × {kgPerFt} kg/ft + {extraPercent}% for {extraArea} sq ft outside the rooms',
  infillArea: 'Roof {area} sq ft between the garders',
  infillUnits: '{area} sq ft × {perSqft} per sq ft',
  screed: 'Roof {area} sq ft × {thicknessIn}″ screed',
  earthFill: 'Roof {area} sq ft × {thicknessIn}″ earth filling',
  planks: 'Precast planks {area} sq ft',
  deck: 'Deck sheet {area} sq ft',
  topping: 'Topping {area} sq ft × {thicknessIn}″',
  beams: 'Beams {length} ft × {widthIn}″ × ({depthIn}″ − slab {slabIn}″)',
  beamShuttering: 'Beam sides 2 × {length} ft × ({depthIn}″ − slab {slabIn}″)',
  columns: '{count} columns × {widthIn}″ × {depthIn}″ × {height} ft',
  columnShuttering: '{count} columns × 2 × ({widthIn}″ + {depthIn}″) × {height} ft',
  lintelsDetailed: '{count} openings, Σ (width + {bearing} ft) × wall thickness × {depthIn}″ = {volume} cft',
  lintelShutteringDetailed: '{length} ft of lintel × (bottom + 2 sides × {depthIn}″)',
  plasterInternalDetailed: 'Inside faces of every room (shared walls from both rooms) + far face of passage walls − openings',
  plasterExternalDetailed: 'Outer face of external / double walls {length} ft × ({height} ft + slab {slabIn}″) − openings',
  mortarBedding: '{area} sq ft × {thicknessIn}″ bedding mortar × {dry} dry × {part}/{parts}',
};

export function formulaText(f: Formula): string {
  const t = FORMULA_TEXT[f.key] ?? f.key;
  return t.replace(/\{(\w+)\}/g, (_, k: string) => (f.params[k] === undefined ? `{${k}}` : String(f.params[k])));
}

// ─── Line builder ───────────────────────────────────────────────────────────

interface Ctx {
  s: EstimateSettings;
  lines: EstimateLine[];
}

type Where = { stage: StageKey; floor: EstimateLine['floor']; element: ElementKey; method?: LineMethod; variant?: string };

function idOf(w: Where, suffix: string) {
  return [w.stage, w.floor?.level ?? 'ALL', w.element, ...(w.variant ? [w.variant] : []), suffix].join('.');
}

const lineBase = (w: Where) => ({ stage: w.stage, floor: w.floor, element: w.element });

function work(c: Ctx, w: Where, measure: Measure, net: number, unit: string, formula: Formula) {
  c.lines.push({
    id: idOf(w, measure.toLowerCase()),
    ...lineBase(w),
    kind: 'WORK',
    measure,
    material: null,
    netQuantity: r2(net),
    wastagePercent: 0,
    quantity: r2(net),
    unit,
    formula,
    formulaText: formulaText(formula),
    method: w.method ?? 'ESTIMATED',
  });
}

/** Wastage % of a material: bricks / blocks, cement, sand + crush, bar steel each have their own; the rest share `wastagePercent`. */
export function wastageOf(s: EstimateSettings, key: MaterialKey): number {
  if (key === 'bricks' || key === 'blocks') return s.brickWastagePercent;
  if (key === 'cement') return s.cementWastagePercent ?? s.wastagePercent;
  if (key === 'sand' || key === 'crush') return s.sandWastagePercent ?? s.wastagePercent;
  if (isBarSteel(key)) return s.steelWastagePercent ?? s.wastagePercent;
  return s.wastagePercent;
}

function material(c: Ctx, w: Where, key: MaterialKey, net: number, formula: Formula) {
  if (net <= 0) return;
  const wastagePercent = wastageOf(c.s, key);
  c.lines.push({
    id: idOf(w, key),
    ...lineBase(w),
    kind: 'MATERIAL',
    measure: null,
    material: key,
    netQuantity: r2(net),
    wastagePercent,
    quantity: r2(net * (1 + wastagePercent / 100)),
    unit: MATERIAL_UNITS[key],
    formula,
    formulaText: formulaText(formula),
    method: w.method ?? 'ESTIMATED',
  });
}

/**
 * Steel of bar runs, one material line per bar size (steel10 / 12 / 16 / 20). `extra` scales the
 * lengths for the slab area outside the rooms (passages, stairs …) at the rooms' own rate.
 */
function bars(c: Ctx, w: Where, runs: BarRun[], extra?: { factor: number; area: number }) {
  for (const g of groupBars(runs, extra?.factor ?? 1)) {
    const params = { bar: g.bar, mm: g.mm, count: g.count, length: r2(g.lengthFt), kgPerFt: r4(kgPerFt(g.mm)) };
    const formula: Formula = extra && extra.factor > 1 ? { key: 'barsExtra', params: { ...params, extraPercent: r2((extra.factor - 1) * 100), extraArea: r2(extra.area) } } : { key: 'bars', params };
    material(c, w, steelKey(g.bar), g.kg, formula);
  }
}

/** Cement / sand / crush of `volume` cft of concrete in `mix`. */
function concrete(c: Ctx, w: Where, volume: number, mix: string) {
  if (volume <= 0) return;
  const [cem, sand, crush] = mixParts(mix) as [number, number, number];
  const parts = cem + sand + crush;
  const dryVol = volume * c.s.concreteDryFactor;
  const base = { volume: r2(volume), dry: c.s.concreteDryFactor, parts };
  material(c, w, 'cement', (dryVol * cem) / parts / c.s.cementBagCft, { key: 'concreteCement', params: { ...base, part: cem, bagCft: c.s.cementBagCft } });
  material(c, w, 'sand', (dryVol * sand) / parts, { key: 'concreteSand', params: { ...base, part: sand } });
  material(c, w, 'crush', (dryVol * crush) / parts, { key: 'concreteCrush', params: { ...base, part: crush } });
}

function steel(c: Ctx, w: Where, volume: number, percent: number) {
  material(c, w, 'steel', volume * (percent / 100) * STEEL_KG_PER_CFT, { key: 'steel', params: { volume: r2(volume), percent } });
}

/**
 * Bricks (or concrete blocks, or stone) + mortar of `volume` cft of masonry. Blocks (rulebook
 * `blockMasonry` = 1, Karachi / Sindh) are counted per sq ft of wall face: volume ÷ the wall
 * thickness `thicknessIn` × blocks per sq ft (one block leaf per wall).
 */
function masonry(c: Ctx, w: Where, volume: number, stone = false, thicknessIn = c.s.externalWallThicknessIn) {
  if (volume <= 0) return;
  const [cem, sand] = mixParts(c.s.masonryMortarMix) as [number, number];
  const parts = cem + sand;
  const dryVol = volume * c.s.mortarPerCftBrickwork * c.s.mortarDryFactor;
  if (stone) material(c, w, 'stone', volume, { key: 'stone', params: { volume: r2(volume) } });
  else if (c.s.blockMasonry === 1 && thicknessIn > 0) {
    const area = volume / inFt(thicknessIn);
    material(c, w, 'blocks', area * c.s.blocksPerSqft, { key: 'blocks', params: { volume: r2(volume), thicknessIn, area: r2(area), perSqft: c.s.blocksPerSqft } });
  } else material(c, w, 'bricks', volume * c.s.bricksPerCft, { key: 'bricks', params: { volume: r2(volume), perCft: c.s.bricksPerCft } });
  const base = { volume: r2(volume), mortar: c.s.mortarPerCftBrickwork, dry: c.s.mortarDryFactor, parts };
  material(c, w, 'cement', (dryVol * cem) / parts / c.s.cementBagCft, { key: 'mortarCement', params: { ...base, bagCft: c.s.cementBagCft } });
  material(c, w, 'sand', (dryVol * sand) / parts, { key: 'mortarSand', params: { ...base, part: sand } });
}

/** Cement + sand of `area` sq ft of plaster. */
function plaster(c: Ctx, w: Where, area: number, mix: string, thicknessIn: number) {
  if (area <= 0) return;
  const [cem, sand] = mixParts(mix) as [number, number];
  const parts = cem + sand;
  const dryVol = area * inFt(thicknessIn) * c.s.mortarDryFactor;
  const base = { area: r2(area), thicknessIn, dry: c.s.mortarDryFactor, parts };
  material(c, w, 'cement', (dryVol * cem) / parts / c.s.cementBagCft, { key: 'plasterCement', params: { ...base, bagCft: c.s.cementBagCft } });
  material(c, w, 'sand', (dryVol * sand) / parts, { key: 'plasterSand', params: { ...base, part: sand } });
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/** Perimeter of a rectangle of `area` with depth / front = `ratio`. */
export function footprintPerimeter(area: number, ratio: number): number {
  if (area <= 0) return 0;
  return 2 * (Math.sqrt(area / ratio) + Math.sqrt(area * ratio));
}

interface FloorGeo extends FloorBasis {
  floor: EstimateFloor;
  /** Detailed walls when every room has its walls entered. */
  detail: WallsDetail | null;
}

/** Slab thickness used for this floor: the RCC roof's own thickness, else the setting. */
const slabInOf = (floor: EstimateFloor, s: EstimateSettings) => (floor.roof?.type === 'RCC_SLAB' && floor.roof.thicknessIn ? floor.roof.thicknessIn : s.slabThicknessIn);
const hasWalls = (r: EstimateRoom) => Array.isArray(r.walls) && r.walls.length === 4;

function floorGeometry(input: EstimateInput, ratio: number, coveredSource: 'PROJECT' | 'ROOMS' | 'NONE', s: EstimateSettings): FloorGeo[] {
  const roomArea = (f: EstimateFloor) => sum(f.rooms.map((r) => r.lengthFt * r.widthFt));
  const totalRoomArea = sum(input.floors.map(roomArea));
  return input.floors.map((floor) => {
    const area = roomArea(floor);
    const perimeter = sum(floor.rooms.map((r) => 2 * (r.lengthFt + r.widthFt)));
    let footprint = 0;
    if (coveredSource === 'PROJECT' && input.coveredAreaSqft) {
      // Shared by room area; with no rooms at all, equally over the floors.
      footprint = totalRoomArea > 0 ? (input.coveredAreaSqft * area) / totalRoomArea : input.coveredAreaSqft / input.floors.length;
    } else {
      footprint = area * FOOTPRINT_ALLOWANCE;
    }
    const detail =
      floor.rooms.length > 0 && floor.rooms.every(hasWalls) ? detailedWalls(floor.rooms, slabInOf(floor, s), s.lintelWidthIn, s.lintelBearingFt) : null;
    const external = detail ? detail.externalRunFt : floor.rooms.length ? Math.min(footprintPerimeter(footprint, ratio), perimeter) : 0;
    const internal = detail ? detail.internalRunFt : Math.max(0, (perimeter - external) / 2);
    const openings = floor.rooms.flatMap((r) => r.openings);
    const areaOf = (types: OpeningKind[]) => sum(openings.filter((o) => types.includes(o.type)).map((o) => o.widthFt * o.heightFt * o.quantity));
    return {
      floor,
      detail,
      level: floor.level,
      name: floor.name,
      heightFt: floor.ceilingHeightFt,
      rooms: floor.rooms.length,
      roomAreaSqft: area,
      footprintSqft: footprint,
      roomPerimeterFt: perimeter,
      externalWallFt: external,
      internalWallFt: internal,
      doorsSqft: areaOf(['DOOR']),
      windowsSqft: areaOf(['WINDOW', 'VENTILATOR']),
      wallsMethod: detail ? 'DETAILED' : 'ESTIMATED',
      roofMethod: floor.roof ? 'DETAILED' : 'ESTIMATED',
      walls: detail
        ? {
            partyWallFt: r2(detail.partyRunFt),
            partyExistingFt: r2(detail.partyExistingFt),
            openFt: r2(detail.openFt),
            builtRunFt: r2(detail.builtRunFt),
            byThickness: detail.byThickness.map((t) => ({
              thicknessIn: t.thicknessIn,
              lengthFt: r2(t.lengthFt),
              areaSqft: r2(t.areaSqft),
              volumeCft: r2(t.volumeCft),
              bricks: r2(s.blockMasonry === 1 ? (t.volumeCft / inFt(t.thicknessIn)) * s.blocksPerSqft : t.volumeCft * s.bricksPerCft),
            })),
          }
        : null,
      roof: null,
    };
  });
}

// ─── Stages ─────────────────────────────────────────────────────────────────

function foundationStage(c: Ctx, f: EstimateFoundation, lengthFt: number, footprint: number, wallIn: number, method: LineMethod) {
  const s = c.s;
  const at = (element: ElementKey): Where => ({ stage: 'FOUNDATION', floor: null, element, method });
  const D = f.excavationDepthFt;
  const pccFt = inFt(f.pccThicknessIn);
  const footFt = inFt(f.footingThicknessIn);
  const t = inFt(wallIn);
  const pads = (f.type === 'ISOLATED' || f.type === 'COMBINED') && f.footingCount && f.footingLengthFt && f.footingWidthFt ? f.footingCount : 0;
  const padL = f.footingLengthFt ?? 0;
  const padW = f.footingWidthFt ?? 0;
  const padArea = pads * padL * padW;
  const L = lengthFt;
  const raft = f.type === 'RAFT';
  const trench = f.type === 'STRIP' ? (f.footingWidthFt ?? t + TRENCH_EXTRA_FT) : t + TRENCH_EXTRA_FT;
  const p = (n: number) => r2(n);

  // 1. Excavation
  if (raft) {
    work(c, at('excavation'), 'VOLUME', footprint * D, 'cft', { key: 'excavationRaft', params: { area: p(footprint), depth: D } });
  } else if (pads) {
    work(c, at('excavation'), 'VOLUME', L * trench * D + padArea * D, 'cft', {
      key: 'excavationTrenchPads',
      params: { length: p(L), width: p(trench), depth: D, pads, padL, padW },
    });
  } else {
    work(c, at('excavation'), 'VOLUME', L * trench * D, 'cft', { key: 'excavationTrench', params: { length: p(L), width: p(trench), depth: D } });
  }

  // 2. PCC (lean concrete) under footings / walls
  const pccVol = raft ? footprint * pccFt : L * trench * pccFt + padArea * pccFt;
  const pccFormula: Formula = raft
    ? { key: 'pccRaft', params: { area: p(footprint), thicknessIn: f.pccThicknessIn } }
    : pads
      ? { key: 'pccTrenchPads', params: { length: p(L), width: p(trench), thicknessIn: f.pccThicknessIn, pads, padL, padW } }
      : { key: 'pccTrench', params: { length: p(L), width: p(trench), thicknessIn: f.pccThicknessIn } };
  work(c, at('pcc'), 'VOLUME', pccVol, 'cft', pccFormula);
  concrete(c, at('pcc'), pccVol, f.pccMix);

  // 3. RCC footing / raft / piles
  const rccMix = f.rccMix ?? s.rccMix;
  let rccVol = 0;
  let rccFormula: Formula | null = null;
  if (f.type === 'STRIP' && f.masonry === 'RCC_ONLY') {
    rccVol = L * trench * footFt;
    rccFormula = { key: 'footingStrip', params: { length: p(L), width: p(trench), thicknessIn: f.footingThicknessIn } };
  } else if (pads) {
    rccVol = padArea * footFt;
    rccFormula = { key: 'footingPads', params: { pads, padL, padW, thicknessIn: f.footingThicknessIn } };
  } else if (raft) {
    rccVol = footprint * footFt;
    rccFormula = { key: 'footingRaft', params: { area: p(footprint), thicknessIn: f.footingThicknessIn } };
  } else if (f.type === 'PILE' && f.pileCount && f.pileDiameterIn && f.pileDepthFt) {
    rccVol = f.pileCount * Math.PI * (inFt(f.pileDiameterIn) / 2) ** 2 * f.pileDepthFt;
    rccFormula = { key: 'footingPiles', params: { piles: f.pileCount, diameterIn: f.pileDiameterIn, depth: f.pileDepthFt } };
  }
  if (rccFormula && rccVol > 0) {
    work(c, at('footing'), 'VOLUME', rccVol, 'cft', rccFormula);
    concrete(c, at('footing'), rccVol, rccMix);
    steel(c, at('footing'), rccVol, s.footingSteelPercent);
  }

  // 4. Foundation masonry: walls from the footing top (or PCC top) up to plinth level
  const stone = f.masonry === 'STONE';
  let masonryVol = 0;
  let masonryFormula: Formula;
  if (f.type === 'STRIP' && f.masonry !== 'RCC_ONLY') {
    // Stepped brick / stone footing: trapezoid from (width − 2 × 3″) down to the wall thickness.
    const avgWidth = Math.max(t, (trench - PCC_PROJECTION_FT + t) / 2);
    const h = Math.max(0, D - pccFt - footFt + f.plinthHeightFt);
    masonryVol = L * avgWidth * footFt + L * t * h;
    masonryFormula = {
      key: 'masonryStepped',
      params: { length: p(L), avgWidth: r4(avgWidth), footingIn: f.footingThicknessIn, wallIn, height: p(h) },
    };
  } else {
    // Isolated / combined / pile: walls stand on their own strip PCC; strip-RCC and raft: on the RCC.
    const onRcc = f.type === 'RAFT' || f.type === 'STRIP';
    const h = Math.max(0, D - pccFt - (onRcc ? footFt : 0) + f.plinthHeightFt);
    masonryVol = L * t * h;
    masonryFormula = { key: 'masonryWall', params: { length: p(L), wallIn, height: p(h) } };
  }
  work(c, at('foundationMasonry'), 'VOLUME', masonryVol, 'cft', masonryFormula);
  masonry(c, at('foundationMasonry'), masonryVol, stone, wallIn);

  // 5. DPC: concrete on top of the plinth walls + waterproofing compound or bitumen
  const dpcVol = L * t * inFt(f.dpcThicknessIn);
  work(c, at('dpc'), 'VOLUME', dpcVol, 'cft', { key: 'dpc', params: { length: p(L), wallIn, thicknessIn: f.dpcThicknessIn } });
  concrete(c, at('dpc'), dpcVol, DPC_MIX);
  if (f.dpcMaterial === 'PCC_WATERPROOF') {
    const [cem, sand, crush] = mixParts(DPC_MIX) as [number, number, number];
    const bags = (dpcVol * s.concreteDryFactor * cem) / (cem + sand + crush) / s.cementBagCft;
    material(c, at('dpc'), 'waterproofing', bags * s.waterproofingKgPerBag, { key: 'waterproofing', params: { bags: r2(bags), perBag: s.waterproofingKgPerBag } });
  } else {
    const area = L * t;
    material(c, at('dpc'), 'bitumen', area * s.bitumenKgPerSqft, { key: 'bitumen', params: { area: p(area), perSqft: s.bitumenKgPerSqft } });
  }

  // 6. Termite (deemak) treatment of the lowest-floor footprint
  if (f.termiteTreatment && footprint > 0) {
    work(c, at('termite'), 'AREA', footprint, 'sqft', { key: 'termiteArea', params: { area: p(footprint) } });
    material(c, at('termite'), 'termite', footprint * s.termiteLitrePerSqft, { key: 'termite', params: { area: p(footprint), perSqft: s.termiteLitrePerSqft } });
  }
}


/** Parapet run on the main roof: external (+ party walls we build) on detailed floors, else E. */
const parapetRun = (g: FloorGeo) => (g.detail ? g.detail.externalRunFt + g.detail.partyRunFt : g.externalWallFt);

function wallsStage(c: Ctx, g: FloorGeo, parapetOn: boolean) {
  const s = c.s;
  const floor = { level: g.level, name: g.name };
  const at = (element: ElementKey): Where => ({ stage: 'WALLS', floor, element, method: g.detail ? 'DETAILED' : 'ESTIMATED' });
  const H = g.heightFt;
  const tE = inFt(s.externalWallThicknessIn);
  const tI = inFt(s.internalWallThicknessIn);
  if (g.rooms > 0 && g.detail) {
    // One line per wall (leaf) thickness: 4.5″, 9″, 13.5″ …
    for (const t of g.detail.byThickness) {
      const w: Where = { ...at('walls'), variant: `t${String(t.thicknessIn).replace('.', '_')}` };
      work(c, w, 'VOLUME', t.volumeCft, 'cft', { key: 'wallsDetailed', params: { thicknessIn: t.thicknessIn, length: r2(t.lengthFt), area: r2(t.areaSqft) } });
      masonry(c, w, t.volumeCft, false, t.thicknessIn);
    }
  } else if (g.rooms > 0) {
    const ext = Math.max(0, g.externalWallFt * H - g.windowsSqft) * tE;
    const int = Math.max(0, g.internalWallFt * H - g.doorsSqft) * tI;
    const vol = ext + int;
    work(c, at('walls'), 'VOLUME', vol, 'cft', {
      key: 'walls',
      params: {
        ext: r2(g.externalWallFt),
        int: r2(g.internalWallFt),
        height: H,
        extIn: s.externalWallThicknessIn,
        intIn: s.internalWallThicknessIn,
        windows: r2(g.windowsSqft),
        doors: r2(g.doorsSqft),
      },
    });
    if (s.blockMasonry === 1) {
      // Blocks are counted per sq ft of each wall's face → external and internal walls separately.
      masonry(c, { ...at('walls'), variant: 'ext' }, ext, false, s.externalWallThicknessIn);
      masonry(c, { ...at('walls'), variant: 'int' }, int, false, s.internalWallThicknessIn);
    } else masonry(c, at('walls'), vol);
  }
  const run = parapetRun(g);
  if (parapetOn && s.parapetHeightFt > 0 && run > 0) {
    const vol = run * s.parapetHeightFt * tI;
    work(c, at('parapet'), 'VOLUME', vol, 'cft', {
      key: g.detail ? 'parapetDetailed' : 'parapet',
      params: { length: r2(run), height: s.parapetHeightFt, wallIn: s.internalWallThicknessIn },
    });
    masonry(c, at('parapet'), vol, false, s.internalWallThicknessIn);
  }
}

/** Roof slab, beams + columns and lintels of a floor. Returns the roof summary for the basis (detailed roofs). */
function rccStage(c: Ctx, g: FloorGeo, framed: boolean, ratio: number): FloorBasis['roof'] {
  const s = c.s;
  const floor = { level: g.level, name: g.name };
  const roof = g.floor.roof ?? null;
  const method: LineMethod = roof ? 'DETAILED' : 'ESTIMATED';
  const at = (element: ElementKey): Where => ({ stage: 'RCC', floor, element, method });
  const slabIn = slabInOf(g.floor, s);
  const mix = roof?.concreteMix ?? s.rccMix;
  const F = g.footprintSqft;
  let summary: FloorBasis['roof'] = null;

  if (!roof) {
    // Roof slab over this floor (% method)
    const slabVol = F * inFt(s.slabThicknessIn);
    if (slabVol > 0) {
      work(c, at('slab'), 'VOLUME', slabVol, 'cft', { key: 'slab', params: { area: r2(F), thicknessIn: s.slabThicknessIn } });
      concrete(c, at('slab'), slabVol, s.rccMix);
      steel(c, at('slab'), slabVol, s.slabSteelPercent);
      work(c, at('slab'), 'SHUTTERING', F, 'sqft', { key: 'slabShuttering', params: { area: r2(F) } });
    }
    // Beams + columns (RCC frame only)
    if (framed && slabVol > 0 && s.frameConcretePercent > 0) {
      const vol = (slabVol * s.frameConcretePercent) / 100;
      work(c, at('frame'), 'VOLUME', vol, 'cft', { key: 'frame', params: { percent: s.frameConcretePercent, slab: r2(slabVol) } });
      concrete(c, at('frame'), vol, s.rccMix);
      steel(c, at('frame'), vol, s.frameSteelPercent);
      work(c, at('frame'), 'SHUTTERING', vol * FRAME_SHUTTERING_SQFT_PER_CFT, 'sqft', {
        key: 'frameShuttering',
        params: { volume: r2(vol), perCft: FRAME_SHUTTERING_SQFT_PER_CFT },
      });
    }
  } else {
    // Panels: every room (clear sizes), or the footprint rectangle when the floor has no rooms
    const panels = g.floor.rooms.length
      ? g.floor.rooms.map((r, i) => ({ l: r.lengthFt, w: r.widthFt, label: r.name ?? `Room ${i + 1}` }))
      : F > 0
        ? [{ l: Math.sqrt(F * ratio), w: Math.sqrt(F / ratio), label: 'Footprint' }]
        : [];
    const panelArea = sum(panels.map((p) => p.l * p.w));
    const extraArea = g.floor.rooms.length ? Math.max(0, F - g.roomAreaSqft * FOOTPRINT_ALLOWANCE) : 0;
    const extra = panelArea > 0 && extraArea > 0 ? { factor: 1 + extraArea / panelArea, area: extraArea } : undefined;
    const span = largestSpan(panels.map((p) => ({ lengthFt: p.l, widthFt: p.w })));
    const steelKg = new Map<BarNo, number>();
    const listed: BarRun[] = [];
    const addBars = (w: Where, runs: BarRun[], ex?: typeof extra) => {
      bars(c, w, runs, ex);
      listed.push(...runs);
      for (const grp of groupBars(runs, ex?.factor ?? 1)) steelKg.set(grp.bar, (steelKg.get(grp.bar) ?? 0) + grp.kg);
    };
    const area = (n: number | null) => (n === null ? F : n);

    if (roof.type === 'RCC_SLAB') {
      const t = roof.thicknessIn!;
      const vol = F * inFt(t);
      if (vol > 0) {
        work(c, at('slab'), 'VOLUME', vol, 'cft', { key: 'slabDetailed', params: { area: r2(F), thicknessIn: t, spanFt: r2(span ?? 0) } });
        concrete(c, at('slab'), vol, mix);
        addBars(at('slab'), panels.flatMap((p) => slabPanelBars(p.l, p.w, roof, p.label)), extra);
        work(c, at('slab'), 'SHUTTERING', F, 'sqft', { key: 'slabShuttering', params: { area: r2(F) } });
      }
      if (roof.chajjaLengthFt && roof.chajjaWidthFt) {
        const L = roof.chajjaLengthFt;
        const W = roof.chajjaWidthFt;
        const cv = L * W * inFt(CHAJJA_THICKNESS_IN);
        work(c, at('chajja'), 'VOLUME', cv, 'cft', { key: 'chajja', params: { length: L, width: W, thicknessIn: CHAJJA_THICKNESS_IN } });
        concrete(c, at('chajja'), cv, mix);
        addBars(at('chajja'), chajjaBars(L, W));
        work(c, at('chajja'), 'SHUTTERING', L * W, 'sqft', { key: 'chajjaShuttering', params: { length: L, width: W } });
      }
    } else if (roof.type === 'T_IRON_TILE') {
      const gs = panels.map((p) => girders(p.l, p.w, roof));
      const count = sum(gs.map((x) => x.count));
      const length = sum(gs.map((x) => x.count * x.lengthFt));
      const factor = extra?.factor ?? 1;
      const perFt = r4(gs.length ? gs[0]!.kg / (gs[0]!.count * gs[0]!.lengthFt) : 0);
      const params = { count, section: roof.tIronSection!, length: r2(length), kgPerFt: perFt };
      material(c, at('girders'), 'tIron', sum(gs.map((x) => x.kg)) * factor, extra ? { key: 'girdersExtra', params: { ...params, extraPercent: r2((factor - 1) * 100), extraArea: r2(extra.area) } } : { key: 'girders', params });
      if (F > 0) {
        const per = INFILL_PER_SQFT[roof.infill!];
        work(c, at('roofInfill'), 'AREA', F, 'sqft', { key: 'infillArea', params: { area: r2(F) } });
        material(c, at('roofInfill'), roof.infill === 'TILE' ? 'roofTile' : 'bricks', F * per, { key: 'infillUnits', params: { area: r2(F), perSqft: per } });
        plasterLike(c, at('roofInfill'), F, INFILL_MORTAR_MIX, INFILL_MORTAR_IN);
        if (roof.screedThicknessIn) {
          const sv = F * inFt(roof.screedThicknessIn);
          work(c, at('screed'), 'VOLUME', sv, 'cft', { key: 'screed', params: { area: r2(F), thicknessIn: roof.screedThicknessIn } });
          concrete(c, at('screed'), sv, mix);
        }
        if (roof.earthFillIn) {
          work(c, at('earthFill'), 'VOLUME', F * inFt(roof.earthFillIn), 'cft', { key: 'earthFill', params: { area: r2(F), thicknessIn: roof.earthFillIn } });
        }
      }
    } else {
      // PRECAST planks or STEEL_DECK sheets + concrete topping (+ mesh); no shuttering
      const precast = roof.type === 'PRECAST';
      const a = area(precast ? roof.plankAreaSqft : roof.deckAreaSqft);
      if (a > 0) {
        const el: ElementKey = precast ? 'planks' : 'deck';
        work(c, at(el), 'AREA', a, 'sqft', { key: precast ? 'planks' : 'deck', params: { area: r2(a) } });
        material(c, at(el), precast ? 'precastPlank' : 'steelDeck', a, { key: precast ? 'planks' : 'deck', params: { area: r2(a) } });
        const tv = a * inFt(roof.toppingIn!);
        work(c, at('topping'), 'VOLUME', tv, 'cft', { key: 'topping', params: { area: r2(a), thicknessIn: roof.toppingIn! } });
        concrete(c, at('topping'), tv, mix);
        if (roof.mesh) addBars(at('topping'), meshBars(a, 'mesh'));
      }
    }

    // Beams + columns from their sizes and bars (RCC frame only)
    let beamRun: number | null = null;
    let columns: number | null = null;
    if (framed && F > 0) {
      beamRun = roof.beamRunFt ?? (g.detail ? g.detail.builtRunFt : g.externalWallFt + g.internalWallFt);
      const below = roof.beamDepthIn - slabIn;
      if (beamRun > 0 && below > 0) {
        const bv = beamRun * inFt(roof.beamWidthIn) * inFt(below);
        work(c, at('beams'), 'VOLUME', bv, 'cft', { key: 'beams', params: { length: r2(beamRun), widthIn: roof.beamWidthIn, depthIn: roof.beamDepthIn, slabIn } });
        concrete(c, at('beams'), bv, mix);
        addBars(at('beams'), beamBars(beamRun, roof));
        work(c, at('beams'), 'SHUTTERING', 2 * beamRun * inFt(below), 'sqft', { key: 'beamShuttering', params: { length: r2(beamRun), depthIn: roof.beamDepthIn, slabIn } });
      }
      columns = roof.columnCount ?? defaultColumnCount(F, ratio);
      const H = g.heightFt;
      if (columns > 0) {
        const cv = columns * inFt(roof.columnWidthIn) * inFt(roof.columnDepthIn) * H;
        work(c, at('columns'), 'VOLUME', cv, 'cft', { key: 'columns', params: { count: columns, widthIn: roof.columnWidthIn, depthIn: roof.columnDepthIn, height: H } });
        concrete(c, at('columns'), cv, mix);
        addBars(at('columns'), columnBars(columns, H, slabIn, roof));
        work(c, at('columns'), 'SHUTTERING', columns * 2 * inFt(roof.columnWidthIn + roof.columnDepthIn) * H, 'sqft', {
          key: 'columnShuttering',
          params: { count: columns, widthIn: roof.columnWidthIn, depthIn: roof.columnDepthIn, height: H },
        });
      }
    }
    summary = {
      type: roof.type,
      thicknessIn: roof.thicknessIn,
      largestSpanFt: span === null ? null : r2(span),
      steelBySize: [...steelKg.entries()].sort((a, b) => a[0] - b[0]).map(([b, kg]) => ({ bar: b, mm: BAR_MM[b], kg: r2(kg) })),
      bars: listed.map((r) => ({ use: r.use, bar: r.bar, mm: BAR_MM[r.bar], count: r.count, lengthFt: r2(r.lengthFt), label: r.label })),
      beamRunFt: beamRun === null ? null : r2(beamRun),
      columnCount: columns,
      columnCountAuto: columns !== null && roof.columnCount === null,
    };
  }

  // Lintels over every opening
  if (g.detail) {
    const ls = g.detail.lintels;
    const count = sum(ls.map((l) => l.count));
    const length = sum(ls.map((l) => l.lengthFt));
    if (length > 0) {
      const d = inFt(s.lintelDepthIn);
      const vol = sum(ls.map((l) => l.lengthFt * inFt(l.widthIn) * d));
      const w: Where = { ...at('lintels'), method: 'DETAILED' };
      work(c, w, 'VOLUME', vol, 'cft', { key: 'lintelsDetailed', params: { count, bearing: s.lintelBearingFt, depthIn: s.lintelDepthIn, volume: r2(vol) } });
      concrete(c, w, vol, mix);
      const byWidth = new Map<number, { length: number; count: number }>();
      for (const l of ls) {
        const x = byWidth.get(l.widthIn) ?? { length: 0, count: 0 };
        x.length += l.lengthFt;
        x.count += l.count;
        byWidth.set(l.widthIn, x);
      }
      bars(c, w, [...byWidth.entries()].flatMap(([widthIn, x]) => lintelBars(x.length, x.count, widthIn, s.lintelDepthIn)));
      work(c, w, 'SHUTTERING', sum(ls.map((l) => l.lengthFt * (inFt(l.widthIn) + 2 * d))), 'sqft', { key: 'lintelShutteringDetailed', params: { length: r2(length), depthIn: s.lintelDepthIn } });
    }
  } else {
    const openings = g.floor.rooms.flatMap((r) => r.openings);
    const count = sum(openings.map((o) => o.quantity));
    const length = sum(openings.map((o) => (o.widthFt + s.lintelBearingFt) * o.quantity));
    if (length > 0) {
      const w = inFt(s.lintelWidthIn);
      const d = inFt(s.lintelDepthIn);
      const vol = length * w * d;
      const where: Where = { ...at('lintels'), method: 'ESTIMATED' };
      work(c, where, 'VOLUME', vol, 'cft', {
        key: 'lintels',
        params: { count, bearing: s.lintelBearingFt, length: r2(length), widthIn: s.lintelWidthIn, depthIn: s.lintelDepthIn },
      });
      concrete(c, where, vol, s.rccMix);
      steel(c, where, vol, s.lintelSteelPercent);
      work(c, where, 'SHUTTERING', length * (w + 2 * d), 'sqft', {
        key: 'lintelShuttering',
        params: { length: r2(length), widthIn: s.lintelWidthIn, depthIn: s.lintelDepthIn },
      });
    }
  }
  return summary;
}

/** Cement + sand of a mortar bed (same arithmetic as plaster, its own formula text). */
function plasterLike(c: Ctx, w: Where, area: number, mix: string, thicknessIn: number) {
  if (area <= 0) return;
  const [cem, sand] = mixParts(mix) as [number, number];
  const parts = cem + sand;
  const dryVol = area * inFt(thicknessIn) * c.s.mortarDryFactor;
  const base = { area: r2(area), thicknessIn, dry: c.s.mortarDryFactor, parts };
  material(c, w, 'cement', (dryVol * cem) / parts / c.s.cementBagCft, { key: 'plasterCement', params: { ...base, bagCft: c.s.cementBagCft } });
  material(c, w, 'sand', (dryVol * sand) / parts, { key: 'mortarBedding', params: { ...base, part: sand } });
}

function plasterStage(c: Ctx, g: FloorGeo, parapetOn: boolean) {
  const s = c.s;
  const floor = { level: g.level, name: g.name };
  const at = (element: ElementKey): Where => ({ stage: 'PLASTER', floor, element, method: g.detail ? 'DETAILED' : 'ESTIMATED' });
  const slabIn = slabInOf(g.floor, s);
  if (g.rooms > 0 && g.detail) {
    const internal = g.detail.plasterInternalSqft;
    work(c, at('plasterInternal'), 'AREA', internal, 'sqft', { key: 'plasterInternalDetailed', params: {} });
    plaster(c, at('plasterInternal'), internal, s.internalPlasterMix, s.internalPlasterThicknessIn);

    work(c, at('plasterCeiling'), 'AREA', g.roomAreaSqft, 'sqft', { key: 'plasterCeiling', params: {} });
    plaster(c, at('plasterCeiling'), g.roomAreaSqft, s.internalPlasterMix, s.internalPlasterThicknessIn);

    const external = g.detail.plasterExternalSqft;
    work(c, at('plasterExternal'), 'AREA', external, 'sqft', {
      key: 'plasterExternalDetailed',
      params: { length: r2(g.detail.externalRunFt), height: g.heightFt, slabIn },
    });
    plaster(c, at('plasterExternal'), external, s.externalPlasterMix, s.externalPlasterThicknessIn);
  } else if (g.rooms > 0) {
    // Inside faces of every room = both faces of internal walls + inner face of external walls.
    const internal = sum(
      g.floor.rooms.map((r) => 2 * (r.lengthFt + r.widthFt) * r.heightFt - sum(r.openings.map((o) => o.widthFt * o.heightFt * o.quantity))),
    );
    work(c, at('plasterInternal'), 'AREA', Math.max(0, internal), 'sqft', { key: 'plasterInternal', params: {} });
    plaster(c, at('plasterInternal'), Math.max(0, internal), s.internalPlasterMix, s.internalPlasterThicknessIn);

    work(c, at('plasterCeiling'), 'AREA', g.roomAreaSqft, 'sqft', { key: 'plasterCeiling', params: {} });
    plaster(c, at('plasterCeiling'), g.roomAreaSqft, s.internalPlasterMix, s.internalPlasterThicknessIn);

    const external = Math.max(0, g.externalWallFt * (g.heightFt + inFt(slabIn)) - g.windowsSqft);
    work(c, at('plasterExternal'), 'AREA', external, 'sqft', {
      key: 'plasterExternal',
      params: { length: r2(g.externalWallFt), height: g.heightFt, slabIn, windows: r2(g.windowsSqft) },
    });
    plaster(c, at('plasterExternal'), external, s.externalPlasterMix, s.externalPlasterThicknessIn);
  }
  const run = parapetRun(g);
  if (parapetOn && s.parapetHeightFt > 0 && run > 0) {
    const area = 2 * run * s.parapetHeightFt;
    work(c, at('plasterParapet'), 'AREA', area, 'sqft', { key: 'plasterParapet', params: { length: r2(run), height: s.parapetHeightFt } });
    plaster(c, at('plasterParapet'), area, s.externalPlasterMix, s.externalPlasterThicknessIn);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

const methodOf = (ms: LineMethod[]): LineMethod | 'MIXED' => (ms.length && ms.every((m) => m === 'DETAILED') ? 'DETAILED' : ms.some((m) => m === 'DETAILED') ? 'MIXED' : 'ESTIMATED');

export function estimateQuantities(input: EstimateInput, settings: EstimateSettings = ESTIMATE_DEFAULTS): EstimateQuantities {
  const c: Ctx = { s: settings, lines: [] };
  const warnings: EngineWarning[] = [];
  const ratio = input.frontFt && input.depthFt && input.frontFt > 0 && input.depthFt > 0 ? input.depthFt / input.frontFt : 1;

  const structureType: StructureKind = input.structureType ?? 'FRAMED';
  if (!input.structureType) warnings.push({ code: 'STRUCTURE_TYPE_ASSUMED', tab: 3, message: 'Structure type is not chosen — the estimate assumes an RCC frame' });
  if (!input.floors.length) warnings.push({ code: 'NO_FLOORS', tab: 3, message: 'No floors yet — only the foundation can be estimated' });
  const roomCount = sum(input.floors.map((f) => f.rooms.length));
  if (input.floors.length && roomCount === 0) {
    warnings.push({ code: 'NO_ROOMS', tab: 5, message: 'No rooms yet — walls, lintels and plaster need the rooms; slabs use the covered area' });
  }

  const coveredSource: 'PROJECT' | 'ROOMS' | 'NONE' = input.coveredAreaSqft && input.coveredAreaSqft > 0 ? 'PROJECT' : roomCount > 0 ? 'ROOMS' : 'NONE';
  if (coveredSource !== 'PROJECT') {
    warnings.push({ code: 'COVERED_AREA_ESTIMATED', tab: 4, message: 'Covered area is not entered — slabs use the room areas + 15 % for walls and passages' });
  }
  const geo = floorGeometry(input, ratio, coveredSource, settings);
  const roomArea = sum(geo.map((g) => g.roomAreaSqft));
  if (coveredSource === 'PROJECT' && roomArea > 0 && roomArea < input.coveredAreaSqft! * ROOMS_COVERAGE_WARN_RATIO) {
    const percent = Math.round((roomArea / input.coveredAreaSqft!) * 100);
    warnings.push({
      code: 'ROOMS_BELOW_COVERED',
      tab: 5,
      params: { percent },
      message: `Rooms add up to only ${percent} % of the covered area — walls, lintels and plaster are probably under-counted (add passages, stairs, stores …)`,
    });
  }
  const coveredAreaSqft = coveredSource === 'PROJECT' ? input.coveredAreaSqft! : sum(geo.map((g) => g.footprintSqft));

  // Walls / roof checks per floor
  for (const g of geo) {
    const floor = { level: g.level, name: g.name };
    const withWalls = g.floor.rooms.filter(hasWalls).length;
    if (withWalls > 0 && withWalls < g.floor.rooms.length) {
      const missing = g.floor.rooms.length - withWalls;
      warnings.push({
        code: 'WALLS_PARTIAL',
        tab: 5,
        floor,
        params: { missing, rooms: g.floor.rooms.length },
        message: `${g.name}: ${missing} of ${g.floor.rooms.length} rooms have no walls entered — this floor's walls are estimated from the room perimeters`,
      });
    }
    if (g.detail && g.detail.unpairedSides > 0) {
      warnings.push({ code: 'WALLS_UNPAIRED', tab: 5, floor, params: { sides: g.detail.unpairedSides }, message: `${g.name}: ${g.detail.unpairedSides} shared wall side(s) are not paired with the other room — counted as passage walls` });
    }
    if (g.floor.roof) {
      for (const w of roofWarnings(g.floor.roof, largestSpan(g.floor.rooms))) {
        const p = w.params;
        const message =
          w.code === 'ROOF_TOO_THIN'
            ? `${g.name}: ${p['thicknessIn']}″ slab is thin for a ${p['spanFt']} ft span — ${p['suggestedIn']}″ suggested`
            : w.code === 'ROOF_SPAN_NEEDS_BEAM'
              ? `${g.name}: ${p['spanFt']} ft span — use a 6–7″ slab or a beam across the room`
              : `${g.name}: bar spacing ${p['spacingIn']}″ is more than ${p['maxIn']}″ (min of 12″ and 2 × slab thickness)`;
        warnings.push({ code: w.code, tab: 3, floor, params: p, message });
      }
    }
  }

  // Foundation: under the lowest floor that has rooms (else the lowest floor)
  const lowest = geo.find((g) => g.rooms > 0) ?? geo[0];
  let autoLength = 0;
  let lengthSource: EstimateQuantities['basis']['foundationWallLengthSource'] = 'ESTIMATED';
  if (lowest && lowest.rooms > 0) {
    autoLength = lowest.detail ? lowest.detail.builtRunFt : lowest.externalWallFt + lowest.internalWallFt;
    lengthSource = lowest.detail ? 'WALLS' : 'ESTIMATED';
  } else if (input.frontFt && input.depthFt) {
    autoLength = 2 * (input.frontFt + input.depthFt);
    lengthSource = 'PLOT';
  }
  if (settings.foundationWallLengthFt !== null) lengthSource = 'SETTING';
  const foundationLength = settings.foundationWallLengthFt ?? autoLength;
  const lowestFootprint = lowest?.footprintSqft || (input.plotAreaSqft ?? 0);
  if (!input.foundation) {
    warnings.push({ code: 'FOUNDATION_MISSING', tab: 3, message: 'Foundation (bunyaad) details are not entered — the foundation is not estimated' });
  } else if (foundationLength <= 0) {
    warnings.push({ code: 'FOUNDATION_LENGTH_UNKNOWN', tab: 5, message: 'Foundation wall length is unknown — add rooms or the plot size, or enter it in the estimate settings' });
  } else {
    foundationStage(c, input.foundation, foundationLength, lowestFootprint, settings.externalWallThicknessIn, lengthSource === 'WALLS' || lengthSource === 'SETTING' ? 'DETAILED' : 'ESTIMATED');
  }

  // Parapet on the main roof: the highest floor with rooms that is not the mumty
  const roofFloor = [...geo].reverse().find((g) => g.rooms > 0 && g.level !== 'MUMTY');
  for (const g of geo) wallsStage(c, g, g === roofFloor);
  for (const g of geo) g.roof = rccStage(c, g, structureType === 'FRAMED', ratio);
  for (const g of geo) plasterStage(c, g, g === roofFloor);

  // Totals
  const stageTotals = Object.fromEntries(STAGES.map((st) => [st, {}])) as EstimateQuantities['stageTotals'];
  const net: Partial<Record<MaterialKey, number>> = {};
  const gross: Partial<Record<MaterialKey, number>> = {};
  for (const l of c.lines) {
    if (l.kind !== 'MATERIAL' || !l.material) continue;
    const st = stageTotals[l.stage];
    st[l.material] = r2((st[l.material] ?? 0) + l.quantity);
    net[l.material] = (net[l.material] ?? 0) + l.netQuantity;
    gross[l.material] = (gross[l.material] ?? 0) + l.quantity;
  }
  const totals = MATERIALS.filter((m) => gross[m] !== undefined).map((m) => ({ material: m, unit: MATERIAL_UNITS[m], netQuantity: r2(net[m]!), quantity: r2(gross[m]!) }));
  const workSum = (pred: (l: EstimateLine) => boolean) => r2(sum(c.lines.filter(pred).map((l) => l.netQuantity)));
  const withRooms = geo.filter((g) => g.rooms > 0);

  return {
    basis: {
      structureType,
      structureTypeAssumed: !input.structureType,
      coveredAreaSqft: r2(coveredAreaSqft),
      coveredAreaSource: coveredSource,
      plotAreaSqft: input.plotAreaSqft,
      aspectRatio: r4(ratio),
      foundationWallLengthFt: r2(foundationLength),
      foundationWallLengthAuto: settings.foundationWallLengthFt === null,
      foundationWallLengthSource: lengthSource,
      methods: { walls: methodOf(withRooms.map((g) => g.wallsMethod)), roof: methodOf(geo.map((g) => g.roofMethod)) },
      floors: geo.map(({ floor: _floor, detail: _detail, ...b }) => ({
        ...b,
        roomAreaSqft: r2(b.roomAreaSqft),
        footprintSqft: r2(b.footprintSqft),
        roomPerimeterFt: r2(b.roomPerimeterFt),
        externalWallFt: r2(b.externalWallFt),
        internalWallFt: r2(b.internalWallFt),
        doorsSqft: r2(b.doorsSqft),
        windowsSqft: r2(b.windowsSqft),
      })),
    },
    lines: c.lines,
    stageTotals,
    totals,
    work: {
      bricks: workSum((l) => (l.material === 'bricks' || l.material === 'blocks') && l.stage !== 'RCC'),
      plasterSqft: workSum((l) => l.stage === 'PLASTER' && l.kind === 'WORK'),
      shutteringSqft: workSum((l) => l.measure === 'SHUTTERING'),
      steelKg: workSum((l) => isBarSteel(l.material)),
    },
    warnings,
  };
}

// ─── Costing (pure) ─────────────────────────────────────────────────────────

/** Built-in conversions from an engine unit to other units: 1 engine unit = factor × target. */
const UNIT_ALIASES: Record<string, string> = {
  bag: 'bag',
  bags: 'bag',
  nos: 'nos',
  no: 'nos',
  pcs: 'nos',
  piece: 'nos',
  pieces: 'nos',
  brick: 'nos',
  bricks: 'nos',
  cft: 'cft',
  'cu ft': 'cft',
  kg: 'kg',
  kgs: 'kg',
  ton: 'ton',
  tons: 'ton',
  tonne: 'ton',
  mt: 'ton',
  litre: 'litre',
  liter: 'litre',
  ltr: 'litre',
  l: 'litre',
  thousand: 'thousand',
  '1000': 'thousand',
  trolley: 'trolley',
  sqft: 'sqft',
  gallon: 'gallon',
  gallons: 'gallon',
  gal: 'gallon',
  'sq ft': 'sqft',
};
const BUILT_IN: Record<string, Record<string, number>> = {
  kg: { ton: 1 / 1000 },
  nos: { thousand: 1 / 1000 },
  cft: { trolley: 1 / 100 },
  bag: { kg: 50 },
  // Pakistani paint "gallon" tins hold 3.64 litres
  gallon: { litre: 3.64 },
};
const normUnit = (u: string) => UNIT_ALIASES[u.trim().toLowerCase()] ?? u.trim().toLowerCase();

/**
 * Quantity in the engine unit → quantity in the material's base unit (the unit its rate is per),
 * or null when there is no known conversion. `altUnits` = [{ unit, factor }]: 1 base = factor × unit.
 */
export function toBaseUnit(qty: number, engineUnit: string, base: string, altUnits: Array<{ unit: string; factor: number }> = []): number | null {
  const from = normUnit(engineUnit);
  const to = normUnit(base);
  if (from === to) return qty;
  const direct = BUILT_IN[from]?.[to];
  if (direct !== undefined) return qty * direct;
  for (const alt of altUnits) {
    if (!(alt.factor > 0)) continue;
    const a = normUnit(alt.unit);
    if (a === from) return qty / alt.factor;
    const via = BUILT_IN[from]?.[a];
    if (via !== undefined) return (qty * via) / alt.factor;
  }
  return null;
}

export type SuppliedByKey = 'CONTRACTOR' | 'OWNER';

/** One price-book entry per estimate material (resolved by the service from the company price list). */
export interface PriceEntry {
  materialId: string | null;
  materialName: string | null;
  /** The material's base unit — its rate is per this unit. */
  unit: string | null;
  altUnits: Array<{ unit: string; factor: number }>;
  ratePaisa: bigint | null;
  qualityCategory: { id: string; name: string } | null;
  suppliedBy: SuppliedByKey;
  /** Priced at another material's rate (bar size without its own rate → the generic steel rate). */
  fallback?: boolean;
}

export type PriceBook = Partial<Record<MaterialKey, PriceEntry>>;

export const LABOUR_ITEMS = ['BRICK_MASONRY', 'PLASTER', 'SHUTTERING', 'STEEL_FIXING'] as const;
export type LabourItem = (typeof LABOUR_ITEMS)[number];
/** The LaborRate unit each piece rate must have. */
export const LABOUR_UNITS: Record<LabourItem, string> = { BRICK_MASONRY: 'BRICK', PLASTER: 'SQFT', SHUTTERING: 'SQFT', STEEL_FIXING: 'TON' };

export interface LabourRates {
  /** Company SUBCONTRACT piece rates by key (only active ones). */
  pieceRates: Partial<Record<LabourItem, { unit: string; ratePaisa: bigint; label: string }>>;
}

export type RateStatus = 'OK' | 'RATE_MISSING' | 'UNIT_MISMATCH';

export interface PricedLine extends EstimateLine {
  ratePaisa: bigint | null;
  rateUnit: string | null;
  /** Quantity in the rate's unit (e.g. tons of steel, trolleys of sand). */
  rateQuantity: number | null;
  amountPaisa: bigint | null;
  rateStatus: RateStatus | null;
  suppliedBy: SuppliedByKey | null;
}

export interface PricedMaterial {
  material: MaterialKey;
  unit: string;
  netQuantity: number;
  quantity: number;
  materialId: string | null;
  materialName: string | null;
  qualityCategory: { id: string; name: string } | null;
  ratePaisa: bigint | null;
  rateUnit: string | null;
  rateQuantity: number | null;
  amountPaisa: bigint | null;
  rateStatus: RateStatus;
  suppliedBy: SuppliedByKey;
  rateFallback: boolean;
}

export interface LabourLine {
  item: LabourItem | 'PER_SQFT';
  quantity: number;
  unit: string;
  ratePaisa: bigint | null;
  amountPaisa: bigint | null;
  rateStatus: RateStatus;
}

export interface PricedEstimate {
  lines: PricedLine[];
  materials: PricedMaterial[];
  stageCosts: Record<StageKey, { materialsPaisa: bigint; ownerSuppliedPaisa: bigint; missingRates: number }>;
  labour: { method: 'PER_SQFT' | 'PIECE_RATES' | 'EXCLUDED'; lines: LabourLine[]; totalPaisa: bigint };
  cost: {
    materialsPaisa: bigint;
    ownerSuppliedPaisa: bigint;
    labourPaisa: bigint;
    totalPaisa: bigint;
    perSqftPaisa: bigint | null;
    contractTotalPaisa: bigint | null;
    marginPaisa: bigint | null;
    marginPercent: number | null;
  };
  /** Materials without a usable rate (excluded from the totals). */
  missingRates: Array<{ material: MaterialKey; status: Exclude<RateStatus, 'OK'> }>;
  missingLabourRates: LabourItem[];
}

const paisa = (n: number) => BigInt(Math.round(n));

function priceFor(entry: PriceEntry | undefined, qty: number, unit: string): { ratePaisa: bigint | null; rateUnit: string | null; rateQuantity: number | null; amountPaisa: bigint | null; status: RateStatus } {
  if (!entry || entry.ratePaisa === null || !entry.unit) return { ratePaisa: null, rateUnit: entry?.unit ?? null, rateQuantity: null, amountPaisa: null, status: 'RATE_MISSING' };
  const baseQty = toBaseUnit(qty, unit, entry.unit, entry.altUnits);
  if (baseQty === null) return { ratePaisa: entry.ratePaisa, rateUnit: entry.unit, rateQuantity: null, amountPaisa: null, status: 'UNIT_MISMATCH' };
  return { ratePaisa: entry.ratePaisa, rateUnit: entry.unit, rateQuantity: r4(baseQty), amountPaisa: paisa(baseQty * Number(entry.ratePaisa)), status: 'OK' };
}

/**
 * Money for the quantities. Material lines × the price-book rate (converted to the rate's unit);
 * lines without a rate are left out of every total (`missingRates`). Owner-supplied materials are
 * valued but kept out of the contractor's cost. Labour: covered area × the per-sq-ft rate when
 * set, else the company piece rates (brick masonry per brick, plaster / shuttering per sq ft,
 * steel fixing per ton) on the net work quantities.
 */
export function priceEstimate(
  q: EstimateQuantities,
  prices: PriceBook,
  labourRates: LabourRates,
  opts: { settings: EstimateSettings; contractTotalPaisa: bigint | null },
): PricedEstimate {
  const stageCosts = Object.fromEntries(STAGES.map((s) => [s, { materialsPaisa: 0n, ownerSuppliedPaisa: 0n, missingRates: 0 }])) as PricedEstimate['stageCosts'];
  const lines: PricedLine[] = q.lines.map((l) => {
    if (l.kind !== 'MATERIAL' || !l.material) return { ...l, ratePaisa: null, rateUnit: null, rateQuantity: null, amountPaisa: null, rateStatus: null, suppliedBy: null };
    const entry = prices[l.material];
    const p = priceFor(entry, l.quantity, l.unit);
    const suppliedBy = entry?.suppliedBy ?? 'CONTRACTOR';
    const sc = stageCosts[l.stage];
    if (p.amountPaisa === null) {
      if (suppliedBy === 'CONTRACTOR') sc.missingRates += 1;
    }
    else if (suppliedBy === 'OWNER') sc.ownerSuppliedPaisa += p.amountPaisa;
    else sc.materialsPaisa += p.amountPaisa;
    return { ...l, ratePaisa: p.ratePaisa, rateUnit: p.rateUnit, rateQuantity: p.rateQuantity, amountPaisa: p.amountPaisa, rateStatus: p.status, suppliedBy };
  });

  const materials: PricedMaterial[] = q.totals.map((t) => {
    const entry = prices[t.material];
    const p = priceFor(entry, t.quantity, t.unit);
    // The amount is the sum of the line amounts, so the summary always equals the stage tables.
    const lineSum = lines.filter((l) => l.material === t.material && l.amountPaisa !== null).reduce((a, l) => a + l.amountPaisa!, 0n);
    return {
      material: t.material,
      unit: t.unit,
      netQuantity: t.netQuantity,
      quantity: t.quantity,
      materialId: entry?.materialId ?? null,
      materialName: entry?.materialName ?? null,
      qualityCategory: entry?.qualityCategory ?? null,
      ratePaisa: p.ratePaisa,
      rateUnit: p.rateUnit,
      rateQuantity: p.rateQuantity,
      amountPaisa: p.status === 'OK' ? lineSum : null,
      rateStatus: p.status,
      suppliedBy: entry?.suppliedBy ?? 'CONTRACTOR',
      rateFallback: Boolean(entry?.fallback),
    };
  });

  // Labour
  const s = opts.settings;
  let labour: PricedEstimate['labour'] = { method: 'EXCLUDED', lines: [], totalPaisa: 0n };
  const missingLabourRates: LabourItem[] = [];
  if (s.includeLabour) {
    if (s.labourRatePerSqftPaisa !== null) {
      const rate = BigInt(s.labourRatePerSqftPaisa);
      const amount = paisa(q.basis.coveredAreaSqft * Number(rate));
      labour = { method: 'PER_SQFT', lines: [{ item: 'PER_SQFT', quantity: q.basis.coveredAreaSqft, unit: 'sqft', ratePaisa: rate, amountPaisa: amount, rateStatus: 'OK' }], totalPaisa: amount };
    } else {
      const qty: Record<LabourItem, { quantity: number; unit: string }> = {
        BRICK_MASONRY: { quantity: q.work.bricks, unit: 'nos' },
        PLASTER: { quantity: q.work.plasterSqft, unit: 'sqft' },
        SHUTTERING: { quantity: q.work.shutteringSqft, unit: 'sqft' },
        STEEL_FIXING: { quantity: r4(q.work.steelKg / 1000), unit: 'ton' },
      };
      const out: LabourLine[] = [];
      for (const item of LABOUR_ITEMS) {
        const { quantity, unit } = qty[item];
        if (quantity <= 0) continue;
        const rate = labourRates.pieceRates[item];
        if (!rate) {
          missingLabourRates.push(item);
          out.push({ item, quantity, unit, ratePaisa: null, amountPaisa: null, rateStatus: 'RATE_MISSING' });
        } else if (rate.unit !== LABOUR_UNITS[item]) {
          missingLabourRates.push(item);
          out.push({ item, quantity, unit, ratePaisa: rate.ratePaisa, amountPaisa: null, rateStatus: 'UNIT_MISMATCH' });
        } else {
          out.push({ item, quantity, unit, ratePaisa: rate.ratePaisa, amountPaisa: paisa(quantity * Number(rate.ratePaisa)), rateStatus: 'OK' });
        }
      }
      labour = { method: 'PIECE_RATES', lines: out, totalPaisa: out.reduce((a, l) => a + (l.amountPaisa ?? 0n), 0n) };
    }
  }

  const materialsPaisa = STAGES.reduce((a, st) => a + stageCosts[st].materialsPaisa, 0n);
  const ownerSuppliedPaisa = STAGES.reduce((a, st) => a + stageCosts[st].ownerSuppliedPaisa, 0n);
  const totalPaisa = materialsPaisa + labour.totalPaisa;
  const covered = q.basis.coveredAreaSqft;
  const contract = opts.contractTotalPaisa;
  const marginPaisa = contract === null ? null : contract - totalPaisa;
  return {
    lines,
    materials,
    stageCosts,
    labour,
    cost: {
      materialsPaisa,
      ownerSuppliedPaisa,
      labourPaisa: labour.totalPaisa,
      totalPaisa,
      perSqftPaisa: covered > 0 ? paisa(Number(totalPaisa) / covered) : null,
      contractTotalPaisa: contract,
      marginPaisa,
      marginPercent: contract && contract > 0n && marginPaisa !== null ? r2((Number(marginPaisa) / Number(contract)) * 100) : null,
    },
    // Owner-supplied materials don't need a rate: they are never part of the contractor's cost.
    missingRates: materials.filter((m) => m.rateStatus !== 'OK' && m.suppliedBy === 'CONTRACTOR').map((m) => ({ material: m.material, status: m.rateStatus as Exclude<RateStatus, 'OK'> })),
    missingLabourRates,
  };
}
