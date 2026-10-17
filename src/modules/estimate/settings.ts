/**
 * Estimate (BoQ) settings of a project — the assumptions behind the estimate.
 *
 * Stored per project in `Project.estimateSettings` (JSONB) as the values the user CHANGED only
 * (the PROJECT layer of the rulebook); everything not stored falls back to the company's rulebook
 * values (published platform rulebook of the company region → company overrides, see rulebook.ts),
 * so a later change of a default reaches every project that never touched it.
 * `PUT /projects/:id/estimate/settings` replaces the stored object (a field left out = back to
 * the default; `{}` = reset everything).
 *
 * Besides the engine settings below, the object may hold any project-overridable rulebook key of
 * the BoQ (finishes, MEP lump sums, earthwork rates, overheads, contingency …) — `boqFields`.
 *
 * Units are fixed per field (in = inches, ft = feet, % = percent, cft = cubic feet).
 * `ESTIMATE_DEFAULTS` are the Phase 1 built-in numbers (the engine unit tests use them and they
 * are the last fallback); live estimates start from the rulebook instead.
 */
import { z } from 'zod';
import { RULEBOOK_PARAMS } from './rulebookDefs.js';

export const RCC_MIXES = ['1:1.5:3', '1:2:4'] as const;
export const MORTAR_MIXES = ['1:3', '1:4', '1:5', '1:6', '1:8'] as const;
export const PLASTER_MIXES = ['1:3', '1:4', '1:5', '1:6'] as const;

const range = (min: number, max: number, unit: string) =>
  z
    .number()
    .min(min, `Must be ${min}–${max} ${unit}`)
    .max(max, `Must be ${min}–${max} ${unit}`);

