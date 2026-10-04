/**
 * Built-in master data: the platform material catalog (seeded once) and the defaults
 * every new company receives (quality categories, labour rates, billing template).
 * Money is paisa (Rs × 100).
 */
import type { LaborRateKind, LaborUnit, MaterialSection, SupplyCategory } from '../../generated/prisma/enums.js';

const rs = (rupees: number) => BigInt(Math.round(rupees * 100));

export interface GroupDef {
  code: string;
  name: string;
  section: MaterialSection;
  sortOrder: number;
}

export const MATERIAL_GROUPS: GroupDef[] = [
  { code: 'CEMENT', name: 'Cement', section: 'CIVIL', sortOrder: 1 },
  { code: 'BRICKS', name: 'Bricks & blocks', section: 'CIVIL', sortOrder: 2 },
  { code: 'STEEL', name: 'Steel', section: 'CIVIL', sortOrder: 3 },
  { code: 'AGGREGATES', name: 'Sand & aggregates', section: 'CIVIL', sortOrder: 4 },
  { code: 'WATERPROOFING', name: 'Waterproofing', section: 'CIVIL', sortOrder: 5 },
  { code: 'PLUMBING', name: 'Plumbing', section: 'FINISHING', sortOrder: 6 },
  { code: 'ELECTRICAL', name: 'Electrical', section: 'FINISHING', sortOrder: 7 },
  { code: 'FLOORING', name: 'Flooring', section: 'FINISHING', sortOrder: 8 },
  { code: 'SANITARY', name: 'Sanitary', section: 'FINISHING', sortOrder: 9 },
  { code: 'WOODWORK', name: 'Woodwork', section: 'FINISHING', sortOrder: 10 },
  { code: 'PAINT', name: 'Paint', section: 'FINISHING', sortOrder: 11 },
  { code: 'OTHER', name: 'Other', section: 'CIVIL', sortOrder: 12 },
];

export interface AltUnit {
  unit: string;
  /** How many `unit` make one base unit: 1 bag = 50 kg → { unit: 'kg', factor: 50 } */
  factor: number;
}

export interface PlatformMaterialDef {
  group: string;
  name: string;
  unit: string;
  unitDetail?: string;
  altUnits?: AltUnit[];
  supplyCategory: SupplyCategory;
  rulebookKey?: string;
}

const G = 'GREY_STRUCTURE' as const;
const F = 'FINISHING' as const;
const trolley: AltUnit[] = [{ unit: 'trolley', factor: 0.01 }];
const ton: AltUnit[] = [{ unit: 'kg', factor: 1000 }];

