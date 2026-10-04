/** Tab 5: floors → rooms → openings, with live calculations. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import type { RoomType } from '../../generated/prisma/client.js';
import { assertEditable, caller, findProjectFor, type Caller } from './access.js';
import { roomCalc, type OpeningInput as CalcOpening } from './calc.js';
import { isWetType, ROOM_TYPE_NAMES } from './presets.js';
import { toFloorDto, toRoomDto } from './projects.dto.js';
import * as repo from './projects.repository.js';
import type { CopyFloorInput, CreateRoomInput, OpeningInput, UpdateOpeningInput, UpdateRoomInput } from './projects.schema.js';
import { audit, markStep } from './projects.service.js';

const floorNotFound = () => new NotFound('FLOOR_NOT_FOUND', 'Floor not found');
const roomNotFound = () => new NotFound('ROOM_NOT_FOUND', 'Room not found');
const openingNotFound = () => new NotFound('OPENING_NOT_FOUND', 'Opening not found');

/** Loads the parent project in the caller's scope; anything outside it is reported as `notFound`. */
async function scopedProject(tx: Tx, c: Caller, projectId: string, notFound: () => NotFound, edit: boolean) {
  const project = await findProjectFor(tx, c, projectId).catch(() => {
    throw notFound();
  });
  if (edit) assertEditable(project);
  return project;
}

async function floorFor(tx: Tx, c: Caller, id: string, edit: boolean) {
  const floor = await tx.floor.findUnique({ where: { id } });
  if (!floor) throw floorNotFound();
  const project = await scopedProject(tx, c, floor.projectId, floorNotFound, edit);
  return { floor, project };
}

async function roomFor(tx: Tx, c: Caller, id: string) {
  const room = await tx.room.findUnique({ where: { id }, include: repo.roomInclude });
  if (!room) throw roomNotFound();
  const project = await scopedProject(tx, c, room.projectId, roomNotFound, true);
  return { room, project };
}

/** Total door / window area may not exceed the room's gross wall area. */
function assertOpeningsFit(dims: { lengthFt: unknown; widthFt: unknown; heightFt: unknown }, openings: CalcOpening[]) {
  const calc = roomCalc({ lengthFt: String(dims.lengthFt), widthFt: String(dims.widthFt), heightFt: String(dims.heightFt), openings });
  if (calc.openingsAreaSqft > calc.grossWallAreaSqft) {
    throw new BadRequest('OPENINGS_EXCEED_WALL', `Openings (${calc.openingsAreaSqft} sq ft) are larger than the walls (${calc.grossWallAreaSqft} sq ft)`, {
      openingsAreaSqft: calc.openingsAreaSqft,
      grossWallAreaSqft: calc.grossWallAreaSqft,
    });
  }
}

/** "Bedroom", then "Bedroom 2", "Bedroom 3" … within the project. */
async function defaultName(tx: Tx, projectId: string, type: RoomType) {
  const base = ROOM_TYPE_NAMES[type];
  const same = await tx.room.count({ where: { projectId, type } });
  return same === 0 ? base : `${base} ${same + 1}`;
}

/** Openings carry tenantId in their composite FK, so they're inserted directly rather than nested. */
function createOpenings(tx: Tx, tenantId: string, roomId: string, openings: Array<{ type: OpeningInput['type']; widthFt: unknown; heightFt: unknown; quantity: number }>) {
  if (!openings.length) return Promise.resolve();
  return tx.opening
    .createMany({ data: openings.map((o) => ({ tenantId, roomId, type: o.type, widthFt: String(o.widthFt), heightFt: String(o.heightFt), quantity: o.quantity })) })
    .then(() => undefined);
}

const loadRoom = (tx: Tx, id: string) => tx.room.findUniqueOrThrow({ where: { id }, include: repo.roomInclude });

// ─── Floors ─────────────────────────────────────────────────────────────────

export async function listFloors(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await findProjectFor(tx, c, projectId);
    const floors = await repo.loadFloors(tx, projectId);
    const dtos = floors.map((f) => toFloorDto(f, true));
    const totals = dtos.reduce(
      (t, f) => ({
        rooms: t.rooms + f.calculations.rooms,
        totalFloorAreaSqft: Math.round((t.totalFloorAreaSqft + f.calculations.totalFloorAreaSqft) * 100) / 100,
        netWallAreaSqft: Math.round((t.netWallAreaSqft + f.calculations.netWallAreaSqft) * 100) / 100,
        wetRooms: t.wetRooms + f.calculations.wetRooms,
      }),
      { rooms: 0, totalFloorAreaSqft: 0, netWallAreaSqft: 0, wetRooms: 0 },
    );
    return { floors: dtos, totals };
  });
}

