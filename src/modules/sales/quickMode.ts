/**
 * Step 12 · Quick-mode estimate for quotes — pure, no database, no clock.
 *
 * A quote has no rooms yet: the client tells the plot, the covered area and how many storeys. Quick
 * mode turns that into the SAME engine input the project estimate uses (Step 11: engine.ts +
 * boq.ts) by laying out area-based "typical" rooms on every floor. The assumptions are listed in
 * QUICK_PARAMS (rulebook-style: key, label in three languages, unit, value, description, all
 * pending civil-engineer review) and shown on GET /quotes/assumptions and in the revision `basis`.
 *
 *   storey area   = covered ÷ (above-ground floors + basement + mumty share)
 *   mumty area    = storey × quickMumtyPercent
 *   rooms area    = floor × quickRoomFillPercent (the rest: walls, passages, stairs)
 *   baths         = max(1, round(floor ÷ quickSqftPerBath)) on every above-ground floor
 *   kitchens      = quickKitchensPerFloor on every above-ground floor
 *   dry rooms     = round((rooms area − baths − kitchens) ÷ quickRoomSizeSqft), sharing that area
 *   openings      = 1 door per room, 1 window per dry room / kitchen, 1 ventilator per bath
 *   foundation    = FRAMED: isolated pads on the engine's ~15 ft column grid; LOAD_BEARING: brick strip
 *
 * Price (quotePrice): cost = the BoQ total (direct + overheads + contingency), then the same
 * "contract value from the estimate" rules as Step 11 (contractValue.ts).
 */
import { Prisma } from '../../generated/prisma/client.js';
import { suggestContractValue, suggestLabourRate } from '../estimate/contractValue.js';
import { defaultColumnCount } from '../estimate/detailed.js';
import type { EstimateFloor, EstimateFoundation, EstimateInput, EstimateRoom, FloorLevelKey, StructureKind } from '../estimate/engine.js';
import { percentOf } from '../estimate/boq.js';
import { laborOnlyTotal } from '../projects/calc.js';

export interface QuickParam {
  key: string;
  group: 'QUICK';
  label: { en: string; roman: string; ur: string };
  unit: string;
  value: number;
  description: string;
  reviewStatus: 'PENDING_ENGINEER_REVIEW';
}

const P = (key: string, en: string, roman: string, ur: string, unit: string, value: number, description: string): QuickParam => ({
  key,
  group: 'QUICK',
  label: { en, roman, ur },
  unit,
  value,
  description,
  reviewStatus: 'PENDING_ENGINEER_REVIEW',
});

