import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { keyFromLabel } from '../../src/modules/master-data/workerTypes.service.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async () => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const ahmedOwner = async () => bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);

type WorkerType = { id: string; key: string; label: string; labelRoman: string | null; labelUrdu: string | null; ratePaisa: string; overtimeMultiplier: number | null; isActive: boolean; workerCount: number };

const electrician = { label: 'Electrician', labelRoman: 'Bijli wala', labelUrdu: 'بجلی والا', ratePaisa: '300000' };
const create = async (auth: Record<string, string>, body: Record<string, unknown>) => api().post('/api/v1/worker-types').set(auth).send(body);

describe('GET /worker-types', () => {
  it('every role lists the default types with names in 3 languages and worker counts; active first, then by name', async () => {
    const res = await api().get('/api/v1/worker-types').set(await munshi());
    expect(res.status).toBe(200);
    const types = res.body.data as WorkerType[];
    expect(types.map((t) => t.label)).toEqual(['Labourer', 'Mason', 'Steel-fixer helper', 'Tile mason', 'Watchman']);
    const mason = types.find((t) => t.key === 'MISTRI')!;
    expect(mason).toEqual({ id: expect.any(String), key: 'MISTRI', label: 'Mason', labelRoman: 'Mistri', labelUrdu: 'مستری', ratePaisa: '280000', overtimeMultiplier: 1.5, isActive: true, workerCount: 3 });
    expect(types.find((t) => t.key === 'MAZDOOR')).toMatchObject({ labelRoman: 'Mazdoor', labelUrdu: 'مزدور', workerCount: 7 });
    expect(types.find((t) => t.key === 'CHOWKIDAR')).toMatchObject({ label: 'Watchman', labelRoman: 'Chowkidar', labelUrdu: 'چوکیدار' });
    expect(types.find((t) => t.key === 'MISTRI_TILES')).toMatchObject({ label: 'Tile mason', labelRoman: 'Mistri (tiles)', labelUrdu: 'ٹائل مستری' });
    expect(types.find((t) => t.key === 'STEEL_FIXER_HELPER')).toMatchObject({ labelRoman: 'Steel fixer helper', labelUrdu: 'اسٹیل فکسر ہیلپر' });

    // Another company only sees its own (copied) defaults.
    const ahmed = await api().get('/api/v1/worker-types').set(await ahmedOwner());
    expect(ahmed.body.data).toHaveLength(5);
    expect(ahmed.body.data.every((t: WorkerType) => t.workerCount === 0)).toBe(true);
  });
});

