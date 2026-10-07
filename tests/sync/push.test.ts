import { beforeEach, describe, expect, it } from 'vitest';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { api, owner, today } from '../labor/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  const s = seeded();
  const base = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects };
  await seedMalikInventory(prismaAdmin, base);
  await seedMalikLabor(prismaAdmin, { ...base, asifId: s.users.asif.id });
});

type Result = { clientId: string; type: string; status: string; serverId: string | null; error: { code: string } | null };
const munshi = async () => {
  const s = await loginMunshi(seeded().malik.id);
  return { auth: bearer(s.accessToken), deviceId: s.deviceId };
};
const push = async (auth: Record<string, string>, mutations: Array<Record<string, unknown>>, headers: Record<string, string> = {}) => {
  const res = await api().post('/api/v1/sync/push').set(auth).set(headers).send({ mutations });
  if (res.status !== 200) throw new Error(`push ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { results: Result[]; applied: number; duplicates: number; rejected: number; retry: number };
};
const m = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ clientId: uuidv7(), type, payload, deviceCreatedAt: new Date().toISOString(), ...extra });

describe('POST /sync/push', () => {
  it('is idempotent: the same batch twice → DUPLICATE with the same server ids, no second effect', async () => {
    const { auth } = await munshi();
    const dha = seeded().projects.dha.id;
    const batch = [m('CASH_EXPENSE_CREATE', { projectId: dha, category: 'TEA_WATER', amountPaisa: '50000', description: 'Chai for the labour' }), m('DAILY_LOG_UPSERT', { projectId: dha, workDone: 'Brickwork 1F', conditions: ['NORMAL'] })];
    const first = await push(auth, batch);
    expect(first.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    const second = await push(auth, batch);
    expect(second.results.map((r) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(second.results.map((r) => r.serverId)).toEqual(first.results.map((r) => r.serverId));
    expect(await prismaAdmin.cashEntry.count({ where: { clientId: batch[0]!.clientId } })).toBe(1);
    expect(await prismaAdmin.dailyLog.count()).toBe(1);
  });

  it('applies in order with dependsOn: new worker → assign to the site → hazri (clientIds resolved)', async () => {
    const { auth } = await munshi();
    const dha = seeded().projects.dha.id;
    const worker = m('WORKER_CREATE', { name: 'Naveed Mazdoor', type: 'MAZDOOR', phone: '03001239876' });
    const assign = m('PROJECT_WORKER_ASSIGN', { projectId: dha, workerId: worker.clientId }, { dependsOn: [worker.clientId] });
    const hazri = m('ATTENDANCE_UPSERT', { projectId: dha, date: today(), entries: [{ workerId: worker.clientId, status: 'FULL' }] }, { dependsOn: [assign.clientId] });
    const r = await push(auth, [worker, assign, hazri]);
    expect(r.results.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    const created = await prismaAdmin.worker.findUniqueOrThrow({ where: { id: r.results[0]!.serverId! } });
    expect(created.name).toBe('Naveed Mazdoor');
    expect(await prismaAdmin.attendance.count({ where: { workerId: created.id, projectId: dha, status: 'FULL' } })).toBe(1);
  });

  it('business errors are REJECTED with their code; a rejected dependency rejects what depends on it', async () => {
    const s = seeded();
    const { auth } = await munshi();
    const dha = s.projects.dha.id;
    const gp140 = await prismaAdmin.dispatch.findFirstOrThrow({ where: { tenantId: s.malik.id, number: 'GP-0142' } });
    const shahid = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: s.malik.id, name: 'Shahid' } });
    const badWorker = m('WORKER_CREATE', { name: 'X', type: 'MAZDOOR' });
    const r = await push(auth, [
      m('CASH_EXPENSE_CREATE', { projectId: dha, category: 'OTHER', amountPaisa: '99900000', description: 'Too much' }),
      m('DISPATCH_RECEIVE', { dispatchId: gp140.id, items: [] }),
      m('ATTENDANCE_UPSERT', { projectId: dha, date: '2026-09-15', entries: [{ workerId: shahid.id, status: 'HALF' }] }),
      badWorker,
      m('PROJECT_WORKER_ASSIGN', { projectId: dha, workerId: badWorker.clientId }, { dependsOn: [badWorker.clientId] }),
    ]);
    expect(r.results.map((x) => (x.status === 'REJECTED' ? x.error!.code : x.status))).toEqual(['INSUFFICIENT_CASH', 'VALIDATION_ERROR', 'DATE_TOO_OLD', 'VALIDATION_ERROR', 'DEPENDENCY_REJECTED']);
    // The office may go further back, but an approved week stays locked.
    const pm = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    const locked = await push(pm, [m('ATTENDANCE_UPSERT', { projectId: dha, date: '2026-09-15', entries: [{ workerId: shahid.id, status: 'HALF' }] })]);
    expect(locked.results[0]!.error!.code).toBe('WEEK_LOCKED');
    // Rejections are remembered: sending the same mutation again gives the same answer.
    const again = await push(auth, [{ ...r.results[0], payload: {}, type: 'CASH_EXPENSE_CREATE', clientId: r.results[0]!.clientId }]);
    expect(again.results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'INSUFFICIENT_CASH' } });
  });

  it('a dispatch already received is REJECTED with ALREADY_RECEIVED', async () => {
    const s = seeded();
    const { auth } = await munshi();
    const gp142 = await prismaAdmin.dispatch.findFirstOrThrow({ where: { tenantId: s.malik.id, number: 'GP-0142' }, include: { items: true } });
    const r = await push(auth, [m('DISPATCH_RECEIVE', { dispatchId: gp142.id, items: gp142.items.map((i) => ({ materialId: i.materialId, receivedQty: 1 })) })]);
    expect(r.results[0]!.error!.code).toBe('ALREADY_RECEIVED');
  });

  it('permission parity with REST: a munshi cannot buy into the store or count the store', async () => {
    const s = seeded();
    const { auth } = await munshi();
    const store = await prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: s.malik.id, type: 'STORE' } });
    const supplier = await prismaAdmin.supplier.findFirstOrThrow({ where: { tenantId: s.malik.id } });
    const material = await prismaAdmin.material.findFirstOrThrow({ where: { tenantId: s.malik.id, name: 'Cement OPC' } });
    const photo = await prismaAdmin.attachment.create({ data: { tenantId: s.malik.id, kind: 'CHALLAN', storageKey: 'x/y.png', fileName: 'c.png', mimeType: 'image/png', sizeBytes: 10 } });
    const r = await push(auth, [
      m('SITE_PURCHASE_CREATE', { supplierId: supplier.id, deliverTo: 'STORE', challanNo: 'CH-1', purchaseDate: today(), paymentMode: 'UDHAAR', challanAttachmentId: photo.id, items: [{ materialId: material.id, challanQty: 10 }] }),
      m('STOCK_COUNT_CREATE', { locationId: store.id, items: [{ materialId: material.id, countedQty: 10 }] }),
    ]);
    expect(r.results.map((x) => x.error?.code)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
  });

  it('late sync (> 48 h after the phone made it) is flagged; pending count and rejections show in /sync/status', async () => {
    const { auth, deviceId } = await munshi();
    const dha = seeded().projects.dha.id;
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const r = await push(auth, [m('CASH_EXPENSE_CREATE', { projectId: dha, category: 'TEA_WATER', amountPaisa: '20000', description: 'Late chai' }, { deviceCreatedAt: old }), m('WORKER_CREATE', { name: 'Y', type: 'MAZDOOR' })], {
      'X-Pending-Mutations': '7',
    });
    const entryId = r.results[0]!.serverId!;
    const pulled = (await api().get('/api/v1/sync/pull').set(auth)).body.data.changes.cash_entries.upserts.find((e: { id: string }) => e.id === entryId);
    expect(pulled.lateSync).toBe(true);
    const device = await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: deviceId } });
    expect(device.pendingUploads).toBe(7);
    const st = (await api().get('/api/v1/sync/status').set(await owner())).body.data.find((d: { id: string }) => d.id === device.id);
    expect(st).toMatchObject({ pendingUploads: 7, user: { name: 'Rafaqat Ali' }, lastRejected: [expect.objectContaining({ type: 'WORKER_CREATE', code: 'VALIDATION_ERROR' })] });
    // The munshi sees only his own devices.
    const mine = (await api().get('/api/v1/sync/status').set(auth)).body.data;
    expect(mine.every((d: { user: { name: string } }) => d.user.name === 'Rafaqat Ali')).toBe(true);
  });
});
