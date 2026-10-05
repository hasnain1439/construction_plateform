import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, attachment, materialId, munshi, owner, pm, siteOf, storeOf, supplierId, type Auth } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  return {
    t,
    auth: await owner(),
    almadina: await supplierId(t, 'Al-Madina Cement Agency'),
    ittefaq: await supplierId(t, 'Ittefaq Steel Traders'),
    chaudhry: await supplierId(t, 'Chaudhry Bricks Kiln'),
    cement: await materialId(t, 'Cement OPC'),
    steel: await materialId(t, 'Steel Grade-60 #4'),
    bricks: await materialId(t, 'Clay bricks Class-1'),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function storePurchase(s: Setup, auth: Auth, body: Record<string, unknown>) {
  return api()
    .post('/api/v1/purchases')
    .set(auth)
    .send({ deliverTo: 'STORE', purchaseDate: '2026-10-02', challanAttachmentId: await attachment(auth), ...body });
}

const balance = async (auth: Auth, supplier: string) => (await api().get(`/api/v1/suppliers/${supplier}`).set(auth)).body.data;

describe('purchases', () => {
  it('store purchase on udhaar: PUR number, stock in at the rate, supplier balance up; locked', async () => {
    const s = await setup();
    const res = await storePurchase(s, s.auth, { supplierId: s.almadina, challanNo: 'CH-2231', vehicleNo: 'LES-4521', items: [{ materialId: s.cement, challanQty: 400 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: expect.stringMatching(/^PUR-2026-0001$/),
      status: 'SAVED',
      locked: true,
      paymentMode: 'UDHAAR',
      totalPaisa: '57200000', // 400 × Rs 1,430 (agreed rate)
      udhaarAddedPaisa: '57200000',
      items: [{ challanQty: 400, countedQty: 400, goodQty: 400, ratePaisa: '143000', amountPaisa: '57200000' }],
      ledgerEffect: [{ type: 'PURCHASE', amountPaisa: '57200000' }],
    });
    expect(res.body.data.challan.url).toContain('/attachments/');

    const { store } = await storeOf(s.t);
    const stock = await api().get(`/api/v1/stores/${store.id}/stock`).set(s.auth);
    expect(stock.body.data.items[0]).toMatchObject({ inStore: 400, avgRatePaisa: '143000', lastPurchaseAt: expect.any(String) });

    expect(await balance(s.auth, s.almadina)).toMatchObject({ udhaarBalancePaisa: '57200000', oldestUnpaidDays: expect.any(Number) });
    const list = await api().get(`/api/v1/purchases?supplierId=${s.almadina}`).set(await pm());
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.totalPaisa).toBe('57200000');
  });

  it('PARTIAL: bill on the ledger, part payment recorded; paid must be between 0 and the bill', async () => {
    const s = await setup();
    const res = await storePurchase(s, s.auth, {
      supplierId: s.ittefaq,
      challanNo: 'IT-8812',
      paymentMode: 'PARTIAL',
      paidNowPaisa: '20000000',
      paidFrom: 'BANK',
      items: [{ materialId: s.steel, challanQty: 2, ratePaisa: '28500000' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ totalPaisa: '57000000', paidNowPaisa: '20000000', udhaarAddedPaisa: '37000000', payments: [{ method: 'BANK', amountPaisa: '20000000' }] });
    expect((await balance(s.auth, s.ittefaq)).udhaarBalancePaisa).toBe('37000000');

    const ledger = await api().get(`/api/v1/suppliers/${s.ittefaq}/ledger`).set(s.auth);
    expect(ledger.body.data.entries.map((e: { type: string; runningBalancePaisa: string }) => [e.type, e.runningBalancePaisa])).toEqual([
      ['PAYMENT', '37000000'],
      ['PURCHASE', '57000000'],
    ]);

    const tooMuch = await storePurchase(s, s.auth, { supplierId: s.ittefaq, challanNo: 'IT-1', paymentMode: 'PARTIAL', paidNowPaisa: '57000000', paidFrom: 'BANK', items: [{ materialId: s.steel, challanQty: 2, ratePaisa: '28500000' }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe('INVALID_PAID_AMOUNT');
    const noRate = await storePurchase(s, s.auth, { supplierId: s.ittefaq, challanNo: 'IT-2', items: [{ materialId: s.steel, challanQty: 1 }] });
    expect(noRate.body.error.code).toBe('RATE_REQUIRED');
    const noChallan = await api().post('/api/v1/purchases').set(s.auth).send({ supplierId: s.almadina, deliverTo: 'STORE', purchaseDate: '2026-10-02', challanNo: 'Z', challanAttachmentId: await attachment(s.auth, 'SITE_PHOTO'), items: [{ materialId: s.cement, challanQty: 1 }] });
    expect(noChallan.body.error.code).toBe('CHALLAN_REQUIRED');
  });

  it('counted less than the challan needs a note; then SUPPLIER_SHORT / DAMAGED shortages are created and only good bags enter stock', async () => {
    const s = await setup();
    const items = [{ materialId: s.cement, challanQty: 200, countedQty: 196, damagedQty: 2 }];
    const noNote = await storePurchase(s, s.auth, { supplierId: s.almadina, challanNo: 'CH-1', items });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error).toMatchObject({ code: 'SHORTAGE_NOTE_REQUIRED', details: { materialId: s.cement, challanQty: 200, goodQty: 194 } });

    const res = await storePurchase(s, s.auth, { supplierId: s.almadina, challanNo: 'CH-1', items: [{ ...items[0], note: '4 missing, 2 torn' }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      totalPaisa: '28600000', // the bill: 200 × 1,430
      items: [{ goodQty: 194, shortQty: 6, amountPaisa: '27742000' }],
    });
    expect(res.body.data.shortages.map((x: { kind: string; qty: number; valuePaisa: string }) => [x.kind, x.qty, x.valuePaisa])).toEqual([
      ['SUPPLIER_SHORT', 4, '572000'],
      ['DAMAGED', 2, '286000'],
    ]);
    const { store } = await storeOf(s.t);
    const stock = await api().get(`/api/v1/stores/${store.id}/stock`).set(s.auth);
    expect(stock.body.data.items[0].inStore).toBe(194);
  });

  it('MUNSHI records a site purchase without rates → PENDING_RATE (no amounts shown); the office adds rates → ledger + stock value', async () => {
    const s = await setup();
    const dha = seeded().projects.dha.id;
    const m = await munshi(s.t);
    const withRate = await api()
      .post('/api/v1/purchases')
      .set(m)
      .send({ supplierId: s.chaudhry, deliverTo: 'SITE', projectId: dha, challanNo: 'CB-77', purchaseDate: '2026-10-03', challanAttachmentId: await attachment(m), items: [{ materialId: s.bricks, challanQty: 1000, ratePaisa: '1700' }] });
    expect(withRate.body.error.code).toBe('RATES_NOT_ALLOWED');
    const toStore = await api()
      .post('/api/v1/purchases')
      .set(m)
      .send({ supplierId: s.chaudhry, deliverTo: 'STORE', challanNo: 'CB-77', purchaseDate: '2026-10-03', challanAttachmentId: await attachment(m), items: [{ materialId: s.bricks, challanQty: 1000 }] });
    expect(toStore.status).toBe(403);

    const res = await api()
      .post('/api/v1/purchases')
      .set(m)
      .send({ supplierId: s.chaudhry, deliverTo: 'SITE', projectId: dha, challanNo: 'CB-77', purchaseDate: '2026-10-03', challanAttachmentId: await attachment(m), items: [{ materialId: s.bricks, challanQty: 1000 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING_RATE', items: [{ challanQty: 1000, countedQty: 1000 }] });
    expect(res.body.data).not.toHaveProperty('totalPaisa');
    expect(res.body.data.items[0]).not.toHaveProperty('ratePaisa');
    expect((await balance(s.auth, s.chaudhry)).udhaarBalancePaisa).toBe('0');

    // The bricks are on site already (at cost 0 until priced)
    const before = await api().get(`/api/v1/projects/${dha}/stock`).set(s.auth);
    expect(before.body.data.items[0]).toMatchObject({ inStock: 1000, valuePaisa: '0' });

    const priced = await api().patch(`/api/v1/purchases/${res.body.data.id}/rates`).set(await pm()).send({ items: [{ materialId: s.bricks, ratePaisa: '1700' }] });
    expect(priced.status).toBe(200);
    expect(priced.body.data).toMatchObject({ status: 'RECEIVED', totalPaisa: '1700000', items: [{ ratePaisa: '1700', amountPaisa: '1700000' }] });
    expect((await balance(s.auth, s.chaudhry)).udhaarBalancePaisa).toBe('1700000');
    const after = await api().get(`/api/v1/projects/${dha}/stock`).set(s.auth);
    expect(after.body.data.items[0]).toMatchObject({ inStock: 1000, avgRatePaisa: '1700', valuePaisa: '1700000' });
    expect((await api().patch(`/api/v1/purchases/${res.body.data.id}/rates`).set(s.auth).send({ items: [{ materialId: s.bricks, ratePaisa: '1700' }] })).body.error.code).toBe('RATES_ALREADY_SET');
  });

  it('returns: credit at purchase rate; more than the stock → 400 RETURN_EXCEEDS_STOCK; more than bought → 400', async () => {
    const s = await setup();
    const buy = await storePurchase(s, s.auth, { supplierId: s.almadina, challanNo: 'CH-9', items: [{ materialId: s.cement, challanQty: 100 }] });
    const id = buy.body.data.id;
    // 95 of the 100 bags leave the store
    const { store } = await storeOf(s.t);
    await prismaAdmin.$transaction(async (tx) => {
      const { postOut, D } = await import('../../src/modules/inventory/stock.js');
      await postOut(tx, s.t, { locationId: store.id, materialId: s.cement, ownerSupplied: false }, D(95), { type: 'USAGE_OUT', refType: 'TEST', refId: id, occurredAt: new Date(), createdById: null });
    });

    const tooMany = await api().post(`/api/v1/purchases/${id}/returns`).set(s.auth).send({ reason: 'Hardened', items: [{ materialId: s.cement, qty: 10 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatchObject({ code: 'RETURN_EXCEEDS_STOCK', details: { available: 5 } });
    const notBought = await api().post(`/api/v1/purchases/${id}/returns`).set(s.auth).send({ reason: 'Wrong', items: [{ materialId: s.steel, qty: 1 }] });
    expect(notBought.body.error.code).toBe('NOT_IN_PURCHASE');

    const ok = await api().post(`/api/v1/purchases/${id}/returns`).set(await pm()).send({ reason: 'Hardened bags', items: [{ materialId: s.cement, qty: 5 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ number: 'PRN-0001', totalPaisa: '715000', items: [{ qty: 5, ratePaisa: '143000' }] });
    expect((await balance(s.auth, s.almadina)).udhaarBalancePaisa).toBe('13585000'); // 1,43,000 − 7,150
    const list = await api().get(`/api/v1/purchase-returns?purchaseId=${id}`).set(s.auth);
    expect(list.body.data).toHaveLength(1);
    const again = await api().post(`/api/v1/purchases/${id}/returns`).set(s.auth).send({ reason: 'x more', items: [{ materialId: s.cement, qty: 1 }] });
    expect(again.body.error.code).toBe('RETURN_EXCEEDS_STOCK');
  });

  it('a correction keeps the original line visible and adjusts stock and the ledger', async () => {
    const s = await setup();
    const buy = await storePurchase(s, s.auth, { supplierId: s.almadina, challanNo: 'CH-5', items: [{ materialId: s.cement, challanQty: 400 }] });
    const itemId = buy.body.data.items[0].id;
    const fixed = await api()
      .post(`/api/v1/purchases/${buy.body.data.id}/corrections`)
      .set(s.auth)
      .send({ reason: 'Agreed rate was 1,420 and only 390 came', items: [{ purchaseItemId: itemId, qty: 390, ratePaisa: '142000' }] });
    expect(fixed.status).toBe(201);
    expect(fixed.body.data).toMatchObject({
      totalPaisa: '57200000', // original stays
      correctedTotalPaisa: '55380000', // 390 × 1,420
      items: [{ challanQty: 400, countedQty: 400, ratePaisa: '143000', correctedQty: 390, correctedRatePaisa: '142000' }],
      corrections: [{ reason: 'Agreed rate was 1,420 and only 390 came', deltaPaisa: '-1820000', items: [{ fromQty: 400, toQty: 390, fromRatePaisa: '143000', toRatePaisa: '142000' }] }],
    });
    expect((await balance(s.auth, s.almadina)).udhaarBalancePaisa).toBe('55380000');
    const { store } = await storeOf(s.t);
    const stock = await api().get(`/api/v1/stores/${store.id}/stock`).set(s.auth);
    expect(stock.body.data.items[0]).toMatchObject({ inStore: 390, valuePaisa: '55380000', avgRatePaisa: '142000' });

    expect((await api().post(`/api/v1/purchases/${buy.body.data.id}/corrections`).set(await pm()).send({ reason: 'nope', items: [{ purchaseItemId: itemId, qty: 1 }] })).status).toBe(403);
  });

  it('a direct-to-site purchase waits for the site count; PM / MUNSHI scoping of the list', async () => {
    const s = await setup();
    const res = await api()
      .post('/api/v1/purchases')
      .set(s.auth)
      .send({ supplierId: s.chaudhry, deliverTo: 'SITE', projectId: seeded().projects.bahria.id, challanNo: 'CB-1190', purchaseDate: '2026-10-04', challanAttachmentId: await attachment(s.auth), items: [{ materialId: s.bricks, challanQty: 10000, ratePaisa: '1700' }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING_RECEIPT', locked: false, items: [{ challanQty: 10000, countedQty: null }] });
    const site = await siteOf(s.t, seeded().projects.bahria.id);
    expect((await api().get(`/api/v1/stock/movements?locationId=${site.id}`).set(s.auth)).body.meta.total).toBe(0);
    // Bilal (PM) is not on Bahria; Rafaqat (MUNSHI) neither
    expect((await api().get(`/api/v1/purchases/${res.body.data.id}`).set(await pm())).status).toBe(404);
    expect((await api().get('/api/v1/purchases').set(await munshi(s.t))).body.data).toEqual([]);
  });
});
