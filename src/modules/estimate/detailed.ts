/**
 * Detailed quantities — used by the estimate engine when a floor has roof data (`Floor.roof`) or
 * every room of a floor has its four walls entered (`Room.walls`). Pure, no database.
 * Every rule and constant is listed in README → "How the estimate is calculated".
 *
 * Steel weight: kg per metre = d² / 162 (d in mm) → kg per ft = 0.3048 × d² / 162.
 */
import { BAR_MM, T_IRON_KG_PER_FT, type BarNo, type Roof } from '../projects/roof.js';
import { sideLength, WALL_SIDES, type Wall, type WallSide, type WallType } from '../projects/walls.js';

export const FT_PER_M = 1 / 0.3048;
/** kg per running ft of a bar of `mm` diameter. */
export const kgPerFt = (mm: number) => (0.3048 * mm * mm) / 162;
/** Anchorage of a slab bar into its support, each end: 12 × bar diameter, at least 6″ (ft). */
export const anchorageFt = (mm: number) => Math.max((12 * mm) / 25.4, 6) / 12;
/** Top (extra) bars over the supports: main size, every other bar (2 × main spacing), 0.25 × short span long + anchorage, along both long edges. */
export const TOP_BAR_SPAN_SHARE = 0.25;
/** Beams / columns: clear cover to the stirrups / ties (in). */
export const FRAME_COVER_IN = 1.5;
/** Stirrup / tie hooks: 2 × 10 bar diameters. */
export const HOOK_DIAMETERS = 20;
/** Beam main bars: + 5 % for laps and anchorage. */
export const BEAM_LAP_FACTOR = 1.05;
/** Column bars: one lap of 50 bar diameters per floor. */
export const COLUMN_LAP_DIAMETERS = 50;
/** Columns when the count is not entered: one per ~15 ft grid over the footprint rectangle. */
export const COLUMN_GRID_FT = 15;
/** Sunshade (chajja): average thickness 4″; main #3 @ 6″ (projection + 18″ anchorage), distribution #3 @ 9″. */
export const CHAJJA_THICKNESS_IN = 4;
export const CHAJJA_ANCHORAGE_FT = 1.5;
/** Mesh in precast / deck toppings: #3 @ 12″ both ways + 10 % laps. */
export const MESH_BAR: BarNo = 3;
export const MESH_SPACING_IN = 12;
export const MESH_LAP_FACTOR = 1.1;
/** Garder (T-iron) bearing on each wall, ft (9″). */
export const GIRDER_BEARING_FT = 0.75;
/** Infill between garders, per sq ft of roof: bricks laid flat (9″ × 4.5″ + joints) 3.2; tiles 12″ × 6″: 2. */
export const INFILL_PER_SQFT = { BRICK: 3.2, TILE: 2 } as const;
/** Bedding mortar under the infill: 0.5″ of 1:4. */
export const INFILL_MORTAR_IN = 0.5;
export const INFILL_MORTAR_MIX = '1:4';
/** Lintels on detailed floors: 2 #4 bottom + 2 #3 top, #3 stirrups @ 9″, 1″ cover. */
export const LINTEL_BARS = { bottom: { bar: 4 as BarNo, count: 2 }, top: { bar: 3 as BarNo, count: 2 }, stirrup: { bar: 3 as BarNo, spacingIn: 9 }, coverIn: 1 };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ─── Bars ───────────────────────────────────────────────────────────────────

export type BarUse = 'MAIN' | 'DIST' | 'TOP' | 'CHAJJA' | 'MESH' | 'BEAM' | 'STIRRUP' | 'COLUMN' | 'TIE' | 'LINTEL';

export interface BarRun {
  use: BarUse;
  bar: BarNo;
  /** Bars (0 for mesh, which is given as a length). */
  count: number;
  /** Length of each bar (ft); for mesh the total length. */
  lengthFt: number;
  /** Room / element this run belongs to (for the breakdown). */
  label: string;
}

export const runLength = (r: BarRun) => (r.count > 0 ? r.count * r.lengthFt : r.lengthFt);

/** Σ bars by size: total length (ft), bar count and kg. */
export function groupBars(runs: BarRun[], factor = 1) {
  const out = new Map<BarNo, { bar: BarNo; mm: number; count: number; lengthFt: number; kg: number }>();
  for (const r of runs) {
    const mm = BAR_MM[r.bar];
    const g = out.get(r.bar) ?? { bar: r.bar, mm, count: 0, lengthFt: 0, kg: 0 };
    g.count += r.count;
    g.lengthFt += runLength(r) * factor;
    out.set(r.bar, g);
  }
  for (const g of out.values()) g.kg = g.lengthFt * kgPerFt(g.mm);
  return [...out.values()].sort((a, b) => a.bar - b.bar);
}

