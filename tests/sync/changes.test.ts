import { describe, expect, it } from 'vitest';
import { runSyncRetention } from '../../src/jobs/syncRetention.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();

const changes = (where: Record<string, unknown> = {}) => prismaAdmin.syncChange.findMany({ where, orderBy: { seq: 'asc' } });

describe('SyncChange triggers', () => {
  it('record insert / update / delete with project and user; child rows count as an update of the parent', async () => {
    const s = seeded();
    const t = s.malik.id;
    const dha = s.projects.dha.id;
    const before = (await prismaAdmin.syncChange.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
    const worker = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: t, name: 'Shahid' } });
    const att = await prismaAdmin.attendance.create({ data: { tenantId: t, projectId: dha, workerId: worker.id, date: new Date('2026-10-05'), status: 'FULL' } });
    await prismaAdmin.attendance.update({ where: { id: att.id }, data: { status: 'HALF' } });
    await prismaAdmin.attendance.delete({ where: { id: att.id } });
    const rows = await changes({ seq: { gt: before }, tableName: 'Attendance' });
    expect(rows.map((r) => r.op)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(rows.every((r) => r.rowId === att.id && r.projectId === dha && r.tenantId === t)).toBe(true);

    const acc = await prismaAdmin.cashAccount.create({ data: { tenantId: t, holderUserId: s.users.rafaqatMalik.id, name: 'Rafaqat' } });
    expect((await changes({ tableName: 'CashAccount', rowId: acc.id }))[0]).toMatchObject({ op: 'INSERT', userId: s.users.rafaqatMalik.id });

    // A usage item → MaterialUsage UPDATE (the phone re-reads the whole usage with its items).
    const site = await prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: t, projectId: dha } }).catch(async () =>
      prismaAdmin.stockLocation.create({ data: { tenantId: t, type: 'SITE', name: 'DHA', projectId: dha } }),
    );
    const material = await prismaAdmin.material.findFirstOrThrow({ where: { tenantId: t } });
    const usage = await prismaAdmin.materialUsage.create({ data: { tenantId: t, projectId: dha, locationId: site.id, usageDate: new Date('2026-10-05') } });
    await prismaAdmin.materialUsageItem.create({ data: { tenantId: t, usageId: usage.id, materialId: material.id, qty: 5, valuePaisa: 0n } });
    expect((await changes({ tableName: 'MaterialUsage', rowId: usage.id })).map((r) => r.op)).toEqual(['INSERT', 'UPDATE']);

    // Stock movements are tracked per location as the virtual site_stock table.
    await prismaAdmin.stockMovement.create({ data: { tenantId: t, locationId: site.id, materialId: material.id, quantity: 10, unitCostPaisa: 0n, valuePaisa: 0n, type: 'RECEIPT_IN', refType: 'TEST', refId: usage.id, occurredAt: new Date() } });
    expect(await changes({ tableName: 'SiteStock', rowId: site.id })).toHaveLength(1);
  });

  it('RLS: a company reads only its own changes; app_user cannot write them', async () => {
    const s = seeded();
    await prismaAdmin.worker.create({ data: { tenantId: s.ahmed.id, name: 'Ahmed worker', type: 'MAZDOOR', dailyRatePaisa: 150000n } });
    const visible = await withTenant(s.malik.id, (tx) => tx.syncChange.findMany());
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.tenantId === s.malik.id)).toBe(true);
    await expect(
      withTenant(s.malik.id, (tx) => tx.syncChange.create({ data: { tenantId: s.malik.id, tableName: 'Worker', rowId: s.malik.id, op: 'INSERT' } })),
    ).rejects.toThrow();
  });
});

describe('sync retention', () => {
  it('drops changes older than 30 days and raises the watermark', async () => {
    const s = seeded();
    await prismaAdmin.worker.create({ data: { tenantId: s.malik.id, name: 'Old change', type: 'MAZDOOR', dailyRatePaisa: 150000n } });
    const all = await changes();
    const max = all.at(-1)!.seq;
    await prismaAdmin.syncChange.updateMany({ where: { seq: { lte: max } }, data: { changedAt: new Date(Date.now() - 31 * 86_400_000) } });
    await prismaAdmin.worker.create({ data: { tenantId: s.malik.id, name: 'New change', type: 'MAZDOOR', dailyRatePaisa: 150000n } });
    const r = await runSyncRetention();
    expect(r.deleted).toBe(all.length);
    expect(r.prunedThroughSeq).toBe(max.toString());
    expect(await prismaAdmin.syncChange.count()).toBe(1);
    expect((await runSyncRetention()).deleted).toBe(0);
  });
});
