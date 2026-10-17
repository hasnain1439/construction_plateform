/**
 * Step 12 · quick-mode geometry and quote price — hand-checked numbers.
 */
import { describe, expect, it } from 'vitest';
import { estimateQuantities } from '../../src/modules/estimate/engine.js';
import { QUICK_PARAMS, QUICK_VALUES, quickGeometry, quotePrice } from '../../src/modules/sales/quickMode.js';

describe('quick-mode geometry (area-based rooms)', () => {
  it('10 marla, 3,950 sq ft covered, ground + first + mumty — hand-checked', () => {
    const g = quickGeometry({ plotAreaSqft: 2250, frontFt: 35, depthFt: 65, coveredAreaSqft: 3950, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED' });
    // storey = 3950 ÷ (2 storeys + 10 % mumty) = 3950 ÷ 2.1 = 1880.952… → 1880.95
    expect(g.storeyAreaSqft).toBe(1880.95);
    expect(g.floors.map((f) => f.level)).toEqual(['GROUND', 'FIRST', 'MUMTY']);
    // per floor: rooms = 80 % × 1880.95 = 1504.76 sq ft; baths = round(1880.95 ÷ 450 = 4.18) = 4 × 48 = 192;
    // 1 kitchen × 110; dry = 1504.76 − 192 − 110 = 1202.76 → round(1202.76 ÷ 160 = 7.52) = 8 rooms of 150.35 sq ft
    const ground = g.input.floors[0]!;
    expect(ground.rooms.filter((r) => r.type === 'ATTACHED_BATH')).toHaveLength(4);
    expect(ground.rooms.filter((r) => r.type === 'KITCHEN')).toHaveLength(1);
    const dry = ground.rooms.filter((r) => r.type === 'BEDROOM');
    expect(dry).toHaveLength(8);
    expect(dry[0]).toMatchObject({ widthFt: 12, lengthFt: 12.53, heightFt: 11, isWet: false }); // 150.35 ÷ 12 = 12.53
    expect(g.floors[0]).toMatchObject({ areaSqft: 1880.95, rooms: 13, wetRooms: 5, ceilingHeightFt: 11 });
    expect(g.floors[1]).toMatchObject({ rooms: 13, ceilingHeightFt: 10 });
    // mumty = 10 % × 1880.95 = 188.10 sq ft, one stair room
    expect(g.floors[2]).toMatchObject({ level: 'MUMTY', areaSqft: 188.1, rooms: 1, ceilingHeightFt: 9 });
    // framed → isolated pads on the ~15 ft column grid of a 1880.95 sq ft footprint (ratio 65 / 35):
    // a = √(1880.95 ÷ 1.857) = 31.82 → ⌈31.82 ÷ 15⌉ + 1 = 4; b = √(1880.95 × 1.857) = 59.1 → 4 + 1 = 5 → 20 pads
    expect(g.input.foundation).toMatchObject({ type: 'ISOLATED', footingCount: 20, footingWidthFt: 5, footingLengthFt: 5, excavationDepthFt: 5 });
    expect(g.foundation).toBe('ISOLATED');
  });

  it('load bearing with a basement: strip footing, deeper excavation, basement has dry rooms only', () => {
    const g = quickGeometry({ plotAreaSqft: 1125, frontFt: null, depthFt: null, coveredAreaSqft: 2000, floors: 1, mumty: false, basement: true, basementHeightFt: 9, structureType: 'LOAD_BEARING' });
    // storey = 2000 ÷ 2 = 1000
    expect(g.storeyAreaSqft).toBe(1000);
    expect(g.floors.map((f) => [f.level, f.wetRooms, f.ceilingHeightFt])).toEqual([
      ['BASEMENT', 0, 9],
      ['GROUND', 3, 11], // round(1000 ÷ 450) = 2 baths + 1 kitchen
    ]);
    expect(g.input.foundation).toMatchObject({ type: 'STRIP', footingWidthFt: 3, excavationDepthFt: 14, footingCount: null });
  });

  it('feeds the Step 11 engine: walls, slabs and plaster come out from the synthetic rooms', () => {
    const g = quickGeometry({ plotAreaSqft: 2250, frontFt: 35, depthFt: 65, coveredAreaSqft: 3950, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED' });
    const q = estimateQuantities(g.input);
    expect(q.basis.coveredAreaSqft).toBe(3950);
    expect(q.warnings.map((w) => w.code)).not.toContain('ROOMS_BELOW_COVERED'); // rooms are 80 % of each floor
    for (const m of ['cement', 'bricks', 'sand', 'crush']) expect(q.totals.find((t) => t.material === m)?.quantity ?? 0).toBeGreaterThan(0);
    expect(q.work.plasterSqft).toBeGreaterThan(0);
  });

  it('every assumption is documented once, pending engineer review', () => {
    expect(new Set(QUICK_PARAMS.map((p) => p.key)).size).toBe(QUICK_PARAMS.length);
    for (const p of QUICK_PARAMS) {
      expect(p.reviewStatus).toBe('PENDING_ENGINEER_REVIEW');
      expect(p.label.en && p.label.roman && p.label.ur && p.description).toBeTruthy();
      expect(QUICK_VALUES[p.key]).toBe(p.value);
    }
  });
});

describe('quote price', () => {
  const cost = 1_234_567_800n; // Rs 1,23,45,678

  it('grey structure: cost × 1.20 → nearest Rs 1,000; rate per sq ft; margin', () => {
    const p = quotePrice({ contractType: 'GREY_OWNER_FINISHING', costPaisa: cost, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 50, finalPricePaisa: null });
    // 1,23,45,678 × 1.2 = 1,48,14,813.60 → Rs 1,48,15,000; finishing allowance ignored
    expect(p.computedPricePaisa).toBe(1_481_500_000n);
    expect(p.pricePaisa).toBe(1_481_500_000n);
    expect(p.finishingAllowancePaisa).toBe(0n);
    expect(p.perSqftPaisa).toBe(740_750n); // Rs 1,48,15,000 ÷ 2,000 = Rs 7,407.50
    expect(p.marginPaisa).toBe(1_481_500_000n - cost); // Rs 24,69,322
    expect(p.marginOnPricePercent).toBe(16.67);
    expect(p.priceOverridden).toBe(false);
  });

  it('full contract adds the finishing allowance before the margin', () => {
    const p = quotePrice({ contractType: 'FULL', costPaisa: cost, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 10, finalPricePaisa: null });
    // 1,23,45,678 × 1.1 × 1.2 = 1,62,96,294.96 → Rs 1,62,96,000; allowance = 10 % of cost = Rs 12,34,567.80
    expect(p.pricePaisa).toBe(1_629_600_000n);
    expect(p.finishingAllowancePaisa).toBe(123_456_780n);
    expect(p.marginPaisa).toBe(1_629_600_000n - cost - 123_456_780n);
  });

  it('labour only: rate = cost × (1 + margin) ÷ covered → nearest Rs 5; price = rate × covered', () => {
    const p = quotePrice({ contractType: 'LABOR_ONLY', costPaisa: 500_000_000n, coveredAreaSqft: 2500, marginPercent: 15, finishingAllowancePercent: 0, finalPricePaisa: null });
    // Rs 50,00,000 × 1.15 ÷ 2,500 = Rs 2,300 per sq ft → Rs 57,50,000
    expect(p.perSqftPaisa).toBe(230_000n);
    expect(p.pricePaisa).toBe(575_000_000n);
  });

  it('a negotiated price overrides; no cost and no override → no price', () => {
    const p = quotePrice({ contractType: 'GREY_OWNER_FINISHING', costPaisa: cost, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 0, finalPricePaisa: 1_450_000_000n });
    expect(p).toMatchObject({ pricePaisa: 1_450_000_000n, computedPricePaisa: 1_481_500_000n, perSqftPaisa: 725_000n, priceOverridden: true });
    expect(quotePrice({ contractType: 'FULL', costPaisa: 0n, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 0, finalPricePaisa: null }).pricePaisa).toBeNull();
  });
});
