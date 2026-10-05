import { describe, expect, it } from 'vitest';
import { nextNumber } from '../../src/core/db/counters.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { avgOf, balanceOf, D, postOut, valueOf } from '../../src/modules/inventory/stock.js';
import { useFreshDatabase } from '../helpers.js';
import { api, materialId, munshi, owner, pm, siteOf, stockIn, storeOf } from './fixtures.js';

const seeded = useFreshDatabase();

describe('stock ledger maths', () => {
  it('value = qty × rate rounded half-up; average = value ÷ qty', () => {
    expect(valueOf(D('2.5'), 143000n)).toBe(357500n);
    expect(valueOf(D('0.333'), 100n)).toBe(33n);
    expect(avgOf(D(600), 87200000n)).toBe(145333n);
    expect(avgOf(D(0), 5n)).toBe(0n);
  });

  it('400 @ 1,430 + 200 @ 1,500 → weighted average 1,453.33; going out keeps the average; the last bag takes the rest', async () => {
    const t = seeded().malik.id;
    const { store } = await storeOf(t);
    const cement = await materialId(t, 'Cement OPC');
    await stockIn(t, store.id, cement, 200, 150000n);
    await stockIn(t, store.id, cement, 400, 143000n);

    const bucket = { locationId: store.id, materialId: cement, ownerSupplied: false };
    const before = await balanceOf(prismaAdmin, t, bucket);
    expect(before.qty.toNumber()).toBe(600);
    expect(before.value).toBe(87200000n);
    expect(avgOf(before.qty, before.value)).toBe(145333n); // Rs 1,453.33

    const ref = { type: 'DISPATCH_OUT' as const, refType: 'TEST', refId: uuidv7(), occurredAt: new Date(), createdById: null };
    const out = await prismaAdmin.$transaction((tx) => postOut(tx, t, bucket, D(100), ref));
    expect(out.valuePaisa).toBe(14533333n);
    const after = await balanceOf(prismaAdmin, t, bucket);
    expect(after.qty.toNumber()).toBe(500);
    expect(avgOf(after.qty, after.value)).toBe(145333n);

    const rest = await prismaAdmin.$transaction((tx) => postOut(tx, t, bucket, D(500), ref));
    expect(rest.valuePaisa).toBe(after.value);
    const empty = await balanceOf(prismaAdmin, t, bucket);
    expect(empty.qty.toNumber()).toBe(0);
    expect(empty.value).toBe(0n);

    await expect(prismaAdmin.$transaction((tx) => postOut(tx, t, bucket, D(1), ref))).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('the store stock API shows quantity, average, value and the movement log', async () => {
    const t = seeded().malik.id;
    const { store } = await storeOf(t);
    const cement = await materialId(t, 'Cement OPC');
    await stockIn(t, store.id, cement, 400, 143000n);
    await stockIn(t, store.id, cement, 200, 150000n);

    const auth = await owner();
    const res = await api().get(`/api/v1/stores/${store.id}/stock`).set(auth);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((i: { material: { id: string } }) => i.material.id === cement);
    expect(row).toMatchObject({ inStore: 600, inTransit: 0, avgRatePaisa: '145333', valuePaisa: '87200000', lowStock: false, minQty: null });
    expect(res.body.data.summary).toMatchObject({ totalValuePaisa: '87200000', materials: 1, lowStockCount: 0, dispatchesOnTheWay: 0 });

    const log = await api().get(`/api/v1/stock/movements?locationId=${store.id}&materialId=${cement}`).set(await pm());
    expect(log.status).toBe(200);
    expect(log.body.meta.total).toBe(2);
    expect(log.body.data[0]).toMatchObject({ type: 'PURCHASE_IN', quantity: 200, unitCostPaisa: '150000', valuePaisa: '30000000' });
  });

  it('owner-supplied stock is a separate bucket at cost 0 and never moves the average', async () => {
    const t = seeded().malik.id;
    const site = await siteOf(t, seeded().projects.dha.id);
    const bricks = await materialId(t, 'Clay bricks Class-1');
    await stockIn(t, site.id, bricks, 1000, 1700n);
    await stockIn(t, site.id, bricks, 5000, 1900n, true);

    const res = await api().get(`/api/v1/projects/${seeded().projects.dha.id}/stock`).set(await owner());
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({
      material: { id: bricks },
      receivedContractor: 1000,
      receivedOwner: 5000,
      inStock: 6000,
      inStockContractor: 1000,
      inStockOwner: 5000,
      avgRatePaisa: '1700',
      valuePaisa: '1700000',
    });
    expect(res.body.data.summary.totalValuePaisa).toBe('1700000');
  });

  it('MUNSHI sees site stock without any value fields, only their sites, and no store', async () => {
    const t = seeded().malik.id;
    const site = await siteOf(t, seeded().projects.dha.id);
    const cement = await materialId(t, 'Cement OPC');
    await stockIn(t, site.id, cement, 50, 145000n);
    const auth = await munshi(t);

    const stock = await api().get(`/api/v1/projects/${seeded().projects.dha.id}/stock`).set(auth);
    expect(stock.status).toBe(200);
    expect(stock.body.data.items[0]).toMatchObject({ inStock: 50 });
    expect(stock.body.data.items[0]).not.toHaveProperty('avgRatePaisa');
    expect(stock.body.data.items[0]).not.toHaveProperty('valuePaisa');
    expect(stock.body.data.summary).not.toHaveProperty('totalValuePaisa');

    const locations = await api().get('/api/v1/stock-locations').set(auth);
    expect(locations.body.data.map((l: { type: string }) => l.type)).toEqual(['SITE']);
    expect(locations.body.data[0].projectId).toBe(seeded().projects.dha.id);

    const { store } = await storeOf(t);
    expect((await api().get(`/api/v1/stores/${store.id}/stock`).set(auth)).status).toBe(403);
    expect((await api().get('/api/v1/stock/movements').set(auth)).status).toBe(403);
    // Bahria is not Rafaqat's project → 404
    expect((await api().get(`/api/v1/projects/${seeded().projects.bahria.id}/stock`).set(auth)).status).toBe(404);
  });

  it('THEKEDAR sets low-stock levels (0 removes one); PM cannot', async () => {
    const t = seeded().malik.id;
    const { store } = await storeOf(t);
    const cement = await materialId(t, 'Cement OPC');
    const sand = await materialId(t, 'Chenab sand');
    await stockIn(t, store.id, cement, 150, 143000n);

    const auth = await owner();
    const put = await api()
      .put(`/api/v1/stores/${store.id}/low-stock-levels`)
      .set(auth)
      .send([
        { materialId: cement, minQty: 200 },
        { materialId: sand, minQty: 500 },
      ]);
    expect(put.status).toBe(200);
    expect(put.body.data).toHaveLength(2);

    const stock = await api().get(`/api/v1/stores/${store.id}/stock?lowStockOnly=true`).set(auth);
    expect(stock.body.data.summary.lowStockCount).toBe(2);
    expect(stock.body.data.items.map((i: { material: { name: string }; lowStock: boolean }) => [i.material.name, i.lowStock])).toEqual([
      ['Cement OPC', true],
      ['Chenab sand', true],
    ]);

    const removed = await api().put(`/api/v1/stores/${store.id}/low-stock-levels`).set(auth).send([{ materialId: sand, minQty: 0 }]);
    expect(removed.body.data.map((l: { material: { name: string } }) => l.material.name)).toEqual(['Cement OPC']);

    expect((await api().put(`/api/v1/stores/${store.id}/low-stock-levels`).set(await pm()).send([{ materialId: cement, minQty: 1 }])).status).toBe(403);
  });

  it('every company has a Central Store and a transit location; non-draft projects get a site', async () => {
    const auth = await owner();
    const res = await api().get('/api/v1/stock-locations').set(auth);
    expect(res.status).toBe(200);
    const types = res.body.data.map((l: { type: string }) => l.type);
    expect(types.filter((x: string) => x === 'STORE')).toHaveLength(1);
    expect(types.filter((x: string) => x === 'TRANSIT')).toHaveLength(1);
    const sites = res.body.data.filter((l: { type: string }) => l.type === 'SITE').map((l: { project: { code: string } }) => l.project.code);
    expect(sites.sort()).toEqual(['MSB-2025-031', 'MSB-2026-008', 'MSB-2026-012', 'MSB-2026-014']); // not the Model Town draft
  });

  it('number series are gap-free per company and roll over per year', async () => {
    const t = seeded().malik.id;
    const numbers = await prismaAdmin.$transaction(async (tx) => [
      await nextNumber(tx, t, 'GP-####'),
      await nextNumber(tx, t, 'GP-####'),
      await nextNumber(tx, t, 'PUR-{YYYY}-####', new Date('2026-06-01T00:00:00Z')),
      await nextNumber(tx, t, 'PUR-{YYYY}-####', new Date('2027-01-05T00:00:00Z')),
    ]);
    expect(numbers).toEqual(['GP-0001', 'GP-0002', 'PUR-2026-0001', 'PUR-2027-0001']);
    // A rolled-back document gives its number back
    await prismaAdmin
      .$transaction(async (tx) => {
        await nextNumber(tx, t, 'GP-####');
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await prismaAdmin.$transaction((tx) => nextNumber(tx, t, 'GP-####'))).toBe('GP-0003');
  });
});
