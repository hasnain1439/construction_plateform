/**
 * The estimation rulebook — every rule-of-thumb number the estimate uses, as platform parameters.
 *
 * This file is the code-side definition of the parameter set: key, group, unit, labels, the
 * built-in v1 value per region and the safe range a company / project override must stay in.
 * The platform `Rulebook` / `RulebookParameter` tables hold the versioned, published values
 * (v1 is inserted by migration 20261101090000_estimation_rulebook from these numbers); the
 * built-in values here are only used when a region has no published version yet.
 *
 * EVERY v1 value is PENDING_ENGINEER_REVIEW — Pakistani rules of thumb (Punjab practice; Karachi /
 * Sindh = concrete-block walls) that a civil engineer still has to confirm. README → "How the
 * estimate is calculated" lists them.
 *
 * Kinds:
 *   NUMBER – the value as is
 *   MIX2   – cement : sand mortar / plaster "1:n" stored as n (the sand parts)
 *   MIX3   – concrete "1:n:2n" stored as n (1.5 → 1:1.5:3, 2 → 1:2:4)
 *   FLAG   – 0 / 1
 * Scope:
 *   SETTING – an engine setting (src/modules/estimate/settings.ts, same key)
 *   BOQ     – used by the BoQ builder (finishes, MEP, lump sums, overheads …)
 *   NORM    – sanity check only (warnings when the estimate is far from it); quick estimates (Step 12)
 *   SCHEDULE – labour productivity / curing used for durations (Step 13), not by the estimate
 */

export type RulebookRegion = 'PUNJAB_KP' | 'KARACHI_SINDH';
export const RULEBOOK_REGIONS: RulebookRegion[] = ['PUNJAB_KP', 'KARACHI_SINDH'];

export const RULEBOOK_GROUPS = [
  'WALLS',
  'MASONRY',
  'CONCRETE',
  'STEEL',
  'PLASTER',
  'FACTORS',
  'WASTAGE',
  'WATERPROOFING',
  'FINISHES',
  'MEP',
  'EARTHWORK',
  'OVERHEADS',
  'NORMS',
  'PRODUCTIVITY',
] as const;
export type RulebookGroup = (typeof RULEBOOK_GROUPS)[number];

export type ParamKind = 'NUMBER' | 'MIX2' | 'MIX3' | 'FLAG';
export type ParamScope = 'SETTING' | 'BOQ' | 'NORM' | 'SCHEDULE';

export interface RulebookParamDef {
  key: string;
  group: RulebookGroup;
  unit: string;
  kind: ParamKind;
  scope: ParamScope;
  label: { en: string; roman: string; ur: string };
  description: string;
  /** Built-in v1 values. */
  value: Record<RulebookRegion, number>;
  safeMin: number;
  safeMax: number;
}

const L = (en: string, roman: string, ur: string) => ({ en, roman, ur });
const both = (v: number): Record<RulebookRegion, number> => ({ PUNJAB_KP: v, KARACHI_SINDH: v });
const reg = (punjab: number, sindh: number): Record<RulebookRegion, number> => ({ PUNJAB_KP: punjab, KARACHI_SINDH: sindh });

type D = Omit<RulebookParamDef, 'kind' | 'scope'> & { kind?: ParamKind; scope?: ParamScope };
const p = (d: D): RulebookParamDef => ({ kind: 'NUMBER', scope: 'SETTING', ...d });

