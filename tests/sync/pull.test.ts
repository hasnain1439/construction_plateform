import { beforeEach, describe, expect, it } from 'vitest';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { serializeAssignment, serializeDispatch } from '../../src/modules/sync/sync.serializers.js';
import { bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { api } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  const s = seeded();
  const base = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects };
  await seedMalikInventory(prismaAdmin, base);
  await seedMalikLabor(prismaAdmin, { ...base, asifId: s.users.asif.id });
});

type Pull = { cursor: string; hasMore: boolean; resetRequired: boolean; changes: Record<string, { upserts: Array<Record<string, unknown>>; deletes: string[] }> };
const pull = async (auth: Record<string, string>, query: Record<string, string> = {}) => {
  const res = await api().get('/api/v1/sync/pull').set(auth).query(query);
  if (res.status !== 200) throw new Error(`pull ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as Pull;
};
const munshi = async () => {
  const s = await loginMunshi(seeded().malik.id);
  return { auth: bearer(s.accessToken), deviceId: s.deviceId };
};

/** Every key anywhere in the payload. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (out.add(k), keys(v, out));
  return out;
}
const FORBIDDEN = /^(ratePaisa|valuePaisa|unitCostPaisa|contractValuePaisa|totalPaisa|paidNowPaisa|ratePerSqftPaisa|udhaarBalancePaisa|amount|rates?|value|cost.*|contract.*|retentionPercent|phone_supplier)$/;

describe('GET /sync/pull — snapshot', () => {
  it('MUNSHI: only his project, no rate / value / contract field anywhere; wages and own cash are there', async () => {
    const { auth } = await munshi();
    const d = await pull(auth);
    expect(d.resetRequired).toBe(false);
    expect(BigInt(d.cursor)).toBeGreaterThan(0n);
    const bad = [...keys(d.changes)].filter((k) => FORBIDDEN.test(k));
    expect(bad).toEqual([]);
    const dha = seeded().projects.dha.id;
    expect(d.changes['projects']!.upserts.map((p) => p['id'])).toEqual([dha]);
    for (const t of ['attendance', 'settlements', 'advances', 'work_measurements', 'daily_logs', 'material_usage', 'owner_deliveries', 'project_workers', 'subcontract_assignments']) {
      expect(d.changes[t]!.upserts.every((r) => r['projectId'] === dha), t).toBe(true);
    }
    expect(d.changes['dispatches']!.upserts.every((r) => r['projectId'] === dha)).toBe(true);
    expect(d.changes['attendance']!.upserts.length).toBeGreaterThan(10);
    expect(d.changes['workers']!.upserts[0]).toHaveProperty('dailyRatePaisa');
    expect(d.changes['cash_accounts']!.upserts).toEqual([expect.objectContaining({ balancePaisa: '930000' })]);
    expect(d.changes['suppliers']!.upserts.every((s) => Object.keys(s).sort().join() === 'id,name')).toBe(true);
    expect(d.changes['settings']!.upserts[0]).toMatchObject({ blindCountEnabled: true, kharchaApprovalLimitPaisa: '2500000' });
    expect(d.changes['site_stock']!.upserts.length).toBeGreaterThan(0);
  });

  it('blind count: a munshi does not see sent quantities on the way; the PM does', async () => {
    const { auth } = await munshi();
    const gp144 = (await pull(auth)).changes['dispatches']!.upserts.find((x) => x['number'] === 'GP-0144')!;
    expect(gp144['blindCount']).toBe(true);
    expect((gp144['items'] as Array<Record<string, unknown>>).every((i) => !('sentQty' in i))).toBe(true);
    const pm = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    const seen = (await pull(pm)).changes['dispatches']!.upserts.find((x) => x['number'] === 'GP-0144')!;
    expect((seen['items'] as Array<Record<string, unknown>>)[0]).toHaveProperty('sentQty');
    expect(seen['blindCount']).toBe(false);
  });
});

describe('GET /sync/pull — incremental', () => {
  it('pages changes after the cursor (hasMore), sends tombstones for deletes', async () => {
    const s = seeded();
    const { auth } = await munshi();
    const first = await pull(auth);
    const worker = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: s.malik.id, name: 'Shahid' } });
    const ids = [];
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      const row = await prismaAdmin.attendance.upsert({
        where: { projectId_workerId_date: { projectId: s.projects.dha.id, workerId: worker.id, date: new Date(d) } },
        create: { tenantId: s.malik.id, projectId: s.projects.dha.id, workerId: worker.id, date: new Date(d), status: 'HALF' },
        update: { status: 'HALF' },
      });
      ids.push(row.id);
    }
    // Another project's change never reaches him.
    const asifWorker = await prismaAdmin.projectWorker.findFirstOrThrow({ where: { tenantId: s.malik.id, projectId: s.projects.bahria.id } }).catch(() => null);
    if (asifWorker) await prismaAdmin.attendance.create({ data: { tenantId: s.malik.id, projectId: s.projects.bahria.id, workerId: asifWorker.workerId, date: new Date('2026-10-04'), status: 'FULL' } });

    const page1 = await pull(auth, { cursor: first.cursor, limit: '2' });
    expect(page1.hasMore).toBe(true);
    const page2 = await pull(auth, { cursor: page1.cursor, limit: '2' });
    expect(page2.hasMore).toBe(false);
    const got = [...(page1.changes['attendance']?.upserts ?? []), ...(page2.changes['attendance']?.upserts ?? [])];
    expect(got.map((r) => r['id']).sort()).toEqual([...ids].sort());
    expect(got.every((r) => r['status'] === 'HALF' && r['projectId'] === s.projects.dha.id)).toBe(true);

    await prismaAdmin.attendance.delete({ where: { id: ids[0]! } });
    const page3 = await pull(auth, { cursor: page2.cursor });
    expect(page3.changes['attendance']).toEqual({ upserts: [], deletes: [ids[0]] });
    expect((await pull(auth, { cursor: page3.cursor })).changes).toEqual({});
  });

  it('resetRequired after retention pruned past the cursor, or when his project access changed', async () => {
    const s = seeded();
    const { auth } = await munshi();
    const first = await pull(auth);
    await prismaAdmin.syncWatermark.upsert({ where: { id: 1 }, create: { id: 1, prunedThroughSeq: BigInt(first.cursor) + 1n }, update: { prunedThroughSeq: BigInt(first.cursor) + 1n } });
    expect((await pull(auth, { cursor: first.cursor })).resetRequired).toBe(true);
    await prismaAdmin.syncWatermark.update({ where: { id: 1 }, data: { prunedThroughSeq: 0n } });
    await prismaAdmin.userProjectAccess.create({ data: { tenantId: s.malik.id, userId: s.users.rafaqatMalik.id, projectId: s.projects.johar.id } });
    expect((await pull(auth, { cursor: first.cursor })).resetRequired).toBe(true);
    const fresh = await pull(auth);
    expect(fresh.changes['projects']!.upserts.map((p) => p['id']).sort()).toEqual([s.projects.dha.id, s.projects.johar.id].sort());
  });

  it('a revoked device gets 401 DEVICE_REVOKED; lastSyncAt is recorded', async () => {
    const { auth, deviceId } = await munshi();
    await pull(auth);
    const device = await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: deviceId } });
    expect(device.lastSyncAt).not.toBeNull();
    await prismaAdmin.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    const res = await api().get('/api/v1/sync/pull').set(auth);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
  });
});

describe('sync serializers', () => {
  const viewer = (role: 'MUNSHI' | 'PM', blindCount = true) => ({ userId: 'u', role, blindCount });
  it('sub-contract rates only for the office; dispatch quantities hidden from a munshi while on the way', () => {
    const asg = {
      id: 'a',
      projectId: 'p',
      scope: 'Slab',
      rateType: 'PER_SQFT',
      ratePaisa: 4500n,
      contractValuePaisa: null,
      retentionPercent: 5,
      progressPercent: 0,
      startDate: new Date('2026-09-01'),
      isActive: true,
      subcontractor: { id: 's', name: 'Sharif', trade: 'SHUTTERING' },
    };
    expect(serializeAssignment(asg, viewer('MUNSHI'))).not.toHaveProperty('ratePaisa');
    expect(serializeAssignment(asg, viewer('MUNSHI'))).toMatchObject({ unit: 'sqft' });
    expect(serializeAssignment(asg, viewer('PM'))).toMatchObject({ ratePaisa: '4500' });
    const d = {
      id: 'd',
      number: 'GP-1',
      status: 'ON_THE_WAY',
      toLocationId: 'l',
      fromLocation: { name: 'Store' },
      toLocation: { projectId: 'p' },
      vehicleNo: null,
      driverName: null,
      driverPhone: null,
      dispatchedAt: new Date(),
      receivedAt: null,
      items: [{ id: 'i', materialId: 'm', sentQty: 10, receivedQty: null, damagedQty: null, note: null }],
    };
    expect(serializeDispatch(d, viewer('MUNSHI')).items[0]).not.toHaveProperty('sentQty');
    expect(serializeDispatch(d, viewer('MUNSHI', false)).items[0]).toHaveProperty('sentQty', 10);
    expect(serializeDispatch({ ...d, status: 'RECEIVED' }, viewer('MUNSHI')).items[0]).toHaveProperty('sentQty', 10);
  });
});
