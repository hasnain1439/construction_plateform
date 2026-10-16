/**
 * Detailed estimate (roof / lenter data + walls per room side) — hand-checked numbers. The
 * arithmetic is written out so the owner can follow it with a calculator (README → "How the
 * estimate is calculated" → "Detailed: roof" / "Detailed: walls").
 *
 * Steel weight: kg per metre = d² / 162 → kg per ft = 0.3048 × d² / 162
 *   #3 (10 mm) = 0.3048 × 100 / 162 = 0.188148 kg/ft · #4 (12 mm) = 0.3048 × 144 / 162 = 0.270933 kg/ft
 */
import { describe, expect, it } from 'vitest';
import { anchorageFt, defaultColumnCount, detailedWalls, kgPerFt, slabPanelBars, stirrupLengthFt } from '../../src/modules/estimate/detailed.js';
import { estimateQuantities, type EstimateInput, type EstimateLine, type EstimateRoom } from '../../src/modules/estimate/engine.js';
import { ESTIMATE_DEFAULTS } from '../../src/modules/estimate/settings.js';
import { normaliseRoof, roofInputSchema, roofWarnings, suggestSlab, type Roof } from '../../src/modules/projects/roof.js';
import type { Wall, WallSide, WallType } from '../../src/modules/projects/walls.js';
import { applyWalls, releaseRoom } from '../../src/modules/projects/walls.service.js';

const byId = (lines: EstimateLine[], id: string) => {
  const l = lines.find((x) => x.id === id);
  if (!l) throw new Error(`line ${id} missing; have ${lines.map((x) => x.id).join(', ')}`);
  return l;
};
const net = (lines: EstimateLine[], id: string) => byId(lines, id).netQuantity;

const wall = (side: WallSide, type: WallType, extra: Partial<Wall> = {}): Wall => ({
  side,
  type,
  thicknessIn: type === 'OPEN' ? null : 9,
  innerLeafIn: null,
  cavityIn: null,
  sharedWithRoomId: null,
  sharedWithSide: null,
  existing: false,
  ...extra,
});
const external = (...except: Wall[]): Wall[] =>
  (['TOP', 'RIGHT', 'BOTTOM', 'LEFT'] as WallSide[]).map((s) => except.find((w) => w.side === s) ?? wall(s, 'EXTERNAL'));

const rcc: Roof = normaliseRoof({ type: 'RCC_SLAB' }); // 5″, #4 @ 6″ main, #3 @ 9″ distribution, top bars on

const input = (rooms: EstimateRoom[], over: Partial<EstimateInput> = {}, roof: Roof | null = null): EstimateInput => ({
  plotAreaSqft: null,
  frontFt: null,
  depthFt: null,
  structureType: 'LOAD_BEARING',
  coveredAreaSqft: null,
  foundation: null,
  floors: [{ level: 'GROUND', name: 'Ground floor', ceilingHeightFt: 10, rooms, roof }],
  ...over,
});
const room = (id: string, lengthFt: number, widthFt: number, walls: Wall[] | null, openings: EstimateRoom['openings'] = []): EstimateRoom => ({
  id,
  name: id,
  lengthFt,
  widthFt,
  heightFt: 10,
  isWet: false,
  openings,
  walls,
});

