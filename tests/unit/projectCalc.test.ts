import { describe, expect, it } from 'vitest';
import { laborOnlyTotal, openingsArea, plotCalc, roomCalc, stageAmounts, totalsCalc } from '../../src/modules/projects/calc.js';

describe('project calculations', () => {
  it('room: 16 × 14 × 11 with a 3.5×7 door and a 5×4 window', () => {
    const calc = roomCalc({
      lengthFt: 16,
      widthFt: 14,
      heightFt: 11,
      openings: [
        { widthFt: 3.5, heightFt: 7, quantity: 1 },
        { widthFt: 5, heightFt: 4, quantity: 1 },
      ],
    });
    expect(calc).toEqual({ floorAreaSqft: 224, grossWallAreaSqft: 660, openingsAreaSqft: 44.5, netWallAreaSqft: 615.5 });
  });

  it('is decimal-safe and rounds to 2 dp', () => {
    expect(roomCalc({ lengthFt: '0.1', widthFt: '0.2', heightFt: 3, openings: [] }).floorAreaSqft).toBe(0.02);
    expect(roomCalc({ lengthFt: 10.33, widthFt: 9.67, heightFt: 10.5, openings: [] })).toMatchObject({ floorAreaSqft: 99.89, grossWallAreaSqft: 420 });
    expect(openingsArea([{ widthFt: 2.5, heightFt: 7, quantity: 3 }])).toBe(52.5);
  });

  it('plot: marla, kanal and sq ft; front × depth mismatch over 10 %', () => {
    expect(plotCalc({ plotUnit: 'MARLA', plotSize: 10, marlaStandard: 225, frontFt: 35, depthFt: 65 })).toEqual({
      plotAreaSqft: 2250,
      frontageAreaSqft: 2275,
      plotAreaMismatch: false,
    });
    expect(plotCalc({ plotUnit: 'KANAL', plotSize: 1, marlaStandard: 272.25, frontFt: null, depthFt: null })).toEqual({
      plotAreaSqft: 5445,
      frontageAreaSqft: null,
      plotAreaMismatch: false,
    });
    expect(plotCalc({ plotUnit: 'SQFT', plotSize: 2000, marlaStandard: 225, frontFt: 40, depthFt: 60 }).plotAreaMismatch).toBe(true);
    expect(plotCalc({ plotUnit: null, plotSize: null, marlaStandard: 225, frontFt: 30, depthFt: 60 }).plotAreaSqft).toBeNull();
  });

  it('totals: rooms, floor area, net wall area, wet rooms', () => {
    const rooms = [
      { lengthFt: 16, widthFt: 14, heightFt: 11, isWet: false, openings: [{ widthFt: 3.5, heightFt: 7, quantity: 1 }] },
      { lengthFt: 8, widthFt: 6, heightFt: 11, isWet: true, openings: [] },
    ];
    expect(totalsCalc(rooms)).toEqual({ rooms: 2, totalFloorAreaSqft: 272, netWallAreaSqft: 635.5 + 308, wetRooms: 1 });
    expect(totalsCalc([])).toEqual({ rooms: 0, totalFloorAreaSqft: 0, netWallAreaSqft: 0, wetRooms: 0 });
  });

  it('stage amounts round to the rupee and the last stage absorbs the difference', () => {
    expect(stageAmounts(1_000_050n, [33.33, 33.33, 33.34])).toEqual([333_300n, 333_300n, 333_450n]);
    expect(stageAmounts(1_850_000_000n, [15, 15, 20, 15, 10, 10, 10, 5]).reduce((a, b) => a + b, 0n)).toBe(1_850_000_000n);
    expect(stageAmounts(0n, [])).toEqual([]);
    expect(laborOnlyTotal(45_000n, 2000)).toBe(90_000_000n);
    expect(laborOnlyTotal(45_050n, '1234.5')).toBe(55_614_200n); // Rs 450.50 × 1,234.5 = 556,142.25 → 556,142
  });
});