const fields = {
  // Walls
  externalWallThicknessIn: range(4.5, 18, 'in').meta({ description: 'External walls (and foundation walls), inches. Default 9″', example: 9 }),
  internalWallThicknessIn: range(3, 13.5, 'in').meta({ description: 'Internal partition walls, inches. Default 4.5″', example: 4.5 }),
  parapetHeightFt: range(0, 6, 'ft').meta({ description: 'Roof parapet height (4.5″ wall on the main roof); 0 = none. Default 3 ft', example: 3 }),
  bricksPerCft: range(10, 16, 'bricks / cft').meta({ description: 'Bricks per cft of brickwork including mortar joints. Default 13.5', example: 13.5 }),
  blockMasonry: z.union([z.literal(0), z.literal(1)]).meta({ description: '1 = walls in concrete blocks per sq ft of wall face (Karachi / Sindh rulebook); 0 = bricks per cft', example: 0 }),
  blocksPerSqft: range(0.8, 1.6, 'blocks / sq ft').meta({ description: 'Concrete blocks per sq ft of wall face (block masonry). Default 1.125 (8 × 16″ face)', example: 1.125 }),
  mortarPerCftBrickwork: range(0.05, 0.4, 'cft').meta({ description: 'Wet mortar per cft of masonry. Default 0.25 (blocks 0.10)', example: 0.25 }),
  masonryMortarMix: z.enum(MORTAR_MIXES).meta({ description: 'Cement : sand for brick masonry. Default 1:6' }),
  // RCC
  slabThicknessIn: range(4, 9, 'in').meta({ description: 'Roof slab thickness, inches. Default 5″ (6″ for larger spans)', example: 5 }),
  rccMix: z.enum(RCC_MIXES).meta({ description: 'Cement : sand : crush for slabs, beams, columns, lintels, DPC. Default 1:2:4' }),
  frameConcretePercent: range(0, 100, '%').meta({
    description: 'RCC frame only: beams + columns concrete as a % of the slab concrete of each floor. Default 45 %',
    example: 45,
  }),
  slabSteelPercent: range(0.3, 3, '%').meta({ description: 'Steel as % of slab concrete volume (1 % ≈ 2.22 kg / cft). Default 1 %', example: 1 }),
  frameSteelPercent: range(0.8, 6, '%').meta({ description: 'Steel as % of beam / column concrete. Default 2.5 %', example: 2.5 }),
  lintelSteelPercent: range(0.3, 3, '%').meta({ description: 'Steel as % of lintel concrete. Default 1 %', example: 1 }),
  footingSteelPercent: range(0.3, 3, '%').meta({ description: 'Steel as % of RCC footing / raft / pile concrete. Default 0.8 %', example: 0.8 }),
  lintelWidthIn: range(4.5, 18, 'in').meta({ description: 'Lintel width, inches. Default 9″', example: 9 }),
  lintelDepthIn: range(3, 18, 'in').meta({ description: 'Lintel depth, inches. Default 6″', example: 6 }),
  lintelBearingFt: range(0, 3, 'ft').meta({ description: 'Extra lintel length over each opening (both sides together), ft. Default 1 ft', example: 1 }),
  // Plaster
  internalPlasterMix: z.enum(PLASTER_MIXES).meta({ description: 'Cement : sand for internal wall + ceiling plaster. Rulebook 1:6' }),
  internalPlasterThicknessIn: range(0.25, 1.5, 'in').meta({ description: 'Internal wall + ceiling plaster, inches. Default 0.5″', example: 0.5 }),
  externalPlasterMix: z.enum(PLASTER_MIXES).meta({ description: 'Cement : sand for external plaster. Default 1:4 (1:6 option)' }),
  externalPlasterThicknessIn: range(0.25, 1.5, 'in').meta({ description: 'External plaster, inches. Default 0.75″', example: 0.75 }),
  // Foundation
  foundationWallLengthFt: range(10, 10000, 'ft')
    .nullable()
    .meta({ description: 'Total running length of foundation walls, ft. null = automatic (external + internal wall run of the lowest floor)', example: null }),
  waterproofingKgPerBag: range(0, 5, 'kg').meta({ description: 'Waterproofing compound per cement bag of the DPC concrete, kg. Default 1 kg', example: 1 }),
  bitumenKgPerSqft: range(0, 2, 'kg').meta({ description: 'Bitumen on the DPC when the DPC material is BITUMEN, kg per sq ft. Default 0.15', example: 0.15 }),
  termiteLitrePerSqft: range(0, 0.1, 'L').meta({
    description: 'Termite (deemak) chemical concentrate per sq ft of treated area (lowest-floor footprint). Default 0.005 L (1 L per 200 sq ft)',
    example: 0.005,
  }),
  // Factors
  wastagePercent: range(0, 25, '%').meta({
    description:
      'Wastage on the other materials (waterproofing, bitumen, termite, stone, garders, roof tiles …). A project value also applies to cement / sand / steel unless those are set too. Default 5 %',
    example: 5,
  }),
  brickWastagePercent: range(0, 25, '%').meta({ description: 'Wastage on bricks / blocks. Default 5 %', example: 5 }),
  cementWastagePercent: range(0, 25, '%').meta({ description: 'Wastage on cement. Rulebook 2 %', example: 2 }),
  sandWastagePercent: range(0, 25, '%').meta({ description: 'Wastage on sand and crush. Rulebook 5 %', example: 5 }),
  steelWastagePercent: range(0, 25, '%').meta({ description: 'Wastage on steel. Rulebook 4 %', example: 4 }),
  concreteDryFactor: range(1.2, 1.7, '').meta({ description: 'Wet → dry volume of concrete. Default 1.54', example: 1.54 }),
  mortarDryFactor: range(1.1, 1.6, '').meta({ description: 'Wet → dry volume of mortar / plaster. Default 1.33', example: 1.33 }),
  cementBagCft: range(1, 1.5, 'cft').meta({ description: 'Volume of one 50 kg cement bag, cft. Default 1.25', example: 1.25 }),
  // Labour
  includeLabour: z.boolean().meta({ description: 'Add grey-structure labour to the cost. Default true' }),
  labourRatePerSqftPaisa: z
    .string()
    .regex(/^\d{1,12}$/, 'Paisa as a whole number string')
    .nullable()
    .meta({
      description: 'Grey-structure labour rate per sq ft of covered area (paisa). null = use the company sub-contract piece rates (brick masonry, plaster, shuttering, steel fixing)',
      example: null,
    }),
};

type Inferred = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> };
/** Mixes are strings "1:n" / "1:n:2n" — a company rulebook value may be any n in its safe range. */
export type EstimateSettings = Omit<Inferred, 'masonryMortarMix' | 'rccMix' | 'internalPlasterMix' | 'externalPlasterMix'> & {
  masonryMortarMix: string;
  rccMix: string;
  internalPlasterMix: string;
  externalPlasterMix: string;
};
export const isSettingKey = (k: string): k is keyof EstimateSettings => k in fields;

