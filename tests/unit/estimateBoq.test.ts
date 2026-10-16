/**
 * BoQ builder (src/modules/estimate/boq.ts) — the worked 10-marla example (estimateBoq.fixture.ts)
 * with every section total worked out by hand below (Rs; the assertions are in paisa), plus the
 * rules: wet-room tiles, owner-supplied lines without rates, GREY_OWNER_FINISHING, Sindh blocks,
 * rulebook layers, norm warnings.
 *
 * Engine quantities used (Punjab rulebook v1, see tests/unit/estimateEngine.test.ts for the method):
 *   footprint 24 × 60 = 1,440 sq ft → external run E = 2 × (24 + 60) = 168 ft; P = 396 → internal
 *   I = (396 − 168) / 2 = 114 ft; foundation run 168 + 114 = 282 ft.
 */
import { describe, expect, it } from 'vitest';
import { buildBoq, priceQuantity, summarize, type BoqLine } from '../../src/modules/estimate/boq.js';
import { estimateQuantities } from '../../src/modules/estimate/engine.js';
import { settingsBase, withProject, type ResolvedRulebook } from '../../src/modules/estimate/rulebook.js';
import { builtInValues, RULEBOOK_PARAMS } from '../../src/modules/estimate/rulebookDefs.js';
import { effectiveSettings, ESTIMATE_DEFAULTS } from '../../src/modules/estimate/settings.js';
import { LABOUR, PRICES, TEN_MARLA } from './estimateBoq.fixture.js';

const params = builtInValues('PUNJAB_KP');
const settings = settingsBase(params);
const run = (over: Partial<Parameters<typeof buildBoq>[0]> = {}) => {
  const input = over.input ?? TEN_MARLA;
  const s = over.settings ?? settings;
  return buildBoq({ input, quantities: estimateQuantities(input, s), settings: s, params, contractType: 'FULL', prices: PRICES, labourRates: LABOUR, contractTotalPaisa: 1_500_000_000n, ...over });
};
const line = (lines: BoqLine[], key: string) => {
  const l = lines.find((x) => x.lineKey === key);
  if (!l) throw new Error(`no line ${key}; have ${lines.map((x) => x.lineKey).join(', ')}`);
  return l;
};

describe('rulebook → engine settings', () => {
  it('Punjab v1 = the Phase 1 numbers except the brief changes (internal plaster 1:6, cement 2 %, steel 4 % wastage)', () => {
    expect(settings).toEqual({
      ...ESTIMATE_DEFAULTS,
      internalPlasterMix: '1:6',
      cementWastagePercent: 2,
      sandWastagePercent: 5,
      steelWastagePercent: 4,
    });
    // every parameter has a value inside its safe range in both regions
    for (const d of RULEBOOK_PARAMS) for (const v of Object.values(d.value)) expect(v >= d.safeMin && v <= d.safeMax, d.key).toBe(true);
  });

  it('Karachi / Sindh v1: concrete blocks, 6″ / 4″ walls, block mortar', () => {
    const sindh = settingsBase(builtInValues('KARACHI_SINDH'));
    expect(sindh).toMatchObject({ blockMasonry: 1, blocksPerSqft: 1.125, externalWallThicknessIn: 6, internalWallThicknessIn: 4, mortarPerCftBrickwork: 0.1, lintelWidthIn: 6 });
  });

  it('layers: rulebook → company → project, a legacy project wastagePercent still covers cement / sand / steel', () => {
    const rb = {
      region: 'PUNJAB_KP',
      rulebook: null,
      params: RULEBOOK_PARAMS.map((d) => ({ key: d.key, value: d.key === 'contingencyPercent' ? 7 : params[d.key]!, source: d.key === 'contingencyPercent' ? 'COMPANY' : 'RULEBOOK' })),
      byKey: new Map(),
      values: { ...params, contingencyPercent: 7 },
    } as unknown as ResolvedRulebook;
    const { params: p, sources } = withProject(rb, { wastagePercent: 8, internalPlasterMix: '1:4', paintCoats: 3 });
    expect(sources['contingencyPercent']).toEqual({ value: 7, source: 'COMPANY' });
    expect(sources['internalPlasterMix']).toEqual({ value: 4, source: 'PROJECT' });
    expect(p['paintCoats']).toBe(3);
    expect([p['cementWastagePercent'], p['sandWastagePercent'], p['steelWastagePercent'], p['brickWastagePercent']]).toEqual([8, 8, 8, 5]);
    const s = effectiveSettings({ wastagePercent: 8 }, settings);
    expect([s.cementWastagePercent, s.sandWastagePercent, s.steelWastagePercent, s.brickWastagePercent]).toEqual([8, 8, 8, 5]);
  });
});

