import { expect } from 'vitest';
import { api } from '../helpers.js';

let seq = 0;
type Auth = Record<string, string>;

/** Tab 1 only → a DRAFT with a new client. */
export async function createDraft(auth: Auth, over: Record<string, unknown> = {}) {
  seq += 1;
  const res = await api()
    .post('/api/v1/projects')
    .set(auth)
    .send({
      name: `Fixture house ${seq}`,
      newClient: { name: `Fixture Client ${seq}`, phone: `0321-77${String(10000 + seq).slice(-5)}` },
      siteAddress: 'Plot 9, Sector D',
      city: 'Lahore',
      startDate: '2026-11-01',
      endDate: '2027-09-30',
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string };
}

/** Tabs 1–5 filled in → review has no errors. */
export async function createReadyDraft(auth: Auth, over: Record<string, unknown> = {}) {
  const p = await createDraft(auth, over);
  const send = async (path: string, body: object) => {
    const res = await api().patch(`/api/v1/projects/${p.id}/${path}`).set(auth).send(body);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body.data;
  };
  await send('contract', { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1100000000' });
  const plot = await send('plot-structure', {
    plotUnit: 'MARLA',
    plotSize: 5,
    frontFt: 25,
    depthFt: 45,
    structureType: 'FRAMED',
    hasBasement: false,
    floors: [{ level: 'GROUND', ceilingHeightFt: 11 }],
  });
  await send('coverage', { coveredAreaSqft: 1000, boundaryWall: false });
  const room = await api().post(`/api/v1/floors/${plot.floors[0].id}/rooms`).set(auth).send({ type: 'TV_LOUNGE', lengthFt: 30, widthFt: 28 });
  expect(room.status).toBe(201);
  return { ...p, groundFloorId: plot.floors[0].id as string, roomId: room.body.data.id as string };
}
