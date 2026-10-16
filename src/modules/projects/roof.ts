/**
 * Roof / slab (lenter, chhat) over a floor — entered per floor in wizard tab 3 (plot & structure).
 *
 * Stored as one JSONB column `Floor.roof` (null = not entered: the estimate then uses the % method of
 * the estimate settings, so floors saved before this existed keep working). Validated with zod on the
 * way in and normalised so every key is always present: fields that don't apply to the roof type are
 * null, the rest get the Pakistani defaults below. Units are fixed per field (in / ft / count / bar #).
 *
 * Bars are Pakistani bar numbers: #3 = 10 mm, #4 = 12 mm, #5 = 16 mm, #6 = 20 mm (3/8″ … 3/4″).
 * Beam / column fields are stored for every roof type; the estimate uses them only when the project
 * structure is an RCC frame (FRAMED).
 */
import { z } from 'zod';

export const ROOF_TYPES = ['RCC_SLAB', 'T_IRON_TILE', 'PRECAST', 'STEEL_DECK'] as const;
export type RoofType = (typeof ROOF_TYPES)[number];
export const ROOF_MIXES = ['1:2:4', '1:1.5:3'] as const;
export const STEEL_GRADES = ['G60', 'G40'] as const;
export const BAR_NUMBERS = [3, 4, 5, 6] as const;
export type BarNo = (typeof BAR_NUMBERS)[number];
/** Bar number → nominal diameter in mm. */
export const BAR_MM: Record<BarNo, number> = { 3: 10, 4: 12, 5: 16, 6: 20 };
/** T-iron / garder (RSJ) sections for T-iron + tile roofs. */
export const T_IRON_SECTIONS = ['T3X3', 'T4X4', 'G4X3', 'G5X3', 'G6X3'] as const;
export type TIronSection = (typeof T_IRON_SECTIONS)[number];
/**
 * Standard weight per running foot (approximate — check the supplier's table):
 * T 3″×3″×5/16″ ≈ 2.7 kg/ft · T 4″×4″×3/8″ ≈ 4.5 kg/ft (100×100×10 mm T ≈ 14.9 kg/m) ·
 * garder (RSJ) 4″×3″ ≈ 10 lb/ft = 4.5 kg/ft · 5″×3″ ≈ 11 lb/ft = 5.0 kg/ft · 6″×3″ ≈ 12 lb/ft = 5.4 kg/ft.
 */
export const T_IRON_KG_PER_FT: Record<TIronSection, number> = { T3X3: 2.7, T4X4: 4.5, G4X3: 4.5, G5X3: 5.0, G6X3: 5.4 };
export const T_IRON_INFILLS = ['BRICK', 'TILE'] as const;

const range = (min: number, max: number, unit: string) =>
  z
    .number()
    .min(min, `Must be ${min}–${max} ${unit}`)
    .max(max, `Must be ${min}–${max} ${unit}`);
const count = (min: number, max: number) => z.number().int('Must be a whole number').min(min).max(max);
const bar = z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)], { error: 'Bar must be 3, 4, 5 or 6 (#3 = 10 mm … #6 = 20 mm)' });