describe('roof defaults, suggestion and warnings', () => {
  it('fills the Pakistani defaults and drops fields of other roof types', () => {
    expect(rcc).toMatchObject({ type: 'RCC_SLAB', thicknessIn: 5, concreteMix: '1:2:4', steelGrade: 'G60', mainBar: 4, mainSpacingIn: 6, distBar: 3, distSpacingIn: 9, topBars: true, coverIn: 0.75 });
    expect(rcc).toMatchObject({ beamWidthIn: 9, beamDepthIn: 15, beamBars: 4, beamBar: 5, stirrupBar: 3, stirrupSpacingIn: 6, columnWidthIn: 12, columnBars: 6, columnBar: 5, tieBar: 3, tieSpacingIn: 6 });
    expect(rcc.tIronSection).toBeNull();
    const t = normaliseRoof({ type: 'T_IRON_TILE' });
    expect(t).toMatchObject({ thicknessIn: null, mainBar: null, tIronSection: 'G5X3', tIronSpacingFt: 3, infill: 'BRICK', screedThicknessIn: 3, earthFillIn: 4 });
    expect(normaliseRoof({ type: 'STEEL_DECK' })).toMatchObject({ toppingIn: 4, mesh: true, deckAreaSqft: null });
    expect(normaliseRoof({ type: 'PRECAST' })).toMatchObject({ toppingIn: 2, mesh: true });
  });

  it('validates hard limits (spacing ≥ 3″) and beam depth > slab', () => {
    expect(roofInputSchema.safeParse({ type: 'RCC_SLAB', mainSpacingIn: 2 }).success).toBe(false);
    expect(roofInputSchema.safeParse({ type: 'RCC_SLAB', mainBar: 7 }).success).toBe(false);
    expect(roofInputSchema.safeParse({ type: 'RCC_SLAB', thicknessIn: 6, beamDepthIn: 6 }).success).toBe(false);
    expect(roofInputSchema.safeParse({ type: 'RCC_SLAB', unknown: 1 }).success).toBe(false);
  });

  it('suggests the thickness by the largest short span and warns when too thin / bars too far apart', () => {
    expect(suggestSlab(11)).toMatchObject({ suggestedIn: 5, minIn: 4.5, beamAdvised: false });
    expect(suggestSlab(14)).toMatchObject({ suggestedIn: 5, minIn: 5 });
    expect(suggestSlab(16)).toMatchObject({ suggestedIn: 6, minIn: 6 });
    expect(suggestSlab(20)).toMatchObject({ suggestedIn: 7, beamAdvised: true });
    // 5″ slab over a 16 ft span → too thin (6″ suggested)
    expect(roofWarnings(rcc, 16).map((w) => w.code)).toEqual(['ROOF_TOO_THIN']);
    // 4″ slab, #4 @ 10″: max spacing = min(12, 2 × 4) = 8″ → main spacing too wide; distribution 9″ too
    const thin = normaliseRoof({ type: 'RCC_SLAB', thicknessIn: 4, mainSpacingIn: 10 });
    expect(roofWarnings(thin, 10).map((w) => w.code)).toEqual(['ROOF_TOO_THIN', 'ROOF_MAIN_SPACING_WIDE', 'ROOF_DIST_SPACING_WIDE']);
    expect(roofWarnings(rcc, 12)).toEqual([]);
  });
});

