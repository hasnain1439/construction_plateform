/**
 * Bill of Quantities (BoQ) builder — pure, no database, no clock.
 *
 * Turns the engine's quantities (engine.ts: foundation, walls, RCC, plaster — line by line per
 * floor and element) into the priced BoQ a contractor reads: grouped by section and by build stage
 * (`stageKey`, used by the schedule), one line per section × stage × material / labour item, plus
 * the work the grey-structure engine doesn't cover — earthwork rates, roof waterproofing, floor and
 * wall tiles, paint, MEP rough-in lump sums, finishing labour, equipment / shuttering hire, site
 * overheads and contingency — all from the resolved rulebook values (`params`).
 *
 * Every line keeps a human-readable `trace` (each contributing formula with its numbers) and a
 * one-line `formula`. Money is BigInt paisa, multiplied with Decimal (no float rounding drift).
 *
 * Rules (README → "How the estimate is calculated"):
 *   - quantityWithWastage = quantity × (1 + wastage %) with the rulebook wastage per material
 *   - MATERIAL rate = company price list (project quality category), converted to the rate's unit
 *   - OWNER-supplied lines (project supply split) keep their quantity but never a rate / amount;
 *     GREY_OWNER_FINISHING: every FINISHING-stage material is the owner's and finishing labour is
 *     left out (the owner does the finishing)
 *   - LABOUR = company sub-contract piece rates; LUMP_SUM = rulebook Rs rates
 *   - direct cost = Σ contractor line amounts; overheads = direct × siteOverheadPercent;
 *     contingency = (direct + overheads) × contingencyPercent; total = Σ
 */
import { Prisma } from '../../generated/prisma/client.js';
import {
  isBarSteel,
  MATERIAL_UNITS,
  MATERIALS,
  toBaseUnit,
  wastageOf,
  type ElementKey,
  type EstimateInput,
  type EstimateLine,
  type EstimateQuantities,
  type FloorLevelKey,
  type MaterialKey,
  type PriceEntry,
  type SuppliedByKey,
} from './engine.js';
import type { EstimateSettings } from './settings.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const BOQ_SECTIONS = [
  'EXCAVATION_EARTHWORK',
  'CONCRETE',
  'STEEL',
  'MASONRY',
  'PLASTER',
  'ROOF_WATERPROOFING',
  'FLOORING_TILES',
  'PAINT',
  'MEP_ROUGH_IN',
  'GREY_LABOUR',
  'FINISHING_LABOUR',
  'EQUIPMENT_SHUTTERING',
  'SITE_OVERHEADS',
  'CONTINGENCY',
] as const;
export type BoqSection = (typeof BOQ_SECTIONS)[number];

export const SECTION_LABELS: Record<BoqSection, string> = {
  EXCAVATION_EARTHWORK: 'Excavation & earthwork',
  CONCRETE: 'Concrete (PCC / RCC)',
  STEEL: 'Steel',
  MASONRY: 'Masonry',
  PLASTER: 'Plaster',
  ROOF_WATERPROOFING: 'Roof & waterproofing',
  FLOORING_TILES: 'Flooring & wall tiles',
  PAINT: 'Paint',
  MEP_ROUGH_IN: 'MEP rough-in',
  GREY_LABOUR: 'Grey-structure labour',
  FINISHING_LABOUR: 'Finishing labour',
  EQUIPMENT_SHUTTERING: 'Equipment & shuttering',
  SITE_OVERHEADS: 'Site overheads',
  CONTINGENCY: 'Contingency',
};

/** Build stages (the schedule's stage keys, Step 13). */
export const BUILD_STAGES = ['FOUNDATION_PLINTH', 'GF_STRUCTURE', 'F1_STRUCTURE', 'F2_STRUCTURE', 'F3_STRUCTURE', 'MUMTY_ROOF', 'PLASTER_MEP', 'FINISHING'] as const;
export type BuildStageKey = (typeof BUILD_STAGES)[number];

const STAGE_OF_LEVEL: Record<FloorLevelKey, BuildStageKey> = {
  BASEMENT: 'FOUNDATION_PLINTH',
  GROUND: 'GF_STRUCTURE',
  FIRST: 'F1_STRUCTURE',
  SECOND: 'F2_STRUCTURE',
  THIRD: 'F3_STRUCTURE',
  MUMTY: 'MUMTY_ROOF',
};

export const FINISH_MATERIALS = ['floorTiles', 'wallTiles', 'paint', 'primer'] as const;
export type FinishMaterial = (typeof FINISH_MATERIALS)[number];
export type BoqMaterialKey = MaterialKey | FinishMaterial;
export const BOQ_MATERIALS: BoqMaterialKey[] = [...MATERIALS, ...FINISH_MATERIALS];
export const BOQ_MATERIAL_UNITS: Record<BoqMaterialKey, string> = { ...MATERIAL_UNITS, floorTiles: 'sqft', wallTiles: 'sqft', paint: 'gallon', primer: 'gallon' };

