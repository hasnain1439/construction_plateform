/**
 * Estimate (BoQ) engine — hand-checked numbers. The arithmetic is written out in the comments so
 * the owner can follow every figure with a calculator (README → "How the estimate is calculated").
 */
import { describe, expect, it } from 'vitest';
import {
  estimateQuantities,
  footprintPerimeter,
  priceEstimate,
  toBaseUnit,
  type EstimateFoundation,
  type EstimateInput,
  type EstimateLine,
  type PriceBook,
} from '../../src/modules/estimate/engine.js';
import { effectiveSettings, ESTIMATE_DEFAULTS, readOverrides } from '../../src/modules/estimate/settings.js';

const door = { type: 'DOOR' as const, widthFt: 3, heightFt: 7, quantity: 1 };
const win = (quantity: number) => ({ type: 'WINDOW' as const, widthFt: 4, heightFt: 4, quantity });
const vent = { type: 'VENTILATOR' as const, widthFt: 2, heightFt: 1.5, quantity: 1 };
const room = (lengthFt: number, widthFt: number, openings: EstimateInput['floors'][number]['rooms'][number]['openings'], isWet = false) => ({
  lengthFt,
  widthFt,
  heightFt: 10,
  isWet,
  openings,
});

/** Brick strip footing (the wizard defaults): 5 ft deep, 3 ft × 9″, plinth 2 ft, PCC 1:4:8 × 3″, DPC 1.5″. */
const STRIP: EstimateFoundation = {
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

/**
 * 5-marla single-storey house: plot 25 × 45 = 1,125 sq ft, covered 1,125 sq ft, load-bearing,
 * ground floor 10 ft. Rooms (L × W → area, perimeter):
 *   Bedroom 15×12 → 180, 54 · Bedroom 15×12 → 180, 54 · Lounge 20×15 → 300, 70 · Kitchen 10×8 → 80, 36
 *   Bath 8×5 → 40, 26 · Bath 8×5 → 40, 26 · Drawing 15×12 → 180, 54
 *   Σ area = 1,000 sq ft, Σ perimeter P = 320 ft.
 * Openings: 7 doors 3×7 (147 sq ft), 5 windows 4×4 (80), 2 ventilators 2×1.5 (6) → windows+vents 86 sq ft.
 */
const FIVE_MARLA: EstimateInput = {
  plotAreaSqft: 1125,
  frontFt: 25,
  depthFt: 45,
  structureType: 'LOAD_BEARING',
  coveredAreaSqft: 1125,
  floors: [
    {
      level: 'GROUND',
      name: 'Ground floor',
      ceilingHeightFt: 10,
      rooms: [
        room(15, 12, [door, win(1)]),
        room(15, 12, [door, win(1)]),
        room(20, 15, [door, win(2)]),
        room(10, 8, [door, win(1)], true),
        room(8, 5, [door, vent], true),
        room(8, 5, [door, vent], true),
        room(15, 12, [door]),
      ],
    },
  ],
  foundation: STRIP,
};

const byId = (lines: EstimateLine[], id: string) => {
  const l = lines.find((x) => x.id === id);
  if (!l) throw new Error(`line ${id} missing; have ${lines.map((x) => x.id).join(', ')}`);
  return l;
};
const q = (lines: EstimateLine[], id: string) => [byId(lines, id).netQuantity, byId(lines, id).quantity];

describe('estimate engine — 5-marla single storey (worked example)', () => {
  const r = estimateQuantities(FIVE_MARLA, ESTIMATE_DEFAULTS);
  const L = r.lines;

  it('wall lengths: external from the footprint, internal from the room perimeters', () => {
    // Footprint F = covered 1,125 (one floor). Plot ratio r = 45 / 25 = 1.8.
    // Rectangle of 1,125 sq ft with that ratio: √(1125 / 1.8) = 25 ft by √(1125 × 1.8) = 45 ft → E = 2 × (25 + 45) = 140 ft.
    // P = E + 2·I → I = (320 − 140) / 2 = 90 ft.
    expect(footprintPerimeter(1125, 1.8)).toBeCloseTo(140, 6);
    expect(r.basis.floors[0]).toMatchObject({ footprintSqft: 1125, roomAreaSqft: 1000, roomPerimeterFt: 320, externalWallFt: 140, internalWallFt: 90, doorsSqft: 147, windowsSqft: 86 });
    // Foundation wall run (auto) = E + I of the lowest floor = 140 + 90 = 230 ft.
    expect(r.basis).toMatchObject({ structureType: 'LOAD_BEARING', coveredAreaSqft: 1125, coveredAreaSource: 'PROJECT', foundationWallLengthFt: 230, foundationWallLengthAuto: true });
    expect(r.warnings).toEqual([]);
  });

  it('foundation: excavation, PCC 1:4:8, stepped brick footing, DPC, termite', () => {
    // Excavation 230 × 3 × 5 = 3,450 cft
    expect(q(L, 'FOUNDATION.ALL.excavation.volume')).toEqual([3450, 3450]);
    // PCC 230 × 3 × 3/12 = 172.5 cft; dry 172.5 × 1.54 = 265.65 cft; 1 + 4 + 8 = 13 parts
    expect(q(L, 'FOUNDATION.ALL.pcc.volume')).toEqual([172.5, 172.5]);
    // cement 265.65 / 13 = 20.4346 cft ÷ 1.25 = 16.3477 bags → +5 % = 17.1651
    expect(q(L, 'FOUNDATION.ALL.pcc.cement')).toEqual([16.35, 17.17]);
    // sand 265.65 × 4/13 = 81.7385 → 85.8254; crush × 8/13 = 163.4769 → 171.6508
    expect(q(L, 'FOUNDATION.ALL.pcc.sand')).toEqual([81.74, 85.83]);
    expect(q(L, 'FOUNDATION.ALL.pcc.crush')).toEqual([163.48, 171.65]);
    // Stepped footing: avg width ((3 − 0.5) + 0.75) / 2 = 1.625 ft × 9″ (0.75 ft) × 230 = 280.3125
    // Wall to plinth: h = 5 − 0.25 (PCC) − 0.75 (footing) + 2 (plinth) = 6 ft → 230 × 0.75 × 6 = 1,035
    // Σ = 1,315.3125 cft
    expect(q(L, 'FOUNDATION.ALL.foundationMasonry.volume')).toEqual([1315.31, 1315.31]);
    // bricks 1,315.3125 × 13.5 = 17,756.72 → +5 % = 18,644.55
    expect(q(L, 'FOUNDATION.ALL.foundationMasonry.bricks')).toEqual([17756.72, 18644.55]);
    // mortar 1,315.3125 × 0.25 = 328.828 wet × 1.33 = 437.341 dry; 1:6 → cement 437.341 / 7 = 62.477 cft ÷ 1.25 = 49.98 bags
    expect(q(L, 'FOUNDATION.ALL.foundationMasonry.cement')).toEqual([49.98, 52.48]);
    // sand 437.341 × 6/7 = 374.86 cft
    expect(q(L, 'FOUNDATION.ALL.foundationMasonry.sand')).toEqual([374.86, 393.61]);
    // DPC 230 × 0.75 × 1.5/12 = 21.5625 cft; 1:2:4 → dry 33.206 / 7 = 4.7438 cft ÷ 1.25 = 3.795 bags
    expect(q(L, 'FOUNDATION.ALL.dpc.volume')).toEqual([21.56, 21.56]);
    expect(q(L, 'FOUNDATION.ALL.dpc.cement')).toEqual([3.8, 3.98]);
    // waterproofing compound 3.795 bags × 1 kg = 3.795 kg
    expect(q(L, 'FOUNDATION.ALL.dpc.waterproofing')).toEqual([3.8, 3.98]);
    // termite: footprint 1,125 × 0.005 L = 5.625 L → +5 % = 5.906
    expect(q(L, 'FOUNDATION.ALL.termite.termite')).toEqual([5.63, 5.91]);
  });

  it('walls: brickwork volume, bricks and 1:6 mortar; parapet on the roof', () => {
    // External (140 × 10 − 86) × 0.75 = 1,314 × 0.75 = 985.5; internal (90 × 10 − 147) × 0.375 = 753 × 0.375 = 282.375
    // Σ 1,267.875 cft
    expect(q(L, 'WALLS.GROUND.walls.volume')).toEqual([1267.88, 1267.88]);
    // bricks 1,267.875 × 13.5 = 17,116.31 → +5 % = 17,972.13
    expect(q(L, 'WALLS.GROUND.walls.bricks')).toEqual([17116.31, 17972.13]);
    // mortar 1,267.875 × 0.25 × 1.33 = 421.568 dry → cement 421.568 / 7 / 1.25 = 48.18 bags; sand × 6/7 = 361.34 cft
    expect(q(L, 'WALLS.GROUND.walls.cement')).toEqual([48.18, 50.59]);
    expect(q(L, 'WALLS.GROUND.walls.sand')).toEqual([361.34, 379.41]);
    // Parapet 140 × 3 ft × 4.5″ (0.375) = 157.5 cft → 2,126.25 bricks
    expect(q(L, 'WALLS.GROUND.parapet.volume')).toEqual([157.5, 157.5]);
    expect(q(L, 'WALLS.GROUND.parapet.bricks')).toEqual([2126.25, 2232.56]);
  });

  it('RCC: slab 1:2:4 with 1 % steel and shuttering, lintels over every opening; no frame for load-bearing', () => {
    // Slab 1,125 × 5/12 = 468.75 cft; dry × 1.54 = 721.875; cement 721.875 / 7 = 103.125 cft ÷ 1.25 = 82.5 bags
    expect(q(L, 'RCC.GROUND.slab.volume')).toEqual([468.75, 468.75]);
    expect(q(L, 'RCC.GROUND.slab.cement')).toEqual([82.5, 86.63]);
    // sand 721.875 × 2/7 = 206.25; crush × 4/7 = 412.5
    expect(q(L, 'RCC.GROUND.slab.sand')).toEqual([206.25, 216.56]);
    expect(q(L, 'RCC.GROUND.slab.crush')).toEqual([412.5, 433.13]);
    // steel 468.75 × 1 % × 222 = 1,040.625 kg
    expect(q(L, 'RCC.GROUND.slab.steel')).toEqual([1040.63, 1092.66]);
    expect(q(L, 'RCC.GROUND.slab.shuttering')).toEqual([1125, 1125]);
    expect(L.some((l) => l.element === 'frame')).toBe(false);
    // Lintels: doors 7 × (3 + 1) = 28, windows 5 × (4 + 1) = 25, vents 2 × (2 + 1) = 6 → 59 ft × 0.75 × 0.5 = 22.125 cft
    expect(q(L, 'RCC.GROUND.lintels.volume')).toEqual([22.13, 22.13]);
    // steel 22.125 × 1 % × 222 = 49.12 kg; shuttering 59 × (0.75 + 2 × 0.5) = 103.25 sq ft
    expect(q(L, 'RCC.GROUND.lintels.steel')).toEqual([49.12, 51.57]);
    expect(q(L, 'RCC.GROUND.lintels.shuttering')).toEqual([103.25, 103.25]);
  });

  it('plaster: room faces + ceilings 1:4 × 0.5″, external faces 1:4 × 0.75″', () => {
    // Internal: Σ 2 (L + W) × H − openings = 320 × 10 − (147 + 86) = 2,967 sq ft
    // mortar 2,967 × 0.5/12 × 1.33 = 164.42 dry; 1:4 → cement 164.42 / 5 / 1.25 = 26.31 bags; sand × 4/5 = 131.54
    expect(q(L, 'PLASTER.GROUND.plasterInternal.area')).toEqual([2967, 2967]);
    expect(q(L, 'PLASTER.GROUND.plasterInternal.cement')).toEqual([26.31, 27.62]);
    expect(q(L, 'PLASTER.GROUND.plasterInternal.sand')).toEqual([131.54, 138.11]);
    expect(q(L, 'PLASTER.GROUND.plasterCeiling.area')).toEqual([1000, 1000]);
    // External: 140 × (10 + 5/12) − 86 = 1,458.33 − 86 = 1,372.33 sq ft
    expect(q(L, 'PLASTER.GROUND.plasterExternal.area')).toEqual([1372.33, 1372.33]);
    // Parapet both faces 2 × 140 × 3 = 840 sq ft
    expect(q(L, 'PLASTER.GROUND.plasterParapet.area')).toEqual([840, 840]);
  });

  it('grand totals per material (with wastage) and the work quantities for labour', () => {
    expect(r.totals).toEqual([
      { material: 'cement', unit: 'bag', netQuantity: 275.29, quantity: 289.04 },
      { material: 'bricks', unit: 'nos', netQuantity: 36999.28, quantity: 38849.24 },
      { material: 'sand', unit: 'cft', netQuantity: 1411.3, quantity: 1481.85 },
      { material: 'crush', unit: 'cft', netQuantity: 614.43, quantity: 645.14 },
      { material: 'steel', unit: 'kg', netQuantity: 1089.75, quantity: 1144.23 },
      { material: 'waterproofing', unit: 'kg', netQuantity: 3.8, quantity: 3.98 },
      { material: 'termite', unit: 'litre', netQuantity: 5.63, quantity: 5.91 },
    ]);
    // bricks 17,756.72 + 17,116.31 + 2,126.25; plaster 2,967 + 1,000 + 1,372.33 + 840; shuttering 1,125 + 103.25
    expect(r.work).toEqual({ bricks: 36999.28, plasterSqft: 6179.33, shutteringSqft: 1228.25, steelKg: 1089.75 });
    expect(r.stageTotals.FOUNDATION.bricks).toBe(18644.55);
    expect(r.stageTotals.RCC.steel).toBe(1144.23);
  });

  it('every line carries its formula as text', () => {
    expect(byId(L, 'FOUNDATION.ALL.excavation.volume').formulaText).toBe('Trench 230 ft × 3 ft wide × 5 ft deep');
    expect(byId(L, 'RCC.GROUND.slab.steel').formulaText).toBe('468.75 cft × 1% × 222 kg per cft');
    expect(L.every((l) => !l.formulaText.includes('{'))).toBe(true);
  });
});

describe('estimate engine — variants', () => {
  it('RCC frame: beams + columns = 45 % of slab concrete, 2.5 % steel, 4 sq ft shuttering per cft', () => {
    const r = estimateQuantities({ ...FIVE_MARLA, structureType: 'FRAMED' }, ESTIMATE_DEFAULTS);
    // 468.75 × 45 % = 210.9375 cft; steel 210.9375 × 2.5 % × 222 = 1,170.70 kg (+5 % = 1,229.24); shuttering 210.9375 × 4 = 843.75 sq ft
    expect(q(r.lines, 'RCC.GROUND.frame.volume')).toEqual([210.94, 210.94]);
    expect(q(r.lines, 'RCC.GROUND.frame.steel')).toEqual([1170.7, 1229.24]);
    expect(q(r.lines, 'RCC.GROUND.frame.shuttering')).toEqual([843.75, 843.75]);
  });

  it('rooms far below the covered area are flagged (walls would be under-counted)', () => {
    // rooms 1,000 of 2,000 sq ft covered = 50 % < 70 %
    const r = estimateQuantities({ ...FIVE_MARLA, coveredAreaSqft: 2000 }, ESTIMATE_DEFAULTS);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'ROOMS_BELOW_COVERED', tab: 5, params: { percent: 50 } })]);
  });

  it('6″ slab, 1:6 external plaster, 10 % wastage, a fixed foundation length', () => {
    const s = effectiveSettings({ slabThicknessIn: 6, externalPlasterMix: '1:6', wastagePercent: 10, foundationWallLengthFt: 200 });
    const r = estimateQuantities(FIVE_MARLA, s);
    // 1,125 × 0.5 = 562.5 cft; steel 562.5 × 1 % × 222 = 1,248.75 → +10 % = 1,373.63
    expect(q(r.lines, 'RCC.GROUND.slab.steel')).toEqual([1248.75, 1373.63]);
    // excavation 200 × 3 × 5 = 3,000
    expect(q(r.lines, 'FOUNDATION.ALL.excavation.volume')).toEqual([3000, 3000]);
    expect(r.basis).toMatchObject({ foundationWallLengthFt: 200, foundationWallLengthAuto: false });
    // external plaster 140 × (10 + 0.5) − 86 = 1,384 sq ft × 0.75/12 × 1.33 = 115.05 dry / 7 / 1.25 = 13.15 bags
    expect(byId(r.lines, 'PLASTER.GROUND.plasterExternal.cement').netQuantity).toBe(13.15);
  });

  it('isolated footings: trench for walls + pads, RCC pads with 0.8 % steel', () => {
    const f: EstimateFoundation = { ...STRIP, type: 'ISOLATED', footingCount: 12, footingLengthFt: 4, footingWidthFt: 4, footingThicknessIn: 12, rccMix: '1:2:4' };
    const r = estimateQuantities({ ...FIVE_MARLA, foundation: f }, ESTIMATE_DEFAULTS);
    // trench = 9″ wall + 1 ft = 1.75 ft: 230 × 1.75 × 5 = 2,012.5 + pads 12 × 16 × 5 = 960 → 2,972.5
    expect(q(r.lines, 'FOUNDATION.ALL.excavation.volume')).toEqual([2972.5, 2972.5]);
    // pads RCC 12 × 4 × 4 × 1 = 192 cft; steel 192 × 0.8 % × 222 = 340.99 kg
    expect(q(r.lines, 'FOUNDATION.ALL.footing.volume')).toEqual([192, 192]);
    expect(q(r.lines, 'FOUNDATION.ALL.footing.steel')).toEqual([340.99, 358.04]);
    // walls on their own strip PCC: h = 5 − 0.25 + 2 = 6.75 → 230 × 0.75 × 6.75 = 1,164.375 cft
    expect(q(r.lines, 'FOUNDATION.ALL.foundationMasonry.volume')).toEqual([1164.38, 1164.38]);
  });

  it('raft and piles', () => {
    const raft = estimateQuantities({ ...FIVE_MARLA, foundation: { ...STRIP, type: 'RAFT', footingWidthFt: null, footingThicknessIn: 12, rccMix: '1:2:4' } }, ESTIMATE_DEFAULTS);
    // raft 1,125 × 1 ft = 1,125 cft; excavation 1,125 × 5 = 5,625
    expect(q(raft.lines, 'FOUNDATION.ALL.footing.volume')).toEqual([1125, 1125]);
    expect(q(raft.lines, 'FOUNDATION.ALL.excavation.volume')).toEqual([5625, 5625]);
    const piles = estimateQuantities(
      { ...FIVE_MARLA, foundation: { ...STRIP, type: 'PILE', footingWidthFt: null, pileCount: 10, pileDiameterIn: 12, pileDepthFt: 30, rccMix: '1:2:4' } },
      ESTIMATE_DEFAULTS,
    );
    // 10 × π × 0.5² × 30 = 235.62 cft
    expect(q(piles.lines, 'FOUNDATION.ALL.footing.volume')).toEqual([235.62, 235.62]);
  });

  it('bitumen DPC instead of waterproofing compound; stone masonry instead of bricks', () => {
    const r = estimateQuantities({ ...FIVE_MARLA, foundation: { ...STRIP, dpcMaterial: 'BITUMEN', masonry: 'STONE' } }, ESTIMATE_DEFAULTS);
    // 230 × 0.75 = 172.5 sq ft × 0.15 kg = 25.875 kg
    expect(q(r.lines, 'FOUNDATION.ALL.dpc.bitumen')).toEqual([25.88, 27.17]);
    expect(r.lines.some((l) => l.id === 'FOUNDATION.ALL.dpc.waterproofing')).toBe(false);
    expect(q(r.lines, 'FOUNDATION.ALL.foundationMasonry.stone')).toEqual([1315.31, 1381.08]);
    expect(r.lines.some((l) => l.id === 'FOUNDATION.ALL.foundationMasonry.bricks')).toBe(false);
  });

  it('two storeys + mumty: covered area shared by room area, parapet on the first-floor roof only', () => {
    const ground = FIVE_MARLA.floors[0]!;
    const r = estimateQuantities(
      {
        ...FIVE_MARLA,
        coveredAreaSqft: 2400,
        floors: [ground, { ...ground, level: 'FIRST', name: 'First floor' }, { level: 'MUMTY', name: 'Mumty', ceilingHeightFt: 9, rooms: [room(10, 10, [door])] }],
      },
      ESTIMATE_DEFAULTS,
    );
    // rooms 1,000 + 1,000 + 100 = 2,100 → shares 2,400 × 1000/2100 = 1,142.86 and 114.29
    expect(r.basis.floors.map((f) => f.footprintSqft)).toEqual([1142.86, 1142.86, 114.29]);
    expect(r.lines.filter((l) => l.element === 'parapet' && l.kind === 'WORK').map((l) => l.floor?.level)).toEqual(['FIRST']);
  });

  it('no rooms, no foundation, no structure type, no covered area: warnings, no crash', () => {
    const r = estimateQuantities(
      { plotAreaSqft: 1125, frontFt: 25, depthFt: 45, structureType: null, coveredAreaSqft: null, floors: [{ level: 'GROUND', name: 'Ground floor', ceilingHeightFt: 11, rooms: [] }], foundation: null },
      ESTIMATE_DEFAULTS,
    );
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['COVERED_AREA_ESTIMATED', 'FOUNDATION_MISSING', 'NO_ROOMS', 'STRUCTURE_TYPE_ASSUMED']);
    expect(r.lines).toEqual([]);
    expect(r.totals).toEqual([]);
    // Foundation length falls back to the plot perimeter 2 × (25 + 45) = 140 when there are no rooms
    expect(r.basis.foundationWallLengthFt).toBe(140);
    const empty = estimateQuantities({ plotAreaSqft: null, frontFt: null, depthFt: null, structureType: null, coveredAreaSqft: null, floors: [], foundation: STRIP }, ESTIMATE_DEFAULTS);
    expect(empty.warnings.map((w) => w.code)).toContain('FOUNDATION_LENGTH_UNKNOWN');
  });

  it('covered area but no rooms: slabs from the covered area split over the floors', () => {
    const r = estimateQuantities(
      { ...FIVE_MARLA, coveredAreaSqft: 2000, floors: [{ level: 'GROUND', name: 'G', ceilingHeightFt: 11, rooms: [] }, { level: 'FIRST', name: 'F', ceilingHeightFt: 10, rooms: [] }] },
      ESTIMATE_DEFAULTS,
    );
    // 2,000 / 2 floors = 1,000 sq ft × 5/12 = 416.67 cft each
    expect(r.lines.filter((l) => l.element === 'slab' && l.measure === 'VOLUME').map((l) => l.netQuantity)).toEqual([416.67, 416.67]);
  });
});

