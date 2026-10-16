/**
 * Roof / lenter per floor (PATCH /projects/:id/plot-structure floors[].roof), walls per room side
 * (PUT /rooms/:id/walls, POST /floors/:id/walls/auto), openings with a side, and the estimate using
 * them (DETAILED lines). The arithmetic is checked in tests/unit/estimateDetailed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { createDraft } from './fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
type Auth = Record<string, string>;

const PLOT = { plotUnit: 'MARLA', plotSize: 5, frontFt: 25, depthFt: 45, structureType: 'LOAD_BEARING', hasBasement: false };

async function draftWithGround(auth: Auth, roof?: unknown) {
  const p = await createDraft(auth);
  const res = await api()
    .patch(`/api/v1/projects/${p.id}/plot-structure`)
    .set(auth)
    .send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 10, ...(roof === undefined ? {} : { roof }) }] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { id: p.id, ground: res.body.data.floors[0].id as string, plot: res.body.data };
}

const ext = (side: string) => ({ side, type: 'EXTERNAL' });

describe('roof per floor', () => {
  it('saves with defaults, returns it on the project, keeps it when omitted, clears with null', async () => {
    const auth = await owner();
    const { id, plot } = await draftWithGround(auth, { type: 'RCC_SLAB', mainSpacingIn: 6, distSpacingIn: 9 });
    expect(plot.floors[0].roof).toMatchObject({ type: 'RCC_SLAB', thicknessIn: 5, mainBar: 4, mainSpacingIn: 6, distBar: 3, distSpacingIn: 9, topBars: true, coverIn: 0.75, tIronSection: null });
    expect(plot.floors[0].slabSuggestion).toMatchObject({ spanFt: null, suggestedIn: 5 });

    // Omitted → unchanged
    const same = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 11 }] });
    expect(same.body.data.floors[0].roof.type).toBe('RCC_SLAB');
    // T-iron roof
    const tIron = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 11, roof: { type: 'T_IRON_TILE', tIronSection: 'T4X4' } }] });
    expect(tIron.body.data.floors[0].roof).toMatchObject({ type: 'T_IRON_TILE', tIronSection: 'T4X4', tIronSpacingFt: 3, thicknessIn: null, mainBar: null });
    // null → cleared
    const cleared = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 11, roof: null }] });
    expect(cleared.body.data.floors[0].roof).toBeNull();
    expect((await prismaAdmin.floor.findFirstOrThrow({ where: { projectId: id } })).roof).toBeNull();
  });

  it('validation: spacing below 3″, unknown bar, beam not deeper than the slab → 400', async () => {
    const auth = await owner();
    const { id } = await draftWithGround(auth);
    for (const roof of [{ type: 'RCC_SLAB', mainSpacingIn: 2 }, { type: 'RCC_SLAB', mainBar: 8 }, { type: 'RCC_SLAB', thicknessIn: 6, beamDepthIn: 6 }, { type: 'TIN' }]) {
      const res = await api().patch(`/api/v1/projects/${id}/plot-structure`).set(auth).send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 10, roof }] });
      expect(res.status, JSON.stringify(roof)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('walls per room side', () => {
  it('shared pairing is created on the other room, kept consistent, and released on delete', async () => {
    const auth = await owner();
    const { ground } = await draftWithGround(auth);
    const a = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    const b = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    expect(a.walls).toBeNull();

    const res = await api()
      .put(`/api/v1/rooms/${a.id}/walls`)
      .set(auth)
      .send({ walls: [ext('TOP'), { side: 'RIGHT', type: 'SHARED', sharedWithRoomId: b.id }, ext('BOTTOM'), { side: 'LEFT', type: 'PARTY', existing: true }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rooms = res.body.data.rooms as Array<{ id: string; walls: Array<Record<string, unknown>> }>;
    const A = rooms.find((r) => r.id === a.id)!;
    const B = rooms.find((r) => r.id === b.id)!;
    // Load-bearing → shared walls default to 9″
    expect(A.walls[1]).toMatchObject({ side: 'RIGHT', type: 'SHARED', thicknessIn: 9, sharedWithRoomId: b.id, sharedWithSide: 'LEFT' });
    expect(A.walls[3]).toMatchObject({ side: 'LEFT', type: 'PARTY', thicknessIn: 9, existing: true });
    expect(B.walls.map((w) => w.type)).toEqual(['EXTERNAL', 'EXTERNAL', 'EXTERNAL', 'SHARED']);
    expect(B.walls[3]).toMatchObject({ sharedWithRoomId: a.id, sharedWithSide: 'RIGHT', thicknessIn: 9 });

    // Explicitly taking B.LEFT from a third room → 409
    const c = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 6, widthFt: 5 })).body.data;
    const taken = await api()
      .put(`/api/v1/rooms/${c.id}/walls`)
      .set(auth)
      .send({ walls: [{ side: 'TOP', type: 'SHARED', sharedWithRoomId: b.id, sharedWithSide: 'LEFT' }, ext('RIGHT'), ext('BOTTOM'), ext('LEFT')] });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('WALL_SIDE_TAKEN');
    // Sharing with a room on another floor / itself → 400
    const self = await api().put(`/api/v1/rooms/${c.id}/walls`).set(auth).send({ walls: [{ side: 'TOP', type: 'SHARED', sharedWithRoomId: c.id }, ext('RIGHT'), ext('BOTTOM'), ext('LEFT')] });
    expect(self.body.error.code).toBe('INVALID_SHARED_ROOM');
    // Only three sides → 400
    expect((await api().put(`/api/v1/rooms/${c.id}/walls`).set(auth).send({ walls: [ext('TOP'), ext('RIGHT'), ext('BOTTOM')] })).status).toBe(400);

    // Deleting A turns B.LEFT back into an EXTERNAL wall
    expect((await api().delete(`/api/v1/rooms/${a.id}`).set(auth)).status).toBe(200);
    const after = await prismaAdmin.room.findUniqueOrThrow({ where: { id: b.id } });
    expect((after.walls as Array<{ type: string; sharedWithRoomId: string | null }>).every((w) => w.type === 'EXTERNAL' && w.sharedWithRoomId === null)).toBe(true);

    // Clearing walls (null)
    const clear = await api().put(`/api/v1/rooms/${b.id}/walls`).set(auth).send({ walls: null });
    expect(clear.body.data.rooms.find((r: { id: string }) => r.id === b.id).walls).toBeNull();
  });

  it('auto-set walls: rooms without walls get four EXTERNAL sides; replace resets every room', async () => {
    const auth = await owner();
    const { ground } = await draftWithGround(auth);
    const a = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    const b = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'KITCHEN', lengthFt: 10, widthFt: 8 })).body.data;
    await api().put(`/api/v1/rooms/${a.id}/walls`).set(auth).send({ walls: [ext('TOP'), { side: 'RIGHT', type: 'SHARED', sharedWithRoomId: b.id }, ext('BOTTOM'), ext('LEFT')] });
    const c = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 6, widthFt: 5 })).body.data;

    const auto = await api().post(`/api/v1/floors/${ground}/walls/auto`).set(auth).send({});
    expect(auto.status).toBe(200);
    const byId = (rs: Array<{ id: string; walls: Array<{ type: string }> }>, id: string) => rs.find((r) => r.id === id)!.walls.map((w) => w.type);
    expect(byId(auto.body.data.rooms, c.id)).toEqual(['EXTERNAL', 'EXTERNAL', 'EXTERNAL', 'EXTERNAL']);
    expect(byId(auto.body.data.rooms, a.id)).toContain('SHARED'); // kept
    const reset = await api().post(`/api/v1/floors/${ground}/walls/auto`).set(auth).send({ replace: true });
    expect(byId(reset.body.data.rooms, a.id)).toEqual(['EXTERNAL', 'EXTERNAL', 'EXTERNAL', 'EXTERNAL']);
    expect(byId(reset.body.data.rooms, b.id)).toEqual(['EXTERNAL', 'EXTERNAL', 'EXTERNAL', 'EXTERNAL']);
  });

  it('copy floor remaps the pairings to the copies; walls can be sent with a new room', async () => {
    const auth = await owner();
    const p = await createDraft(auth);
    const plot = await api()
      .patch(`/api/v1/projects/${p.id}/plot-structure`)
      .set(auth)
      .send({ ...PLOT, floors: [{ level: 'GROUND', ceilingHeightFt: 10 }, { level: 'FIRST', ceilingHeightFt: 10 }] });
    const [ground, first] = plot.body.data.floors.map((f: { id: string }) => f.id);
    const a = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    const b = await api()
      .post(`/api/v1/floors/${ground}/rooms`)
      .set(auth)
      .send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10, walls: [ext('TOP'), ext('RIGHT'), ext('BOTTOM'), { side: 'LEFT', type: 'SHARED', sharedWithRoomId: a.id, thicknessIn: 4.5 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.data.walls[3]).toMatchObject({ sharedWithRoomId: a.id, sharedWithSide: 'RIGHT', thicknessIn: 4.5 });

    const copied = await api().post(`/api/v1/floors/${ground}/copy`).set(auth).send({ targetFloorId: first });
    const [ca, cb] = copied.body.data.rooms as Array<{ id: string; walls: Array<{ side: string; sharedWithRoomId: string | null }> }>;
    expect(ca!.walls.find((w) => w.side === 'RIGHT')!.sharedWithRoomId).toBe(cb!.id);
    expect(cb!.walls.find((w) => w.side === 'LEFT')!.sharedWithRoomId).toBe(ca!.id);
  });
});

describe('openings with a side', () => {
  it('stores the side, checks the side wall area, allows null', async () => {
    const auth = await owner();
    const { ground } = await draftWithGround(auth);
    const room = await api()
      .post(`/api/v1/floors/${ground}/rooms`)
      .set(auth)
      .send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10, openings: [{ type: 'DOOR', widthFt: 3, heightFt: 7, side: 'RIGHT' }, { type: 'WINDOW', widthFt: 4, heightFt: 4 }] });
    expect(room.status).toBe(201);
    expect(room.body.data.openings.map((o: { side: string | null }) => o.side).sort()).toEqual([null, 'RIGHT'].sort());
    // RIGHT wall is 10 × 10 = 100 sq ft: a 12 × 9 window does not fit there
    const over = await api().post(`/api/v1/rooms/${room.body.data.id}/openings`).set(auth).send({ type: 'WINDOW', widthFt: 12, heightFt: 9, side: 'RIGHT' });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatchObject({ code: 'OPENINGS_EXCEED_WALL', details: { side: 'RIGHT' } });
    const win = room.body.data.openings.find((o: { type: string }) => o.type === 'WINDOW');
    const moved = await api().patch(`/api/v1/openings/${win.id}`).set(auth).send({ side: 'TOP' });
    expect(moved.body.data.openings.find((o: { id: string }) => o.id === win.id).side).toBe('TOP');
    const unplaced = await api().patch(`/api/v1/openings/${win.id}`).set(auth).send({ side: null });
    expect(unplaced.body.data.openings.find((o: { id: string }) => o.id === win.id).side).toBeNull();
  });
});

describe('estimate uses roof + walls (DETAILED)', () => {
  it('steel by size, walls by thickness, methods; old projects stay ESTIMATED', async () => {
    const auth = await owner();
    const { id, ground } = await draftWithGround(auth, { type: 'RCC_SLAB' });
    await api().patch(`/api/v1/projects/${id}/coverage`).set(auth).send({ coveredAreaSqft: 240, boundaryWall: false });
    const a = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    const b = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    await api().post(`/api/v1/floors/${ground}/walls/auto`).set(auth).send({});
    await api().put(`/api/v1/rooms/${a.id}/walls`).set(auth).send({ walls: [ext('TOP'), { side: 'RIGHT', type: 'SHARED', sharedWithRoomId: b.id, thicknessIn: 4.5 }, ext('BOTTOM'), ext('LEFT')] });

    const res = await api().get(`/api/v1/projects/${id}/estimate`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const e = res.body.data;
    expect(e.basis.methods).toEqual({ walls: 'DETAILED', roof: 'DETAILED' });
    const lines = e.stages.flatMap((s: { lines: Array<{ id: string; method: string; netQuantity: number }> }) => s.lines);
    const line = (lid: string) => lines.find((l: { id: string }) => l.id === lid);
    // 68 ft external × 10 × 0.75 = 510 cft; shared 10 × 10 × 0.375 = 37.5 cft once
    expect(line('WALLS.GROUND.walls.t9.volume')).toMatchObject({ netQuantity: 510, method: 'DETAILED' });
    expect(line('WALLS.GROUND.walls.t4_5.volume')).toMatchObject({ netQuantity: 37.5 });
    expect(line('RCC.GROUND.slab.steel12').method).toBe('DETAILED');
    expect(e.materials.map((m: { material: string }) => m.material)).toEqual(expect.arrayContaining(['steel10', 'steel12']));
    expect(e.basis.floors[0].roof.steelBySize.map((s: { bar: number }) => s.bar)).toEqual([3, 4]);

    // The seeded project (no roof / walls) is unchanged: ESTIMATED
    const dha = await api().get(`/api/v1/projects/${seeded().projects.dha.id}/estimate`).set(auth);
    expect(dha.body.data.basis.methods).toEqual({ walls: 'ESTIMATED', roof: 'ESTIMATED' });
  });

  it('MUNSHI cannot edit walls', async () => {
    const auth = await owner();
    const { ground } = await draftWithGround(auth);
    const a = (await api().post(`/api/v1/floors/${ground}/rooms`).set(auth).send({ type: 'BEDROOM', lengthFt: 12, widthFt: 10 })).body.data;
    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    expect((await api().put(`/api/v1/rooms/${a.id}/walls`).set(munshi).send({ walls: null })).status).toBe(403);
    expect((await api().post(`/api/v1/floors/${ground}/walls/auto`).set(munshi).send({})).status).toBe(403);
  });
});