export const MATERIAL_LABELS: Record<BoqMaterialKey, string> = {
  cement: 'Cement',
  bricks: 'Bricks',
  blocks: 'Concrete blocks',
  sand: 'Sand',
  crush: 'Crush (bajri)',
  steel: 'Steel',
  steel10: 'Steel #3 (10 mm)',
  steel12: 'Steel #4 (12 mm)',
  steel16: 'Steel #5 (16 mm)',
  steel20: 'Steel #6 (20 mm)',
  tIron: 'T-iron garders',
  roofTile: 'Roof tiles',
  precastPlank: 'Precast planks',
  steelDeck: 'Steel deck sheet',
  waterproofing: 'Waterproofing compound',
  bitumen: 'Bitumen',
  termite: 'Termite chemical',
  stone: 'Stone',
  floorTiles: 'Floor tiles',
  wallTiles: 'Wall tiles',
  paint: 'Emulsion paint',
  primer: 'Primer',
};

const ELEMENT_LABELS: Record<ElementKey, string> = {
  excavation: 'excavation',
  pcc: 'PCC',
  footing: 'footing',
  foundationMasonry: 'foundation masonry',
  dpc: 'DPC',
  termite: 'termite treatment',
  walls: 'walls',
  parapet: 'parapet',
  slab: 'slab',
  chajja: 'sunshade',
  girders: 'garders',
  roofInfill: 'roof infill',
  screed: 'screed',
  earthFill: 'earth filling',
  planks: 'planks',
  deck: 'deck',
  topping: 'topping',
  frame: 'beams + columns',
  beams: 'beams',
  columns: 'columns',
  lintels: 'lintels',
  plasterInternal: 'internal plaster',
  plasterCeiling: 'ceiling plaster',
  plasterExternal: 'external plaster',
  plasterParapet: 'parapet plaster',
};

export const BOQ_LABOUR_ITEMS = ['BRICK_MASONRY', 'PLASTER', 'SHUTTERING', 'STEEL_FIXING', 'TILE_LAYING', 'PAINT', 'WATERPROOFING'] as const;
export type BoqLabourItem = (typeof BOQ_LABOUR_ITEMS)[number];
/** The LaborRate unit each piece rate must have. */
export const BOQ_LABOUR_UNITS: Record<BoqLabourItem, string> = {
  BRICK_MASONRY: 'BRICK',
  PLASTER: 'SQFT',
  SHUTTERING: 'SQFT',
  STEEL_FIXING: 'TON',
  TILE_LAYING: 'SQFT',
  PAINT: 'SQFT',
  WATERPROOFING: 'SQFT',
};
const LABOUR_LABELS: Record<BoqLabourItem, string> = {
  BRICK_MASONRY: 'Brick / block masonry labour',
  PLASTER: 'Plaster labour',
  SHUTTERING: 'Shuttering labour',
  STEEL_FIXING: 'Steel fixing labour',
  TILE_LAYING: 'Tile laying labour',
  PAINT: 'Paint labour',
  WATERPROOFING: 'Roof waterproofing',
};

export type BoqPriceBook = Partial<Record<BoqMaterialKey, PriceEntry>>;
export interface BoqLabourRates {
  pieceRates: Partial<Record<BoqLabourItem, { unit: string; ratePaisa: bigint; label: string }>>;
}

export type BoqKind = 'MATERIAL' | 'LABOUR' | 'LUMP_SUM' | 'PERCENT';
export type BoqRateStatus = 'OK' | 'RATE_MISSING' | 'UNIT_MISMATCH' | 'OWNER_SUPPLIED';
export type ContractKindKey = 'FULL' | 'GREY_OWNER_FINISHING' | 'LABOR_ONLY';

export interface BoqLine {
  lineKey: string;
  section: BoqSection;
  stageKey: BuildStageKey | null;
  kind: BoqKind;
  description: string;
  /** Estimate material key (cement, steel12, floorTiles …) or labour item; null for lump sums / percentages. */
  material: string | null;
  materialId: string | null;
  unit: string;
  /** Net quantity (without wastage). PERCENT lines: the percentage. */
  quantity: number;
  wastagePercent: number;
  quantityWithWastage: number;
  suppliedBy: SuppliedByKey;
  formula: string;
  trace: string[];
  ratePaisa: bigint | null;
  rateUnit: string | null;
  /** Rate units per line unit (kg → ton 0.001 …); null without a usable rate. */
  rateFactor: number | null;
  /** Quantity in the rate's unit (PERCENT lines: the base amount in paisa). */
  rateQuantity: number | null;
  amountPaisa: bigint | null;
  rateStatus: BoqRateStatus | null;
}

export interface BoqWarning {
  code: 'RATES_MISSING' | 'LABOUR_RATES_MISSING' | 'STEEL_NORM_DEVIATION' | 'RCC_NORM_DEVIATION';
  message: string;
  params?: Record<string, number>;
  items?: string[];
}