/** Main / distribution / top bars of one rectangular panel (a room) of an RCC slab. */
export function slabPanelBars(lengthFt: number, widthFt: number, roof: Roof, label: string): BarRun[] {
  const short = Math.min(lengthFt, widthFt);
  const long = Math.max(lengthFt, widthFt);
  const main = roof.mainBar!;
  const dist = roof.distBar!;
  const s = roof.mainSpacingIn!;
  const sd = roof.distSpacingIn!;
  const runs: BarRun[] = [
    // Main bars along the short span, spread over the long side
    { use: 'MAIN', bar: main, count: Math.ceil((long * 12) / s) + 1, lengthFt: short + 2 * anchorageFt(BAR_MM[main]), label },
    // Distribution bars along the long side, spread over the short span
    { use: 'DIST', bar: dist, count: Math.ceil((short * 12) / sd) + 1, lengthFt: long + 2 * anchorageFt(BAR_MM[dist]), label },
  ];
  if (roof.topBars) {
    runs.push({ use: 'TOP', bar: main, count: 2 * (Math.ceil((long * 12) / (2 * s)) + 1), lengthFt: TOP_BAR_SPAN_SHARE * short + anchorageFt(BAR_MM[main]), label });
  }
  return runs;
}

/** Sunshade (chajja) bars. */
export function chajjaBars(lengthFt: number, widthFt: number): BarRun[] {
  return [
    { use: 'CHAJJA', bar: 3, count: Math.ceil((lengthFt * 12) / 6) + 1, lengthFt: widthFt + CHAJJA_ANCHORAGE_FT, label: 'chajja' },
    { use: 'CHAJJA', bar: 3, count: Math.ceil((widthFt * 12) / 9) + 1, lengthFt, label: 'chajja' },
  ];
}

/** Mesh #3 @ 12″ both ways over `area`: 2 × area × 12 / spacing ft of bar + laps. */
export function meshBars(area: number, label: string): BarRun[] {
  return [{ use: 'MESH', bar: MESH_BAR, count: 0, lengthFt: 2 * area * (12 / MESH_SPACING_IN) * MESH_LAP_FACTOR, label }];
}

/** Length of one closed stirrup / tie (ft): core perimeter (cover all round) + two hooks. */
export function stirrupLengthFt(widthIn: number, depthIn: number, bar: BarNo, coverIn = FRAME_COVER_IN): number {
  const diaIn = BAR_MM[bar] / 25.4;
  return (2 * (widthIn - 2 * coverIn + (depthIn - 2 * coverIn)) + HOOK_DIAMETERS * diaIn) / 12;
}

export function beamBars(runFt: number, roof: Roof): BarRun[] {
  return [
    { use: 'BEAM', bar: roof.beamBar, count: roof.beamBars, lengthFt: runFt * BEAM_LAP_FACTOR, label: 'beams' },
    { use: 'STIRRUP', bar: roof.stirrupBar, count: Math.ceil((runFt * 12) / roof.stirrupSpacingIn) + 1, lengthFt: stirrupLengthFt(roof.beamWidthIn, roof.beamDepthIn, roof.stirrupBar), label: 'beams' },
  ];
}

export function columnBars(count: number, heightFt: number, slabIn: number, roof: Roof): BarRun[] {
  const lapFt = (COLUMN_LAP_DIAMETERS * BAR_MM[roof.columnBar]) / 304.8;
  return [
    { use: 'COLUMN', bar: roof.columnBar, count: count * roof.columnBars, lengthFt: heightFt + slabIn / 12 + lapFt, label: 'columns' },
    { use: 'TIE', bar: roof.tieBar, count: count * (Math.ceil((heightFt * 12) / roof.tieSpacingIn) + 1), lengthFt: stirrupLengthFt(roof.columnWidthIn, roof.columnDepthIn, roof.tieBar), label: 'columns' },
  ];
}

/** Columns from the footprint (a × b rectangle with depth / front = ratio) on a ~15 ft grid. */
export function defaultColumnCount(footprint: number, ratio: number): number {
  if (footprint <= 0) return 0;
  const a = Math.sqrt(footprint / ratio);
  const b = Math.sqrt(footprint * ratio);
  return (Math.ceil(a / COLUMN_GRID_FT) + 1) * (Math.ceil(b / COLUMN_GRID_FT) + 1);
}

/** Garders (T-iron) of one room panel: max(1, ⌈long ÷ spacing⌉ − 1) across the short span + 9″ bearing each end. */
export function girders(lengthFt: number, widthFt: number, roof: Roof) {
  const short = Math.min(lengthFt, widthFt);
  const long = Math.max(lengthFt, widthFt);
  const count = Math.max(1, Math.ceil(long / roof.tIronSpacingFt!) - 1);
  const each = short + 2 * GIRDER_BEARING_FT;
  return { count, lengthFt: each, kg: count * each * T_IRON_KG_PER_FT[roof.tIronSection!] };
}