/** Quick-mode assumptions (rulebook-style; values pending civil-engineer review). */
export const QUICK_PARAMS: readonly QuickParam[] = [
  P('quickMumtyPercent', 'Mumty size (% of a storey)', 'Mumty ka size (manzil ka %)', 'ممٹی کا سائز (منزل کا ٪)', '%', 10, 'Stair room on the roof, as a share of one storey; it is part of the covered area.'),
  P('quickRoomFillPercent', 'Rooms share of each floor', 'Har manzil mein kamron ka hissa', 'ہر منزل میں کمروں کا حصہ', '%', 80, 'Part of every floor that is rooms; the rest is walls, passages and stairs.'),
  P('quickRoomSizeSqft', 'Typical room size', 'Aam kamre ka size', 'عام کمرے کا سائز', 'sq ft', 160, 'Bedrooms, lounges and other dry rooms share the room area in rooms of about this size.'),
  P('quickSqftPerBath', 'Floor area per bathroom', 'Fi bathroom manzil ka raqba', 'فی باتھ روم منزل کا رقبہ', 'sq ft', 450, 'One bathroom per this much floor area (at least one per above-ground floor).'),
  P('quickBathSizeSqft', 'Bathroom size', 'Bathroom ka size', 'باتھ روم کا سائز', 'sq ft', 48, 'Each bathroom 6 ft wide (6 × 8 ft by default).'),
  P('quickKitchensPerFloor', 'Kitchens per floor', 'Fi manzil kitchen', 'فی منزل کچن', 'nos', 1, 'Kitchens on every above-ground floor (separate portions are common).'),
  P('quickKitchenSizeSqft', 'Kitchen size', 'Kitchen ka size', 'کچن کا سائز', 'sq ft', 110, 'Each kitchen 10 ft wide (10 × 11 ft by default).'),
  P('quickDoorWidthFt', 'Door width', 'Darwaze ki chaurai', 'دروازے کی چوڑائی', 'ft', 3, 'One door per room, 7 ft high (bathrooms 2.5 ft wide).'),
  P('quickWindowSizeFt', 'Window size (square)', 'Khirki ka size (chakor)', 'کھڑکی کا سائز (مربع)', 'ft', 4, 'One window per dry room and kitchen; bathrooms get a 2 × 1.5 ft ventilator.'),
  P('quickGroundCeilingFt', 'Ground floor ceiling height', 'Ground floor ki chhat ki unchai', 'گراؤنڈ فلور کی چھت کی اونچائی', 'ft', 11, 'Floor to ceiling, ground floor.'),
  P('quickUpperCeilingFt', 'Upper floors ceiling height', 'Upar ki manzilon ki chhat ki unchai', 'اوپر کی منزلوں کی چھت کی اونچائی', 'ft', 10, 'Floor to ceiling, first floor and above.'),
  P('quickMumtyCeilingFt', 'Mumty ceiling height', 'Mumty ki unchai', 'ممٹی کی اونچائی', 'ft', 9, 'Floor to ceiling of the mumty.'),
  P('quickExcavationDepthFt', 'Excavation depth', 'Khudai ki gehrai', 'کھدائی کی گہرائی', 'ft', 5, 'Foundation trench depth (a basement adds its height).'),
  P('quickPlinthHeightFt', 'Plinth height', 'Plinth ki unchai', 'پلنتھ کی اونچائی', 'ft', 2, 'Plinth above natural ground level.'),
  P('quickPadSizeFt', 'Column footing size (framed)', 'Column footing ka size (frame)', 'کالم فٹنگ کا سائز (فریم)', 'ft', 5, 'Square isolated pad under each column of an RCC frame, 18″ thick; columns on a ~15 ft grid.'),
  P('quickStripWidthFt', 'Strip footing width (load bearing)', 'Strip footing ki chaurai (load bearing)', 'اسٹرپ فٹنگ کی چوڑائی (لوڈ بیئرنگ)', 'ft', 3, 'Stepped brick strip footing under the walls of a load-bearing house.'),
  P('quickProjectMonths', 'Default project duration', 'Project ki aam muddat', 'پراجیکٹ کی عام مدت', 'months', 12, 'End date of the draft project made from a won quote (start + this many months) when none is given.'),
];

export type QuickValues = Record<string, number>;
export const QUICK_VALUES: QuickValues = Object.fromEntries(QUICK_PARAMS.map((p) => [p.key, p.value]));

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const D = (v: number | string | bigint) => new Prisma.Decimal(v.toString());

// ─── Geometry ───────────────────────────────────────────────────────────────

export interface QuickGeometryInput {
  plotAreaSqft: number | null;
  frontFt: number | null;
  depthFt: number | null;
  coveredAreaSqft: number;
  /** Storeys above ground (1 = ground only … 4 = up to the third floor). */
  floors: number;
  mumty: boolean;
  basement: boolean;
  basementHeightFt: number;
  structureType: StructureKind;
}

export interface QuickFloorBasis {
  level: FloorLevelKey;
  name: string;
  areaSqft: number;
  rooms: number;
  wetRooms: number;
  ceilingHeightFt: number;
}

export interface QuickGeometry {
  input: EstimateInput;
  storeyAreaSqft: number;
  floors: QuickFloorBasis[];
  foundation: 'ISOLATED' | 'STRIP';
}

const ABOVE: FloorLevelKey[] = ['GROUND', 'FIRST', 'SECOND', 'THIRD'];
export const QUICK_FLOOR_NAMES: Record<FloorLevelKey, string> = {
  BASEMENT: 'Basement',
  GROUND: 'Ground floor',
  FIRST: 'First floor',
  SECOND: 'Second floor',
  THIRD: 'Third floor',
  MUMTY: 'Mumty',
};