describe('POST / PATCH /worker-types', () => {
  it('THEKEDAR creates a type: key from the English name, default overtime 1.5, audited; PM / MUNSHI → 403', async () => {
    expect((await create(await pm(), electrician)).status).toBe(403);
    expect((await create(await munshi(), electrician)).status).toBe(403);

    const res = await create(await owner(), electrician);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: expect.any(String), key: 'ELECTRICIAN', ...electrician, overtimeMultiplier: 1.5, isActive: true, workerCount: 0 });
    const row = await prismaAdmin.laborRate.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row).toMatchObject({ tenantId: seeded().malik.id, kind: 'DAILY', unit: 'DAY', ratePaisa: 300000n });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'worker_type.create', entityId: row.id } })).toBe(1);

    // The new type is a DAILY labour rate too (labour-rates endpoints keep working).
    const rates = await api().get('/api/v1/labor-rates').set(await munshi());
    expect(rates.body.data.find((r: { key: string }) => r.key === 'ELECTRICIAN')).toMatchObject({ kind: 'DAILY', label: 'Electrician', labelRoman: 'Bijli wala', isActive: true });
    const put = await api().put('/api/v1/labor-rates').set(await owner()).send({ rates: [{ kind: 'DAILY', key: 'ELECTRICIAN', unit: 'DAY', ratePaisa: '310000' }] });
    expect(put.status).toBe(200);
    expect((await prismaAdmin.laborRate.findUniqueOrThrow({ where: { id: row.id } })).ratePaisa).toBe(310000n);
  });

  it('key generation: UPPER_SNAKE, suffix on a clash, never OTHER; same active name → 409', async () => {
    expect(keyFromLabel('  Steel-fixer (helper) ')).toBe('STEEL_FIXER_HELPER');
    expect(keyFromLabel('Café wala')).toBe('CAFE_WALA');
    expect(keyFromLabel('مستری')).toBe('TYPE');

    const auth = await owner();
    const other = await create(auth, { label: 'Other', ratePaisa: '100000' });
    expect(other.status).toBe(201);
    expect(other.body.data.key).toBe('OTHER_2');

    const dup = await create(auth, { label: 'mason', ratePaisa: '100000' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WORKER_TYPE_EXISTS');

    // "Mistri" is a free name but its key is taken (the Mason type) → suffix.
    const mistri = await create(auth, { label: 'Mistri', ratePaisa: '290000', overtimeMultiplier: null });
    expect(mistri.body.data).toMatchObject({ key: 'MISTRI_2', overtimeMultiplier: null });
    const p1 = await create(auth, { label: 'Painter', ratePaisa: '250000' });
    // Deactivate, then a new "Painter" may be created (gets a new key); reactivating the old one clashes.
    await api().patch(`/api/v1/worker-types/${p1.body.data.id}`).set(auth).send({ isActive: false });
    const p2 = await create(auth, { label: 'Painter', ratePaisa: '260000' });
    expect(p2.status).toBe(201);
    expect(p2.body.data.key).toBe('PAINTER_2');
    const back = await api().patch(`/api/v1/worker-types/${p1.body.data.id}`).set(auth).send({ isActive: true });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('WORKER_TYPE_EXISTS');
    const rename = await api().patch(`/api/v1/worker-types/${p2.body.data.id}`).set(auth).send({ label: 'LABOURER' });
    expect(rename.body.error.code).toBe('WORKER_TYPE_EXISTS');

    expect((await create(auth, { label: 'X', ratePaisa: '1' })).status).toBe(400);
    expect((await create(auth, { label: 'Welder' })).status).toBe(400);
  });

  it('PATCH updates names / rate / overtime; deactivating keeps existing workers; no delete route', async () => {
    const auth = await owner();
    const mason = await prismaAdmin.laborRate.findFirstOrThrow({ where: { tenantId: seeded().malik.id, kind: 'DAILY', key: 'MISTRI' } });
    expect((await api().patch(`/api/v1/worker-types/${mason.id}`).set(await pm()).send({ ratePaisa: '1' })).status).toBe(403);

    const patched = await api().patch(`/api/v1/worker-types/${mason.id}`).set(auth).send({ label: 'Mason (civil)', labelUrdu: null, ratePaisa: '300000', overtimeMultiplier: 2 });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ key: 'MISTRI', label: 'Mason (civil)', labelRoman: 'Mistri', labelUrdu: null, ratePaisa: '300000', overtimeMultiplier: 2, workerCount: 3 });

    const off = await api().patch(`/api/v1/worker-types/${mason.id}`).set(auth).send({ isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect(await prismaAdmin.worker.count({ where: { tenantId: seeded().malik.id, type: 'MISTRI', isActive: true } })).toBe(3);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'worker_type.deactivate', entityId: mason.id } })).toBe(1);

    const active = await api().get('/api/v1/worker-types').set(auth);
    expect(active.body.data.map((t: WorkerType) => t.key)).not.toContain('MISTRI');
    const all = await api().get('/api/v1/worker-types?includeInactive=true').set(auth);
    expect(all.body.data.at(-1)).toMatchObject({ key: 'MISTRI', isActive: false });

    // Workers still show the type's names.
    const akram = (await api().get('/api/v1/workers?type=MISTRI').set(auth)).body.data[0];
    expect(akram).toMatchObject({ type: 'MISTRI', typeLabel: 'Mason (civil)', typeLabelRoman: 'Mistri', typeLabelUrdu: null });

    expect((await api().delete(`/api/v1/worker-types/${mason.id}`).set(auth)).status).toBe(404);
    const subcontract = await prismaAdmin.laborRate.findFirstOrThrow({ where: { tenantId: seeded().malik.id, kind: 'SUBCONTRACT' } });
    expect((await api().patch(`/api/v1/worker-types/${subcontract.id}`).set(auth).send({ ratePaisa: '1' })).body.error.code).toBe('WORKER_TYPE_NOT_FOUND');
    // Another company's type is invisible.
    expect((await api().patch(`/api/v1/worker-types/${mason.id}`).set(await ahmedOwner()).send({ ratePaisa: '1' })).status).toBe(404);
  });
});

