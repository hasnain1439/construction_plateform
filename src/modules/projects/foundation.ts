/**
 * Foundation (bunyaad) of a project — part of wizard tab 3 (plot & structure).
 *
 * Stored as one JSONB column `Project.foundation` (null = not entered yet, so projects created
 * before this existed stay valid). The shape is validated here with zod on the way in and
 * normalised so every key is always present: fields that don't apply to the chosen type are
 * stored as null. Everything is a number in a fixed unit (ft / in / mm / count) so a later
 * material-quantity estimate can read it directly.
 */
import { z } from 'zod';

export const FOUNDATION_TYPES = ['STRIP', 'ISOLATED', 'COMBINED', 'RAFT', 'PILE'] as const;
export const FOUNDATION_MASONRY = ['BRICK', 'STONE', 'RCC_ONLY'] as const;
export const PCC_MIXES = ['1:4:8', '1:3:6', '1:2:4'] as const;
export const RCC_MIXES = ['1:2:4', '1:1.5:3'] as const;
/** Main bar diameter in mm: #3 = 10, #4 = 12, #5 = 16, #6 = 20. */
export const BAR_SIZES_MM = [10, 12, 16, 20] as const;
export const DPC_MATERIALS = ['BITUMEN', 'PCC_WATERPROOF'] as const;
export const SOIL_TYPES = ['HARD', 'MEDIUM', 'SOFT', 'SANDY', 'FILLED', 'CLAY'] as const;

export type FoundationType = (typeof FOUNDATION_TYPES)[number];

/** Pad footings: a count and an L × W size. */
export const hasPads = (type: FoundationType) => type === 'ISOLATED' || type === 'COMBINED';
/** Footing width applies to strip (wall) footings and to pads (their W). */
export const hasFootingWidth = (type: FoundationType) => type === 'STRIP' || hasPads(type);
/** RCC mix + main steel: every type except a plain strip footing in brick / stone masonry. */
export const rccApplies = (type: FoundationType, masonry: (typeof FOUNDATION_MASONRY)[number]) => type !== 'STRIP' || masonry === 'RCC_ONLY';

const range = (min: number, max: number, unit: string) =>
  z
    .number()
    .min(min, `Must be ${min}–${max} ${unit}`)
    .max(max, `Must be ${min}–${max} ${unit}`);
const count = (max: number) => z.number().int('Must be a whole number').min(1).max(max);

const fields = {
  type: z.enum(FOUNDATION_TYPES).meta({ description: 'STRIP (wall footing), ISOLATED (column footing), COMBINED, RAFT (mat), PILE' }),
  // Dimensions
  excavationDepthFt: range(1, 30, 'ft').meta({ example: 5 }),
  footingWidthFt: range(1, 20, 'ft').meta({ description: 'Strip width, or pad W (STRIP / ISOLATED / COMBINED)', example: 3 }),
  footingThicknessIn: range(3, 36, 'in').meta({ example: 9 }),
  plinthHeightFt: range(0, 6, 'ft').meta({ description: 'Plinth above natural ground level', example: 2 }),
  dpcThicknessIn: range(0.5, 6, 'in').meta({ example: 1.5 }),
  footingCount: count(500).meta({ description: 'ISOLATED / COMBINED' }),
  footingLengthFt: range(1, 20, 'ft').meta({ description: 'Pad L (ISOLATED / COMBINED)' }),
  pileCount: count(1000).meta({ description: 'PILE' }),
  pileDiameterIn: range(6, 60, 'in').meta({ description: 'PILE' }),
  pileDepthFt: range(5, 150, 'ft').meta({ description: 'PILE' }),
  // Material
  masonry: z.enum(FOUNDATION_MASONRY),
  pccMix: z.enum(PCC_MIXES).meta({ description: 'Lean concrete under the footing' }),
  pccThicknessIn: range(2, 12, 'in').meta({ example: 3 }),
  rccMix: z.enum(RCC_MIXES).meta({ description: 'Where RCC applies (every type except a brick / stone strip footing)' }),
  mainBarMm: z
    .union([z.literal(10), z.literal(12), z.literal(16), z.literal(20)], { error: 'mainBarMm must be 10, 12, 16 or 20' })
    .meta({ description: 'Main steel bar in mm: 10 (#3), 12 (#4), 16 (#5), 20 (#6)' }),
  termiteTreatment: z.boolean().meta({ description: 'Deemak (anti-termite) treatment' }),
  dpcMaterial: z.enum(DPC_MATERIALS),
  // Soil / site
  soilType: z.enum(SOIL_TYPES),
  waterTableDepthFt: range(0, 300, 'ft'),
  dewateringNeeded: z.boolean(),
  soilTestDone: z.boolean(),
  soilTestNote: z.string().trim().max(300).meta({ description: 'Lab / report reference, bearing capacity… (only with soilTestDone)' }),
  notes: z.string().trim().max(1000),
};

