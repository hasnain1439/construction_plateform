/**
 * Worked 10-marla example for the BoQ tests (tests/unit/estimateBoq.test.ts).
 *
 * Plot 30 × 75 ft = 2,250 sq ft (10 marla of 225), load-bearing, ground floor only, 10 ft rooms,
 * covered area 1,440 sq ft (24 × 60 ft footprint at the plot ratio 75 / 30 = 2.5), brick strip
 * footing. Punjab rulebook v1 values, a FULL contract (every section), Malik-like rates.
 *
 * Rooms (L × W → area, perimeter): Bedroom 16×14 → 224, 60 · Bedroom 16×14 → 224, 60 ·
 * Lounge 24×16 → 384, 80 · Drawing 16×14 → 224, 60 · Kitchen 12×10 → 120, 44 ·
 * Bath 8×6 → 48, 28 · Bath 8×6 → 48, 28 · Store 10×8 → 80, 36
 *   Σ area 1,352 sq ft (94 % of covered), Σ perimeter P = 396 ft.
 * Openings: a 3 × 7 door in every room (8 → 168 sq ft); 4 × 4 windows: bedrooms 1 + 1, lounge 2,
 * drawing 1, kitchen 1 (6 → 96 sq ft); 2 × 1.5 ventilators in the baths (2 → 6 sq ft).
 */
import type { BoqLabourRates, BoqPriceBook } from '../../src/modules/estimate/boq.js';
import type { EstimateFoundation, EstimateInput, PriceEntry } from '../../src/modules/estimate/engine.js';

const door = { type: 'DOOR' as const, widthFt: 3, heightFt: 7, quantity: 1 };
const win = (quantity: number) => ({ type: 'WINDOW' as const, widthFt: 4, heightFt: 4, quantity });
const vent = { type: 'VENTILATOR' as const, widthFt: 2, heightFt: 1.5, quantity: 1 };
const room = (name: string, type: string, lengthFt: number, widthFt: number, openings: EstimateInput['floors'][number]['rooms'][number]['openings'], isWet = false) => ({
  name,
  type,
  lengthFt,
  widthFt,
  heightFt: 10,
  isWet,
  openings,
});

export const STRIP: EstimateFoundation = {
  type: 'STRIP',
  excavationDepthFt: 5,
  footingWidthFt: 3,
  footingThicknessIn: 9,
  plinthHeightFt: 2,
  dpcThicknessIn: 1.5,
  footingCount: null,
  footingLengthFt: null,
  pileCount: null,
  pileDiameterIn: null,
  pileDepthFt: null,
  masonry: 'BRICK',
  pccMix: '1:4:8',
  pccThicknessIn: 3,
  rccMix: null,
  termiteTreatment: true,
  dpcMaterial: 'PCC_WATERPROOF',
};

export const TEN_MARLA: EstimateInput = {
  plotAreaSqft: 2250,
  frontFt: 30,
  depthFt: 75,
  structureType: 'LOAD_BEARING',
  coveredAreaSqft: 1440,
  floors: [
    {
      level: 'GROUND',
      name: 'Ground floor',
      ceilingHeightFt: 10,
      rooms: [
        room('Bedroom 1', 'BEDROOM', 16, 14, [door, win(1)]),
        room('Bedroom 2', 'BEDROOM', 16, 14, [door, win(1)]),
        room('Lounge', 'TV_LOUNGE', 24, 16, [door, win(2)]),
        room('Drawing', 'DRAWING_ROOM', 16, 14, [door, win(1)]),
        room('Kitchen', 'KITCHEN', 12, 10, [door, win(1)], true),
        room('Bath 1', 'ATTACHED_BATH', 8, 6, [door, vent], true),
        room('Bath 2', 'ATTACHED_BATH', 8, 6, [door, vent], true),
        room('Store', 'STORE', 10, 8, [door]),
      ],
    },
  ],
  foundation: STRIP,
};

const entry = (name: string, unit: string, ratePaisa: bigint | null, extra: Partial<PriceEntry> = {}): PriceEntry => ({
  materialId: `00000000-0000-7000-8000-${name.length.toString().padStart(12, '0')}`,
  materialName: name,
  unit,
  altUnits: [],
  ratePaisa,
  qualityCategory: { id: 'cat', name: 'A Standard' },
  suppliedBy: 'CONTRACTOR',
  ...extra,
});

/**
 * Rates (paisa): cement Rs 1,450 / bag · bricks Rs 17 each · sand Rs 70 / cft · crush Rs 180 / cft ·
 * steel Rs 2,85,000 / ton · waterproofing compound Rs 500 / kg · termite Rs 1,200 / L ·
 * floor tiles Rs 250 / sq ft · wall tiles Rs 220 / sq ft · emulsion Rs 3,500 / gallon · primer Rs 2,500 / gallon.
 */
export const PRICES: BoqPriceBook = {
  cement: entry('Cement OPC', 'bag', 145_000n),
  bricks: entry('Clay bricks Class-1', 'nos', 1_700n),
  sand: entry('Chenab sand', 'cft', 7_000n),
  crush: entry('Bajri Margalla crush', 'cft', 18_000n),
  steel: entry('Steel Grade-60 #4', 'ton', 28_500_000n, { altUnits: [{ unit: 'kg', factor: 1000 }] }),
  waterproofing: entry('Waterproofing compound', 'kg', 50_000n),
  termite: entry('Termite chemical', 'litre', 120_000n),
  floorTiles: entry('Floor tiles', 'sqft', 25_000n),
  wallTiles: entry('Wall tiles', 'sqft', 22_000n),
  paint: entry('Emulsion', 'gallon', 350_000n),
  primer: entry('Primer', 'gallon', 250_000n),
};

/** Sub-contract piece rates (paisa): brick masonry Rs 9 / brick, plaster Rs 22, shuttering Rs 45 / sq ft, steel fixing Rs 9,000 / ton, tiles Rs 45, paint Rs 25, waterproofing Rs 30 / sq ft. */
export const LABOUR: BoqLabourRates = {
  pieceRates: {
    BRICK_MASONRY: { unit: 'BRICK', ratePaisa: 900n, label: 'Brick masonry' },
    PLASTER: { unit: 'SQFT', ratePaisa: 2_200n, label: 'Plaster' },
    SHUTTERING: { unit: 'SQFT', ratePaisa: 4_500n, label: 'Shuttering' },
    STEEL_FIXING: { unit: 'TON', ratePaisa: 900_000n, label: 'Steel fixing' },
    TILE_LAYING: { unit: 'SQFT', ratePaisa: 4_500n, label: 'Tile laying' },
    PAINT: { unit: 'SQFT', ratePaisa: 2_500n, label: 'Paint' },
    WATERPROOFING: { unit: 'SQFT', ratePaisa: 3_000n, label: 'Waterproofing' },
  },
};