export interface BoqTotals {
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  totalPaisa: bigint;
  perSqftPaisa: bigint | null;
  contractTotalPaisa: bigint | null;
  marginPaisa: bigint | null;
  marginPercent: number | null;
  sections: Record<BoqSection, bigint>;
  stages: Record<BuildStageKey, bigint>;
}

export interface BoqInput {
  input: EstimateInput;
  quantities: EstimateQuantities;
  settings: EstimateSettings;
  /** Resolved rulebook values (rulebook → company → project), every key of rulebookDefs.ts. */
  params: Record<string, number>;
  contractType: ContractKindKey | null;
  prices: BoqPriceBook;
  labourRates: BoqLabourRates;
  contractTotalPaisa: bigint | null;
}

export interface Boq {
  lines: BoqLine[];
  totals: BoqTotals;
  warnings: BoqWarning[];
  coveredAreaSqft: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const D = (v: number | string | bigint) => new Prisma.Decimal(v.toString());
/** Rulebook rupees → paisa. */
export const rsToPaisa = (rupees: number) => BigInt(Math.round(rupees * 100));
const fmt = (n: number) => String(r2(n));

/** rateQuantity = qty × factor (4 dp); amount = rateQuantity × rate, half-up to the paisa. */
export function priceQuantity(qty: number, factor: number | null, ratePaisa: bigint | null): { rateQuantity: number | null; amountPaisa: bigint | null } {
  if (factor === null) return { rateQuantity: null, amountPaisa: null };
  const rateQuantity = r4(qty * factor);
  if (ratePaisa === null) return { rateQuantity, amountPaisa: null };
  return { rateQuantity, amountPaisa: BigInt(D(rateQuantity).mul(D(ratePaisa)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)) };
}

/** base × percent ÷ 100, half-up to the paisa. */
export const percentOf = (base: bigint, percent: number) => BigInt(D(base).mul(D(percent)).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));

const ROOF_ELEMENTS: ElementKey[] = ['girders', 'roofInfill', 'screed', 'earthFill', 'planks', 'deck'];
const MASONRY_ELEMENTS: ElementKey[] = ['foundationMasonry', 'walls', 'parapet'];
const RCC_ELEMENTS: ElementKey[] = ['footing', 'slab', 'chajja', 'frame', 'beams', 'columns', 'lintels', 'topping'];

export function stageOfLine(l: Pick<EstimateLine, 'stage' | 'floor' | 'element'>): BuildStageKey {
  if (l.stage === 'FOUNDATION') return 'FOUNDATION_PLINTH';
  if (l.stage === 'PLASTER') return 'PLASTER_MEP';
  if (l.element === 'parapet') return 'MUMTY_ROOF';
  return l.floor ? STAGE_OF_LEVEL[l.floor.level] : 'GF_STRUCTURE';
}

export function sectionOfLine(l: Pick<EstimateLine, 'stage' | 'element' | 'material'>): BoqSection {
  if (l.material === 'waterproofing' || l.material === 'bitumen') return 'ROOF_WATERPROOFING';
  if (l.material === 'termite') return 'EXCAVATION_EARTHWORK';
  if (ROOF_ELEMENTS.includes(l.element)) return 'ROOF_WATERPROOFING';
  if (l.stage === 'PLASTER') return 'PLASTER';
  if (MASONRY_ELEMENTS.includes(l.element)) return 'MASONRY';
  if (isBarSteel(l.material as MaterialKey | null)) return 'STEEL';
  return 'CONCRETE';
}

const traceOf = (l: EstimateLine) => `${l.floor ? l.floor.name : 'Foundation'} · ${ELEMENT_LABELS[l.element]}: ${l.formulaText} = ${fmt(l.netQuantity)} ${l.unit}`;

const sectionIdx = (s: BoqSection) => BOQ_SECTIONS.indexOf(s);
const stageIdx = (s: BuildStageKey | null) => (s === null ? BUILD_STAGES.length : BUILD_STAGES.indexOf(s));
const itemIdx = (m: string | null) => {
  if (m === null) return 999;
  const i = BOQ_MATERIALS.indexOf(m as BoqMaterialKey);
  return i >= 0 ? i : 100 + BOQ_LABOUR_ITEMS.indexOf(m as BoqLabourItem);
};

// ─── Builder ────────────────────────────────────────────────────────────────

