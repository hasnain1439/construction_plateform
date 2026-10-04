import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

/** A draft with Ground (11 ft) and First (10 ft) floors. */
async function projectWithFloors(auth: Record<string, string>) {
  const p = await api()
    .post('/api/v1/projects')
    .set(auth)
    .send({ name: 'Rooms test', newClient: { name: 'Room Client', phone: '0300-4443322' }, siteAddress: 'Plot 1', city: 'Lahore', startDate: '2026-11-01', endDate: '2027-09-30' });
  const id = p.body.data.id as string;
  const res = await api()
    .patch(`/api/v1/projects/${id}/plot-structure`)
    .set(auth)
    .send({
      plotUnit: 'MARLA',
      plotSize: 10,
      frontFt: 35,
      depthFt: 65,
      structureType: 'FRAMED',
      hasBasement: false,
      floors: [
        { level: 'GROUND', ceilingHeightFt: 11 },
        { level: 'FIRST', ceilingHeightFt: 10 },
      ],
    });
  const [ground, first] = res.body.data.floors as Array<{ id: string }>;
  return { id, ground: ground!.id, first: first!.id };
}

const drawing = {
  type: 'DRAWING_ROOM',
  lengthFt: 16,
  widthFt: 14,
  openings: [
    { type: 'DOOR', widthFt: 3.5, heightFt: 7 },
    { type: 'WINDOW', widthFt: 5, heightFt: 4 },
  ],
};

describe('rooms', () => {
  it('creates a room with the floor height, openings and calculations', async () => {
    const auth = await owner();
    const { id, ground } = await projectWithFloors(auth);
    const res = await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send(drawing);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Drawing Room',
      heightFt: 11,
      isWet: false,
      isWetOverridden: false,
      calculations: { floorAreaSqft: 224, grossWallAreaSqft: 660, openingsAreaSqft: 44.5, netWallAreaSqft: 615.5 },
    });
    expect(res.body.data.openings).toHaveLength(2);

    const floors = await api().get(`/api/v1/projects/${id}/floors`).set(auth);
    expect(floors.body.data.floors[0].calculations).toEqual({ rooms: 1, totalFloorAreaSqft: 224, netWallAreaSqft: 615.5, wetRooms: 0 });
    expect(floors.body.data.totals.rooms).toBe(1);
    const project = await api().get(`/api/v1/projects/${id}`).set(auth);
    expect(project.body.data.wizardCompletedSteps).toEqual([1, 3, 5]);
    expect(project.body.data.calculations).toMatchObject({ rooms: 1, totalFloorAreaSqft: 224 });
  });

  it('wet rooms are automatic (bath, powder, kitchen) and can be overridden', async () => {
    const auth = await owner();
    const { ground } = await projectWithFloors(auth);
    const kitchen = await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'KITCHEN', lengthFt: 12, widthFt: 10 });
    expect(kitchen.body.data).toMatchObject({ isWet: true, isWetOverridden: false });
    const store = await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 6, widthFt: 5, isWet: true });
    expect(store.body.data).toMatchObject({ isWet: true, isWetOverridden: true });

    // Type change re-derives only when not overridden
    const asBedroom = await api().patch(`/api/v1/rooms/${kitchen.body.data.id}`).set(auth).send({ type: 'BEDROOM' });
    expect(asBedroom.body.data.isWet).toBe(false);
    const keep = await api().patch(`/api/v1/rooms/${store.body.data.id}`).set(auth).send({ type: 'GARAGE' });
    expect(keep.body.data.isWet).toBe(true);
    const auto = await api().patch(`/api/v1/rooms/${store.body.data.id}`).set(auth).send({ isWet: null });
    expect(auto.body.data).toMatchObject({ isWet: false, isWetOverridden: false });
  });

  it('second bedroom is named "Bedroom 2"; delete cascades openings', async () => {
    const auth = await owner();
    const { first } = await projectWithFloors(auth);
    await api().post(`/api/v1/floors/${first}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 14, widthFt: 12 });
    const second = await api().post(`/api/v1/floors/${first}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 14, widthFt: 12, openings: [{ type: 'DOOR', widthFt: 3, heightFt: 7 }] });
    expect(second.body.data).toMatchObject({ name: 'Bedroom 2', heightFt: 10 });
    expect((await api().delete(`/api/v1/rooms/${second.body.data.id}`).set(auth)).status).toBe(200);
    expect(await prismaAdmin.opening.count({ where: { roomId: second.body.data.id } })).toBe(0);
  });
});