export const RULEBOOK_PARAMS: readonly RulebookParamDef[] = [
  // ─── Walls ────────────────────────────────────────────────────────────────
  p({ key: 'externalWallThicknessIn', group: 'WALLS', unit: 'in', label: L('External wall thickness', 'Bahar ki deewar ki motai', 'بیرونی دیوار کی موٹائی'), description: 'External walls (and foundation walls). Punjab 9″ brick; Karachi 6″ block.', value: reg(9, 6), safeMin: 4.5, safeMax: 18 }),
  p({ key: 'internalWallThicknessIn', group: 'WALLS', unit: 'in', label: L('Internal wall thickness', 'Andar ki deewar ki motai', 'اندرونی دیوار کی موٹائی'), description: 'Internal partition walls. Punjab 4.5″ brick; Karachi 4″ block.', value: reg(4.5, 4), safeMin: 3, safeMax: 13.5 }),
  p({ key: 'parapetHeightFt', group: 'WALLS', unit: 'ft', label: L('Roof parapet height', 'Chhat ki mundair ki unchai', 'چھت کی منڈیر کی اونچائی'), description: 'Parapet on the main roof (internal-wall thickness); 0 = none.', value: both(3), safeMin: 0, safeMax: 6 }),

  // ─── Masonry ──────────────────────────────────────────────────────────────
  p({ key: 'blockMasonry', group: 'MASONRY', unit: '0 / 1', kind: 'FLAG', label: L('Concrete blocks instead of bricks', 'Eenton ki jagah blocks', 'اینٹوں کی جگہ بلاک'), description: '1 = walls in concrete blocks counted per sq ft of wall face (Karachi / Sindh); 0 = clay bricks per cft (Punjab / KP).', value: reg(0, 1), safeMin: 0, safeMax: 1 }),
  p({ key: 'bricksPerCft', group: 'MASONRY', unit: 'bricks / cft', label: L('Bricks per cft of brickwork', 'Fi cft eenten', 'فی مکعب فٹ اینٹیں'), description: 'Standard 9 × 4.5 × 3″ bricks per cft of brickwork including mortar joints.', value: both(13.5), safeMin: 12, safeMax: 15 }),
  p({ key: 'blocksPerSqft', group: 'MASONRY', unit: 'blocks / sq ft', label: L('Blocks per sq ft of wall', 'Fi sq ft blocks', 'فی مربع فٹ بلاک'), description: '8 × 16″ face blocks per sq ft of wall face including joints (one block leaf per wall).', value: both(1.125), safeMin: 1, safeMax: 1.3 }),
  p({ key: 'mortarPerCftBrickwork', group: 'MASONRY', unit: 'cft / cft', label: L('Mortar per cft of masonry', 'Fi cft masala', 'فی مکعب فٹ مسالا'), description: 'Wet mortar per cft of masonry. Brick 0.25; block 0.10.', value: reg(0.25, 0.1), safeMin: 0.05, safeMax: 0.4 }),
  p({ key: 'masonryMortarMix', group: 'MASONRY', unit: '1 : n (sand)', kind: 'MIX2', label: L('Masonry mortar mix (cement : sand)', 'Chunai masala (cement : ret)', 'چنائی مسالا (سیمنٹ : ریت)'), description: '1 : 6 for brick / block masonry.', value: both(6), safeMin: 3, safeMax: 8 }),

  // ─── Concrete ─────────────────────────────────────────────────────────────
  p({ key: 'slabThicknessIn', group: 'CONCRETE', unit: 'in', label: L('Roof slab thickness', 'Lenter ki motai', 'لینٹر کی موٹائی'), description: 'Roof slab (lenter) when the floor has no roof details; 6″ for larger spans.', value: both(5), safeMin: 4, safeMax: 9 }),
  p({ key: 'rccMix', group: 'CONCRETE', unit: '1 : n : 2n (sand)', kind: 'MIX3', label: L('RCC mix (cement : sand : crush)', 'RCC masala (cement : ret : bajri)', 'آر سی سی مسالا (سیمنٹ : ریت : بجری)'), description: '2 = 1 : 2 : 4 (slabs, beams, columns, lintels); 1.5 = 1 : 1.5 : 3.', value: both(2), safeMin: 1.5, safeMax: 2 }),
  p({ key: 'frameConcretePercent', group: 'CONCRETE', unit: '%', label: L('Beams + columns concrete (% of slab)', 'Beam + column concrete (lenter ka %)', 'بیم + کالم کنکریٹ (لینٹر کا ٪)'), description: 'RCC frame only, when the floor has no roof details.', value: both(45), safeMin: 20, safeMax: 80 }),
  p({ key: 'lintelWidthIn', group: 'CONCRETE', unit: 'in', label: L('Lintel width', 'Lintel ki chaurai', 'لنٹل کی چوڑائی'), description: 'Lintel width (estimated walls); usually the wall thickness.', value: reg(9, 6), safeMin: 4, safeMax: 18 }),
  p({ key: 'lintelDepthIn', group: 'CONCRETE', unit: 'in', label: L('Lintel depth', 'Lintel ki gehrai', 'لنٹل کی گہرائی'), description: 'Lintel depth over doors and windows.', value: both(6), safeMin: 4, safeMax: 12 }),
  p({ key: 'lintelBearingFt', group: 'CONCRETE', unit: 'ft', label: L('Lintel bearing (both sides)', 'Lintel bearing (dono taraf)', 'لنٹل بیئرنگ (دونوں طرف)'), description: 'Extra lintel length over each opening, both sides together.', value: both(1), safeMin: 0.5, safeMax: 2 }),

  // ─── Steel ────────────────────────────────────────────────────────────────
  p({ key: 'slabSteelPercent', group: 'STEEL', unit: '% of concrete', label: L('Slab steel', 'Lenter sariya', 'لینٹر سریا'), description: 'Steel as % of slab concrete volume (1 % ≈ 2.22 kg per cft).', value: both(1), safeMin: 0.6, safeMax: 1.6 }),
  p({ key: 'frameSteelPercent', group: 'STEEL', unit: '% of concrete', label: L('Beam / column steel', 'Beam / column sariya', 'بیم / کالم سریا'), description: 'Steel as % of beam + column concrete.', value: both(2.5), safeMin: 1.5, safeMax: 4 }),
  p({ key: 'lintelSteelPercent', group: 'STEEL', unit: '% of concrete', label: L('Lintel steel', 'Lintel sariya', 'لنٹل سریا'), description: 'Steel as % of lintel concrete.', value: both(1), safeMin: 0.6, safeMax: 2 }),
  p({ key: 'footingSteelPercent', group: 'STEEL', unit: '% of concrete', label: L('Footing / raft steel', 'Bunyaad sariya', 'بنیاد سریا'), description: 'Steel as % of RCC footing / raft / pile concrete.', value: both(0.8), safeMin: 0.5, safeMax: 1.6 }),

  // ─── Plaster ──────────────────────────────────────────────────────────────
  p({ key: 'internalPlasterMix', group: 'PLASTER', unit: '1 : n (sand)', kind: 'MIX2', label: L('Internal plaster mix', 'Andar ka plaster masala', 'اندرونی پلستر مسالا'), description: 'Cement : sand for internal walls and ceilings (1 : 6).', value: both(6), safeMin: 3, safeMax: 6 }),
  p({ key: 'internalPlasterThicknessIn', group: 'PLASTER', unit: 'in', label: L('Internal plaster thickness', 'Andar ke plaster ki motai', 'اندرونی پلستر کی موٹائی'), description: 'Internal walls and ceilings (½″).', value: both(0.5), safeMin: 0.375, safeMax: 1 }),
  p({ key: 'externalPlasterMix', group: 'PLASTER', unit: '1 : n (sand)', kind: 'MIX2', label: L('External plaster mix', 'Bahar ka plaster masala', 'بیرونی پلستر مسالا'), description: 'Cement : sand for external faces and parapets (1 : 4).', value: both(4), safeMin: 3, safeMax: 6 }),
  p({ key: 'externalPlasterThicknessIn', group: 'PLASTER', unit: 'in', label: L('External plaster thickness', 'Bahar ke plaster ki motai', 'بیرونی پلستر کی موٹائی'), description: 'External faces (¾″).', value: both(0.75), safeMin: 0.5, safeMax: 1.25 }),

  // ─── Factors ──────────────────────────────────────────────────────────────
  p({ key: 'concreteDryFactor', group: 'FACTORS', unit: '×', label: L('Concrete dry-volume factor', 'Concrete dry factor', 'کنکریٹ ڈرائی فیکٹر'), description: 'Wet → dry volume of concrete (1.54).', value: both(1.54), safeMin: 1.5, safeMax: 1.6 }),
  p({ key: 'mortarDryFactor', group: 'FACTORS', unit: '×', label: L('Mortar dry-volume factor', 'Masala dry factor', 'مسالا ڈرائی فیکٹر'), description: 'Wet → dry volume of mortar / plaster (1.33).', value: both(1.33), safeMin: 1.25, safeMax: 1.4 }),
  p({ key: 'cementBagCft', group: 'FACTORS', unit: 'cft / bag', label: L('Cement bag volume', 'Cement bori ka hajm', 'سیمنٹ بوری کا حجم'), description: 'Volume of one 50 kg bag (1.25 cft).', value: both(1.25), safeMin: 1.2, safeMax: 1.3 }),

  // ─── Wastage ──────────────────────────────────────────────────────────────
  p({ key: 'brickWastagePercent', group: 'WASTAGE', unit: '%', label: L('Bricks / blocks wastage', 'Eenton / blocks ka zaya', 'اینٹوں / بلاک کا ضیاع'), description: 'Breakage of bricks or blocks.', value: both(5), safeMin: 2, safeMax: 10 }),
  p({ key: 'cementWastagePercent', group: 'WASTAGE', unit: '%', label: L('Cement wastage', 'Cement ka zaya', 'سیمنٹ کا ضیاع'), description: 'Cement bags.', value: both(2), safeMin: 1, safeMax: 6 }),
  p({ key: 'sandWastagePercent', group: 'WASTAGE', unit: '%', label: L('Sand & crush wastage', 'Ret aur bajri ka zaya', 'ریت اور بجری کا ضیاع'), description: 'Sand and crush (bajri).', value: both(5), safeMin: 2, safeMax: 12 }),
  p({ key: 'steelWastagePercent', group: 'WASTAGE', unit: '%', label: L('Steel wastage', 'Sariye ka zaya', 'سریے کا ضیاع'), description: 'Cutting / laps not in the bar lengths.', value: both(4), safeMin: 2, safeMax: 8 }),
  p({ key: 'tileWastagePercent', group: 'WASTAGE', unit: '%', label: L('Tiles wastage', 'Tiles ka zaya', 'ٹائلوں کا ضیاع'), description: 'Cutting and breakage of floor / wall tiles.', value: both(7), safeMin: 3, safeMax: 15 }),
  p({ key: 'paintWastagePercent', group: 'WASTAGE', unit: '%', label: L('Paint wastage', 'Rang ka zaya', 'رنگ کا ضیاع'), description: 'Paint and primer.', value: both(5), safeMin: 2, safeMax: 10 }),
  p({ key: 'wastagePercent', group: 'WASTAGE', unit: '%', label: L('Other materials wastage', 'Baqi samaan ka zaya', 'باقی سامان کا ضیاع'), description: 'Waterproofing, bitumen, termite chemical, stone, garders, roof tiles, planks, deck.', value: both(5), safeMin: 0, safeMax: 15 }),

  // ─── Waterproofing ────────────────────────────────────────────────────────
  p({ key: 'waterproofingKgPerBag', group: 'WATERPROOFING', unit: 'kg / bag', label: L('DPC waterproofing compound', 'DPC waterproofing compound', 'ڈی پی سی واٹر پروفنگ کمپاؤنڈ'), description: 'Compound per cement bag of the DPC concrete.', value: both(1), safeMin: 0.5, safeMax: 2.5 }),
  p({ key: 'bitumenKgPerSqft', group: 'WATERPROOFING', unit: 'kg / sq ft', label: L('DPC bitumen', 'DPC bitumen', 'ڈی پی سی بٹومن'), description: 'Bitumen on the DPC when the DPC material is bitumen.', value: both(0.15), safeMin: 0.08, safeMax: 0.3 }),
  p({ key: 'roofWaterproofingRsPerSqft', group: 'WATERPROOFING', unit: 'Rs / sq ft', scope: 'BOQ', label: L('Roof waterproofing (lump sum)', 'Chhat ki waterproofing', 'چھت کی واٹر پروفنگ'), description: 'Roof waterproofing treatment per sq ft of the top roof, used when the company has no WATERPROOFING sub-contract rate.', value: both(60), safeMin: 25, safeMax: 200 }),

  // ─── Earthwork ────────────────────────────────────────────────────────────
  p({ key: 'termiteLitrePerSqft', group: 'EARTHWORK', unit: 'L / sq ft', label: L('Termite chemical', 'Deemak dawai', 'دیمک دوائی'), description: 'Termite (deemak) concentrate per sq ft of the lowest-floor footprint (1 L per 200 sq ft).', value: both(0.005), safeMin: 0.003, safeMax: 0.01 }),
  p({ key: 'excavationRsPerCft', group: 'EARTHWORK', unit: 'Rs / cft', scope: 'BOQ', label: L('Excavation rate', 'Khudai ka rate', 'کھدائی کا ریٹ'), description: 'Manual excavation of foundation trenches, including throwing out.', value: both(12), safeMin: 5, safeMax: 40 }),
  p({ key: 'earthFillingRsPerCft', group: 'EARTHWORK', unit: 'Rs / cft', scope: 'BOQ', label: L('Earth filling rate', 'Bharai ka rate', 'بھرائی کا ریٹ'), description: 'Plinth / roof earth filling with compaction (earth included).', value: both(10), safeMin: 3, safeMax: 40 }),

  // ─── Finishes ─────────────────────────────────────────────────────────────
  p({ key: 'wallTileHeightBathFt', group: 'FINISHES', unit: 'ft', scope: 'BOQ', label: L('Bathroom wall tiles height', 'Bathroom tiles ki unchai', 'باتھ روم ٹائلوں کی اونچائی'), description: 'Wall tiles in baths / wet rooms up to this height (capped at the room height).', value: both(7), safeMin: 4, safeMax: 10 }),
  p({ key: 'wallTileHeightKitchenFt', group: 'FINISHES', unit: 'ft', scope: 'BOQ', label: L('Kitchen splash tiles height', 'Kitchen splash tiles ki unchai', 'کچن اسپلیش ٹائلوں کی اونچائی'), description: 'Kitchen wall (splash) tiles along the walls up to this height.', value: both(3), safeMin: 2, safeMax: 8 }),
  p({ key: 'tileBeddingThicknessIn', group: 'FINISHES', unit: 'in', scope: 'BOQ', label: L('Floor tile bedding mortar', 'Farsh ke neeche masala', 'فرش کے نیچے مسالا'), description: 'Cement-sand bed under floor tiles.', value: both(1), safeMin: 0.5, safeMax: 2 }),
  p({ key: 'tileBeddingMix', group: 'FINISHES', unit: '1 : n (sand)', kind: 'MIX2', scope: 'BOQ', label: L('Tile bedding mix', 'Tile masala', 'ٹائل مسالا'), description: 'Cement : sand of the tile bed (1 : 4).', value: both(4), safeMin: 3, safeMax: 6 }),
  p({ key: 'paintCoats', group: 'FINISHES', unit: 'coats', scope: 'BOQ', label: L('Paint coats', 'Rang ke coat', 'رنگ کے کوٹ'), description: 'Emulsion coats on plastered walls and ceilings.', value: both(2), safeMin: 1, safeMax: 4 }),
  p({ key: 'primerCoats', group: 'FINISHES', unit: 'coats', scope: 'BOQ', label: L('Primer coats', 'Primer ke coat', 'پرائمر کے کوٹ'), description: 'Primer / sealer coats before the paint.', value: both(1), safeMin: 0, safeMax: 2 }),
  p({ key: 'paintCoverageSqftPerGallon', group: 'FINISHES', unit: 'sq ft / gallon / coat', scope: 'BOQ', label: L('Paint coverage', 'Rang ki coverage', 'رنگ کی کوریج'), description: 'Area one gallon of emulsion covers per coat.', value: both(350), safeMin: 200, safeMax: 500 }),
  p({ key: 'primerCoverageSqftPerGallon', group: 'FINISHES', unit: 'sq ft / gallon / coat', scope: 'BOQ', label: L('Primer coverage', 'Primer ki coverage', 'پرائمر کی کوریج'), description: 'Area one gallon of primer covers per coat.', value: both(400), safeMin: 250, safeMax: 600 }),

  // ─── MEP rough-in (lump sums) ─────────────────────────────────────────────
  p({ key: 'mepElectricalRsPerSqft', group: 'MEP', unit: 'Rs / sq ft', scope: 'BOQ', label: L('Electrical rough-in', 'Bijli ki wiring (conduit)', 'بجلی کی وائرنگ (کنڈیوٹ)'), description: 'Conduits, boxes and laying in walls / slabs per sq ft of covered area.', value: both(150), safeMin: 50, safeMax: 500 }),
  p({ key: 'mepPlumbingRsPerWetRoom', group: 'MEP', unit: 'Rs / wet room', scope: 'BOQ', label: L('Plumbing rough-in per wet room', 'Plumbing fi wet room', 'پلمبنگ فی گیلا کمرہ'), description: 'Water supply + drainage pipes and fittings laid in walls / floors, per bath or kitchen.', value: both(35000), safeMin: 10000, safeMax: 150000 }),
  p({ key: 'mepSewerageGasRsLumpSum', group: 'MEP', unit: 'Rs', scope: 'BOQ', label: L('Sewerage + gas lump sum', 'Gutter line + gas (lump sum)', 'گٹر لائن + گیس (یکمشت)'), description: 'Main sewer line, manholes, rain-water pipes and gas pipe rough-in for the house.', value: both(75000), safeMin: 20000, safeMax: 400000 }),

  // ─── Overheads ────────────────────────────────────────────────────────────
  p({ key: 'equipmentShutteringRsPerSqft', group: 'OVERHEADS', unit: 'Rs / sq ft', scope: 'BOQ', label: L('Equipment & shuttering hire', 'Machinery aur shuttering kiraya', 'مشینری اور شٹرنگ کرایہ'), description: 'Lump sum per sq ft of covered area: shuttering plates / props, mixer, vibrator, scaffolding, water.', value: both(60), safeMin: 20, safeMax: 250 }),
  p({ key: 'siteOverheadPercent', group: 'OVERHEADS', unit: '%', scope: 'BOQ', label: L('Site overheads', 'Site ke kharche', 'سائٹ کے اخراجات'), description: 'Chowkidar, site office, utilities, transport — % of the direct cost.', value: both(3), safeMin: 0, safeMax: 12 }),
  p({ key: 'contingencyPercent', group: 'OVERHEADS', unit: '%', scope: 'BOQ', label: L('Contingency', 'Ghair mutawaqqa kharcha', 'غیر متوقع خرچہ'), description: '% of direct cost + overheads for price changes and unforeseen work.', value: both(5), safeMin: 0, safeMax: 15 }),

  // ─── Norms (checks; quick estimates) ──────────────────────────────────────
  p({ key: 'rccCftPerSqftFramed', group: 'NORMS', unit: 'cft / sq ft', scope: 'NORM', label: L('RCC per sq ft (frame)', 'Fi sq ft RCC (frame)', 'فی مربع فٹ آر سی سی (فریم)'), description: 'RCC concrete per sq ft of covered area for an RCC-frame house (slabs + beams + columns + footings).', value: both(0.6), safeMin: 0.4, safeMax: 0.9 }),
  p({ key: 'rccCftPerSqftLoadBearing', group: 'NORMS', unit: 'cft / sq ft', scope: 'NORM', label: L('RCC per sq ft (load bearing)', 'Fi sq ft RCC (load bearing)', 'فی مربع فٹ آر سی سی (لوڈ بیئرنگ)'), description: 'RCC concrete per sq ft of covered area for a load-bearing house (slabs + lintels).', value: both(0.45), safeMin: 0.3, safeMax: 0.7 }),
  p({ key: 'steelKgPerSqftFramed', group: 'NORMS', unit: 'kg / sq ft', scope: 'NORM', label: L('Steel per sq ft (frame)', 'Fi sq ft sariya (frame)', 'فی مربع فٹ سریا (فریم)'), description: 'Steel per sq ft of covered area for an RCC-frame house.', value: both(4), safeMin: 2.5, safeMax: 6 }),
  p({ key: 'steelKgPerSqftLoadBearing', group: 'NORMS', unit: 'kg / sq ft', scope: 'NORM', label: L('Steel per sq ft (load bearing)', 'Fi sq ft sariya (load bearing)', 'فی مربع فٹ سریا (لوڈ بیئرنگ)'), description: 'Steel per sq ft of covered area for a load-bearing house.', value: both(2.5), safeMin: 1.5, safeMax: 4 }),

  // ─── Productivity (Step 13 durations) ─────────────────────────────────────
  p({ key: 'productivityExcavationCftPerDay', group: 'PRODUCTIVITY', unit: 'cft / gang-day', scope: 'SCHEDULE', label: L('Excavation output', 'Khudai rozana', 'کھدائی روزانہ'), description: 'One gang (1 mistri + 4 mazdoor) per day.', value: both(500), safeMin: 200, safeMax: 1500 }),
  p({ key: 'productivityBricksPerDay', group: 'PRODUCTIVITY', unit: 'bricks / team-day', scope: 'SCHEDULE', label: L('Brick laying output', 'Chunai rozana (eenten)', 'چنائی روزانہ (اینٹیں)'), description: 'One team (2 masons + 3 helpers) per day.', value: both(1500), safeMin: 600, safeMax: 3000 }),
  p({ key: 'productivityBlocksPerDay', group: 'PRODUCTIVITY', unit: 'blocks / team-day', scope: 'SCHEDULE', label: L('Block laying output', 'Chunai rozana (blocks)', 'چنائی روزانہ (بلاک)'), description: 'One team (2 masons + 3 helpers) per day.', value: both(400), safeMin: 150, safeMax: 900 }),
  p({ key: 'productivityConcreteCftPerDay', group: 'PRODUCTIVITY', unit: 'cft / team-day', scope: 'SCHEDULE', label: L('Concrete casting output', 'Concrete dhalai rozana', 'کنکریٹ ڈھلائی روزانہ'), description: 'Mixer team per day (slab casting).', value: both(400), safeMin: 150, safeMax: 1200 }),
  p({ key: 'productivityShutteringSqftPerDay', group: 'PRODUCTIVITY', unit: 'sq ft / team-day', scope: 'SCHEDULE', label: L('Shuttering output', 'Shuttering rozana', 'شٹرنگ روزانہ'), description: 'One shuttering team per day.', value: both(300), safeMin: 100, safeMax: 800 }),
  p({ key: 'productivitySteelKgPerDay', group: 'PRODUCTIVITY', unit: 'kg / team-day', scope: 'SCHEDULE', label: L('Steel fixing output', 'Sariya bandhai rozana', 'سریا بندھائی روزانہ'), description: 'One steel fixer team per day.', value: both(400), safeMin: 150, safeMax: 1000 }),
  p({ key: 'productivityPlasterSqftPerDay', group: 'PRODUCTIVITY', unit: 'sq ft / team-day', scope: 'SCHEDULE', label: L('Plaster output', 'Plaster rozana', 'پلستر روزانہ'), description: 'One mason + helper per day.', value: both(250), safeMin: 100, safeMax: 600 }),
  p({ key: 'productivityTileSqftPerDay', group: 'PRODUCTIVITY', unit: 'sq ft / team-day', scope: 'SCHEDULE', label: L('Tile fixing output', 'Tile lagai rozana', 'ٹائل لگائی روزانہ'), description: 'One tile mistri + helper per day.', value: both(120), safeMin: 50, safeMax: 300 }),
  p({ key: 'productivityPaintSqftPerDay', group: 'PRODUCTIVITY', unit: 'sq ft / team-day', scope: 'SCHEDULE', label: L('Paint output', 'Rang rozana', 'رنگ روزانہ'), description: 'One painter + helper per day, all coats.', value: both(600), safeMin: 200, safeMax: 1500 }),
  p({ key: 'curingDaysSlab', group: 'PRODUCTIVITY', unit: 'days', scope: 'SCHEDULE', label: L('Slab curing / de-shuttering', 'Lenter ki tarai / shuttering', 'لینٹر کی ترائی / شٹرنگ'), description: 'Days before the slab shuttering comes off and the next floor starts.', value: both(14), safeMin: 7, safeMax: 28 }),
  p({ key: 'curingDaysColumns', group: 'PRODUCTIVITY', unit: 'days', scope: 'SCHEDULE', label: L('Column curing', 'Column ki tarai', 'کالم کی ترائی'), description: 'Days of curing before loading columns.', value: both(7), safeMin: 3, safeMax: 14 }),
  p({ key: 'curingDaysPlaster', group: 'PRODUCTIVITY', unit: 'days', scope: 'SCHEDULE', label: L('Plaster curing', 'Plaster ki tarai', 'پلستر کی ترائی'), description: 'Days of curing before paint.', value: both(7), safeMin: 3, safeMax: 21 }),
];