export function buildBoq(b: BoqInput): Boq {
  const { quantities: q, settings: s, params: P } = b;
  const lines: BoqLine[] = [];
  const warnings: BoqWarning[] = [];
  const covered = q.basis.coveredAreaSqft;
  const greyOwnerFinishing = b.contractType === 'GREY_OWNER_FINISHING';

  const materialLine = (section: BoqSection, stageKey: BuildStageKey, material: BoqMaterialKey, net: number, wastagePercent: number, trace: string[]) => {
    if (net <= 0) return;
    const unit = BOQ_MATERIAL_UNITS[material];
    const entry = b.prices[material];
    const owner = (greyOwnerFinishing && stageKey === 'FINISHING') || entry?.suppliedBy === 'OWNER';
    const withWastage = r2(net * (1 + wastagePercent / 100));
    const base = {
      lineKey: `${section}.${stageKey}.${material}`,
      section,
      stageKey,
      kind: 'MATERIAL' as const,
      description: entry?.materialName ?? MATERIAL_LABELS[material],
      material,
      materialId: entry?.materialId ?? null,
      unit,
      quantity: r2(net),
      wastagePercent,
      quantityWithWastage: withWastage,
      formula: `${trace.length} item${trace.length === 1 ? '' : 's'} · ${fmt(net)} ${unit} + ${wastagePercent}% wastage = ${fmt(withWastage)} ${unit}`,
      trace,
    };
    if (owner) {
      lines.push({ ...base, suppliedBy: 'OWNER', ratePaisa: null, rateUnit: null, rateFactor: null, rateQuantity: null, amountPaisa: null, rateStatus: 'OWNER_SUPPLIED' });
      return;
    }
    if (!entry || entry.ratePaisa === null || !entry.unit) {
      lines.push({ ...base, suppliedBy: 'CONTRACTOR', ratePaisa: null, rateUnit: entry?.unit ?? null, rateFactor: null, rateQuantity: null, amountPaisa: null, rateStatus: 'RATE_MISSING' });
      return;
    }
    const factor = toBaseUnit(1, unit, entry.unit, entry.altUnits);
    if (factor === null) {
      lines.push({ ...base, suppliedBy: 'CONTRACTOR', ratePaisa: entry.ratePaisa, rateUnit: entry.unit, rateFactor: null, rateQuantity: null, amountPaisa: null, rateStatus: 'UNIT_MISMATCH' });
      return;
    }
    const priced = priceQuantity(withWastage, factor, entry.ratePaisa);
    lines.push({ ...base, suppliedBy: 'CONTRACTOR', ratePaisa: entry.ratePaisa, rateUnit: entry.unit, rateFactor: factor, ...priced, rateStatus: 'OK' });
  };

  const lumpSum = (section: BoqSection, stageKey: BuildStageKey, key: string, description: string, qty: number, unit: string, rupees: number, formula: string, trace: string[]) => {
    if (qty <= 0) return;
    const rate = rsToPaisa(rupees);
    lines.push({
      lineKey: `${section}.${stageKey}.${key}`,
      section,
      stageKey,
      kind: 'LUMP_SUM',
      description,
      material: null,
      materialId: null,
      unit,
      quantity: r4(qty),
      wastagePercent: 0,
      quantityWithWastage: r4(qty),
      suppliedBy: 'CONTRACTOR',
      formula,
      trace,
      ratePaisa: rate,
      rateUnit: unit,
      rateFactor: 1,
      ...priceQuantity(r4(qty), 1, rate),
      rateStatus: 'OK',
    });
  };

  const missingLabour = new Set<BoqLabourItem>();
  const labourLine = (section: BoqSection, stageKey: BuildStageKey, item: BoqLabourItem, qty: number, unit: string, formula: string, trace: string[]) => {
    if (qty <= 0) return;
    const rate = b.labourRates.pieceRates[item];
    const base = {
      lineKey: `${section}.${stageKey}.${item}`,
      section,
      stageKey,
      kind: 'LABOUR' as const,
      description: rate?.label ?? LABOUR_LABELS[item],
      material: item,
      materialId: null,
      unit,
      quantity: r4(qty),
      wastagePercent: 0,
      quantityWithWastage: r4(qty),
      suppliedBy: 'CONTRACTOR' as const,
      formula,
      trace,
    };
    if (!rate) {
      missingLabour.add(item);
      lines.push({ ...base, ratePaisa: null, rateUnit: null, rateFactor: null, rateQuantity: null, amountPaisa: null, rateStatus: 'RATE_MISSING' });
    } else if (rate.unit !== BOQ_LABOUR_UNITS[item]) {
      missingLabour.add(item);
      lines.push({ ...base, ratePaisa: rate.ratePaisa, rateUnit: rate.unit, rateFactor: null, rateQuantity: null, amountPaisa: null, rateStatus: 'UNIT_MISMATCH' });
    } else {
      lines.push({ ...base, ratePaisa: rate.ratePaisa, rateUnit: rate.unit, rateFactor: 1, ...priceQuantity(r4(qty), 1, rate.ratePaisa), rateStatus: 'OK' });
    }
  };

  // 1. Engine materials, grouped by section × stage × material
  const groups = new Map<string, { section: BoqSection; stageKey: BuildStageKey; material: MaterialKey; net: number; trace: string[] }>();
  for (const l of q.lines) {
    if (l.kind !== 'MATERIAL' || !l.material) continue;
    const section = sectionOfLine(l);
    const stageKey = stageOfLine(l);
    const key = `${section}.${stageKey}.${l.material}`;
    const g = groups.get(key) ?? { section, stageKey, material: l.material, net: 0, trace: [] };
    g.net += l.netQuantity;
    g.trace.push(traceOf(l));
    groups.set(key, g);
  }
  for (const g of groups.values()) materialLine(g.section, g.stageKey, g.material, g.net, wastageOf(s, g.material), g.trace);

  // 2. Earthwork: excavation, plinth filling, roof earth filling
  const work = (pred: (l: EstimateLine) => boolean) => q.lines.filter((l) => l.kind === 'WORK' && pred(l));
  const excavation = work((l) => l.element === 'excavation');
  const excavationCft = sum(excavation.map((l) => l.netQuantity));
  lumpSum('EXCAVATION_EARTHWORK', 'FOUNDATION_PLINTH', 'excavation', 'Excavation (khudai)', excavationCft, 'cft', P['excavationRsPerCft'] ?? 0, `${fmt(excavationCft)} cft × Rs ${P['excavationRsPerCft']} per cft`, excavation.map(traceOf));
  const lowest = q.basis.floors.find((f) => f.rooms > 0) ?? q.basis.floors[0];
  const f = b.input.foundation;
  if (f && excavation.length) {
    const footprint = lowest?.footprintSqft || (b.input.plotAreaSqft ?? 0);
    const fill = footprint * f.plinthHeightFt;
    lumpSum('EXCAVATION_EARTHWORK', 'FOUNDATION_PLINTH', 'plinthFilling', 'Earth filling of the plinth (bharai)', fill, 'cft', P['earthFillingRsPerCft'] ?? 0, `Footprint ${fmt(footprint)} sq ft × plinth ${f.plinthHeightFt} ft = ${fmt(fill)} cft × Rs ${P['earthFillingRsPerCft']} per cft`, [
      `Lowest floor footprint ${fmt(footprint)} sq ft × plinth height ${f.plinthHeightFt} ft`,
    ]);
  }
  const roofFill = new Map<BuildStageKey, EstimateLine[]>();
  for (const l of work((x) => x.element === 'earthFill')) roofFill.set(stageOfLine(l), [...(roofFill.get(stageOfLine(l)) ?? []), l]);
  for (const [stageKey, ls] of roofFill) {
    const cft = sum(ls.map((l) => l.netQuantity));
    lumpSum('ROOF_WATERPROOFING', stageKey, 'roofEarthFill', 'Roof earth filling', cft, 'cft', P['earthFillingRsPerCft'] ?? 0, `${fmt(cft)} cft × Rs ${P['earthFillingRsPerCft']} per cft`, ls.map(traceOf));
  }

  // 3. Roof waterproofing on the main roof (highest floor with rooms, not the mumty)
  const roofFloor = [...q.basis.floors].reverse().find((x) => x.rooms > 0 && x.level !== 'MUMTY');
  if (roofFloor && roofFloor.footprintSqft > 0) {
    const area = roofFloor.footprintSqft;
    const trace = [`${roofFloor.name} roof footprint ${fmt(area)} sq ft`];
    if (b.labourRates.pieceRates.WATERPROOFING?.unit === 'SQFT') {
      labourLine('ROOF_WATERPROOFING', 'MUMTY_ROOF', 'WATERPROOFING', area, 'sqft', `${fmt(area)} sq ft × sub-contract rate`, trace);
    } else {
      lumpSum('ROOF_WATERPROOFING', 'MUMTY_ROOF', 'roofWaterproofing', 'Roof waterproofing', area, 'sqft', P['roofWaterproofingRsPerSqft'] ?? 0, `${fmt(area)} sq ft × Rs ${P['roofWaterproofingRsPerSqft']} per sq ft`, trace);
    }
  }

  // 4. Floor + wall tiles
  const rooms = b.input.floors.flatMap((fl) => fl.rooms.map((r) => ({ ...r, floorName: fl.name })));
  const floorTrace: string[] = [];
  let floorArea = 0;
  const wallTrace: string[] = [];
  let wallArea = 0;
  for (const r of rooms) {
    const a = r.lengthFt * r.widthFt;
    if (a <= 0) continue;
    floorArea += a;
    floorTrace.push(`${r.floorName} · ${r.name ?? 'Room'}: ${r.lengthFt} × ${r.widthFt} ft = ${fmt(a)} sq ft`);
    const kitchen = r.type === 'KITCHEN';
    if (!kitchen && !r.isWet) continue;
    const h = Math.min(kitchen ? (P['wallTileHeightKitchenFt'] ?? 0) : (P['wallTileHeightBathFt'] ?? 0), r.heightFt);
    if (h <= 0) continue;
    const doors = sum(r.openings.filter((o) => o.type === 'DOOR').map((o) => o.widthFt * Math.min(o.heightFt, h) * o.quantity));
    const wa = Math.max(0, 2 * (r.lengthFt + r.widthFt) * h - doors);
    wallArea += wa;
    wallTrace.push(`${r.floorName} · ${r.name ?? 'Room'} (${kitchen ? 'kitchen splash' : 'wet room'}): 2 × (${r.lengthFt} + ${r.widthFt}) × ${h} ft − doors ${fmt(doors)} sq ft = ${fmt(wa)} sq ft`);
  }
  const tileW = P['tileWastagePercent'] ?? 0;
  materialLine('FLOORING_TILES', 'FINISHING', 'floorTiles', floorArea, tileW, floorTrace);
  materialLine('FLOORING_TILES', 'FINISHING', 'wallTiles', wallArea, tileW, wallTrace);
  if (floorArea > 0 && (P['tileBeddingThicknessIn'] ?? 0) > 0) {
    const t = P['tileBeddingThicknessIn']!;
    const n = P['tileBeddingMix'] ?? 4;
    const dry = (floorArea * t) / 12 * s.mortarDryFactor;
    const bed = `Floor ${fmt(floorArea)} sq ft × ${t}″ bed × ${s.mortarDryFactor} dry`;
    materialLine('FLOORING_TILES', 'FINISHING', 'cement', dry / (1 + n) / s.cementBagCft, wastageOf(s, 'cement'), [`${bed} × 1/${1 + n} ÷ ${s.cementBagCft} cft per bag`]);
    materialLine('FLOORING_TILES', 'FINISHING', 'sand', (dry * n) / (1 + n), wastageOf(s, 'sand'), [`${bed} × ${n}/${1 + n}`]);
  }

  // 5. Paint on the plastered faces (walls, ceilings, external, parapet) not covered by wall tiles
  const plasterWork = work((l) => l.stage === 'PLASTER' && l.measure === 'AREA');
  const plastered = sum(plasterWork.map((l) => l.netQuantity));
  const painted = Math.max(0, plastered - wallArea);
  const paintTrace = [`Plastered area ${fmt(plastered)} sq ft − wall tiles ${fmt(wallArea)} sq ft = ${fmt(painted)} sq ft`];
  if (painted > 0) {
    const coats = P['paintCoats'] ?? 0;
    const cov = P['paintCoverageSqftPerGallon'] ?? 0;
    if (coats > 0 && cov > 0) materialLine('PAINT', 'FINISHING', 'paint', (painted * coats) / cov, P['paintWastagePercent'] ?? 0, [...paintTrace, `${fmt(painted)} sq ft × ${coats} coats ÷ ${cov} sq ft per gallon`]);
    const pc = P['primerCoats'] ?? 0;
    const pcov = P['primerCoverageSqftPerGallon'] ?? 0;
    if (pc > 0 && pcov > 0) materialLine('PAINT', 'FINISHING', 'primer', (painted * pc) / pcov, P['paintWastagePercent'] ?? 0, [...paintTrace, `${fmt(painted)} sq ft × ${pc} coat ÷ ${pcov} sq ft per gallon`]);
  }

  // 6. MEP rough-in (rulebook lump sums)
  const wetRooms = rooms.filter((r) => r.isWet || r.type === 'KITCHEN');
  if (covered > 0 && rooms.length) {
    lumpSum('MEP_ROUGH_IN', 'PLASTER_MEP', 'electrical', 'Electrical rough-in (conduits, boxes)', covered, 'sqft', P['mepElectricalRsPerSqft'] ?? 0, `Covered ${fmt(covered)} sq ft × Rs ${P['mepElectricalRsPerSqft']} per sq ft`, [`Covered area ${fmt(covered)} sq ft`]);
    lumpSum('MEP_ROUGH_IN', 'PLASTER_MEP', 'plumbing', 'Plumbing rough-in (supply + drainage pipes)', wetRooms.length, 'nos', P['mepPlumbingRsPerWetRoom'] ?? 0, `${wetRooms.length} wet rooms × Rs ${P['mepPlumbingRsPerWetRoom']}`, wetRooms.map((r) => `${r.floorName} · ${r.name ?? 'Room'}`));
    lumpSum('MEP_ROUGH_IN', 'PLASTER_MEP', 'sewerageGas', 'Sewerage, rain-water and gas rough-in', 1, 'LS', P['mepSewerageGasRsLumpSum'] ?? 0, `Lump sum Rs ${P['mepSewerageGasRsLumpSum']}`, ['One per house']);
  }

  // 7. Grey-structure labour
  if (s.includeLabour) {
    if (s.labourRatePerSqftPaisa !== null) {
      const rate = BigInt(s.labourRatePerSqftPaisa);
      const footprints = q.basis.floors.filter((x) => x.footprintSqft > 0);
      for (const fl of footprints) {
        const stageKey = STAGE_OF_LEVEL[fl.level];
        lines.push({
          lineKey: `GREY_LABOUR.${stageKey}.PER_SQFT`,
          section: 'GREY_LABOUR',
          stageKey,
          kind: 'LABOUR',
          description: 'Grey-structure labour (per sq ft)',
          material: 'PER_SQFT',
          materialId: null,
          unit: 'sqft',
          quantity: r4(fl.footprintSqft),
          wastagePercent: 0,
          quantityWithWastage: r4(fl.footprintSqft),
          suppliedBy: 'CONTRACTOR',
          formula: `${fmt(fl.footprintSqft)} sq ft × project labour rate`,
          trace: [`${fl.name} footprint ${fmt(fl.footprintSqft)} sq ft`],
          ratePaisa: rate,
          rateUnit: 'sqft',
          rateFactor: 1,
          ...priceQuantity(r4(fl.footprintSqft), 1, rate),
          rateStatus: 'OK',
        });
      }
    } else {
      const byStage = (pred: (l: EstimateLine) => boolean) => {
        const m = new Map<BuildStageKey, { qty: number; trace: string[] }>();
        for (const l of q.lines.filter(pred)) {
          const st = stageOfLine(l);
          const x = m.get(st) ?? { qty: 0, trace: [] };
          x.qty += l.netQuantity;
          x.trace.push(traceOf(l));
          m.set(st, x);
        }
        return m;
      };
      for (const [st, x] of byStage((l) => (l.material === 'bricks' || l.material === 'blocks') && l.stage !== 'RCC')) {
        labourLine('GREY_LABOUR', st, 'BRICK_MASONRY', x.qty, 'nos', `${fmt(x.qty)} bricks / blocks × piece rate`, x.trace);
      }
      for (const [st, x] of byStage((l) => l.kind === 'WORK' && l.stage === 'PLASTER' && l.measure === 'AREA')) {
        labourLine('GREY_LABOUR', st, 'PLASTER', x.qty, 'sqft', `${fmt(x.qty)} sq ft × piece rate`, x.trace);
      }
      for (const [st, x] of byStage((l) => l.measure === 'SHUTTERING')) {
        labourLine('GREY_LABOUR', st, 'SHUTTERING', x.qty, 'sqft', `${fmt(x.qty)} sq ft × piece rate`, x.trace);
      }
      for (const [st, x] of byStage((l) => l.kind === 'MATERIAL' && isBarSteel(l.material))) {
        labourLine('GREY_LABOUR', st, 'STEEL_FIXING', x.qty / 1000, 'ton', `${fmt(x.qty)} kg ÷ 1000 × piece rate per ton`, x.trace);
      }
    }
  }

  // 8. Finishing labour (not for GREY_OWNER_FINISHING: the owner does the finishing)
  if (!greyOwnerFinishing) {
    const tiles = floorArea + wallArea;
    labourLine('FINISHING_LABOUR', 'FINISHING', 'TILE_LAYING', tiles, 'sqft', `Floor ${fmt(floorArea)} + wall ${fmt(wallArea)} sq ft × piece rate`, [...floorTrace, ...wallTrace]);
    labourLine('FINISHING_LABOUR', 'FINISHING', 'PAINT', painted, 'sqft', `${fmt(painted)} sq ft × piece rate (all coats)`, paintTrace);
  }

  // 9. Equipment & shuttering hire (lump sum per sq ft of covered area)
  if (covered > 0) {
    lumpSum('EQUIPMENT_SHUTTERING', 'FOUNDATION_PLINTH', 'equipment', 'Equipment & shuttering hire (plates, props, mixer, vibrator, scaffolding)', covered, 'sqft', P['equipmentShutteringRsPerSqft'] ?? 0, `Covered ${fmt(covered)} sq ft × Rs ${P['equipmentShutteringRsPerSqft']} per sq ft`, [`Covered area ${fmt(covered)} sq ft`]);
  }

  // 10–11. Site overheads and contingency (PERCENT lines)
  lines.sort((x, y) => sectionIdx(x.section) - sectionIdx(y.section) || stageIdx(x.stageKey) - stageIdx(y.stageKey) || itemIdx(x.material) - itemIdx(y.material) || x.lineKey.localeCompare(y.lineKey));
  lines.push(percentLine('SITE_OVERHEADS', 'siteOverheads', 'Site overheads', P['siteOverheadPercent'] ?? 0));
  lines.push(percentLine('CONTINGENCY', 'contingency', 'Contingency', P['contingencyPercent'] ?? 0));
  const totals = summarize(lines, covered, b.contractTotalPaisa);

  // Warnings
  const missing = lines.filter((l) => l.kind === 'MATERIAL' && l.suppliedBy === 'CONTRACTOR' && l.amountPaisa === null);
  if (missing.length) {
    const items = [...new Set(missing.map((l) => l.material!))];
    warnings.push({ code: 'RATES_MISSING', message: `No price-list rate for: ${items.join(', ')} — these lines are left out of the cost`, items });
  }
  if (missingLabour.size) warnings.push({ code: 'LABOUR_RATES_MISSING', message: `No sub-contract rate for: ${[...missingLabour].join(', ')} — left out of the cost`, items: [...missingLabour] });
  if (covered > 0 && rooms.length) {
    const framed = q.basis.structureType === 'FRAMED';
    const steelKg = sum(q.lines.filter((l) => l.kind === 'MATERIAL' && isBarSteel(l.material)).map((l) => l.netQuantity));
    const rccCft = sum(q.lines.filter((l) => l.kind === 'WORK' && l.measure === 'VOLUME' && RCC_ELEMENTS.includes(l.element)).map((l) => l.netQuantity));
    const check = (code: BoqWarning['code'], actual: number, norm: number | undefined, what: string, unit: string) => {
      if (!norm || norm <= 0) return;
      const percent = Math.round(((actual - norm) / norm) * 100);
      if (Math.abs(percent) <= 30) return;
      warnings.push({
        code,
        params: { actual: r2(actual), norm, percent },
        message: `${what} works out to ${r2(actual)} ${unit} per sq ft of covered area, ${Math.abs(percent)} % ${percent < 0 ? 'below' : 'above'} the rulebook norm of ${norm} — check the structure inputs`,
      });
    };
    check('STEEL_NORM_DEVIATION', steelKg / covered, framed ? P['steelKgPerSqftFramed'] : P['steelKgPerSqftLoadBearing'], 'Steel', 'kg');
    check('RCC_NORM_DEVIATION', rccCft / covered, framed ? P['rccCftPerSqftFramed'] : P['rccCftPerSqftLoadBearing'], 'RCC concrete', 'cft');
  }

  return { lines, totals, warnings, coveredAreaSqft: covered };
}