/** Lintel bars of `lengthFt` of lintel `widthIn` × `depthIn`. */
export function lintelBars(lengthFt: number, count: number, widthIn: number, depthIn: number): BarRun[] {
  const L = LINTEL_BARS;
  return [
    { use: 'LINTEL', bar: L.bottom.bar, count: L.bottom.count * count, lengthFt: lengthFt / Math.max(1, count), label: 'lintels' },
    { use: 'LINTEL', bar: L.top.bar, count: L.top.count * count, lengthFt: lengthFt / Math.max(1, count), label: 'lintels' },
    {
      use: 'STIRRUP',
      bar: L.stirrup.bar,
      count: Math.ceil((lengthFt * 12) / L.stirrup.spacingIn) + count,
      lengthFt: stirrupLengthFt(widthIn, depthIn, L.stirrup.bar, L.coverIn),
      label: 'lintels',
    },
  ];
}

// ─── Walls ──────────────────────────────────────────────────────────────────

export interface DetailOpening {
  type: 'DOOR' | 'WINDOW' | 'VENTILATOR';
  widthFt: number;
  heightFt: number;
  quantity: number;
  side?: WallSide | null;
}

export interface DetailRoom {
  id?: string;
  name?: string;
  lengthFt: number;
  widthFt: number;
  heightFt: number;
  openings: DetailOpening[];
  walls?: Wall[] | null;
}

export type SegmentKind = WallType | 'REMAINDER';

export interface WallSegment {
  kind: SegmentKind;
  lengthFt: number;
  heightFt: number;
  /** Wall (outer leaf) thickness, in. */
  thicknessIn: number;
  /** DOUBLE: inner leaf, in. */
  innerLeafIn: number | null;
  /** Net face area (length × height − openings), sq ft. */
  netAreaSqft: number;
}

export interface WallsDetail {
  segments: WallSegment[];
  /** Brickwork by leaf thickness: net area and volume (cft). */
  byThickness: Array<{ thicknessIn: number; lengthFt: number; areaSqft: number; volumeCft: number }>;
  /** Inside faces of every room (both faces of shared walls via both rooms) + the far face of passage walls. */
  plasterInternalSqft: number;
  /** Outer face of EXTERNAL and DOUBLE walls, height + slab edge. */
  plasterExternalSqft: number;
  externalRunFt: number;
  internalRunFt: number;
  partyRunFt: number;
  partyExistingFt: number;
  openFt: number;
  /** Every wall that is built (foundation / beam run): external + internal (shared once) + party (not existing). */
  builtRunFt: number;
  /** Lintels: one per opening line, width = the wall's thickness (or the default when not placed). */
  lintels: Array<{ lengthFt: number; count: number; widthIn: number }>;
  /** SHARED sides whose partner does not point back (counted as passage walls). */
  unpairedSides: number;
}

const openingArea = (o: DetailOpening) => o.widthFt * o.heightFt * o.quantity;

/**
 * Walls of a floor whose rooms ALL have walls entered.
 *   - Openings on a side are deducted from that side; openings without a side are spread over the
 *     room's walls (non-OPEN sides) by length.
 *   - SHARED sides are counted once per pair: length = the shorter of the two sides, height = the
 *     taller room; the rest of the longer side (remainder) is a wall of the same thickness facing an
 *     unmodelled space (plastered both faces, like a passage wall).
 *   - PARTY `existing` and OPEN sides have no brickwork; a party wall's inner face is still plastered.
 *   - DOUBLE: outer leaf + inner leaf (the cavity has no material).
 */
