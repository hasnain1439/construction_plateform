/**
 * Shared-wall pairing. A SHARED side of room A points at room B's side (and B's side points back),
 * so the estimate counts the wall once. These helpers keep both ends consistent:
 *   - setting A.side → SHARED with B creates / updates B's matching side (the opposite side when it
 *     is free, else the free side closest in length; an explicit `sharedWithSide` must be free);
 *     B without walls gets four EXTERNAL sides first;
 *   - changing / clearing A's pairing turns B's old side back into a plain EXTERNAL wall;
 *   - deleting a room turns every side that pointed at it into EXTERNAL.
 * "Free" = not SHARED, or already shared with exactly this side of A.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { Prisma } from '../../generated/prisma/client.js';
import { allExternal, externalWall, OPPOSITE, sideLength, WALL_SIDES, readWalls, type Wall, type WallSide } from './walls.js';

export interface PairRoom {
  id: string;
  name: string;
  lengthFt: number;
  widthFt: number;
}

type State = Map<string, Wall[] | null>;

const sideOf = (walls: Wall[], side: WallSide) => walls.find((w) => w.side === side)!;
const isFree = (w: Wall, roomId: string, side: WallSide) => w.type !== 'SHARED' || (w.sharedWithRoomId === roomId && w.sharedWithSide === side);

function replaceSide(walls: Wall[], next: Wall): Wall[] {
  return walls.map((w) => (w.side === next.side ? next : w));
}

/** Turns partner sides that point at (roomId, side?) back into EXTERNAL. */
function release(state: State, changed: Set<string>, roomId: string, onlySide?: WallSide, onlyPartner?: string) {
  for (const [id, walls] of state) {
    if (!walls || id === roomId || (onlyPartner && id !== onlyPartner)) continue;
    let next = walls;
    for (const w of walls) {
      if (w.type === 'SHARED' && w.sharedWithRoomId === roomId && (!onlySide || w.sharedWithSide === onlySide)) next = replaceSide(next, externalWall(w.side));
    }
    if (next !== walls) {
      state.set(id, next);
      changed.add(id);
    }
  }
}

/**
 * Applies the new walls of `roomId` (already normalised; SHARED sides may lack `sharedWithSide`)
 * to `state` (every room of the floor → walls), pairing / un-pairing the partners. Returns the ids
 * of the rooms whose walls changed (incl. `roomId`).
 */
export function applyWalls(roomId: string, walls: Wall[] | null, state: State, rooms: Map<string, PairRoom>): Set<string> {
  const changed = new Set<string>([roomId]);
  const old = state.get(roomId) ?? null;

  // 1. Release partners whose pairing is gone or changed
  for (const w of old ?? []) {
    if (w.type !== 'SHARED' || !w.sharedWithRoomId) continue;
    const now = walls ? sideOf(walls, w.side) : null;
    if (now && now.type === 'SHARED' && now.sharedWithRoomId === w.sharedWithRoomId && (now.sharedWithSide === null || now.sharedWithSide === w.sharedWithSide)) continue;
    release(state, changed, roomId, w.side, w.sharedWithRoomId);
  }
  if (!walls) {
    state.set(roomId, null);
    return changed;
  }

  // 2. Pair every SHARED side
  const me = rooms.get(roomId)!;
  let mine = walls;
  const taken = new Set<string>();
  for (const w of walls) {
    if (w.type !== 'SHARED') continue;
    const partnerId = w.sharedWithRoomId!;
    const partner = rooms.get(partnerId);
    if (!partner || partnerId === roomId) {
      throw new BadRequest('INVALID_SHARED_ROOM', 'A shared wall must be with another room on the same floor', { side: w.side, sharedWithRoomId: partnerId });
    }
    const theirs = state.get(partnerId) ?? allExternal();
    const usable = (s: WallSide) => isFree(sideOf(theirs, s), roomId, w.side) && !taken.has(`${partnerId}:${s}`);
    let target: WallSide | undefined;
    if (w.sharedWithSide) {
      if (!usable(w.sharedWithSide)) {
        throw new Conflict('WALL_SIDE_TAKEN', `${partner.name}: the ${w.sharedWithSide} side is already shared with another room`, { roomId: partnerId, side: w.sharedWithSide });
      }
      target = w.sharedWithSide;
    } else {
      const already = theirs.find((x) => x.type === 'SHARED' && x.sharedWithRoomId === roomId && x.sharedWithSide === w.side);
      const myLen = sideLength(w.side, me);
      target =
        already?.side ??
        (usable(OPPOSITE[w.side]) ? OPPOSITE[w.side] : undefined) ??
        [...WALL_SIDES].filter(usable).sort((a, b) => Math.abs(sideLength(a, partner) - myLen) - Math.abs(sideLength(b, partner) - myLen))[0];
      if (!target) throw new Conflict('WALL_SIDE_TAKEN', `${partner.name} has no free side left to share`, { roomId: partnerId });
    }
    taken.add(`${partnerId}:${target}`);
    mine = replaceSide(mine, { ...w, sharedWithSide: target });
    const mirrored: Wall = {
      side: target,
      type: 'SHARED',
      thicknessIn: w.thicknessIn,
      innerLeafIn: null,
      cavityIn: null,
      sharedWithRoomId: roomId,
      sharedWithSide: w.side,
      existing: false,
    };
    const prev = sideOf(theirs, target);
    if (JSON.stringify(prev) !== JSON.stringify(mirrored) || !state.get(partnerId)) {
      state.set(partnerId, replaceSide(theirs, mirrored));
      changed.add(partnerId);
    }
  }
  state.set(roomId, mine);
  return changed;
}

/** Room deleted → every side that pointed at it becomes EXTERNAL. Returns the changed room ids. */
export function releaseRoom(roomId: string, state: State): Set<string> {
  const changed = new Set<string>();
  release(state, changed, roomId);
  return changed;
}

// ─── Database helpers ───────────────────────────────────────────────────────

/** Every room of a floor with its walls. */
export async function loadFloorState(tx: Tx, floorId: string) {
  const rows = await tx.room.findMany({ where: { floorId }, select: { id: true, name: true, lengthFt: true, widthFt: true, walls: true } });
  const rooms = new Map<string, PairRoom>(rows.map((r) => [r.id, { id: r.id, name: r.name, lengthFt: Number(r.lengthFt), widthFt: Number(r.widthFt) }]));
  const state: State = new Map(rows.map((r) => [r.id, readWalls(r.walls)]));
  return { rooms, state };
}

/** Writes the walls of `ids` (sequentially: one connection per transaction). */
export async function saveWalls(tx: Tx, state: State, ids: Iterable<string>) {
  for (const id of ids) {
    const walls = state.get(id) ?? null;
    await tx.room.update({ where: { id }, data: { walls: walls ? (walls as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  }
}