function percentLine(section: 'SITE_OVERHEADS' | 'CONTINGENCY', key: string, description: string, percent: number): BoqLine {
  return {
    lineKey: `${section}.ALL.${key}`,
    section,
    stageKey: null,
    kind: 'PERCENT',
    description,
    material: null,
    materialId: null,
    unit: '%',
    quantity: percent,
    wastagePercent: 0,
    quantityWithWastage: percent,
    suppliedBy: 'CONTRACTOR',
    formula: section === 'SITE_OVERHEADS' ? `${percent}% of the direct cost` : `${percent}% of (direct cost + site overheads)`,
    trace: [],
    ratePaisa: null,
    rateUnit: null,
    rateFactor: null,
    rateQuantity: 0,
    amountPaisa: 0n,
    rateStatus: 'OK',
  };
}

/** Line shape the totals need (BoQ lines and stored estimate lines with their effective amounts). */
export interface TotalsLine {
  section: BoqSection | string;
  stageKey: string | null;
  kind: BoqKind | string;
  suppliedBy: SuppliedByKey | string;
  quantity: number;
  amountPaisa: bigint | null;
  rateQuantity: number | null;
}

/**
 * Totals of a set of lines. PERCENT lines are (re)computed in place: SITE_OVERHEADS = direct ×
 * its %, CONTINGENCY = (direct + overheads) × its % (`rateQuantity` = the base, `amountPaisa`).
 */