describe('BoQ — worked 10-marla example (FULL contract, Punjab v1)', () => {
  const b = run();
  const L = b.lines;
  const t = b.totals;

  it('Excavation & earthwork = Rs 88,632', () => {
    // excavation 282 × 3 × 5 = 4,230 cft × Rs 12 = 50,760
    expect(line(L, 'EXCAVATION_EARTHWORK.FOUNDATION_PLINTH.excavation')).toMatchObject({ kind: 'LUMP_SUM', quantity: 4230, amountPaisa: 5_076_000n });
    // plinth filling 1,440 sq ft × 2 ft = 2,880 cft × Rs 10 = 28,800
    expect(line(L, 'EXCAVATION_EARTHWORK.FOUNDATION_PLINTH.plinthFilling')).toMatchObject({ quantity: 2880, amountPaisa: 2_880_000n });
    // termite 1,440 × 0.005 = 7.2 L + 5 % = 7.56 L × Rs 1,200 = 9,072
    expect(line(L, 'EXCAVATION_EARTHWORK.FOUNDATION_PLINTH.termite')).toMatchObject({ quantity: 7.2, wastagePercent: 5, quantityWithWastage: 7.56, amountPaisa: 907_200n });
    // 50,760 + 28,800 + 9,072 = 88,632
    expect(t.sections.EXCAVATION_EARTHWORK).toBe(8_863_200n);
  });

  it('Concrete (PCC / RCC) = Rs 3,74,093.90', () => {
    // Foundation: PCC 1:4:8 (211.5 cft) + DPC 1:2:4 (26.44 cft)
    //   cement 20.04 + 4.65 = 24.69 bags + 2 % = 25.18 × 1,450 = 36,511
    //   sand 100.22 + 11.63 = 111.85 + 5 % = 117.44 cft × 70 = 8,220.80
    //   crush 200.44 + 23.26 = 223.70 + 5 % = 234.89 cft × 180 = 42,280.20
    expect(line(L, 'CONCRETE.FOUNDATION_PLINTH.cement')).toMatchObject({ quantity: 24.69, quantityWithWastage: 25.18, amountPaisa: 3_651_100n, trace: expect.arrayContaining([expect.stringContaining('Foundation · PCC')]) });
    // Ground floor: slab 1,440 × 5″ = 600 cft + lintels 68 ft × 9″ × 6″ = 25.5 cft, 1:2:4
    //   cement 105.6 + 4.49 = 110.09 + 2 % = 112.29 × 1,450 = 1,62,820.50
    //   sand 264 + 11.22 = 275.22 + 5 % = 288.98 × 70 = 20,228.60
    //   crush 528 + 22.44 = 550.44 + 5 % = 577.96 × 180 = 1,04,032.80
    expect(line(L, 'CONCRETE.GF_STRUCTURE.crush')).toMatchObject({ quantity: 550.44, quantityWithWastage: 577.96, amountPaisa: 10_403_280n });
    // 36,511 + 8,220.80 + 42,280.20 + 1,62,820.50 + 20,228.60 + 1,04,032.80 = 3,74,093.90
    expect(t.sections.CONCRETE).toBe(37_409_390n);
  });

  it('Steel = Rs 4,11,597', () => {
    // slab 600 × 1 % × 222 = 1,332 kg + lintels 25.5 × 1 % × 222 = 56.61 → 1,388.61 kg + 4 % = 1,444.15 kg
    // = 1.4442 ton × Rs 2,85,000 = 4,11,597
    expect(line(L, 'STEEL.GF_STRUCTURE.steel')).toMatchObject({ quantity: 1388.61, wastagePercent: 4, quantityWithWastage: 1444.15, rateQuantity: 1.4442, rateUnit: 'ton', amountPaisa: 41_159_700n });
    expect(t.sections.STEEL).toBe(41_159_700n);
  });

  it('Masonry = Rs 10,65,612.44', () => {
    // Foundation 1,612.69 cft: bricks 21,771.28 + 5 % = 22,859.84 × 17 = 3,88,617.28;
    //   cement 61.28 + 2 % = 62.51 × 1,450 = 90,639.50; sand 459.62 + 5 % = 482.60 × 70 = 33,782
    // Walls 1,548 cft: bricks 20,898 + 5 % = 21,942.90 × 17 = 3,73,029.30; cement 60 × 1,450 = 87,000;
    //   sand 463.24 × 70 = 32,426.80
    // Parapet 168 × 3 × 4.5″ = 189 cft (roof stage): bricks 2,679.08 × 17 = 45,544.36; cement 7.32 × 1,450 = 10,614;
    //   sand 56.56 × 70 = 3,959.20
    expect(line(L, 'MASONRY.MUMTY_ROOF.bricks')).toMatchObject({ quantity: 2551.5, quantityWithWastage: 2679.08, amountPaisa: 4_554_436n });
    // Σ = 10,65,612.44
    expect(t.sections.MASONRY).toBe(106_561_244n);
  });

  it('Plaster = Rs 1,30,069.60 (internal 1:6 ½″, external 1:4 ¾″)', () => {
    // internal walls 3,690 + ceilings 1,352 sq ft at ½″ 1:6; external 1,648 + parapet 1,008 sq ft at ¾″ 1:4
    // cement 23.37 + 8.56 + 21.92 + 13.41 = 67.26 + 2 % = 68.61 × 1,450 = 99,484.50
    // sand 175.28 + 64.22 + 109.59 + 67.03 = 416.12 + 5 % = 436.93 × 70 = 30,585.10
    expect(line(L, 'PLASTER.PLASTER_MEP.cement')).toMatchObject({ quantity: 67.26, quantityWithWastage: 68.61 });
    expect(t.sections.PLASTER).toBe(13_006_960n);
  });

  it('Roof & waterproofing = Rs 45,640', () => {
    // DPC compound 4.65 kg + 5 % = 4.88 × 500 = 2,440; roof waterproofing 1,440 sq ft × Rs 30 (sub-contract) = 43,200
    expect(line(L, 'ROOF_WATERPROOFING.MUMTY_ROOF.WATERPROOFING')).toMatchObject({ kind: 'LABOUR', quantity: 1440, amountPaisa: 4_320_000n });
    expect(t.sections.ROOF_WATERPROOFING).toBe(4_564_000n);
  });

  it('Flooring & wall tiles = Rs 5,17,267.60 (floor = room floor area; wet rooms by height)', () => {
    // floor tiles = Σ room floor areas 1,352 sq ft + 7 % = 1,446.64 × 250 = 3,61,660
    expect(line(L, 'FLOORING_TILES.FINISHING.floorTiles')).toMatchObject({ quantity: 1352, wastagePercent: 7, quantityWithWastage: 1446.64, amountPaisa: 36_166_000n });
    // wall tiles: kitchen splash 2 × (12 + 10) × 3 ft − door 3 × 3 = 123; each bath 2 × (8 + 6) × 7 − door 3 × 7 = 175
    //   123 + 175 + 175 = 473 sq ft + 7 % = 506.11 × 220 = 1,11,344.20
    const wall = line(L, 'FLOORING_TILES.FINISHING.wallTiles');
    expect(wall).toMatchObject({ quantity: 473, quantityWithWastage: 506.11, amountPaisa: 11_134_420n });
    expect(wall.trace).toEqual([
      'Ground floor · Kitchen (kitchen splash): 2 × (12 + 10) × 3 ft − doors 9 sq ft = 123 sq ft',
      'Ground floor · Bath 1 (wet room): 2 × (8 + 6) × 7 ft − doors 21 sq ft = 175 sq ft',
      'Ground floor · Bath 2 (wet room): 2 × (8 + 6) × 7 ft − doors 21 sq ft = 175 sq ft',
    ]);
    // bed 1″ 1:4 under the floor tiles: 1,352 × 1/12 × 1.33 = 149.85 cft dry
    //   cement 149.85 / 5 / 1.25 = 23.98 + 2 % = 24.45 × 1,450 = 35,452.50; sand × 4/5 = 119.88 + 5 % = 125.87 × 70 = 8,810.90
    // 3,61,660 + 1,11,344.20 + 35,452.50 + 8,810.90 = 5,17,267.60
    expect(t.sections.FLOORING_TILES).toBe(51_726_760n);
  });

  it('Paint = Rs 1,99,150 (2 coats + primer on the plastered area not tiled)', () => {
    // plastered 3,690 + 1,352 + 1,648 + 1,008 = 7,698 − wall tiles 473 = 7,225 sq ft
    // emulsion 7,225 × 2 ÷ 350 = 41.29 gal + 5 % = 43.35 × 3,500 = 1,51,725; primer 7,225 × 1 ÷ 400 = 18.06 + 5 % = 18.97 × 2,500 = 47,425
    expect(line(L, 'PAINT.FINISHING.paint')).toMatchObject({ quantity: 41.29, quantityWithWastage: 43.35, unit: 'gallon' });
    expect(t.sections.PAINT).toBe(19_915_000n);
  });

  it('MEP rough-in = Rs 3,96,000 (rulebook lump sums)', () => {
    // electrical 1,440 × 150 = 2,16,000; plumbing 3 wet rooms (kitchen + 2 baths) × 35,000 = 1,05,000; sewerage + gas 75,000
    expect(line(L, 'MEP_ROUGH_IN.PLASTER_MEP.plumbing')).toMatchObject({ quantity: 3, amountPaisa: 10_500_000n });
    expect(t.sections.MEP_ROUGH_IN).toBe(39_600_000n);
  });

  it('Grey-structure labour = Rs 6,58,995.42 (piece rates per stage, net quantities)', () => {
    // bricks: foundation 21,771.28 × 9 = 1,95,941.52; walls 20,898 × 9 = 1,88,082; parapet 2,551.5 × 9 = 22,963.50
    // shuttering slab 1,440 + lintels 119 = 1,559 × 45 = 70,155; steel 1.3886 t × 9,000 = 12,497.40; plaster 7,698 × 22 = 1,69,356
    expect(line(L, 'GREY_LABOUR.GF_STRUCTURE.SHUTTERING')).toMatchObject({ quantity: 1559, amountPaisa: 7_015_500n });
    expect(t.sections.GREY_LABOUR).toBe(65_899_542n);
  });

  it('Finishing labour = Rs 2,62,750', () => {
    // tiles (1,352 + 473) × 45 = 82,125; paint 7,225 × 25 = 1,80,625
    expect(t.sections.FINISHING_LABOUR).toBe(26_275_000n);
  });

  it('Equipment & shuttering = Rs 86,400', () => {
    // 1,440 sq ft × Rs 60
    expect(t.sections.EQUIPMENT_SHUTTERING).toBe(8_640_000n);
  });

  it('direct cost, site overheads 3 %, contingency 5 %, total, per sq ft and margin', () => {
    // direct = 88,632 + 3,74,093.90 + 4,11,597 + 10,65,612.44 + 1,30,069.60 + 45,640 + 5,17,267.60 + 1,99,150
    //        + 3,96,000 + 6,58,995.42 + 2,62,750 + 86,400 = 42,36,207.96
    expect(t.directCostPaisa).toBe(423_620_796n);
    // overheads 3 % = 1,27,086.24; contingency 5 % × (42,36,207.96 + 1,27,086.24) = 2,18,164.71
    expect(t.sections.SITE_OVERHEADS).toBe(12_708_624n);
    expect(t.sections.CONTINGENCY).toBe(21_816_471n);
    expect(line(L, 'CONTINGENCY.ALL.contingency')).toMatchObject({ kind: 'PERCENT', quantity: 5, stageKey: null, rateQuantity: 436_329_420 });
    // total 45,81,458.91 ÷ 1,440 sq ft = Rs 3,181.57 per sq ft; margin vs Rs 1,50,00,000 = 1,04,18,541.09 (69.46 %)
    expect(t).toMatchObject({ totalPaisa: 458_145_891n, perSqftPaisa: 318_157n, marginPaisa: 1_041_854_109n, marginPercent: 69.46 });
    // stage totals add up to the direct cost
    expect(Object.values(t.stages).reduce((a, x) => a + x, 0n)).toBe(t.directCostPaisa);
    expect(t.stages).toMatchObject({ FOUNDATION_PLINTH: 97_346_430n, GF_STRUCTURE: 146_186_940n, MUMTY_ROOF: 12_628_106n, PLASTER_MEP: 69_542_560n, FINISHING: 97_916_760n });
  });

  it('every line has a stage (but overheads / contingency), a formula and a readable trace', () => {
    for (const l of L) {
      expect(l.formula.length, l.lineKey).toBeGreaterThan(0);
      if (l.kind === 'PERCENT') expect(l.stageKey).toBeNull();
      else {
        expect(l.stageKey, l.lineKey).not.toBeNull();
        expect(l.trace.length, l.lineKey).toBeGreaterThan(0);
      }
    }
    expect(new Set(L.map((l) => l.lineKey)).size).toBe(L.length);
  });

  it('load-bearing steel far below the rulebook norm → STEEL_NORM_DEVIATION warning', () => {
    // 1,388.61 kg ÷ 1,440 sq ft = 0.96 kg / sq ft vs 2.5 → 61 % below (the % method under-counts; engineer review)
    expect(b.warnings).toEqual([expect.objectContaining({ code: 'STEEL_NORM_DEVIATION', params: { actual: 0.96, norm: 2.5, percent: -61 } })]);
  });
});