describe('workers with company worker types', () => {
  it('a worker gets a custom type; rate defaults from the type; names in the response', async () => {
    const type = (await create(await owner(), electrician)).body.data as WorkerType;
    const res = await api().post('/api/v1/workers').set(await munshi()).send({ name: 'Imran', type: 'electrician' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'ELECTRICIAN', typeLabel: 'Electrician', typeLabelRoman: 'Bijli wala', typeLabelUrdu: 'بجلی والا', dailyRatePaisa: '300000' });
    expect((await api().get('/api/v1/worker-types').set(await munshi())).body.data.find((t: WorkerType) => t.id === type.id).workerCount).toBe(1);

    const other = await api().post('/api/v1/workers').set(await owner()).send({ name: 'Driver Imtiaz', type: 'OTHER', dailyRatePaisa: '200000' });
    expect(other.body.data).toMatchObject({ type: 'OTHER', typeLabel: 'Other' });
  });

  it('unknown type → 400 INVALID_WORKER_TYPE; an inactive type is refused for new workers but kept by existing ones', async () => {
    const auth = await owner();
    const unknown = await api().post('/api/v1/workers').set(auth).send({ name: 'Someone', type: 'PLUMBER' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_WORKER_TYPE');
    // A SUBCONTRACT key is not a worker type.
    expect((await api().post('/api/v1/workers').set(auth).send({ name: 'Someone', type: 'PLASTER' })).body.error.code).toBe('INVALID_WORKER_TYPE');

    const chowkidar = await prismaAdmin.laborRate.findFirstOrThrow({ where: { tenantId: seeded().malik.id, kind: 'DAILY', key: 'CHOWKIDAR' } });
    await api().patch(`/api/v1/worker-types/${chowkidar.id}`).set(auth).send({ isActive: false });
    const refused = await api().post('/api/v1/workers').set(auth).send({ name: 'New Chowkidar', type: 'CHOWKIDAR', dailyRatePaisa: '120000' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_WORKER_TYPE');

    const ghulam = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Ghulam Rasool' } });
    const keep = await api().patch(`/api/v1/workers/${ghulam.id}`).set(auth).send({ type: 'CHOWKIDAR', notes: 'Night shift' });
    expect(keep.status).toBe(200);
    expect(keep.body.data).toMatchObject({ type: 'CHOWKIDAR', typeLabel: 'Watchman' });
    const shahid = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Shahid' } });
    expect((await api().patch(`/api/v1/workers/${shahid.id}`).set(auth).send({ type: 'CHOWKIDAR' })).body.error.code).toBe('INVALID_WORKER_TYPE');
    expect((await api().patch(`/api/v1/workers/${shahid.id}`).set(auth).send({ type: 'STEEL_FIXER_HELPER' })).body.data.typeLabel).toBe('Steel-fixer helper');

    // Another company's custom type is unknown here.
    await create(await ahmedOwner(), { label: 'Welder', ratePaisa: '250000' });
    expect((await api().post('/api/v1/workers').set(auth).send({ name: 'Someone', type: 'WELDER' })).body.error.code).toBe('INVALID_WORKER_TYPE');
  });

  it('sync push WORKER_CREATE validates the type the same way', async () => {
    const auth = await munshi();
    await create(await owner(), electrician);
    const m = (payload: Record<string, unknown>) => ({ clientId: uuidv7(), type: 'WORKER_CREATE', payload, deviceCreatedAt: new Date().toISOString() });
    const res = await api()
      .post('/api/v1/sync/push')
      .set(auth)
      .send({ mutations: [m({ name: 'Imran', type: 'ELECTRICIAN' }), m({ name: 'Someone', type: 'PLUMBER' })] });
    expect(res.status).toBe(200);
    const [ok, bad] = res.body.data.results;
    expect(ok.status).toBe('APPLIED');
    expect(bad).toMatchObject({ status: 'REJECTED', error: { code: 'INVALID_WORKER_TYPE' } });
    expect((await prismaAdmin.worker.findUniqueOrThrow({ where: { id: ok.serverId } })).dailyRatePaisa).toBe(300000n);
  });
});

describe('sync pull worker_types', () => {
  it('the snapshot has the company types (active and inactive); a change comes through the cursor', async () => {
    const auth = await munshi();
    const snap = (await api().get('/api/v1/sync/pull').set(auth)).body.data;
    const types = snap.changes.worker_types.upserts as Array<Record<string, unknown>>;
    expect(types.map((t) => t['key']).sort()).toEqual(['CHOWKIDAR', 'MAZDOOR', 'MISTRI', 'MISTRI_TILES', 'STEEL_FIXER_HELPER']);
    expect(types.find((t) => t['key'] === 'MISTRI')).toEqual({
      id: expect.any(String),
      key: 'MISTRI',
      label: 'Mason',
      labelRoman: 'Mistri',
      labelUrdu: 'مستری',
      ratePaisa: '280000',
      overtimeMultiplier: 1.5,
      isActive: true,
      updatedAt: expect.any(String),
    });

    const created = (await create(await owner(), electrician)).body.data as WorkerType;
    await api().patch(`/api/v1/worker-types/${created.id}`).set(await owner()).send({ isActive: false });
    // A sub-contract rate change does not show up as a worker type.
    await api().put('/api/v1/labor-rates').set(await owner()).send({ rates: [{ kind: 'SUBCONTRACT', key: 'PLASTER', unit: 'SQFT', ratePaisa: '2600' }] });

    const next = (await api().get('/api/v1/sync/pull').set(auth).query({ cursor: snap.cursor })).body.data;
    expect(next.changes.worker_types).toEqual({ upserts: [expect.objectContaining({ id: created.id, key: 'ELECTRICIAN', isActive: false, ratePaisa: '300000' })], deletes: [] });
  });
});