/** Ceiling height of a level under the quick assumptions (basement = its own height). */
export function quickCeiling(level: FloorLevelKey, v: QuickValues, basementHeightFt: number): number {
  if (level === 'BASEMENT') return basementHeightFt;
  if (level === 'GROUND') return v['quickGroundCeilingFt']!;
  if (level === 'MUMTY') return v['quickMumtyCeilingFt']!;
  return v['quickUpperCeilingFt']!;
}

function rect(area: number, maxWidth: number) {
  const width = r2(Math.min(maxWidth, Math.sqrt(area)));
  return { widthFt: width, lengthFt: r2(area / width) };
}

/** The synthetic floors / rooms / foundation the engine estimates a quote from. */
export function quickGeometry(g: QuickGeometryInput, v: QuickValues = QUICK_VALUES): QuickGeometry {
  const mumtyShare = g.mumty ? v['quickMumtyPercent']! / 100 : 0;
  const storeys = g.floors + (g.basement ? 1 : 0);
  const storey = r2(g.coveredAreaSqft / (storeys + mumtyShare));
  const fill = v['quickRoomFillPercent']! / 100;
  const doorW = v['quickDoorWidthFt']!;
  const win = v['quickWindowSizeFt']!;
  const door = (w = doorW) => ({ type: 'DOOR' as const, widthFt: w, heightFt: 7, quantity: 1 });
  const window = { type: 'WINDOW' as const, widthFt: win, heightFt: win, quantity: 1 };
  const vent = { type: 'VENTILATOR' as const, widthFt: 2, heightFt: 1.5, quantity: 1 };

  const floors: EstimateFloor[] = [];
  const basis: QuickFloorBasis[] = [];
  const add = (level: FloorLevelKey, area: number, rooms: EstimateRoom[]) => {
    const ceiling = quickCeiling(level, v, g.basementHeightFt);
    for (const r of rooms) r.heightFt = ceiling;
    floors.push({ level, name: QUICK_FLOOR_NAMES[level], ceilingHeightFt: ceiling, rooms, roof: null });
    basis.push({ level, name: QUICK_FLOOR_NAMES[level], areaSqft: area, rooms: rooms.length, wetRooms: rooms.filter((r) => r.isWet).length, ceilingHeightFt: ceiling });
  };
  const dryRooms = (level: FloorLevelKey, area: number, withWindows: boolean): EstimateRoom[] => {
    if (area <= 0) return [];
    const n = Math.max(1, Math.round(area / v['quickRoomSizeSqft']!));
    const size = rect(area / n, 12);
    return Array.from({ length: n }, (_, i) => ({
      name: `${level === 'BASEMENT' ? 'Basement hall' : 'Room'} ${i + 1}`,
      type: level === 'BASEMENT' ? 'OTHER' : 'BEDROOM',
      ...size,
      heightFt: 0,
      isWet: false,
      openings: withWindows ? [door(), window] : [door()],
    }));
  };

  if (g.basement) add('BASEMENT', storey, dryRooms('BASEMENT', storey * fill, false));
  for (const level of ABOVE.slice(0, g.floors)) {
    const roomsArea = storey * fill;
    const baths = Math.max(1, Math.round(storey / v['quickSqftPerBath']!));
    const kitchens = Math.max(0, Math.round(v['quickKitchensPerFloor']!));
    const bathSize = { widthFt: 6, lengthFt: r2(v['quickBathSizeSqft']! / 6) };
    const kitchenSize = { widthFt: 10, lengthFt: r2(v['quickKitchenSizeSqft']! / 10) };
    const rest = roomsArea - baths * v['quickBathSizeSqft']! - kitchens * v['quickKitchenSizeSqft']!;
    const rooms: EstimateRoom[] = [
      ...dryRooms(level, rest, true),
      ...Array.from({ length: kitchens }, (_, i) => ({ name: `Kitchen ${i + 1}`, type: 'KITCHEN', ...kitchenSize, heightFt: 0, isWet: true, openings: [door(), window] })),
      ...Array.from({ length: baths }, (_, i) => ({ name: `Bath ${i + 1}`, type: 'ATTACHED_BATH', ...bathSize, heightFt: 0, isWet: true, openings: [door(2.5), vent] })),
    ];
    add(level, storey, rooms);
  }
  if (g.mumty) {
    const area = r2(storey * mumtyShare);
    add('MUMTY', area, [{ name: 'Stair', type: 'STAIR', ...rect(area * fill, 10), heightFt: 0, isWet: false, openings: [door()] }]);
  }

  const ratio = g.frontFt && g.depthFt && g.frontFt > 0 && g.depthFt > 0 ? g.depthFt / g.frontFt : 1;
  const framed = g.structureType === 'FRAMED';
  const pad = v['quickPadSizeFt']!;
  const foundation: EstimateFoundation = {
    type: framed ? 'ISOLATED' : 'STRIP',
    excavationDepthFt: Math.min(30, v['quickExcavationDepthFt']! + (g.basement ? g.basementHeightFt : 0)),
    footingWidthFt: framed ? pad : v['quickStripWidthFt']!,
    footingThicknessIn: framed ? 18 : 12,
    plinthHeightFt: v['quickPlinthHeightFt']!,
    dpcThicknessIn: 1.5,
    footingCount: framed ? defaultColumnCount(storey, ratio) : null,
    footingLengthFt: framed ? pad : null,
    pileCount: null,
    pileDiameterIn: null,
    pileDepthFt: null,
    masonry: 'BRICK',
    pccMix: '1:4:8',
    pccThicknessIn: 3,
    rccMix: framed ? '1:2:4' : null,
    termiteTreatment: true,
    dpcMaterial: 'PCC_WATERPROOF',
  };

  return {
    input: {
      plotAreaSqft: g.plotAreaSqft,
      frontFt: g.frontFt,
      depthFt: g.depthFt,
      structureType: g.structureType,
      coveredAreaSqft: g.coveredAreaSqft,
      floors,
      foundation,
    },
    storeyAreaSqft: storey,
    floors: basis,
    foundation: framed ? 'ISOLATED' : 'STRIP',
  };
}