/** Request body `foundation` of PATCH /projects/:id/plot-structure. */
export const foundationInputSchema = z
  .object({
    type: fields.type,
    excavationDepthFt: fields.excavationDepthFt,
    footingWidthFt: fields.footingWidthFt.optional(),
    footingThicknessIn: fields.footingThicknessIn,
    plinthHeightFt: fields.plinthHeightFt,
    dpcThicknessIn: fields.dpcThicknessIn,
    footingCount: fields.footingCount.optional(),
    footingLengthFt: fields.footingLengthFt.optional(),
    pileCount: fields.pileCount.optional(),
    pileDiameterIn: fields.pileDiameterIn.optional(),
    pileDepthFt: fields.pileDepthFt.optional(),
    masonry: fields.masonry,
    pccMix: fields.pccMix,
    pccThicknessIn: fields.pccThicknessIn,
    rccMix: fields.rccMix.optional(),
    mainBarMm: fields.mainBarMm.optional(),
    termiteTreatment: fields.termiteTreatment.default(true),
    dpcMaterial: fields.dpcMaterial.default('PCC_WATERPROOF'),
    soilType: fields.soilType.optional(),
    waterTableDepthFt: fields.waterTableDepthFt.nullable().optional(),
    dewateringNeeded: fields.dewateringNeeded.default(false),
    soilTestDone: fields.soilTestDone.default(false),
    soilTestNote: fields.soilTestNote.optional(),
    notes: fields.notes.optional(),
  })
  .superRefine((v, ctx) => {
    const need = (key: keyof typeof v, why: string) => {
      if (v[key] === undefined || v[key] === null) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required ${why}` });
    };
    if (hasFootingWidth(v.type)) need('footingWidthFt', `for a ${v.type} foundation`);
    if (hasPads(v.type)) {
      need('footingCount', `for a ${v.type} foundation`);
      need('footingLengthFt', `for a ${v.type} foundation`);
    }
    if (v.type === 'PILE') {
      need('pileCount', 'for a PILE foundation');
      need('pileDiameterIn', 'for a PILE foundation');
      need('pileDepthFt', 'for a PILE foundation');
    }
    if (rccApplies(v.type, v.masonry)) {
      need('rccMix', 'where RCC applies');
      need('mainBarMm', 'where RCC applies');
    }
    if (v.excavationDepthFt * 12 < v.footingThicknessIn + v.pccThicknessIn) {
      ctx.addIssue({ code: 'custom', path: ['excavationDepthFt'], message: 'Excavation must be at least as deep as the PCC + footing thickness' });
    }
  })
  .meta({ id: 'FoundationInput' });

export type FoundationInput = z.infer<typeof foundationInputSchema>;

/** The stored / returned shape: every key present, null where it doesn't apply or wasn't given. */
export const foundationSchema = z
  .object({
    type: fields.type,
    excavationDepthFt: fields.excavationDepthFt,
    footingWidthFt: fields.footingWidthFt.nullable(),
    footingThicknessIn: fields.footingThicknessIn,
    plinthHeightFt: fields.plinthHeightFt,
    dpcThicknessIn: fields.dpcThicknessIn,
    footingCount: fields.footingCount.nullable(),
    footingLengthFt: fields.footingLengthFt.nullable(),
    pileCount: fields.pileCount.nullable(),
    pileDiameterIn: fields.pileDiameterIn.nullable(),
    pileDepthFt: fields.pileDepthFt.nullable(),
    masonry: fields.masonry,
    pccMix: fields.pccMix,
    pccThicknessIn: fields.pccThicknessIn,
    rccMix: fields.rccMix.nullable(),
    mainBarMm: fields.mainBarMm.nullable(),
    termiteTreatment: fields.termiteTreatment,
    dpcMaterial: fields.dpcMaterial,
    soilType: fields.soilType.nullable(),
    waterTableDepthFt: fields.waterTableDepthFt.nullable(),
    dewateringNeeded: fields.dewateringNeeded,
    soilTestDone: fields.soilTestDone,
    soilTestNote: fields.soilTestNote.nullable(),
    notes: fields.notes.nullable(),
  })
  .meta({ id: 'Foundation' });

export type Foundation = z.infer<typeof foundationSchema>;

/** Validated input → stored shape: fields that don't apply to the type are dropped (null). */
export function normaliseFoundation(v: FoundationInput): Foundation {
  const pads = hasPads(v.type);
  const pile = v.type === 'PILE';
  const rcc = rccApplies(v.type, v.masonry);
  return {
    type: v.type,
    excavationDepthFt: v.excavationDepthFt,
    footingWidthFt: hasFootingWidth(v.type) ? (v.footingWidthFt ?? null) : null,
    footingThicknessIn: v.footingThicknessIn,
    plinthHeightFt: v.plinthHeightFt,
    dpcThicknessIn: v.dpcThicknessIn,
    footingCount: pads ? (v.footingCount ?? null) : null,
    footingLengthFt: pads ? (v.footingLengthFt ?? null) : null,
    pileCount: pile ? (v.pileCount ?? null) : null,
    pileDiameterIn: pile ? (v.pileDiameterIn ?? null) : null,
    pileDepthFt: pile ? (v.pileDepthFt ?? null) : null,
    masonry: v.masonry,
    pccMix: v.pccMix,
    pccThicknessIn: v.pccThicknessIn,
    rccMix: rcc ? (v.rccMix ?? null) : null,
    mainBarMm: rcc ? (v.mainBarMm ?? null) : null,
    termiteTreatment: v.termiteTreatment,
    dpcMaterial: v.dpcMaterial,
    soilType: v.soilType ?? null,
    waterTableDepthFt: v.waterTableDepthFt ?? null,
    dewateringNeeded: v.dewateringNeeded,
    soilTestDone: v.soilTestDone,
    soilTestNote: v.soilTestDone && v.soilTestNote ? v.soilTestNote : null,
    notes: v.notes ? v.notes : null,
  };
}

/** Stored JSON → response. Null (not entered) or a row that no longer matches the shape → null. */
export function readFoundation(json: unknown): Foundation | null {
  if (json === null || json === undefined) return null;
  const parsed = foundationSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