describe('BoQ rules', () => {
  it('owner-supplied lines keep the quantity but never a rate or amount, and stay out of the cost', () => {
    const b = run({ prices: { ...PRICES, bricks: { ...PRICES.bricks!, suppliedBy: 'OWNER' } } });
    const bricks = line(b.lines, 'MASONRY.GF_STRUCTURE.bricks');
    expect(bricks).toMatchObject({ suppliedBy: 'OWNER', quantity: 20898, quantityWithWastage: 21942.9, ratePaisa: null, amountPaisa: null, rateStatus: 'OWNER_SUPPLIED' });
    // masonry loses the three brick amounts: 3,88,617.28 + 3,73,029.30 + 45,544.36 = 8,07,190.94
    expect(b.totals.sections.MASONRY).toBe(106_561_244n - 80_719_094n);
    // the brick masonry LABOUR stays (the contractor lays the owner's bricks)
    expect(line(b.lines, 'GREY_LABOUR.GF_STRUCTURE.BRICK_MASONRY').amountPaisa).toBe(18_808_200n);
  });

  it('GREY_OWNER_FINISHING: finishing materials are the owner\'s, no finishing labour', () => {
    const b = run({ contractType: 'GREY_OWNER_FINISHING' });
    const finishing = b.lines.filter((l) => l.stageKey === 'FINISHING');
    expect(finishing.map((l) => l.lineKey).sort()).toEqual(
      ['FLOORING_TILES.FINISHING.cement', 'FLOORING_TILES.FINISHING.floorTiles', 'FLOORING_TILES.FINISHING.sand', 'FLOORING_TILES.FINISHING.wallTiles', 'PAINT.FINISHING.paint', 'PAINT.FINISHING.primer'].sort(),
    );
    expect(finishing.every((l) => l.suppliedBy === 'OWNER' && l.amountPaisa === null)).toBe(true);
    expect(b.totals.sections.FINISHING_LABOUR).toBe(0n);
    expect(b.totals.stages.FINISHING).toBe(0n);
  });

  it('wet-room wall tiles stop at the room height; a wet store (no kitchen) uses the bath height', () => {
    const lowBath = { ...TEN_MARLA, floors: [{ ...TEN_MARLA.floors[0]!, rooms: [{ name: 'Low bath', type: 'ATTACHED_BATH', lengthFt: 8, widthFt: 6, heightFt: 6, isWet: true, openings: [] }, { name: 'Laundry', type: 'STORE', lengthFt: 10, widthFt: 5, heightFt: 10, isWet: true, openings: [] }] }] };
    const b = run({ input: lowBath });
    // low bath 2 × 14 × 6 (capped at 6 ft) = 168; laundry 2 × 15 × 7 = 210 → 378
    expect(line(b.lines, 'FLOORING_TILES.FINISHING.wallTiles').quantity).toBe(378);
  });

  it('Karachi / Sindh: walls in concrete blocks per sq ft of wall face', () => {
    const sp = builtInValues('KARACHI_SINDH');
    const s = settingsBase(sp);
    const b = buildBoq({ input: TEN_MARLA, quantities: estimateQuantities(TEN_MARLA, s), settings: s, params: sp, contractType: 'FULL', prices: PRICES, labourRates: LABOUR, contractTotalPaisa: null });
    const blocks = line(b.lines, 'MASONRY.GF_STRUCTURE.blocks');
    // external (168 × 10 − 102) × 6″ = 789 cft → 1,578 sq ft; internal (114 × 10 − 168) × 4″ = 324 cft → 972 sq ft
    // (1,578 + 972) × 1.125 = 2,868.75 blocks + 5 %
    expect(blocks).toMatchObject({ quantity: 2868.75, quantityWithWastage: 3012.19, rateStatus: 'RATE_MISSING' });
    expect(b.lines.some((l) => l.material === 'bricks' && l.section === 'MASONRY' && l.stageKey === 'GF_STRUCTURE')).toBe(false);
    expect(b.warnings.find((w) => w.code === 'RATES_MISSING')?.items).toContain('blocks');
  });

  it('a project labour rate per sq ft replaces the piece rates (one line per floor footprint)', () => {
    const s = effectiveSettings({ labourRatePerSqftPaisa: '45000' }, settings);
    const b = run({ settings: s });
    expect(b.lines.filter((l) => l.section === 'GREY_LABOUR').map((l) => [l.lineKey, l.quantity, l.amountPaisa])).toEqual([['GREY_LABOUR.GF_STRUCTURE.PER_SQFT', 1440, 64_800_000n]]);
  });

  it('summarize recomputes overheads and contingency from the effective amounts (line overrides)', () => {
    const b = run();
    const lines = b.lines.map((l) => ({ ...l }));
    const tiles = lines.find((l) => l.lineKey === 'FLOORING_TILES.FINISHING.floorTiles')!;
    // override 1,500 sq ft at Rs 250 = 3,75,000 (was 3,61,660 → +13,340)
    tiles.amountPaisa = priceQuantity(1500, tiles.rateFactor, tiles.ratePaisa).amountPaisa;
    const t = summarize(lines, b.coveredAreaSqft, null);
    expect(t.directCostPaisa).toBe(b.totals.directCostPaisa + 1_334_000n);
    expect(t.overheadPaisa).toBe(12_748_644n); // 3 % × 42,49,547.96 = 1,27,486.44
    expect(lines.find((l) => l.section === 'SITE_OVERHEADS')!.amountPaisa).toBe(12_748_644n);
  });
});