/** ~40 materials. `rulebookKey` marks the ones the estimating rulebook uses. */
export const PLATFORM_MATERIALS: PlatformMaterialDef[] = [
  { group: 'CEMENT', name: 'Cement OPC', unit: 'bag', unitDetail: '1 bag = 50 kg', altUnits: [{ unit: 'kg', factor: 50 }], supplyCategory: G, rulebookKey: 'cement_opc' },
  { group: 'CEMENT', name: 'Cement SRC', unit: 'bag', unitDetail: '1 bag = 50 kg', altUnits: [{ unit: 'kg', factor: 50 }], supplyCategory: G, rulebookKey: 'cement_src' },
  { group: 'CEMENT', name: 'White cement', unit: 'bag', unitDetail: '1 bag = 40 kg', altUnits: [{ unit: 'kg', factor: 40 }], supplyCategory: F },

  { group: 'BRICKS', name: 'Clay bricks Class-1', unit: 'nos', unitDetail: 'Sold per 1,000', altUnits: [{ unit: 'thousand', factor: 0.001 }], supplyCategory: G, rulebookKey: 'bricks_class1' },
  { group: 'BRICKS', name: 'Clay bricks 2nd class', unit: 'nos', unitDetail: 'Sold per 1,000', altUnits: [{ unit: 'thousand', factor: 0.001 }], supplyCategory: G, rulebookKey: 'bricks_class2' },
  { group: 'BRICKS', name: 'Concrete block 6"', unit: 'nos', supplyCategory: G },

  { group: 'STEEL', name: 'Steel Grade-60 #3', unit: 'ton', unitDetail: '1 ton = 1000 kg', altUnits: ton, supplyCategory: G, rulebookKey: 'steel_g60_3' },
  { group: 'STEEL', name: 'Steel Grade-60 #4', unit: 'ton', unitDetail: '1 ton = 1000 kg', altUnits: ton, supplyCategory: G, rulebookKey: 'steel_g60_4' },
  { group: 'STEEL', name: 'Steel Grade-60 #5', unit: 'ton', unitDetail: '1 ton = 1000 kg', altUnits: ton, supplyCategory: G, rulebookKey: 'steel_g60_5' },
  { group: 'STEEL', name: 'Steel Grade-60 #6', unit: 'ton', unitDetail: '1 ton = 1000 kg', altUnits: ton, supplyCategory: G, rulebookKey: 'steel_g60_6' },
  { group: 'STEEL', name: 'Binding wire', unit: 'kg', supplyCategory: G },

  { group: 'AGGREGATES', name: 'Chenab sand', unit: 'cft', unitDetail: '1 trolley ≈ 100 cft', altUnits: trolley, supplyCategory: G, rulebookKey: 'sand_chenab' },
  { group: 'AGGREGATES', name: 'Ravi sand', unit: 'cft', unitDetail: '1 trolley ≈ 100 cft', altUnits: trolley, supplyCategory: G, rulebookKey: 'sand_ravi' },
  { group: 'AGGREGATES', name: 'Bajri Margalla crush', unit: 'cft', unitDetail: '1 trolley ≈ 100 cft', altUnits: trolley, supplyCategory: G, rulebookKey: 'bajri_margalla' },
  { group: 'AGGREGATES', name: 'Sargodha crush', unit: 'cft', unitDetail: '1 trolley ≈ 100 cft', altUnits: trolley, supplyCategory: G, rulebookKey: 'bajri_sargodha' },

  { group: 'WATERPROOFING', name: 'Bitumen', unit: 'kg', unitDetail: '1 drum ≈ 200 kg', altUnits: [{ unit: 'drum', factor: 0.005 }], supplyCategory: G },
  { group: 'WATERPROOFING', name: 'Chemical membrane', unit: 'litre', supplyCategory: G },
  { group: 'WATERPROOFING', name: 'Polythene sheet', unit: 'sqft', supplyCategory: G },

  { group: 'PLUMBING', name: 'PPR pipe ½"', unit: 'rft', supplyCategory: G },
  { group: 'PLUMBING', name: 'PPR pipe 1"', unit: 'rft', supplyCategory: G },
  { group: 'PLUMBING', name: 'PVC pipe 4"', unit: 'rft', supplyCategory: G },
  { group: 'PLUMBING', name: 'Plumbing fittings', unit: 'lot', supplyCategory: F },
  { group: 'PLUMBING', name: 'Water tank', unit: 'nos', unitDetail: '1,000 gallon', supplyCategory: F },

  { group: 'ELECTRICAL', name: 'Conduit ¾"', unit: 'rft', supplyCategory: G },
  { group: 'ELECTRICAL', name: 'Wire 3/29', unit: 'coil', unitDetail: '1 coil = 90 m', supplyCategory: F },
  { group: 'ELECTRICAL', name: 'Wire 7/29', unit: 'coil', unitDetail: '1 coil = 90 m', supplyCategory: F },
  { group: 'ELECTRICAL', name: 'Switches & sockets', unit: 'lot', supplyCategory: F },
  { group: 'ELECTRICAL', name: 'DB box', unit: 'nos', supplyCategory: F },

  { group: 'FLOORING', name: 'Floor tiles', unit: 'sqft', supplyCategory: F },
  { group: 'FLOORING', name: 'Wall tiles', unit: 'sqft', supplyCategory: F },
  { group: 'FLOORING', name: 'Marble', unit: 'sqft', supplyCategory: F },
  { group: 'FLOORING', name: 'Granite', unit: 'sqft', supplyCategory: F },

  { group: 'SANITARY', name: 'WC set', unit: 'nos', supplyCategory: F },
  { group: 'SANITARY', name: 'Basin set', unit: 'nos', supplyCategory: F },
  { group: 'SANITARY', name: 'Mixer', unit: 'nos', supplyCategory: F },

  { group: 'WOODWORK', name: 'Doors with frames', unit: 'nos', supplyCategory: F },
  { group: 'WOODWORK', name: 'Kitchen cabinets', unit: 'rft', supplyCategory: F },

  { group: 'PAINT', name: 'Emulsion', unit: 'gallon', supplyCategory: F },
  { group: 'PAINT', name: 'Enamel', unit: 'gallon', supplyCategory: F },
  { group: 'PAINT', name: 'Putty', unit: 'bag', unitDetail: '1 bag = 20 kg', altUnits: [{ unit: 'kg', factor: 20 }], supplyCategory: F },
];

// ─── Defaults for every new company ─────────────────────────────────────────

export const DEFAULT_CATEGORIES = [
  { name: 'A+ Premium', code: 'A_PLUS', description: 'Top brands, premium finish', isDefault: false, sortOrder: 1 },
  { name: 'A Standard', code: 'A_STD', description: 'Good-quality standard brands', isDefault: true, sortOrder: 2 },
  { name: 'B Economy', code: 'B_ECO', description: 'Budget brands', isDefault: false, sortOrder: 3 },
];

export const DAILY_KEYS = ['MISTRI', 'MISTRI_TILES', 'MAZDOOR', 'STEEL_FIXER_HELPER', 'CHOWKIDAR'] as const;
export const SUBCONTRACT_KEYS = [
  'SHUTTERING',
  'STEEL_FIXING',
  'BRICK_MASONRY',
  'PLASTER',
  'TILE_LAYING',
  'ELECTRICAL_CONDUIT',
  'PLUMBING_ROUGH_IN',
  'WATERPROOFING',
  'PAINT',
] as const;