/**
 * BoQ-only rulebook keys a project may override (finishes, MEP lump sums, earthwork rates,
 * overheads, contingency, norms). Validated loosely here (0 … 10,000,000); the rulebook safe range
 * is checked by the service (400 OUT_OF_SAFE_RANGE).
 */
export const boqFields: Record<string, z.ZodNumber> = Object.fromEntries(
  RULEBOOK_PARAMS.filter((d) => (d.scope === 'BOQ' || d.scope === 'NORM') && !(d.key in fields)).map((d) => [
    d.key,
    z
      .number()
      .min(0, 'Must be 0 or more')
      .max(10_000_000, 'Too large')
      .meta({ description: `${d.label.en} (${d.unit}). Rulebook v1: ${d.value.PUNJAB_KP}`, example: d.value.PUNJAB_KP }),
  ]),
);

/** Phase 1 built-in numbers (Punjab practice). Live estimates use the rulebook (rulebookDefs.ts). */
export const ESTIMATE_DEFAULTS: EstimateSettings = {
  externalWallThicknessIn: 9,
  internalWallThicknessIn: 4.5,
  parapetHeightFt: 3,
  bricksPerCft: 13.5,
  blockMasonry: 0,
  blocksPerSqft: 1.125,
  mortarPerCftBrickwork: 0.25,
  masonryMortarMix: '1:6',
  slabThicknessIn: 5,
  rccMix: '1:2:4',
  frameConcretePercent: 45,
  slabSteelPercent: 1,
  frameSteelPercent: 2.5,
  lintelSteelPercent: 1,
  footingSteelPercent: 0.8,
  lintelWidthIn: 9,
  lintelDepthIn: 6,
  lintelBearingFt: 1,
  internalPlasterMix: '1:4',
  internalPlasterThicknessIn: 0.5,
  externalPlasterMix: '1:4',
  externalPlasterThicknessIn: 0.75,
  foundationWallLengthFt: null,
  waterproofingKgPerBag: 1,
  bitumenKgPerSqft: 0.15,
  termiteLitrePerSqft: 0.005,
  wastagePercent: 5,
  brickWastagePercent: 5,
  cementWastagePercent: 5,
  sandWastagePercent: 5,
  steelWastagePercent: 5,
  concreteDryFactor: 1.54,
  mortarDryFactor: 1.33,
  cementBagCft: 1.25,
  includeLabour: true,
  labourRatePerSqftPaisa: null,
};

/** PUT body: every field optional — what is sent is stored; what is left out goes back to the default. */
export const estimateSettingsBody = z
  .object({
    ...(Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> }),
    ...(Object.fromEntries(Object.entries(boqFields).map(([k, s]) => [k, s.optional()])) as Record<string, z.ZodOptional<z.ZodNumber>>),
  })
  .strict()
  .meta({ id: 'EstimateSettingsInput' });

/** Engine settings + BoQ rulebook keys (numbers). */
export type EstimateSettingsInput = Partial<Inferred> & { [key: string]: unknown };

/** Stored overrides (JSON) → only the keys that are still valid (a stale or broken key is dropped, never an error). */
export function readOverrides(json: unknown): EstimateSettingsInput {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    const schema = (fields as Record<string, z.ZodType>)[k] ?? boqFields[k];
    if (!schema) continue;
    const parsed = schema.safeParse(v);
    if (parsed.success) out[k] = parsed.data;
  }
  return out as EstimateSettingsInput;
}

/** Wastage keys a project `wastagePercent` also covers (its Phase 1 meaning: every material except bricks). */
const WASTAGE_FOLLOWERS = ['cementWastagePercent', 'sandWastagePercent', 'steelWastagePercent'] as const;

/**
 * `base` (the company's rulebook values; ESTIMATE_DEFAULTS when not given) ⊕ project overrides.
 * Only engine settings are taken from `overrides`; BoQ keys are read by the BoQ builder.
 */
export function effectiveSettings(overrides: EstimateSettingsInput, base: EstimateSettings = ESTIMATE_DEFAULTS): EstimateSettings {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && isSettingKey(k)) out[k] = v;
  if (typeof overrides.wastagePercent === 'number') {
    for (const k of WASTAGE_FOLLOWERS) if (overrides[k] === undefined) out[k] = overrides.wastagePercent;
  }
  return out as EstimateSettings;
}

/** "1:2:4" → [1, 2, 4]. */
export function mixParts(mix: string): number[] {
  return mix.split(':').map(Number);
}