describe('RCC slab steel by actual bars — 12 × 15 ft room, 5″, #4 @ 6″, #3 @ 9″', () => {
  // Short span 12 ft, long side 15 ft. Anchorage each end = max(12 × d, 6″):
  //   #4: 12 × 12 mm = 144 mm = 5.67″ → 6″ = 0.5 ft · #3: 12 × 10 mm = 4.72″ → 6″ = 0.5 ft
  // Main #4 along the short span: ⌈15 × 12 / 6⌉ + 1 = 31 bars × (12 + 2 × 0.5) = 13 ft → 403 ft
  // Distribution #3 along the long side: ⌈12 × 12 / 9⌉ + 1 = 17 bars × (15 + 1) = 16 ft → 272 ft
  // Top bars #4 over both long supports, every other bar (@ 12″): 2 × (⌈15 × 12 / 12⌉ + 1) = 32 bars
  //   × (0.25 × 12 + 0.5) = 3.5 ft → 112 ft
  // #4: (403 + 112) = 515 ft × 0.270933 = 139.53 kg · #3: 272 ft × 0.188148 = 51.18 kg
  // Concrete 12 × 15 = 180 sq ft × 5/12 = 75 cft (old 1 % method: 75 × 1 % × 222 = 166.5 kg of mixed steel)
  it('bar runs', () => {
    expect(anchorageFt(12)).toBe(0.5);
    expect(anchorageFt(10)).toBe(0.5);
    expect(kgPerFt(12)).toBeCloseTo(0.270933, 6);
    const runs = slabPanelBars(12, 15, rcc, 'Bedroom');
    expect(runs.map((r) => [r.use, r.bar, r.count, r.lengthFt])).toEqual([
      ['MAIN', 4, 31, 13],
      ['DIST', 3, 17, 16],
      ['TOP', 4, 32, 3.5],
    ]);
  });

  it('estimate lines: steel by size, concrete, shuttering, method DETAILED', () => {
    const r = estimateQuantities(input([room('Bedroom', 15, 12, null)], { coveredAreaSqft: 180 }, rcc));
    expect(net(r.lines, 'RCC.GROUND.slab.volume')).toBe(75);
    expect(net(r.lines, 'RCC.GROUND.slab.steel12')).toBe(139.53);
    expect(net(r.lines, 'RCC.GROUND.slab.steel10')).toBe(51.18);
    // + 5 % wastage
    expect(byId(r.lines, 'RCC.GROUND.slab.steel12').quantity).toBe(146.51);
    expect(byId(r.lines, 'RCC.GROUND.slab.steel12').formulaText).toBe('#4 (12 mm): 63 bars, 515 ft × 0.2709 kg/ft');
    expect(r.lines.find((l) => l.id === 'RCC.GROUND.slab.steel')).toBeUndefined();
    expect(net(r.lines, 'RCC.GROUND.slab.shuttering')).toBe(180);
    // 1:2:4: 75 × 1.54 = 115.5 dry / 7 = 16.5 cft ÷ 1.25 = 13.2 bags
    expect(net(r.lines, 'RCC.GROUND.slab.cement')).toBe(13.2);
    expect(byId(r.lines, 'RCC.GROUND.slab.volume').method).toBe('DETAILED');
    expect(r.basis.floors[0]!.roofMethod).toBe('DETAILED');
    expect(r.basis.floors[0]!.roof).toMatchObject({ type: 'RCC_SLAB', thicknessIn: 5, largestSpanFt: 12, steelBySize: [{ bar: 3, mm: 10, kg: 51.18 }, { bar: 4, mm: 12, kg: 139.53 }] });
    expect(r.basis.methods.roof).toBe('DETAILED');
    expect(r.totals.map((t) => t.material)).toEqual(expect.arrayContaining(['steel10', 'steel12']));
  });

  it('without roof data the old % method stays (ESTIMATED)', () => {
    const r = estimateQuantities(input([room('Bedroom', 15, 12, null)], { coveredAreaSqft: 180 }));
    // 75 cft × 1 % × 222 = 166.5 kg
    expect(net(r.lines, 'RCC.GROUND.slab.steel')).toBe(166.5);
    expect(byId(r.lines, 'RCC.GROUND.slab.steel').method).toBe('ESTIMATED');
    expect(r.basis.methods).toEqual({ walls: 'ESTIMATED', roof: 'ESTIMATED' });
  });

  it('slab area outside the rooms gets steel at the rooms’ rate', () => {
    // Covered 300 sq ft, room 180 → extra = 300 − 180 × 1.15 = 93 sq ft → factor 1 + 93 / 180 = 1.51667
    const r = estimateQuantities(input([room('Bedroom', 15, 12, null)], { coveredAreaSqft: 300 }, rcc));
    // #4: 515 × 1.51667 = 781.08 ft × 0.270933 = 211.62 kg
    expect(net(r.lines, 'RCC.GROUND.slab.steel12')).toBe(211.62);
    expect(byId(r.lines, 'RCC.GROUND.slab.steel12').formula.key).toBe('barsExtra');
  });

  it('RCC frame: beams and columns from their sizes and bars', () => {
    const framed = normaliseRoof({ type: 'RCC_SLAB', beamRunFt: 100, columnCount: 4 });
    const r = estimateQuantities(input([room('Hall', 15, 12, null)], { coveredAreaSqft: 180, structureType: 'FRAMED' }, framed));
    // Beams 100 ft × 9″ × (15 − 5)″ = 100 × 0.75 × 0.8333 = 62.5 cft
    expect(net(r.lines, 'RCC.GROUND.beams.volume')).toBe(62.5);
    // Main 4 #5 × 100 × 1.05 = 420 ft × (0.3048 × 256 / 162 = 0.481659) = 202.3 kg
    expect(net(r.lines, 'RCC.GROUND.beams.steel16')).toBe(202.3);
    // Stirrups #3 @ 6″: ⌈1,200 / 6⌉ + 1 = 201 × (2 × (6 + 12) + 20 × 0.3937)/12 = (36 + 7.874) / 12 = 3.6562 ft → 734.89 ft × 0.188148 = 138.27 kg
    expect(stirrupLengthFt(9, 15, 3)).toBeCloseTo(3.65617, 4);
    expect(net(r.lines, 'RCC.GROUND.beams.steel10')).toBe(138.27);
    // Beam sides 2 × 100 × 10/12 = 166.67 sq ft
    expect(net(r.lines, 'RCC.GROUND.beams.shuttering')).toBe(166.67);
    // Columns 4 × 1 × 1 × 10 = 40 cft
    expect(net(r.lines, 'RCC.GROUND.columns.volume')).toBe(40);
    // Bars 4 × 6 = 24 #5 × (10 + 5/12 + 50 × 16 / 304.8 = 2.6247) = 13.0413 ft → 312.99 ft × 0.481659 = 150.76 kg
    expect(net(r.lines, 'RCC.GROUND.columns.steel16')).toBe(150.76);
    expect(r.lines.find((l) => l.element === 'frame')).toBeUndefined();
    // Default column count on a 25 × 45 footprint: (⌈25/15⌉ + 1) × (⌈45/15⌉ + 1) = 3 × 4 = 12
    expect(defaultColumnCount(1125, 1.8)).toBe(12);
  });

  it('T-iron + brick roof: garders, bricks, screed, earth', () => {
    const roof = normaliseRoof({ type: 'T_IRON_TILE' }); // G5X3 @ 3 ft, bricks, 3″ screed, 4″ earth
    const r = estimateQuantities(input([room('Room', 15, 12, null)], { coveredAreaSqft: 180 }, roof));
    // Garders: ⌈15 / 3⌉ − 1 = 4 × (12 + 2 × 0.75) = 13.5 ft → 54 ft × 5 kg/ft = 270 kg
    expect(net(r.lines, 'RCC.GROUND.girders.tIron')).toBe(270);
    // Bricks laid flat: 180 × 3.2 = 576
    expect(net(r.lines, 'RCC.GROUND.roofInfill.bricks')).toBe(576);
    // Screed 180 × 3/12 = 45 cft; earth 180 × 4/12 = 60 cft; no shuttering
    expect(net(r.lines, 'RCC.GROUND.screed.volume')).toBe(45);
    expect(net(r.lines, 'RCC.GROUND.earthFill.volume')).toBe(60);
    expect(r.lines.some((l) => l.measure === 'SHUTTERING' && l.element !== 'lintels')).toBe(false);
  });

  it('steel deck: sheet area, 4″ topping, #3 mesh', () => {
    const r = estimateQuantities(input([room('Room', 15, 12, null)], { coveredAreaSqft: 180 }, normaliseRoof({ type: 'STEEL_DECK' })));
    expect(net(r.lines, 'RCC.GROUND.deck.steelDeck')).toBe(180);
    expect(net(r.lines, 'RCC.GROUND.topping.volume')).toBe(60);
    // Mesh 2 × 180 × 1.1 = 396 ft × 0.188148 = 74.51 kg
    expect(net(r.lines, 'RCC.GROUND.topping.steel10')).toBe(74.51);
  });
});