const fields = {
  type: z.enum(ROOF_TYPES).meta({ description: 'RCC_SLAB (lenter, default), T_IRON_TILE (garder / T-iron + bricks or tiles), PRECAST (hollow-core planks), STEEL_DECK' }),
  // RCC slab
  thicknessIn: range(3, 12, 'in').meta({ description: 'RCC slab thickness. Default 5″ (suggested from the largest room span)', example: 5 }),
  concreteMix: z.enum(ROOF_MIXES).meta({ description: 'Slab / topping / screed concrete. Default 1:2:4' }),
  steelGrade: z.enum(STEEL_GRADES).meta({ description: 'Steel grade (price list lookup). Default G60' }),
  mainBar: bar.meta({ description: 'Main bars (along the short span). Default #4 (12 mm)' }),
  mainSpacingIn: range(3, 18, 'in').meta({ description: 'Main bar spacing c/c. Default 6″', example: 6 }),
  distBar: bar.meta({ description: 'Distribution bars. Default #3 (10 mm)' }),
  distSpacingIn: range(3, 18, 'in').meta({ description: 'Distribution bar spacing. Default 9″', example: 9 }),
  topBars: z.boolean().meta({ description: 'Extra top bars over the supports (main size, every other bar, 0.25 × short span). Default true' }),
  coverIn: range(0.5, 2, 'in').meta({ description: 'Clear cover. Default 0.75″', example: 0.75 }),
  chajjaLengthFt: range(0, 1000, 'ft').meta({ description: 'Sunshade (chajja) total length, ft. Optional' }),
  chajjaWidthFt: range(1, 4, 'ft').meta({ description: 'Sunshade projection. Default 2 ft' }),
  // RCC frame (used for FRAMED structures)
  beamWidthIn: range(6, 24, 'in').meta({ description: 'Beam width. Default 9″', example: 9 }),
  beamDepthIn: range(9, 36, 'in').meta({ description: 'Beam overall depth (incl. slab). Default 15″', example: 15 }),
  beamBars: count(2, 12).meta({ description: 'Main bars per beam (top + bottom). Default 4' }),
  beamBar: bar.meta({ description: 'Beam main bar. Default #5 (16 mm)' }),
  stirrupBar: bar.meta({ description: 'Stirrups. Default #3' }),
  stirrupSpacingIn: range(3, 12, 'in').meta({ description: 'Stirrup spacing. Default 6″', example: 6 }),
  beamRunFt: range(1, 10000, 'ft').meta({ description: 'Total beam length on this floor. Omitted = the floor’s wall run' }),
  columnCount: count(0, 500).meta({ description: 'Columns under this slab. Omitted = derived from the footprint (one per ~15 ft grid)' }),
  columnWidthIn: range(9, 36, 'in').meta({ description: 'Column width. Default 12″', example: 12 }),
  columnDepthIn: range(9, 36, 'in').meta({ description: 'Column depth. Default 12″', example: 12 }),
  columnBars: count(4, 16).meta({ description: 'Vertical bars per column. Default 6' }),
  columnBar: bar.meta({ description: 'Column bar. Default #5' }),
  tieBar: bar.meta({ description: 'Column ties. Default #3' }),
  tieSpacingIn: range(3, 12, 'in').meta({ description: 'Tie spacing. Default 6″', example: 6 }),
  // T-iron + tile (garder-tile)
  tIronSection: z.enum(T_IRON_SECTIONS).meta({ description: 'T3X3, T4X4, G4X3, G5X3 (default), G6X3 — garder / T-iron section' }),
  tIronSpacingFt: range(1, 6, 'ft').meta({ description: 'Garder spacing. Default 3 ft', example: 3 }),
  infill: z.enum(T_IRON_INFILLS).meta({ description: 'BRICK (laid flat, default) or TILE (12″×6″) between the garders' }),
  screedThicknessIn: range(0, 6, 'in').meta({ description: 'Concrete screed on top. Default 3″' }),
  earthFillIn: range(0, 12, 'in').meta({ description: 'Earth filling (mitti) on top. Default 4″' }),
  // Precast / steel deck
  plankAreaSqft: range(1, 100000, 'sq ft').meta({ description: 'PRECAST planks area. Omitted = the floor footprint' }),
  deckAreaSqft: range(1, 100000, 'sq ft').meta({ description: 'STEEL_DECK sheet area. Omitted = the floor footprint' }),
  toppingIn: range(1, 8, 'in').meta({ description: 'Concrete topping. Default 2″ (precast) / 4″ (steel deck, average over the flutes)' }),
  mesh: z.boolean().meta({ description: 'Mesh in the topping (#3 @ 12″ both ways). Default true' }),
  notes: z.string().trim().max(500),
};