export const PARAM_BY_KEY: ReadonlyMap<string, RulebookParamDef> = new Map(RULEBOOK_PARAMS.map((d) => [d.key, d]));
export const RULEBOOK_KEYS: readonly string[] = RULEBOOK_PARAMS.map((d) => d.key);

/** Keys a project may override (`PUT /projects/:id/estimate/settings`): everything except productivity. */
export const projectOverridable = (d: RulebookParamDef) => d.scope !== 'SCHEDULE';

/** Built-in v1 values of a region (used when the region has no published rulebook yet). */
export function builtInValues(region: RulebookRegion): Record<string, number> {
  return Object.fromEntries(RULEBOOK_PARAMS.map((d) => [d.key, d.value[region]]));
}

/** Rulebook number → engine setting value ("1:6", "1:2:4", 0/1 …). */
export function toSettingValue(def: RulebookParamDef, value: number): number | string {
  if (def.kind === 'MIX2') return `1:${value}`;
  if (def.kind === 'MIX3') return `1:${value}:${value * 2}`;
  return value;
}

/** Engine setting value (number or "1:n" / "1:n:m") → rulebook number, or null when it can't be read. */
export function fromSettingValue(def: RulebookParamDef, value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && (def.kind === 'MIX2' || def.kind === 'MIX3')) {
    const parts = value.split(':').map(Number);
    return parts.length >= 2 && Number.isFinite(parts[1]) ? parts[1]! : null;
  }
  return null;
}
