import { describe, expect, it } from 'vitest';
import { todayIn } from '../../src/core/utils/dates.js';
import { useFreshDatabase } from '../helpers.js';
import { api, materialId, munshi, owner, pm, siteOf, stockIn, storeOf } from './fixtures.js';

const seeded = useFreshDatabase();
const today = () => todayIn('Asia/Karachi');

async function setup() {
  const t = seeded().malik.id;
  const dha = seeded().projects.dha.id;
  const site = await siteOf(t, dha);
  const cement = await materialId(t, 'Cement OPC');
  const tiles = await materialId(t, 'Floor tiles');
  await stockIn(t, site.id, cement, 100, 145000n);
  await stockIn(t, site.id, tiles, 500, 0n, true);
  return { t, dha, site, cement, tiles };
}

describe('material usage', () => {
  it('MUNSHI records usage at average cost (no values shown); over the balance → 400 INSUFFICIENT_STOCK', async () => {
    const s = await setup();
    const m = await munshi(s.t);
    const over = await api().post(`/api/v1/projects/${s.dha}/material-usage`).set(m).send({ usageDate: today(), items: [{ materialId: s.cement, qty: 101 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { materialId: s.cement, available: 100 } });

    const res = await api()
      .post(`/api/v1/projects/${s.dha}/material-usage`)
      .set(m)
      .send({ usageDate: today(), items: [{ materialId: s.cement, qty: 20 }, { materialId: s.tiles, qty: 150 }], note: 'Roof slab' });
    expect(res.status).toBe(201);
    expect(res.body.data.items).toEqual([
      { material: expect.objectContaining({ id: s.cement }), qty: 20, ownerSupplied: false },
      { material: expect.objectContaining({ id: s.tiles }), qty: 150, ownerSupplied: true }, // DHA finishing is owner-supplied
    ]);

    const office = await api().get(`/api/v1/projects/${s.dha}/material-usage`).set(await owner());
    expect(office.body.data[0]).toMatchObject({ note: 'Roof slab', totalValuePaisa: '2900000', items: [{ valuePaisa: '2900000' }, { valuePaisa: '0' }] });
    const stock = await api().get(`/api/v1/projects/${s.dha}/stock`).set(await owner());
    expect(stock.body.data.items.find((i: { material: { id: string } }) => i.material.id === s.cement)).toMatchObject({ used: 20, inStock: 80 });

    const future = await api().post(`/api/v1/projects/${s.dha}/material-usage`).set(m).send({ usageDate: '2099-01-01', items: [{ materialId: s.cement, qty: 1 }] });
    expect(future.body.error.code).toBe('DATE_IN_FUTURE');
    // Bahria is not Rafaqat's site
    expect((await api().post(`/api/v1/projects/${seeded().projects.bahria.id}/material-usage`).set(m).send({ usageDate: today(), items: [{ materialId: s.cement, qty: 1 }] })).status).toBe(404);
  });
});

describe('stock counts', () => {
  it('system quantity from the ledger; a difference needs a reason and becomes a COUNT_ADJUSTMENT', async () => {
    const s = await setup();
    const m = await munshi(s.t);
    const noReason = await api().post('/api/v1/stock-counts').set(m).send({ locationId: s.site.id, items: [{ materialId: s.cement, countedQty: 96 }] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatchObject({ code: 'REASON_REQUIRED', details: { systemQty: 100, countedQty: 96 } });

    const res = await api()
      .post('/api/v1/stock-counts')
      .set(m)
      .send({ locationId: s.site.id, items: [{ materialId: s.cement, countedQty: 96, reason: 'HARDENED_IN_RAIN', note: 'Left open' }, { materialId: s.tiles, countedQty: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'SC-0001',
      items: [
        { systemQty: 100, countedQty: 96, difference: -4, reason: 'HARDENED_IN_RAIN' },
        { systemQty: 500, countedQty: 500, difference: 0, reason: null, ownerSupplied: true },
      ],
      summary: { materials: 2, withDifference: 1 },
    });
    expect(res.body.data.items[0]).not.toHaveProperty('valuePaisa');

    const stock = await api().get(`/api/v1/projects/${s.dha}/stock`).set(await owner());
    const cement = stock.body.data.items.find((i: { material: { id: string } }) => i.material.id === s.cement);
    expect(cement).toMatchObject({ inStock: 96, adjustments: -4, valuePaisa: '13920000', lastCountAt: expect.any(String) });

    const list = await api().get(`/api/v1/stock-counts?projectId=${s.dha}`).set(await pm());
    expect(list.body.data[0]).toMatchObject({ number: 'SC-0001', summary: { differenceValuePaisa: '-580000' } });
  });

  it('a surplus is valued at the current average; MUNSHI and PM cannot count the store', async () => {
    const t = seeded().malik.id;
    const { store } = await storeOf(t);
    const cement = await materialId(t, 'Cement OPC');
    await stockIn(t, store.id, cement, 10, 150000n);
    const body = { locationId: store.id, items: [{ materialId: cement, countedQty: 12, reason: 'MEASUREMENT' }] };
    expect((await api().post('/api/v1/stock-counts').set(await munshi(t)).send(body)).status).toBe(403);
    expect((await api().post('/api/v1/stock-counts').set(await pm()).send(body)).status).toBe(403);

    const res = await api().post('/api/v1/stock-counts').set(await owner()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.items[0]).toMatchObject({ difference: 2, valuePaisa: '300000' });
  });
});