/** Request body `floors[].roof` of PATCH /projects/:id/plot-structure — only `type` is required. */
export const roofInputSchema = z
  .object({
    type: fields.type,
    thicknessIn: fields.thicknessIn.optional(),
    concreteMix: fields.concreteMix.optional(),
    steelGrade: fields.steelGrade.optional(),
    mainBar: fields.mainBar.optional(),
    mainSpacingIn: fields.mainSpacingIn.optional(),
    distBar: fields.distBar.optional(),
    distSpacingIn: fields.distSpacingIn.optional(),
    topBars: fields.topBars.optional(),
    coverIn: fields.coverIn.optional(),
    chajjaLengthFt: fields.chajjaLengthFt.nullable().optional(),
    chajjaWidthFt: fields.chajjaWidthFt.nullable().optional(),
    beamWidthIn: fields.beamWidthIn.optional(),
    beamDepthIn: fields.beamDepthIn.optional(),
    beamBars: fields.beamBars.optional(),
    beamBar: fields.beamBar.optional(),
    stirrupBar: fields.stirrupBar.optional(),
    stirrupSpacingIn: fields.stirrupSpacingIn.optional(),
    beamRunFt: fields.beamRunFt.nullable().optional(),
    columnCount: fields.columnCount.nullable().optional(),
    columnWidthIn: fields.columnWidthIn.optional(),
    columnDepthIn: fields.columnDepthIn.optional(),
    columnBars: fields.columnBars.optional(),
    columnBar: fields.columnBar.optional(),
    tieBar: fields.tieBar.optional(),
    tieSpacingIn: fields.tieSpacingIn.optional(),
    tIronSection: fields.tIronSection.optional(),
    tIronSpacingFt: fields.tIronSpacingFt.optional(),
    infill: fields.infill.optional(),
    screedThicknessIn: fields.screedThicknessIn.optional(),
    earthFillIn: fields.earthFillIn.optional(),
    plankAreaSqft: fields.plankAreaSqft.nullable().optional(),
    deckAreaSqft: fields.deckAreaSqft.nullable().optional(),
    toppingIn: fields.toppingIn.optional(),
    mesh: fields.mesh.optional(),
    notes: fields.notes.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const t = v.thicknessIn ?? ROOF_DEFAULTS.thicknessIn;
    const depth = v.beamDepthIn ?? ROOF_DEFAULTS.beamDepthIn;
    if (v.type === 'RCC_SLAB' && depth <= t) ctx.addIssue({ code: 'custom', path: ['beamDepthIn'], message: 'Beam depth must be more than the slab thickness' });
  })
  .meta({ id: 'RoofInput' });

export type RoofInput = z.infer<typeof roofInputSchema>;

/** The stored / returned shape: every key present, null where it doesn't apply to the type. */
export const roofSchema = z
  .object({
    type: fields.type,
    thicknessIn: fields.thicknessIn.nullable(),
    concreteMix: fields.concreteMix,
    steelGrade: fields.steelGrade,
    mainBar: fields.mainBar.nullable(),
    mainSpacingIn: fields.mainSpacingIn.nullable(),
    distBar: fields.distBar.nullable(),
    distSpacingIn: fields.distSpacingIn.nullable(),
    topBars: fields.topBars.nullable(),
    coverIn: fields.coverIn.nullable(),
    chajjaLengthFt: fields.chajjaLengthFt.nullable(),
    chajjaWidthFt: fields.chajjaWidthFt.nullable(),
    beamWidthIn: fields.beamWidthIn,
    beamDepthIn: fields.beamDepthIn,
    beamBars: fields.beamBars,
    beamBar: fields.beamBar,
    stirrupBar: fields.stirrupBar,
    stirrupSpacingIn: fields.stirrupSpacingIn,
    beamRunFt: fields.beamRunFt.nullable(),
    columnCount: fields.columnCount.nullable(),
    columnWidthIn: fields.columnWidthIn,
    columnDepthIn: fields.columnDepthIn,
    columnBars: fields.columnBars,
    columnBar: fields.columnBar,
    tieBar: fields.tieBar,
    tieSpacingIn: fields.tieSpacingIn,
    tIronSection: fields.tIronSection.nullable(),
    tIronSpacingFt: fields.tIronSpacingFt.nullable(),
    infill: fields.infill.nullable(),
    screedThicknessIn: fields.screedThicknessIn.nullable(),
    earthFillIn: fields.earthFillIn.nullable(),
    plankAreaSqft: fields.plankAreaSqft.nullable(),
    deckAreaSqft: fields.deckAreaSqft.nullable(),
    toppingIn: fields.toppingIn.nullable(),
    mesh: fields.mesh.nullable(),
    notes: fields.notes.nullable(),
  })
  .meta({ id: 'Roof' });