// ─── Price ──────────────────────────────────────────────────────────────────

export interface QuotePriceInput {
  contractType: 'FULL' | 'GREY_OWNER_FINISHING' | 'LABOR_ONLY';
  costPaisa: bigint;
  coveredAreaSqft: number;
  marginPercent: number;
  finishingAllowancePercent: number;
  /** Negotiated price; null = the computed one. */
  finalPricePaisa: bigint | null;
}

export interface QuotePrice {
  finishingAllowancePaisa: bigint;
  computedPricePaisa: bigint | null;
  pricePaisa: bigint | null;
  perSqftPaisa: bigint | null;
  marginPaisa: bigint | null;
  marginOnPricePercent: number | null;
  priceOverridden: boolean;
}

/**
 *   FULL                  price = cost × (1 + finishing %) × (1 + margin %)  → nearest Rs 1,000
 *   GREY_OWNER_FINISHING  price = cost × (1 + margin %)                      → nearest Rs 1,000
 *   LABOR_ONLY            rate  = cost × (1 + margin %) ÷ covered            → nearest Rs 5;  price = rate × covered
 * margin = price − cost − finishing allowance.
 */
export function quotePrice(i: QuotePriceInput): QuotePrice {
  const finishing = i.contractType === 'FULL' ? percentOf(i.costPaisa, i.finishingAllowancePercent) : 0n;
  let computed: bigint | null;
  let rate: bigint | null = null;
  if (i.contractType === 'LABOR_ONLY') {
    rate = suggestLabourRate(i.costPaisa, i.marginPercent, i.coveredAreaSqft);
    computed = rate === null ? null : laborOnlyTotal(rate, i.coveredAreaSqft);
  } else {
    computed = suggestContractValue(i.costPaisa, i.marginPercent, i.contractType === 'FULL' ? i.finishingAllowancePercent : 0);
  }
  const price = i.finalPricePaisa ?? computed;
  const perSqft =
    price === null || i.coveredAreaSqft <= 0
      ? null
      : rate !== null && i.finalPricePaisa === null
        ? rate
        : BigInt(D(price).div(D(i.coveredAreaSqft)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
  const margin = price === null ? null : price - i.costPaisa - finishing;
  return {
    finishingAllowancePaisa: finishing,
    computedPricePaisa: computed,
    pricePaisa: price,
    perSqftPaisa: perSqft,
    marginPaisa: margin,
    marginOnPricePercent: price !== null && price > 0n && margin !== null ? r2((Number(margin) / Number(price)) * 100) : null,
    priceOverridden: i.finalPricePaisa !== null,
  };
}