export async function copyFloor(sourceId: string, input: CopyFloorInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { floor: source, project } = await floorFor(tx, c, sourceId, true);
    if (input.targetFloorId === sourceId) throw new BadRequest('INVALID_TARGET_FLOOR', 'Choose a different floor to copy to');
    const target = await tx.floor.findUnique({ where: { id: input.targetFloorId } });
    if (!target || target.projectId !== source.projectId) throw new BadRequest('INVALID_TARGET_FLOOR', 'The target floor must belong to the same project');
    const existing = await tx.room.count({ where: { floorId: target.id } });
    if (existing && !input.replace) throw new Conflict('FLOOR_NOT_EMPTY', 'The target floor already has rooms — send replace: true to overwrite them', { rooms: existing });
    if (existing) await tx.room.deleteMany({ where: { floorId: target.id } });

    const rooms = await tx.room.findMany({ where: { floorId: source.id }, include: repo.roomInclude, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    for (const r of rooms) {
      const copy = await tx.room.create({
        data: {
          tenantId: c.tenantId,
          projectId: r.projectId,
          floorId: target.id,
          type: r.type,
          name: r.name,
          lengthFt: r.lengthFt,
          widthFt: r.widthFt,
          heightFt: target.ceilingHeightFt, // the target floor's ceiling
          isWet: r.isWet,
          isWetOverridden: r.isWetOverridden,
          sortOrder: r.sortOrder,
        },
      });
      await createOpenings(tx, c.tenantId, copy.id, r.openings);
    }
    await audit(tx, c, 'project.floor_copy', project.id, { from: source.level, to: target.level, rooms: rooms.length, replaced: existing });
    const floor = (await repo.loadFloors(tx, project.id)).find((f) => f.id === target.id)!;
    return toFloorDto(floor, true);
  });
}

// ─── Rooms ──────────────────────────────────────────────────────────────────

export async function createRoom(floorId: string, input: CreateRoomInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { floor, project } = await floorFor(tx, c, floorId, true);
    const heightFt = input.heightFt ?? Number(floor.ceilingHeightFt);
    assertOpeningsFit({ lengthFt: input.lengthFt, widthFt: input.widthFt, heightFt }, input.openings);
    const sortOrder = ((await tx.room.aggregate({ where: { floorId }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
    const room = await tx.room.create({
      data: {
        tenantId: c.tenantId,
        projectId: project.id,
        floorId,
        type: input.type,
        name: input.name ?? (await defaultName(tx, project.id, input.type)),
        lengthFt: input.lengthFt,
        widthFt: input.widthFt,
        heightFt,
        isWet: input.isWet ?? isWetType(input.type),
        isWetOverridden: input.isWet !== undefined,
        sortOrder,
      },
    });
    await createOpenings(tx, c.tenantId, room.id, input.openings);
    await markStep(tx, project, 5);
    await audit(tx, c, 'project.room_create', project.id, { roomId: room.id, floor: floor.level, type: room.type, name: room.name });
    return toRoomDto(await loadRoom(tx, room.id));
  });
}

export async function updateRoom(id: string, input: UpdateRoomInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { room, project } = await roomFor(tx, c, id);
    const type = input.type ?? room.type;
    const dims = { lengthFt: input.lengthFt ?? room.lengthFt, widthFt: input.widthFt ?? room.widthFt, heightFt: input.heightFt ?? room.heightFt };
    assertOpeningsFit(dims, room.openings);

    // Wet flag: explicit true/false overrides; null returns to automatic; a type change re-derives it unless overridden
    let wet: { isWet: boolean; isWetOverridden: boolean } | undefined;
    if (input.isWet === null) wet = { isWet: isWetType(type), isWetOverridden: false };
    else if (input.isWet !== undefined) wet = { isWet: input.isWet, isWetOverridden: true };
    else if (input.type && !room.isWetOverridden) wet = { isWet: isWetType(type), isWetOverridden: false };

    await tx.room.update({
      where: { id },
      data: {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.lengthFt !== undefined ? { lengthFt: input.lengthFt } : {}),
        ...(input.widthFt !== undefined ? { widthFt: input.widthFt } : {}),
        ...(input.heightFt !== undefined ? { heightFt: input.heightFt } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(wet ?? {}),
      },
    });
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateRoomInput] !== undefined);
    await audit(tx, c, 'project.room_update', project.id, { roomId: id, fields });
    return toRoomDto(await loadRoom(tx, id));
  });
}

export async function deleteRoom(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { room, project } = await roomFor(tx, c, id);
    await tx.room.delete({ where: { id } }); // openings cascade
    await audit(tx, c, 'project.room_delete', project.id, { roomId: id, name: room.name });
    return { id, deleted: true };
  });
}

// ─── Openings ───────────────────────────────────────────────────────────────

export async function createOpening(roomId: string, input: OpeningInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { room, project } = await roomFor(tx, c, roomId);
    assertOpeningsFit(room, [...room.openings, input]);
    const opening = await tx.opening.create({ data: { tenantId: c.tenantId, roomId, ...input } });
    await audit(tx, c, 'project.opening_create', project.id, { roomId, openingId: opening.id, type: opening.type });
    return toRoomDto(await loadRoom(tx, roomId));
  });
}

async function openingFor(tx: Tx, c: Caller, id: string) {
  const opening = await tx.opening.findUnique({ where: { id } });
  if (!opening) throw openingNotFound();
  const room = await tx.room.findUniqueOrThrow({ where: { id: opening.roomId }, include: repo.roomInclude });
  const project = await scopedProject(tx, c, room.projectId, openingNotFound, true);
  return { opening, room, project };
}

export async function updateOpening(id: string, input: UpdateOpeningInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { opening, room, project } = await openingFor(tx, c, id);
    const next = { ...opening, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    assertOpeningsFit(room, [...room.openings.filter((o) => o.id !== id), next]);
    await tx.opening.update({ where: { id }, data: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    await audit(tx, c, 'project.opening_update', project.id, { roomId: room.id, openingId: id });
    return toRoomDto(await loadRoom(tx, room.id));
  });
}

export async function deleteOpening(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { room, project } = await openingFor(tx, c, id);
    await tx.opening.delete({ where: { id } });
    await audit(tx, c, 'project.opening_delete', project.id, { roomId: room.id, openingId: id });
    return toRoomDto(await loadRoom(tx, room.id));
  });
}
