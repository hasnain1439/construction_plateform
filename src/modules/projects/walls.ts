/**
 * Walls of a room — four sides, each with a wall type and thickness (wizard tab 5, rooms).
 *
 * Stored as one JSONB column `Room.walls` (null = not entered: the estimate then works the walls out
 * from the room perimeters, as before). When entered it is always exactly four sides:
 *   TOP / BOTTOM run along the room's length, LEFT / RIGHT along its width.
 * Types:
 *   EXTERNAL  outside wall (default 9″)
 *   SHARED    wall between this room and another room on the same floor — counted ONCE; both rooms
 *             carry the pairing (`sharedWithRoomId` + `sharedWithSide`), kept consistent by
 *             walls.service.ts. Default 4.5″ in an RCC frame, 9″ load-bearing.
 *   PARTY     boundary wall with the neighbour (default 9″); `existing: true` = already built → no cost
 *   DOUBLE    cavity wall: outer leaf `thicknessIn` (9″) + cavity `cavityIn` (2″) + inner leaf `innerLeafIn` (4.5″)
 *   OPEN      no wall (open to a lounge / terrace)
 *   PASSAGE   wall to a corridor / stair that is not entered as a room (4.5″ or 9″)
 */
import { z } from 'zod';

export const WALL_SIDES = ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'] as const;
export type WallSide = (typeof WALL_SIDES)[number];
export const WALL_TYPES = ['EXTERNAL', 'SHARED', 'PARTY', 'DOUBLE', 'OPEN', 'PASSAGE'] as const;
export type WallType = (typeof WALL_TYPES)[number];
export const OPPOSITE: Record<WallSide, WallSide> = { TOP: 'BOTTOM', BOTTOM: 'TOP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
export const DOUBLE_INNER_LEAF_IN = 4.5;
export const DOUBLE_CAVITY_IN = 2;

/** TOP / BOTTOM = the room's length, LEFT / RIGHT = its width. */
export function sideLength(side: WallSide, room: { lengthFt: number; widthFt: number }): number {
  return side === 'TOP' || side === 'BOTTOM' ? room.lengthFt : room.widthFt;
}

/** Default thickness of a wall type (inches); OPEN has none. */
export function defaultThickness(type: WallType, structure: 'FRAMED' | 'LOAD_BEARING' | null): number | null {
  switch (type) {
    case 'OPEN':
      return null;
    case 'SHARED':
      return structure === 'LOAD_BEARING' ? 9 : 4.5;
    case 'PASSAGE':
      return 4.5;
    default:
      return 9; // EXTERNAL, PARTY, DOUBLE (outer leaf)
  }
}

const sideSchema = z.enum(WALL_SIDES);
const thickness = z.number().min(3, 'Must be 3–18 in').max(18, 'Must be 3–18 in');

export const wallSideInputSchema = z
  .object({
    side: sideSchema,
    type: z.enum(WALL_TYPES),
    thicknessIn: thickness.optional().meta({ description: 'Wall (or DOUBLE outer leaf) thickness. Default by type: 9″; SHARED 4.5″ (frame) / 9″ (load-bearing); PASSAGE 4.5″' }),
    innerLeafIn: thickness.max(9).optional().meta({ description: 'DOUBLE: inner leaf. Default 4.5″' }),
    cavityIn: z.number().min(0).max(6).optional().meta({ description: 'DOUBLE: cavity (no material). Default 2″' }),
    sharedWithRoomId: z.uuid({ error: 'Invalid sharedWithRoomId' }).nullable().optional().meta({ description: 'SHARED: the other room (same floor)' }),
    sharedWithSide: sideSchema.nullable().optional().meta({ description: 'SHARED: the other room’s side. Omitted = the opposite side if free, else a free side' }),
    existing: z.boolean().optional().meta({ description: 'PARTY: already built by the neighbour → no brickwork' }),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'SHARED' && !v.sharedWithRoomId) ctx.addIssue({ code: 'custom', path: ['sharedWithRoomId'], message: 'Choose the room this wall is shared with' });
  });

export const setWallsBody = z
  .object({
    walls: z
      .array(wallSideInputSchema)
      .length(4, 'Send all four sides: TOP, RIGHT, BOTTOM, LEFT')
      .refine((ws) => new Set(ws.map((w) => w.side)).size === 4, 'Each side once: TOP, RIGHT, BOTTOM, LEFT')
      .nullable()
      .meta({ description: 'The four sides, or null to clear (the estimate goes back to the perimeter method for this floor)' }),
  })
  .meta({ id: 'SetRoomWalls' });

export const autoWallsBody = z
  .object({
    replace: z.boolean().default(false).meta({ description: 'Reset rooms that already have walls too (pairings are cleared)' }),
  })
  .meta({ id: 'AutoWalls' });

export type WallSideInput = z.infer<typeof wallSideInputSchema>;
export type SetWallsInput = z.infer<typeof setWallsBody>;
export type AutoWallsInput = z.infer<typeof autoWallsBody>;

export const wallSchema = z
  .object({
    side: sideSchema,
    type: z.enum(WALL_TYPES),
    thicknessIn: thickness.nullable(),
    innerLeafIn: thickness.nullable(),
    cavityIn: z.number().nullable(),
    sharedWithRoomId: z.string().nullable(),
    sharedWithSide: sideSchema.nullable(),
    existing: z.boolean(),
  })
  .meta({ id: 'RoomWall' });

export type Wall = z.infer<typeof wallSchema>;

/** One side → stored shape (defaults by type, fields that don't apply → null / false). */
export function normaliseWall(v: WallSideInput, structure: 'FRAMED' | 'LOAD_BEARING' | null): Wall {
  const open = v.type === 'OPEN';
  const double = v.type === 'DOUBLE';
  const shared = v.type === 'SHARED';
  return {
    side: v.side,
    type: v.type,
    thicknessIn: open ? null : (v.thicknessIn ?? defaultThickness(v.type, structure)),
    innerLeafIn: double ? (v.innerLeafIn ?? DOUBLE_INNER_LEAF_IN) : null,
    cavityIn: double ? (v.cavityIn ?? DOUBLE_CAVITY_IN) : null,
    sharedWithRoomId: shared ? (v.sharedWithRoomId ?? null) : null,
    sharedWithSide: shared ? (v.sharedWithSide ?? null) : null,
    existing: v.type === 'PARTY' ? Boolean(v.existing) : false,
  };
}

/** A plain EXTERNAL side (auto-set, or what is left when a pairing is removed). */
export const externalWall = (side: WallSide): Wall => ({
  side,
  type: 'EXTERNAL',
  thicknessIn: 9,
  innerLeafIn: null,
  cavityIn: null,
  sharedWithRoomId: null,
  sharedWithSide: null,
  existing: false,
});

/** Four EXTERNAL sides. */
export const allExternal = (): Wall[] => WALL_SIDES.map(externalWall);

/** Stored JSON → four sides in TOP, RIGHT, BOTTOM, LEFT order; null when not entered or broken. */
export function readWalls(json: unknown): Wall[] | null {
  if (!Array.isArray(json) || json.length !== 4) return null;
  const parsed = z.array(wallSchema).safeParse(json);
  if (!parsed.success) return null;
  const bySide = new Map(parsed.data.map((w) => [w.side, w]));
  if (bySide.size !== 4) return null;
  return WALL_SIDES.map((s) => bySide.get(s)!);
}
