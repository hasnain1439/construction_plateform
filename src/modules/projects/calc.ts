/**
 * Pure, Decimal-safe project calculations (feet / square feet). Inputs may be numbers,
 * strings or Prisma Decimals; outputs are numbers rounded to 2 dp.
 */
import { Prisma } from '../../generated/prisma/client.js';

type Num = number | string | Prisma.Decimal;
const D = (v: Num) => new Prisma.Decimal(v);
const out = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();

export const SQFT_PER_KANAL_MARLAS = 20;
/** Plot vs front × depth differ by more than this → warning. */
export const PLOT_MISMATCH_RATIO = 0.1;

export interface PlotInput {
  plotUnit: 'MARLA' | 'KANAL' | 'SQFT' | null;
  plotSize: Num | null;
  marlaStandard: Num;
  frontFt: Num | null;
  depthFt: Num | null;
}

export function plotCalc(p: PlotInput) {
  let plotAreaSqft: number | null = null;
  if (p.plotUnit && p.plotSize !== null) {
    const size = D(p.plotSize);
    const sqft =
      p.plotUnit === 'SQFT' ? size : p.plotUnit === 'MARLA' ? size.mul(D(p.marlaStandard)) : size.mul(SQFT_PER_KANAL_MARLAS).mul(D(p.marlaStandard));
    plotAreaSqft = out(sqft);
  }
  const frontageAreaSqft = p.frontFt !== null && p.depthFt !== null ? out(D(p.frontFt).mul(D(p.depthFt))) : null;
  const plotAreaMismatch =
    plotAreaSqft !== null && frontageAreaSqft !== null && plotAreaSqft > 0
      ? Math.abs(frontageAreaSqft - plotAreaSqft) / plotAreaSqft > PLOT_MISMATCH_RATIO
      : false;
  return { plotAreaSqft, frontageAreaSqft, plotAreaMismatch };
}

export interface OpeningInput {
  widthFt: Num;
  heightFt: Num;
  quantity: number;
}

export interface RoomInput {
  lengthFt: Num;
  widthFt: Num;
  heightFt: Num;
  isWet?: boolean;
  openings: OpeningInput[];
}

export function openingsArea(openings: OpeningInput[]) {
  return out(openings.reduce((sum, o) => sum.add(D(o.widthFt).mul(D(o.heightFt)).mul(o.quantity)), D(0)));
}

export function roomCalc(r: RoomInput) {
  const L = D(r.lengthFt);
  const W = D(r.widthFt);
  const H = D(r.heightFt);
  const floorAreaSqft = L.mul(W);
  const grossWallAreaSqft = L.add(W).mul(2).mul(H);
  const opening = D(openingsArea(r.openings));
  return {
    floorAreaSqft: out(floorAreaSqft),
    grossWallAreaSqft: out(grossWallAreaSqft),
    openingsAreaSqft: out(opening),
    netWallAreaSqft: out(grossWallAreaSqft.sub(opening)),
  };
}

export function totalsCalc(rooms: RoomInput[]) {
  let floorArea = D(0);
  let netWall = D(0);
  let wetRooms = 0;
  for (const r of rooms) {
    const c = roomCalc(r);
    floorArea = floorArea.add(c.floorAreaSqft);
    netWall = netWall.add(c.netWallAreaSqft);
    if (r.isWet) wetRooms += 1;
  }
  return { rooms: rooms.length, totalFloorAreaSqft: out(floorArea), netWallAreaSqft: out(netWall), wetRooms };
}

/**
 * Splits `totalPaisa` over stage percentages, each rounded to the nearest rupee; the
 * last stage absorbs the rounding so the amounts add up to the total exactly.
 */
export function stageAmounts(totalPaisa: bigint, percents: Num[]): bigint[] {
  if (!percents.length) return [];
  const total = D(totalPaisa.toString());
  const amounts = percents.map((p) => BigInt(total.mul(D(p)).div(100).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).mul(100).toFixed(0)));
  const others = amounts.slice(0, -1).reduce((a, b) => a + b, 0n);
  amounts[amounts.length - 1] = totalPaisa - others;
  return amounts;
}

/** Labour-only contract value: rate per sq ft × covered area, rounded to the rupee. */
export function laborOnlyTotal(ratePerSqftPaisa: bigint, coveredAreaSqft: Num): bigint {
  return BigInt(D(ratePerSqftPaisa.toString()).mul(D(coveredAreaSqft)).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).mul(100).toFixed(0));
}