export type Roof = z.infer<typeof roofSchema>;

/** Pakistani defaults (Punjab practice). Documented in README → "How the estimate is calculated". */
export const ROOF_DEFAULTS = {
  thicknessIn: 5,
  concreteMix: '1:2:4' as const,
  steelGrade: 'G60' as const,
  mainBar: 4 as BarNo,
  mainSpacingIn: 6,
  distBar: 3 as BarNo,
  distSpacingIn: 9,
  topBars: true,
  coverIn: 0.75,
  chajjaWidthFt: 2,
  beamWidthIn: 9,
  beamDepthIn: 15,
  beamBars: 4,
  beamBar: 5 as BarNo,
  stirrupBar: 3 as BarNo,
  stirrupSpacingIn: 6,
  columnWidthIn: 12,
  columnDepthIn: 12,
  columnBars: 6,
  columnBar: 5 as BarNo,
  tieBar: 3 as BarNo,
  tieSpacingIn: 6,
  tIronSection: 'G5X3' as TIronSection,
  tIronSpacingFt: 3,
  infill: 'BRICK' as const,
  screedThicknessIn: 3,
  earthFillIn: 4,
  precastToppingIn: 2,
  deckToppingIn: 4,
  mesh: true,
};

/** Validated input → stored shape: defaults filled in, fields that don't apply to the type dropped (null). */
export function normaliseRoof(v: RoofInput): Roof {
  const d = ROOF_DEFAULTS;
  const rcc = v.type === 'RCC_SLAB';
  const tIron = v.type === 'T_IRON_TILE';
  const topped = v.type === 'PRECAST' || v.type === 'STEEL_DECK';
  const chajja = rcc && v.chajjaLengthFt ? v.chajjaLengthFt : null;
  return {
    type: v.type,
    thicknessIn: rcc ? (v.thicknessIn ?? d.thicknessIn) : null,
    concreteMix: v.concreteMix ?? d.concreteMix,
    steelGrade: v.steelGrade ?? d.steelGrade,
    mainBar: rcc ? (v.mainBar ?? d.mainBar) : null,
    mainSpacingIn: rcc ? (v.mainSpacingIn ?? d.mainSpacingIn) : null,
    distBar: rcc ? (v.distBar ?? d.distBar) : null,
    distSpacingIn: rcc ? (v.distSpacingIn ?? d.distSpacingIn) : null,
    topBars: rcc ? (v.topBars ?? d.topBars) : null,
    coverIn: rcc ? (v.coverIn ?? d.coverIn) : null,
    chajjaLengthFt: chajja,
    chajjaWidthFt: chajja ? (v.chajjaWidthFt ?? d.chajjaWidthFt) : null,
    beamWidthIn: v.beamWidthIn ?? d.beamWidthIn,
    beamDepthIn: v.beamDepthIn ?? d.beamDepthIn,
    beamBars: v.beamBars ?? d.beamBars,
    beamBar: v.beamBar ?? d.beamBar,
    stirrupBar: v.stirrupBar ?? d.stirrupBar,
    stirrupSpacingIn: v.stirrupSpacingIn ?? d.stirrupSpacingIn,
    beamRunFt: v.beamRunFt ?? null,
    columnCount: v.columnCount ?? null,
    columnWidthIn: v.columnWidthIn ?? d.columnWidthIn,
    columnDepthIn: v.columnDepthIn ?? d.columnDepthIn,
    columnBars: v.columnBars ?? d.columnBars,
    columnBar: v.columnBar ?? d.columnBar,
    tieBar: v.tieBar ?? d.tieBar,
    tieSpacingIn: v.tieSpacingIn ?? d.tieSpacingIn,
    tIronSection: tIron ? (v.tIronSection ?? d.tIronSection) : null,
    tIronSpacingFt: tIron ? (v.tIronSpacingFt ?? d.tIronSpacingFt) : null,
    infill: tIron ? (v.infill ?? d.infill) : null,
    screedThicknessIn: tIron ? (v.screedThicknessIn ?? d.screedThicknessIn) : null,
    earthFillIn: tIron ? (v.earthFillIn ?? d.earthFillIn) : null,
    plankAreaSqft: v.type === 'PRECAST' ? (v.plankAreaSqft ?? null) : null,
    deckAreaSqft: v.type === 'STEEL_DECK' ? (v.deckAreaSqft ?? null) : null,
    toppingIn: topped ? (v.toppingIn ?? (v.type === 'PRECAST' ? d.precastToppingIn : d.deckToppingIn)) : null,
    mesh: topped ? (v.mesh ?? d.mesh) : null,
    notes: v.notes ? v.notes : null,
  };
}