export function summarize(lines: TotalsLine[], coveredAreaSqft: number, contractTotalPaisa: bigint | null): BoqTotals {
  const sections = Object.fromEntries(BOQ_SECTIONS.map((x) => [x, 0n])) as Record<BoqSection, bigint>;
  const stages = Object.fromEntries(BUILD_STAGES.map((x) => [x, 0n])) as Record<BuildStageKey, bigint>;
  let direct = 0n;
  for (const l of lines) {
    if (l.kind === 'PERCENT' || l.suppliedBy !== 'CONTRACTOR' || l.amountPaisa === null) continue;
    direct += l.amountPaisa;
    sections[l.section as BoqSection] += l.amountPaisa;
    if (l.stageKey) stages[l.stageKey as BuildStageKey] += l.amountPaisa;
  }
  let overhead = 0n;
  for (const l of lines.filter((x) => x.kind === 'PERCENT' && x.section === 'SITE_OVERHEADS')) {
    l.rateQuantity = Number(direct);
    l.amountPaisa = percentOf(direct, l.quantity);
    overhead += l.amountPaisa;
  }
  let contingency = 0n;
  for (const l of lines.filter((x) => x.kind === 'PERCENT' && x.section === 'CONTINGENCY')) {
    l.rateQuantity = Number(direct + overhead);
    l.amountPaisa = percentOf(direct + overhead, l.quantity);
    contingency += l.amountPaisa;
  }
  sections.SITE_OVERHEADS = overhead;
  sections.CONTINGENCY = contingency;
  const total = direct + overhead + contingency;
  const margin = contractTotalPaisa === null ? null : contractTotalPaisa - total;
  return {
    directCostPaisa: direct,
    overheadPaisa: overhead,
    contingencyPaisa: contingency,
    totalPaisa: total,
    perSqftPaisa: coveredAreaSqft > 0 ? BigInt(D(total).div(D(coveredAreaSqft)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)) : null,
    contractTotalPaisa,
    marginPaisa: margin,
    marginPercent: contractTotalPaisa && contractTotalPaisa > 0n && margin !== null ? r2((Number(margin) / Number(contractTotalPaisa)) * 100) : null,
    sections,
    stages,
  };
}