describe('estimate settings', () => {
  it('stored overrides: only valid keys survive; defaults fill the rest', () => {
    expect(readOverrides({ slabThicknessIn: 6, bogus: 1, wastagePercent: 99, rccMix: '1:3:6' })).toEqual({ slabThicknessIn: 6 });
    expect(readOverrides(null)).toEqual({});
    expect(effectiveSettings({ slabThicknessIn: 6 })).toEqual({ ...ESTIMATE_DEFAULTS, slabThicknessIn: 6 });
  });
});

describe('estimate costing', () => {
  const r = estimateQuantities(FIVE_MARLA, ESTIMATE_DEFAULTS);
  const entry = (unit: string, rupees: number | null, altUnits: Array<{ unit: string; factor: number }> = []) => ({
    materialId: `m-${unit}`,
    materialName: unit,
    unit,
    altUnits,
    ratePaisa: rupees === null ? null : BigInt(rupees * 100),
    qualityCategory: { id: 'c', name: 'A Standard' },
    suppliedBy: 'CONTRACTOR' as const,
  });
  // The seeded Malik "A Standard" rates: cement 1,450 / bag, bricks 17 / brick, steel 2,85,000 / ton, Chenab sand 70 / cft, Margalla crush 180 / cft.
  const prices: PriceBook = {
    cement: entry('bag', 1450),
    bricks: entry('nos', 17, [{ unit: 'thousand', factor: 0.001 }]),
    steel: entry('ton', 285000, [{ unit: 'kg', factor: 1000 }]),
    sand: entry('cft', 70),
    crush: entry('cft', 180),
    // no rate for waterproofing compound / termite chemical
  };
  const labour = {
    pieceRates: {
      BRICK_MASONRY: { unit: 'BRICK', ratePaisa: 900n, label: 'Brick masonry' },
      PLASTER: { unit: 'SQFT', ratePaisa: 2200n, label: 'Plaster' },
      SHUTTERING: { unit: 'SQFT', ratePaisa: 4500n, label: 'Shuttering' },
      STEEL_FIXING: { unit: 'TON', ratePaisa: 900000n, label: 'Steel fixing' },
    },
  };

  it('unit conversion: kg → ton, nos → thousand, cft → trolley, alt units', () => {
    expect(toBaseUnit(1144.23, 'kg', 'ton')).toBeCloseTo(1.14423, 6);
    expect(toBaseUnit(38849, 'nos', 'thousand')).toBeCloseTo(38.849, 6);
    expect(toBaseUnit(250, 'cft', 'trolley')).toBe(2.5);
    expect(toBaseUnit(10, 'bag', 'kg')).toBe(500);
    expect(toBaseUnit(5, 'litre', 'drum', [{ unit: 'litre', factor: 200 }])).toBe(0.025);
    expect(toBaseUnit(5, 'kg', 'coil')).toBeNull();
  });

  it('prices every line; missing rates are left out of the totals; piece-rate labour; margin vs contract', () => {
    const p = priceEstimate(r, prices, labour, { settings: ESTIMATE_DEFAULTS, contractTotalPaisa: 3_000_000_00n });
    const slabSteel = p.lines.find((l) => l.id === 'RCC.GROUND.slab.steel')!;
    // 1,092.66 kg = 1.09266 t × 2,85,000 = Rs 3,11,408.10
    expect(slabSteel).toMatchObject({ rateQuantity: 1.0927, rateUnit: 'ton', amountPaisa: 31140810n, rateStatus: 'OK' });
    const cement = p.materials.find((m) => m.material === 'cement')!;
    // amount = Σ line amounts (each line qty × 1,450); 289.04 bags ≈ Rs 4,19,108
    expect(Number(cement.amountPaisa) / 100).toBeCloseTo(289.04 * 1450, -1);
    expect(p.missingRates).toEqual([
      { material: 'waterproofing', status: 'RATE_MISSING' },
      { material: 'termite', status: 'RATE_MISSING' },
    ]);
    expect(p.materials.find((m) => m.material === 'termite')).toMatchObject({ amountPaisa: null, rateStatus: 'RATE_MISSING' });
    const sumMaterials = p.materials.reduce((a, m) => a + (m.amountPaisa ?? 0n), 0n);
    expect(p.cost.materialsPaisa).toBe(sumMaterials);
    // Labour: bricks 36,999.28 × 9 = 3,32,993.52; plaster 6,179.33 × 22 = 1,35,945.26;
    // shuttering 1,228.25 × 45 = 55,271.25; steel 1.0898 t × 9,000 = 9,808.20 → Rs 5,34,018.23
    expect(p.labour.method).toBe('PIECE_RATES');
    expect(p.labour.totalPaisa).toBe(53401823n);
    expect(p.cost.totalPaisa).toBe(p.cost.materialsPaisa + p.cost.labourPaisa);
    expect(p.cost.marginPaisa).toBe(3_000_000_00n - p.cost.totalPaisa);
    expect(p.cost.marginPercent).toBeCloseTo((Number(p.cost.marginPaisa) / 3_000_000_00) * 100, 2);
    // per sq ft = total ÷ 1,125
    expect(p.cost.perSqftPaisa).toBe(BigInt(Math.round(Number(p.cost.totalPaisa) / 1125)));
  });

  it('labour per sq ft when set; owner-supplied material valued but outside the contractor cost', () => {
    const s = effectiveSettings({ labourRatePerSqftPaisa: '45000' });
    const owner = { ...prices, bricks: { ...prices.bricks!, suppliedBy: 'OWNER' as const } };
    const p = priceEstimate(r, owner, labour, { settings: s, contractTotalPaisa: null });
    // 1,125 sq ft × Rs 450 = Rs 5,06,250
    expect(p.labour).toMatchObject({ method: 'PER_SQFT', totalPaisa: 50625000n });
    expect(p.cost.ownerSuppliedPaisa).toBeGreaterThan(0n);
    expect(p.cost.totalPaisa).toBe(p.cost.materialsPaisa + 50625000n);
    expect(p.cost.marginPaisa).toBeNull();
    const off = priceEstimate(r, prices, labour, { settings: effectiveSettings({ includeLabour: false }), contractTotalPaisa: null });
    expect(off.labour).toEqual({ method: 'EXCLUDED', lines: [], totalPaisa: 0n });
  });

  it('missing piece rates are reported, not guessed', () => {
    const p = priceEstimate(r, prices, { pieceRates: { PLASTER: { unit: 'SQFT', ratePaisa: 2200n, label: 'Plaster' } } }, { settings: ESTIMATE_DEFAULTS, contractTotalPaisa: null });
    expect(p.missingLabourRates).toEqual(['BRICK_MASONRY', 'SHUTTERING', 'STEEL_FIXING']);
    // only plaster: 6,179.33 × 22 = 1,35,945.26
    expect(p.labour.totalPaisa).toBe(13594526n);
  });
});
