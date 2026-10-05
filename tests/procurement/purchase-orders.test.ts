import { describe, expect, it } from 'vitest';
import { useFreshDatabase } from '../helpers.js';
import { api, attachment, materialId, munshi, owner, pm, supplierId } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  return {
    t,
    auth: await owner(),
    almadina: await supplierId(t, 'Al-Madina Cement Agency'),
    ittefaq: await supplierId(t, 'Ittefaq Steel Traders'),
    cement: await materialId(t, 'Cement OPC'),
    steel: await materialId(t, 'Steel Grade-60 #4'),
  };
}

describe('purchase orders', () => {
  it('creates PO-0001, then the status follows the linked purchases: OPEN → PARTLY_RECEIVED → RECEIVED', async () => {
    const s = await setup();
    const po = await api()
      .post('/api/v1/purchase-orders')
      .set(s.auth)
      .send({ supplierId: s.almadina, deliverTo: 'STORE', expectedDate: '2026-10-10', items: [{ materialId: s.cement, orderedQty: 600, ratePaisa: '142000' }] });
    expect(po.status, JSON.stringify(po.body).slice(0, 1500)).toBe(201);
    expect(po.body.data).toMatchObject({ number: 'PO-0001', status: 'OPEN', totalPaisa: '85200000', items: [{ orderedQty: 600, receivedQty: 0, pendingQty: 600 }] });

    const buy = async (qty: number) =>
      api()
        .post('/api/v1/purchases')
        .set(s.auth)
        .send({
          supplierId: s.almadina,
          deliverTo: 'STORE',
          purchaseOrderId: po.body.data.id,
          challanNo: `CH-${qty}`,
          purchaseDate: '2026-10-02',
          challanAttachmentId: await attachment(s.auth),
          items: [{ materialId: s.cement, challanQty: qty }],
        });
    const first = await buy(400);
    expect(first.status).toBe(201);
    // The PO rate (1,420) wins over the supplier's agreed rate (1,430)
    expect(first.body.data.items[0].ratePaisa).toBe('142000');
    expect((await api().get(`/api/v1/purchase-orders/${po.body.data.id}`).set(s.auth)).body.data).toMatchObject({
      status: 'PARTLY_RECEIVED',
      items: [{ receivedQty: 400, pendingQty: 200 }],
      purchases: [{ challanNo: 'CH-400' }],
    });

    await buy(200);
    expect((await api().get(`/api/v1/purchase-orders/${po.body.data.id}`).set(s.auth)).body.data.status).toBe('RECEIVED');
    // A received order takes no more purchases
    const closed = await buy(10);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('PO_CLOSED');
  });

  it('PATCH only while OPEN; cancel blocked once goods arrived; a cancelled order cannot be cancelled again', async () => {
    const s = await setup();
    const create = () =>
      api()
        .post('/api/v1/purchase-orders')
        .set(s.auth)
        .send({ supplierId: s.ittefaq, deliverTo: 'STORE', items: [{ materialId: s.steel, orderedQty: 3, ratePaisa: '28500000' }] });

    const a = (await create()).body.data;
    const edited = await api().patch(`/api/v1/purchase-orders/${a.id}`).set(s.auth).send({ items: [{ materialId: s.steel, orderedQty: 4, ratePaisa: '28000000' }], note: 'Rate agreed on phone' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ note: 'Rate agreed on phone', items: [{ orderedQty: 4, ratePaisa: '28000000' }] });

    await api()
      .post('/api/v1/purchases')
      .set(s.auth)
      .send({ supplierId: s.ittefaq, deliverTo: 'STORE', purchaseOrderId: a.id, challanNo: 'IT-1', purchaseDate: '2026-10-02', challanAttachmentId: await attachment(s.auth), items: [{ materialId: s.steel, challanQty: 1 }] })
      .expect(201);
    const blocked = await api().post(`/api/v1/purchase-orders/${a.id}/cancel`).set(s.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PURCHASE_ORDER_HAS_RECEIPTS');
    const locked = await api().patch(`/api/v1/purchase-orders/${a.id}`).set(s.auth).send({ note: 'x' });
    expect(locked.body.error.code).toBe('PURCHASE_ORDER_LOCKED');

    const b = (await create()).body.data;
    const cancelled = await api().post(`/api/v1/purchase-orders/${b.id}/cancel`).set(await pm());
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await api().post(`/api/v1/purchase-orders/${b.id}/cancel`).set(s.auth)).body.error.code).toBe('PURCHASE_ORDER_CANCELLED');
  });

  it('a PO for another supplier cannot be linked; MUNSHI has no access to purchase orders', async () => {
    const s = await setup();
    const po = await api()
      .post('/api/v1/purchase-orders')
      .set(s.auth)
      .send({ supplierId: s.ittefaq, deliverTo: 'STORE', items: [{ materialId: s.steel, orderedQty: 1, ratePaisa: '28500000' }] });
    const res = await api()
      .post('/api/v1/purchases')
      .set(s.auth)
      .send({ supplierId: s.almadina, deliverTo: 'STORE', purchaseOrderId: po.body.data.id, challanNo: 'X', purchaseDate: '2026-10-02', challanAttachmentId: await attachment(s.auth), items: [{ materialId: s.cement, challanQty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PO_SUPPLIER_MISMATCH');

    const m = await munshi(s.t);
    expect((await api().get('/api/v1/purchase-orders').set(m)).status).toBe(403);
  });
});