describe('openings', () => {
  it('CRUD, and total openings larger than the walls → 400 OPENINGS_EXCEED_WALL', async () => {
    const auth = await owner();
    const { ground } = await projectWithFloors(auth);
    // 5 × 4 × 9 ft room: gross wall 2 × (5 + 4) × 9 = 162 sq ft
    const tooBig = await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 5, widthFt: 4, heightFt: 9, openings: [{ type: 'WINDOW', widthFt: 10, heightFt: 9, quantity: 2 }] });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatchObject({ code: 'OPENINGS_EXCEED_WALL', details: { openingsAreaSqft: 180, grossWallAreaSqft: 162 } });

    const room = await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 5, widthFt: 4, heightFt: 9 });
    const added = await api().post(`/api/v1/rooms/${room.body.data.id}/openings`).set(auth).send({ type: 'DOOR', widthFt: 2.5, heightFt: 7 });
    expect(added.status).toBe(201);
    expect(added.body.data.calculations).toMatchObject({ openingsAreaSqft: 17.5, netWallAreaSqft: 144.5 });
    const openingId = added.body.data.openings[0].id;

    const qty = await api().patch(`/api/v1/openings/${openingId}`).set(auth).send({ quantity: 2 });
    expect(qty.body.data.calculations.openingsAreaSqft).toBe(35);
    const over = await api().patch(`/api/v1/openings/${openingId}`).set(auth).send({ quantity: 50 });
    expect(over.body.error.code).toBe('OPENINGS_EXCEED_WALL');
    const shrink = await api().patch(`/api/v1/rooms/${room.body.data.id}`).set(auth).send({ heightFt: 1 });
    expect(shrink.body.error.code).toBe('OPENINGS_EXCEED_WALL');
    const removed = await api().delete(`/api/v1/openings/${openingId}`).set(auth);
    expect(removed.body.data.openings).toHaveLength(0);
  });
});

describe('copy floor', () => {
  it('copies rooms + openings with the target ceiling height; a non-empty target needs replace', async () => {
    const auth = await owner();
    const { id, ground, first } = await projectWithFloors(auth);
    await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send(drawing);
    await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'ATTACHED_BATH', lengthFt: 8, widthFt: 6 });

    const copied = await api().post(`/api/v1/floors/${ground}/copy`).set(auth).send({ targetFloorId: first });
    expect(copied.status).toBe(200);
    expect(copied.body.data.rooms.map((r: { name: string; heightFt: number }) => `${r.name}@${r.heightFt}`)).toEqual(['Drawing Room@10', 'Attached Bath@10']);
    expect(copied.body.data.rooms[0].openings).toHaveLength(2);
    expect(copied.body.data.calculations).toMatchObject({ rooms: 2, wetRooms: 1 });

    const again = await api().post(`/api/v1/floors/${ground}/copy`).set(auth).send({ targetFloorId: first });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FLOOR_NOT_EMPTY');
    const replaced = await api().post(`/api/v1/floors/${ground}/copy`).set(auth).send({ targetFloorId: first, replace: true });
    expect(replaced.body.data.rooms).toHaveLength(2);
    expect(await prismaAdmin.room.count({ where: { projectId: id } })).toBe(4);
    expect((await api().post(`/api/v1/floors/${ground}/copy`).set(auth).send({ targetFloorId: ground })).body.error.code).toBe('INVALID_TARGET_FLOOR');
  });
});

describe('access', () => {
  it('unassigned PM → 404, MUNSHI → 403 on writes but can read floors of an assigned project', async () => {
    const auth = await owner();
    const { id, ground } = await projectWithFloors(auth);
    const pmRes = await api().post(`/api/v1/floors/${ground}/rooms`).set(await pm()).send(drawing);
    expect(pmRes.status).toBe(404);
    expect(pmRes.body.error.code).toBe('FLOOR_NOT_FOUND');
    expect((await api().get(`/api/v1/projects/${id}/floors`).set(await pm())).status).toBe(404);

    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().post(`/api/v1/floors/${ground}/rooms`).set(munshi).send(drawing)).status).toBe(403);
    expect((await api().get(`/api/v1/projects/${seeded().projects.dha.id}/floors`).set(munshi)).status).toBe(200);
  });
});