export interface LaborRateDef {
  kind: LaborRateKind;
  key: string;
  label: string;
  unit: LaborUnit;
  ratePaisa: bigint;
  overtimeMultiplier?: number;
}

export const DEFAULT_LABOR_RATES: LaborRateDef[] = [
  { kind: 'DAILY', key: 'MISTRI', label: 'Mistri', unit: 'DAY', ratePaisa: rs(2800), overtimeMultiplier: 1.5 },
  { kind: 'DAILY', key: 'MISTRI_TILES', label: 'Mistri (tiles)', unit: 'DAY', ratePaisa: rs(3200), overtimeMultiplier: 1.5 },
  { kind: 'DAILY', key: 'MAZDOOR', label: 'Mazdoor', unit: 'DAY', ratePaisa: rs(1600), overtimeMultiplier: 1.5 },
  { kind: 'DAILY', key: 'STEEL_FIXER_HELPER', label: 'Steel-fixer helper', unit: 'DAY', ratePaisa: rs(1800), overtimeMultiplier: 1.5 },
  { kind: 'DAILY', key: 'CHOWKIDAR', label: 'Chowkidar', unit: 'DAY', ratePaisa: rs(1200), overtimeMultiplier: 1.5 },
  { kind: 'SUBCONTRACT', key: 'SHUTTERING', label: 'Shuttering', unit: 'SQFT', ratePaisa: rs(45) },
  { kind: 'SUBCONTRACT', key: 'STEEL_FIXING', label: 'Steel fixing', unit: 'TON', ratePaisa: rs(9000) },
  { kind: 'SUBCONTRACT', key: 'BRICK_MASONRY', label: 'Brick masonry', unit: 'BRICK', ratePaisa: rs(9) },
  { kind: 'SUBCONTRACT', key: 'PLASTER', label: 'Plaster', unit: 'SQFT', ratePaisa: rs(22) },
  { kind: 'SUBCONTRACT', key: 'TILE_LAYING', label: 'Tile laying', unit: 'SQFT', ratePaisa: rs(45) },
  { kind: 'SUBCONTRACT', key: 'ELECTRICAL_CONDUIT', label: 'Electrical conduit', unit: 'SQFT', ratePaisa: rs(55) },
  { kind: 'SUBCONTRACT', key: 'PLUMBING_ROUGH_IN', label: 'Plumbing rough-in', unit: 'LUMPSUM', ratePaisa: rs(120000) },
  // Not in the seed brief; sensible starting points the THEKEDAR can change.
  { kind: 'SUBCONTRACT', key: 'WATERPROOFING', label: 'Waterproofing', unit: 'SQFT', ratePaisa: rs(30) },
  { kind: 'SUBCONTRACT', key: 'PAINT', label: 'Paint', unit: 'SQFT', ratePaisa: rs(25) },
];

export interface StageDef {
  label: string;
  percent: number;
  isRetention?: boolean;
}

export interface TemplateDef {
  name: string;
  billingModel: 'STAGE_SCHEDULE' | 'RUNNING_BILLS';
  stages: StageDef[];
  isDefault: boolean;
}

export const RESIDENTIAL_STANDARD: TemplateDef = {
  name: 'Residential standard',
  billingModel: 'STAGE_SCHEDULE',
  isDefault: true,
  stages: [
    { label: 'Agreement & mobilisation', percent: 15 },
    { label: 'Foundation & plinth', percent: 15 },
    { label: 'Grey structure — ground floor', percent: 20 },
    { label: 'Grey structure — first floor & roof', percent: 15 },
    { label: 'Plaster & MEP rough-in', percent: 10 },
    { label: 'Flooring & tiles', percent: 10 },
    { label: 'Finishing & handover', percent: 10 },
    { label: 'Retention (after defect period)', percent: 5, isRetention: true },
  ],
};

export const LABOR_ONLY_MONTHLY: TemplateDef = {
  name: 'Labor-only monthly',
  billingModel: 'RUNNING_BILLS',
  isDefault: false,
  stages: [
    { label: 'Monthly running bills', percent: 95 },
    { label: 'Retention', percent: 5, isRetention: true },
  ],
};

export const COMMERCIAL: TemplateDef = {
  name: 'Commercial',
  billingModel: 'STAGE_SCHEDULE',
  isDefault: false,
  stages: [
    { label: 'Advance', percent: 10 },
    { label: 'Foundation & basement', percent: 20 },
    { label: 'Structure', percent: 20 },
    { label: 'Envelope & masonry', percent: 20 },
    { label: 'MEP & finishing', percent: 20 },
    { label: 'Handover', percent: 5 },
    { label: 'Retention', percent: 5, isRetention: true },
  ],
};