describe('walls per side', () => {
  it('two rooms with one shared wall: counted once', () => {
    // A 12 × 10 and B 12 × 10 (L × W), A.RIGHT ↔ B.LEFT (10 ft, 4.5″); every other side EXTERNAL 9″.
    const A = room('A', 12, 10, external(wall('RIGHT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'B', sharedWithSide: 'LEFT' })));
    const B = room('B', 12, 10, external(wall('LEFT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'A', sharedWithSide: 'RIGHT' })));
    const r = estimateQuantities(input([A, B]));
    // External run: A 12 + 12 + 10 = 34, B 34 → 68 ft; 68 × 10 = 680 sq ft × 0.75 = 510 cft → 6,885 bricks
    expect(net(r.lines, 'WALLS.GROUND.walls.t9.volume')).toBe(510);
    expect(net(r.lines, 'WALLS.GROUND.walls.t9.bricks')).toBe(6885);
    // Shared 10 × 10 = 100 sq ft × 0.375 = 37.5 cft (ONCE — counting from both rooms would give 75) → 506.25 bricks
    expect(net(r.lines, 'WALLS.GROUND.walls.t4_5.volume')).toBe(37.5);
    expect(net(r.lines, 'WALLS.GROUND.walls.t4_5.bricks')).toBe(506.25);
    expect(r.basis.floors[0]).toMatchObject({ wallsMethod: 'DETAILED', externalWallFt: 68, internalWallFt: 10, walls: { builtRunFt: 78 } });
    // Plaster: inside faces 2 × 2 × (12 + 10) × 10 = 880 (both faces of the shared wall); outside 68 × (10 + 5/12) = 708.33
    expect(net(r.lines, 'PLASTER.GROUND.plasterInternal.area')).toBe(880);
    expect(net(r.lines, 'PLASTER.GROUND.plasterExternal.area')).toBe(708.33);
    expect(byId(r.lines, 'WALLS.GROUND.walls.t9.volume').method).toBe('DETAILED');
  });

  it('openings on a side come off that wall; a door in the shared wall once', () => {
    const door = { type: 'DOOR' as const, widthFt: 3, heightFt: 7, quantity: 1, side: 'RIGHT' as const };
    const win = { type: 'WINDOW' as const, widthFt: 4, heightFt: 4, quantity: 1, side: 'TOP' as const };
    const A = room('A', 12, 10, external(wall('RIGHT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'B', sharedWithSide: 'LEFT' })), [door, win]);
    const B = room('B', 12, 10, external(wall('LEFT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'A', sharedWithSide: 'RIGHT' })));
    const r = estimateQuantities(input([A, B]));
    // Shared (100 − 21) × 0.375 = 29.625 cft; external (680 − 16) × 0.75 = 498 cft
    expect(net(r.lines, 'WALLS.GROUND.walls.t4_5.volume')).toBe(29.63);
    expect(net(r.lines, 'WALLS.GROUND.walls.t9.volume')).toBe(498);
    // Lintels: door (3 + 1) × 4.5″ wall + window (4 + 1) × 9″ wall, 6″ deep → 4 × 0.375 × 0.5 + 5 × 0.75 × 0.5 = 0.75 + 1.875 = 2.625 cft
    expect(net(r.lines, 'RCC.GROUND.lintels.volume')).toBe(2.63);
    expect(byId(r.lines, 'RCC.GROUND.lintels.volume').method).toBe('DETAILED');
  });

  it('party wall already built: no brickwork, no foundation; inner face still plastered', () => {
    const A = room('A', 12, 10, external(wall('LEFT', 'PARTY', { existing: true })));
    const r = estimateQuantities(input([A]));
    // Built: 12 + 10 + 12 = 34 ft × 10 = 340 sq ft × 0.75 = 255 cft
    expect(net(r.lines, 'WALLS.GROUND.walls.t9.volume')).toBe(255);
    expect(r.basis.floors[0]!.walls).toMatchObject({ partyExistingFt: 10, builtRunFt: 34 });
    expect(net(r.lines, 'PLASTER.GROUND.plasterInternal.area')).toBe(440);
    // Outside: 34 × (10 + 5/12) = 354.17
    expect(net(r.lines, 'PLASTER.GROUND.plasterExternal.area')).toBe(354.17);
    // A new party wall (not existing) is built and in the foundation run
    const built = estimateQuantities(input([room('A', 12, 10, external(wall('LEFT', 'PARTY')))]));
    expect(net(built.lines, 'WALLS.GROUND.walls.t9.volume')).toBe(330);
  });

  it('double (cavity) wall: both leaves, nothing for the cavity', () => {
    const A = room('A', 12, 10, external(wall('TOP', 'DOUBLE', { innerLeafIn: 4.5, cavityIn: 2 })));
    const r = estimateQuantities(input([A]));
    // 9″ leaves: (12 + 10 + 12 + 10) × 10 = 440 sq ft × 0.75 = 330 cft; 4.5″ inner leaf: 12 × 10 = 120 × 0.375 = 45 cft
    expect(net(r.lines, 'WALLS.GROUND.walls.t9.volume')).toBe(330);
    expect(net(r.lines, 'WALLS.GROUND.walls.t4_5.volume')).toBe(45);
  });

  it('foundation run from the ground-floor walls (shared once, party existing and open excluded)', () => {
    const STRIP = {
      type: 'STRIP' as const, excavationDepthFt: 5, footingWidthFt: 3, footingThicknessIn: 9, plinthHeightFt: 2, dpcThicknessIn: 1.5,
      footingCount: null, footingLengthFt: null, pileCount: null, pileDiameterIn: null, pileDepthFt: null, masonry: 'BRICK' as const,
      pccMix: '1:4:8', pccThicknessIn: 3, rccMix: null, termiteTreatment: false, dpcMaterial: 'BITUMEN' as const,
    };
    const A = room('A', 12, 10, external(wall('RIGHT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'B', sharedWithSide: 'LEFT' }), wall('LEFT', 'PARTY', { existing: true })));
    const B = room('B', 12, 10, external(wall('LEFT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'A', sharedWithSide: 'RIGHT' }), wall('RIGHT', 'OPEN')));
    const r = estimateQuantities(input([A, B], { foundation: STRIP }));
    // A: 12 + 12 (+ party existing 10 excluded) · shared 10 once · B: 12 + 12 (+ open 10 excluded) → 58 ft
    expect(r.basis).toMatchObject({ foundationWallLengthFt: 58, foundationWallLengthSource: 'WALLS' });
    expect(net(r.lines, 'FOUNDATION.ALL.excavation.volume')).toBe(58 * 3 * 5);
    expect(byId(r.lines, 'FOUNDATION.ALL.excavation.volume').method).toBe('DETAILED');
  });

  it('shared sides of different lengths: the shorter is shared, the rest is a wall of its own', () => {
    // A.RIGHT is 10 ft, B.LEFT is 8 ft → 8 ft shared + 2 ft remainder (4.5″)
    const A = room('A', 12, 10, external(wall('RIGHT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'B', sharedWithSide: 'LEFT' })));
    const B = room('B', 12, 8, external(wall('LEFT', 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: 'A', sharedWithSide: 'RIGHT' })));
    const d = detailedWalls([A, B], 5, 9, 1);
    expect(d.segments.filter((s) => s.kind === 'SHARED').map((s) => s.lengthFt)).toEqual([8]);
    expect(d.segments.filter((s) => s.kind === 'REMAINDER').map((s) => s.lengthFt)).toEqual([2]);
    expect(d.byThickness.find((t) => t.thicknessIn === 4.5)!.volumeCft).toBeCloseTo((8 + 2) * 10 * 0.375, 6);
  });

  it('a floor with some rooms missing walls stays on the perimeter method with a warning', () => {
    const r = estimateQuantities(input([room('A', 12, 10, external()), room('B', 12, 10, null)]));
    expect(r.basis.floors[0]!.wallsMethod).toBe('ESTIMATED');
    expect(r.warnings.map((w) => w.code)).toContain('WALLS_PARTIAL');
    expect(byId(r.lines, 'WALLS.GROUND.walls.volume').method).toBe('ESTIMATED');
  });
});

describe('shared-wall pairing', () => {
  const rooms = new Map([
    ['A', { id: 'A', name: 'A', lengthFt: 12, widthFt: 10 }],
    ['B', { id: 'B', name: 'B', lengthFt: 12, widthFt: 10 }],
    ['C', { id: 'C', name: 'C', lengthFt: 10, widthFt: 8 }],
  ]);
  const shared = (side: WallSide, withId: string, withSide: WallSide | null = null) => wall(side, 'SHARED', { thicknessIn: 4.5, sharedWithRoomId: withId, sharedWithSide: withSide });

  it('A.RIGHT → B creates B.LEFT (the opposite side) and keeps both consistent', () => {
    const state = new Map<string, Wall[] | null>([['A', null], ['B', null], ['C', null]]);
    const changed = applyWalls('A', external(shared('RIGHT', 'B')), state, rooms);
    expect([...changed].sort()).toEqual(['A', 'B']);
    expect(state.get('A')!.find((w) => w.side === 'RIGHT')).toMatchObject({ sharedWithRoomId: 'B', sharedWithSide: 'LEFT' });
    expect(state.get('B')!.find((w) => w.side === 'LEFT')).toMatchObject({ type: 'SHARED', thicknessIn: 4.5, sharedWithRoomId: 'A', sharedWithSide: 'RIGHT' });
    expect(state.get('B')!.filter((w) => w.type === 'EXTERNAL')).toHaveLength(3);

    // Changing A.RIGHT to EXTERNAL releases B.LEFT back to EXTERNAL
    applyWalls('A', external(), state, rooms);
    expect(state.get('B')!.every((w) => w.type === 'EXTERNAL')).toBe(true);
  });

  it('a taken side → 409 WALL_SIDE_TAKEN; the opposite taken → the next free side', () => {
    const state = new Map<string, Wall[] | null>([['A', null], ['B', null], ['C', null]]);
    applyWalls('A', external(shared('RIGHT', 'B')), state, rooms);
    // C.TOP → B.LEFT explicitly: taken by A
    expect(() => applyWalls('C', external(shared('TOP', 'B', 'LEFT')), state, rooms)).toThrow(/already shared/);
    // C.RIGHT → B (opposite = LEFT, taken) → a free side of B closest in length to 8 ft (RIGHT 10 ft)
    applyWalls('C', external(shared('RIGHT', 'B')), state, rooms);
    expect(state.get('C')!.find((w) => w.side === 'RIGHT')!.sharedWithSide).toBe('RIGHT');
  });

  it('deleting a room turns its partners’ sides into EXTERNAL', () => {
    const state = new Map<string, Wall[] | null>([['A', null], ['B', null], ['C', null]]);
    applyWalls('A', external(shared('RIGHT', 'B')), state, rooms);
    const changed = releaseRoom('A', state);
    expect([...changed]).toEqual(['B']);
    expect(state.get('B')!.every((w) => w.type === 'EXTERNAL')).toBe(true);
  });

  it('sharing with itself / another floor → 400', () => {
    const state = new Map<string, Wall[] | null>([['A', null]]);
    expect(() => applyWalls('A', external(shared('RIGHT', 'A')), state, rooms)).toThrow(/same floor/);
    expect(() => applyWalls('A', external(shared('RIGHT', 'Z')), state, rooms)).toThrow(/same floor/);
  });
});