export function detailedWalls(rooms: DetailRoom[], slabIn: number, defaultLintelWidthIn: number, lintelBearingFt: number): WallsDetail {
  const byId = new Map(rooms.filter((r) => r.id).map((r) => [r.id!, r]));
  // Deduction per room side
  const deductions = rooms.map((r) => {
    const walls = r.walls!;
    const ded: Record<WallSide, number> = { TOP: 0, RIGHT: 0, BOTTOM: 0, LEFT: 0 };
    const solid = walls.filter((w) => w.type !== 'OPEN');
    const solidLen = sum(solid.map((w) => sideLength(w.side, r)));
    let loose = 0;
    for (const o of r.openings) {
      if (o.side) {
        if (walls.find((w) => w.side === o.side)!.type !== 'OPEN') ded[o.side] += openingArea(o);
      } else loose += openingArea(o);
    }
    if (loose > 0 && solidLen > 0) for (const w of solid) ded[w.side] += (loose * sideLength(w.side, r)) / solidLen;
    return ded;
  });

  const segments: WallSegment[] = [];
  let plasterInternal = 0;
  let plasterExternal = 0;
  let partyExisting = 0;
  let open = 0;
  let unpaired = 0;
  const seen = new Set<string>();
  const seg = (kind: SegmentKind, lengthFt: number, heightFt: number, w: Wall, net: number) =>
    segments.push({ kind, lengthFt, heightFt, thicknessIn: w.thicknessIn ?? 0, innerLeafIn: w.innerLeafIn, netAreaSqft: Math.max(0, net) });

  rooms.forEach((r, i) => {
    for (const side of WALL_SIDES) {
      const w = r.walls!.find((x) => x.side === side)!;
      const len = sideLength(side, r);
      const H = r.heightFt;
      const net = Math.max(0, len * H - deductions[i]![side]);
      if (w.type === 'OPEN') {
        open += len;
        continue;
      }
      plasterInternal += net; // this room's inside face
      if (w.type === 'SHARED') {
        const partner = w.sharedWithRoomId ? byId.get(w.sharedWithRoomId) : undefined;
        const theirSide = partner?.walls?.find((x) => x.side === w.sharedWithSide);
        const paired = partner && theirSide && theirSide.type === 'SHARED' && theirSide.sharedWithRoomId === r.id && theirSide.sharedWithSide === side;
        if (!paired) {
          unpaired += 1;
          seg('PASSAGE', len, H, w, net);
          plasterInternal += net; // far face
          continue;
        }
        const key = [`${r.id}:${side}`, `${partner.id}:${theirSide.side}`].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const j = rooms.indexOf(partner);
        const theirLen = sideLength(theirSide.side, partner);
        const sharedLen = Math.min(len, theirLen);
        const height = Math.max(H, partner.heightFt);
        seg('SHARED', sharedLen, height, w, sharedLen * height - deductions[i]![side] - deductions[j]![theirSide.side]);
        const rest = Math.abs(len - theirLen);
        if (rest > 0) {
          const restH = len > theirLen ? H : partner.heightFt;
          seg('REMAINDER', rest, restH, w, rest * restH);
          plasterInternal += rest * restH; // far face of the remainder
        }
        continue;
      }
      if (w.type === 'PARTY' && w.existing) {
        partyExisting += len;
        continue;
      }
      seg(w.type, len, H, w, net);
      if (w.type === 'PASSAGE') plasterInternal += net;
      if (w.type === 'EXTERNAL' || w.type === 'DOUBLE') plasterExternal += Math.max(0, len * (H + slabIn / 12) - deductions[i]![side]);
    }
  });

  // Brickwork by leaf thickness
  const groups = new Map<number, { thicknessIn: number; lengthFt: number; areaSqft: number; volumeCft: number }>();
  const addLeaf = (t: number, length: number, area: number) => {
    if (t <= 0) return;
    const g = groups.get(t) ?? { thicknessIn: t, lengthFt: 0, areaSqft: 0, volumeCft: 0 };
    g.lengthFt += length;
    g.areaSqft += area;
    g.volumeCft += (area * t) / 12;
    groups.set(t, g);
  };
  for (const s of segments) {
    addLeaf(s.thicknessIn, s.lengthFt, s.netAreaSqft);
    if (s.innerLeafIn) addLeaf(s.innerLeafIn, s.lengthFt, s.netAreaSqft);
  }

  // Lintels: width = the wall the opening is in
  const lintels: WallsDetail['lintels'] = [];
  for (const r of rooms) {
    for (const o of r.openings) {
      const w = o.side ? r.walls!.find((x) => x.side === o.side) : undefined;
      const widthIn = w && w.type !== 'OPEN' && w.thicknessIn ? w.thicknessIn + (w.innerLeafIn ?? 0) : defaultLintelWidthIn;
      lintels.push({ lengthFt: (o.widthFt + lintelBearingFt) * o.quantity, count: o.quantity, widthIn });
    }
  }

  const runOf = (kinds: SegmentKind[]) => sum(segments.filter((s) => kinds.includes(s.kind)).map((s) => s.lengthFt));
  const external = runOf(['EXTERNAL', 'DOUBLE']);
  const internal = runOf(['SHARED', 'PASSAGE', 'REMAINDER']);
  const party = runOf(['PARTY']);
  return {
    segments,
    byThickness: [...groups.values()].sort((a, b) => a.thicknessIn - b.thicknessIn),
    plasterInternalSqft: plasterInternal,
    plasterExternalSqft: plasterExternal,
    externalRunFt: external,
    internalRunFt: internal,
    partyRunFt: party,
    partyExistingFt: partyExisting,
    openFt: open,
    builtRunFt: external + internal + party,
    lintels,
    unpairedSides: unpaired,
  };
}