/** Stored JSON → response. Null (not entered) or a row that no longer matches the shape → null. */
export function readRoof(json: unknown): Roof | null {
  if (json === null || json === undefined) return null;
  const parsed = roofSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ─── Suggestions & soft warnings ────────────────────────────────────────────

export interface SlabSuggestion {
  /** Largest clear short span of the floor's rooms, ft (null without rooms). */
  spanFt: number | null;
  suggestedIn: number;
  minIn: number;
  beamAdvised: boolean;
}

/**
 * RCC slab thickness by the largest room short span (Pakistani rule of thumb for two-way house slabs):
 * ≤ 12 ft → 4.5–5″ · 12–15 ft → 5″ · 15–18 ft → 6″ · > 18 ft → 6–7″ or a beam across the room.
 */
export function suggestSlab(spanFt: number | null): SlabSuggestion {
  if (spanFt === null || spanFt <= 12) return { spanFt, suggestedIn: 5, minIn: 4.5, beamAdvised: false };
  if (spanFt <= 15) return { spanFt, suggestedIn: 5, minIn: 5, beamAdvised: false };
  if (spanFt <= 18) return { spanFt, suggestedIn: 6, minIn: 6, beamAdvised: false };
  return { spanFt, suggestedIn: 7, minIn: 6, beamAdvised: true };
}

/** Largest short side (min of L, W) over the rooms. */
export function largestSpan(rooms: Array<{ lengthFt: number; widthFt: number }>): number | null {
  if (!rooms.length) return null;
  return Math.max(...rooms.map((r) => Math.min(r.lengthFt, r.widthFt)));
}

export type RoofWarningCode = 'ROOF_TOO_THIN' | 'ROOF_SPAN_NEEDS_BEAM' | 'ROOF_MAIN_SPACING_WIDE' | 'ROOF_DIST_SPACING_WIDE';

/** Max bar spacing: min(12″, 2 × slab thickness). */
export const maxSpacingIn = (thicknessIn: number) => Math.min(12, 2 * thicknessIn);

/** Soft checks of an RCC slab (stored anyway; shown in the wizard and the estimate). */
export function roofWarnings(roof: Roof, spanFt: number | null): Array<{ code: RoofWarningCode; params: Record<string, number> }> {
  if (roof.type !== 'RCC_SLAB' || roof.thicknessIn === null) return [];
  const out: Array<{ code: RoofWarningCode; params: Record<string, number> }> = [];
  const s = suggestSlab(spanFt);
  if (spanFt !== null && roof.thicknessIn < s.minIn) out.push({ code: 'ROOF_TOO_THIN', params: { thicknessIn: roof.thicknessIn, suggestedIn: s.suggestedIn, spanFt } });
  if (s.beamAdvised && spanFt !== null) out.push({ code: 'ROOF_SPAN_NEEDS_BEAM', params: { spanFt } });
  const max = maxSpacingIn(roof.thicknessIn);
  if (roof.mainSpacingIn !== null && roof.mainSpacingIn > max) out.push({ code: 'ROOF_MAIN_SPACING_WIDE', params: { spacingIn: roof.mainSpacingIn, maxIn: max } });
  if (roof.distSpacingIn !== null && roof.distSpacingIn > max) out.push({ code: 'ROOF_DIST_SPACING_WIDE', params: { spacingIn: roof.distSpacingIn, maxIn: max } });
  return out;
}
