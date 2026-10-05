import { describe, expect, it } from 'vitest';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { SEED, useFreshDatabase } from '../helpers.js';
import { api, attachment, materialId, munshi, owner, pm, siteOf, stockIn, storeOf, supplierId, type Auth } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  const { store, transit } = await storeOf(t);
  const cement = await materialId(t, 'Cement OPC');
  const bricks = await materialId(t, 'Clay bricks Class-1');
  await stockIn(t, store.id, cement, 200, 150000n);
  await stockIn(t, store.id, cement, 400, 143000n);
  await stockIn(t, store.id, bricks, 17000, 1700n);
  return { t, store, transit, cement, bricks, auth: await owner(), dha: seeded().projects.dha.id, bahria: seeded().projects.bahria.id };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const send = (s: Setup, auth: Auth, body: Record<string, unknown> = {}) =>
  api()
    .post('/api/v1/dispatches')
    .set(auth)
    .send({
      fromLocationId: s.store.id,
      toProjectId: s.dha,
      vehicleNo: 'LES-4521',
      driverName: 'Nadeem',
      driverPhone: '0300-1112233',
      items: [
        { materialId: s.cement, qty: 200 },
        { materialId: s.bricks, qty: 5000 },
      ],
      ...body,
    });

const storeRow = async (s: Setup, material: string) =>
  (await api().get(`/api/v1/stores/${s.store.id}/stock`).set(s.auth)).body.data.items.find((i: { material: { id: string } }) => i.material.id === material);

describe('dispatches', () => {
  it('moves stock into transit at the average cost, numbers GP-0001 and texts the site team', async () => {
    const s = await setup();
    const res = await send(s, s.auth);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'GP-0001',
      status: 'ON_THE_WAY',
      from: { id: s.store.id },
      to: { projectId: s.dha },
      driverPhone: '+923001112233',
      items: [
        { material: { id: s.cement }, sentQty: 200, unitCostPaisa: '145333' },
        { material: { id: s.bricks }, sentQty: 5000, unitCostPaisa: '1700' },
      ],
    });
    expect(await storeRow(s, s.cement)).toMatchObject({ inStore: 400, inTransit: 200, avgRatePaisa: '145333' });
    const store = await api().get(`/api/v1/stores/${s.store.id}/stock`).set(s.auth);
    expect(store.body.data.summary.dispatchesOnTheWay).toBe(1);
    const transit = await api().get(`/api/v1/stock/movements?locationId=${s.transit.id}`).set(s.auth);
    expect(transit.body.data.map((m: { type: string; quantity: number }) => [m.type, m.quantity]).sort()).toEqual([
      ['TRANSIT_IN', 200],
      ['TRANSIT_IN', 5000],
    ]);

    const text = 'GP-0001: 200 bags cement aur 5,000 eent aap ki site par aa rahe hain (LES-4521).';
    expect(lastSmsTo(SEED.malik.pm.phone)?.body).toBe(text); // Bilal (PM on DHA)
    expect(lastSmsTo(SEED.malik.munshi.phone)?.body).toBe(text); // Rafaqat (MUNSHI on DHA)
  });

  it('not enough stock → 400 INSUFFICIENT_STOCK with the available quantity; nothing moves', async () => {
    const s = await setup();
    const res = await send(s, s.auth, { items: [{ materialId: s.cement, qty: 601 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { materialId: s.cement, available: 600 } });
    expect(await storeRow(s, s.cement)).toMatchObject({ inStore: 600, inTransit: 0 });
  });

  it('cancel on the way puts the stock back at the same value; a received dispatch cannot be cancelled', async () => {
    const s = await setup();
    const before = await storeRow(s, s.cement);
    const d = (await send(s, s.auth)).body.data;
    const cancelled = await api().post(`/api/v1/dispatches/${d.id}/cancel`).set(s.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(await storeRow(s, s.cement)).toMatchObject({ inStore: 600, inTransit: 0, valuePaisa: before.valuePaisa });
    expect((await api().post(`/api/v1/dispatches/${d.id}/cancel`).set(s.auth)).body.error.code).toBe('DISPATCH_NOT_CANCELLABLE');
  });

  it('PM cannot dispatch from the store, but can transfer from a site they manage; MUNSHI cannot dispatch', async () => {
    const s = await setup();
    const bilal = await pm();
    const fromStore = await send(s, bilal);
    expect(fromStore.status).toBe(403);

    const dhaSite = await siteOf(s.t, s.dha);
    await stockIn(s.t, dhaSite.id, s.cement, 50, 145000n);
    const johar = seeded().projects.johar.id;
    const transfer = await api().post('/api/v1/dispatches').set(bilal).send({ fromLocationId: dhaSite.id, toProjectId: johar, items: [{ materialId: s.cement, qty: 20 }] });
    expect(transfer.status).toBe(201);
    // Bahria is not Bilal's project
    const notMine = await api().post('/api/v1/dispatches').set(bilal).send({ fromLocationId: dhaSite.id, toProjectId: s.bahria, items: [{ materialId: s.cement, qty: 1 }] });
    expect(notMine.status).toBe(404);
    expect((await send(s, await munshi(s.t))).status).toBe(403);
  });
});

describe('receiving (blind count) and shortages', () => {
  it('MUNSHI sees no sent quantities while on the way; receiving reveals them and records short + damaged with values', async () => {
    const s = await setup();
    const d = (await send(s, s.auth)).body.data;
    const m = await munshi(s.t);

    const incoming = await api().get(`/api/v1/projects/${s.dha}/incoming`).set(m);
    expect(incoming.status).toBe(200);
    expect(incoming.body.data).toMatchObject({ blindCount: true, count: 1, dispatches: [{ number: 'GP-0001', vehicleNo: 'LES-4521' }] });
    expect(incoming.body.data.dispatches[0].items[0]).not.toHaveProperty('sentQty');
    const detail = await api().get(`/api/v1/dispatches/${d.id}`).set(m);
    expect(detail.body.data.items[0]).not.toHaveProperty('sentQty');
    expect(detail.body.data.items[0]).not.toHaveProperty('unitCostPaisa');

    const noNote = await api().post(`/api/v1/dispatches/${d.id}/receive`).set(m).send({ items: [{ materialId: s.cement, receivedQty: 190 }, { materialId: s.bricks, receivedQty: 5000 }] });
    expect(noNote.body.error.code).toBe('SHORTAGE_NOTE_REQUIRED');
    const missing = await api().post(`/api/v1/dispatches/${d.id}/receive`).set(m).send({ items: [{ materialId: s.cement, receivedQty: 200 }] });
    expect(missing.body.error.code).toBe('ITEMS_MISMATCH');

    const res = await api()
      .post(`/api/v1/dispatches/${d.id}/receive`)
      .set(m)
      .send({
        items: [
          { materialId: s.cement, receivedQty: 190, note: '10 bags missing' },
          { materialId: s.bricks, receivedQty: 5000, damagedQty: 200, note: '200 broken', photoAttachmentId: await attachment(m, 'SITE_PHOTO') },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.comparison).toEqual([
      expect.objectContaining({ expectedQty: 200, countedQty: 190, damagedQty: 0, goodQty: 190, differenceQty: -10, result: 'SHORT' }),
      expect.objectContaining({ expectedQty: 5000, countedQty: 5000, damagedQty: 200, goodQty: 4800, differenceQty: -200, result: 'DAMAGED' }),
    ]);
    expect(res.body.data.dispatch.status).toBe('RECEIVED_WITH_SHORTAGE');
    expect(res.body.data.dispatch.shortages[0]).not.toHaveProperty('valuePaisa');

    const again = await api().post(`/api/v1/dispatches/${d.id}/receive`).set(m).send({ items: [{ materialId: s.cement, receivedQty: 200 }, { materialId: s.bricks, receivedQty: 5000 }] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_RECEIVED');

    const shortages = await api().get('/api/v1/shortages?status=OPEN').set(s.auth);
    expect(shortages.body.data.map((x: { kind: string; qty: number; valuePaisa: string }) => [x.kind, x.qty, x.valuePaisa]).sort()).toEqual([
      ['DAMAGED', 200, '340000'],
      ['DISPATCH_SHORT', 10, '1453330'],
    ]);
    expect(shortages.body.meta).toMatchObject({ openCount: 2, openValuePaisa: '1793330' });

    const site = await api().get(`/api/v1/projects/${s.dha}/stock`).set(s.auth);
    expect(site.body.data.items.map((i: { material: { id: string }; inStock: number }) => [i.material.id, i.inStock]).sort()).toEqual(
      [
        [s.cement, 190],
        [s.bricks, 4800],
      ].sort(),
    );
    const transit = await api().get(`/api/v1/stock/movements?locationId=${s.transit.id}&type=TRANSIT_OUT`).set(s.auth);
    expect(transit.body.meta.total).toBe(2);
  });

  it('resolutions: SEND_REMAINING dispatches again, RETURN_TO_STORE restocks, RECOVER_FROM_DRIVER needs an amount, resolved → 409', async () => {
    const s = await setup();
    const d = (await send(s, s.auth)).body.data;
    await api()
      .post(`/api/v1/dispatches/${d.id}/receive`)
      .set(s.auth)
      .send({
        items: [
          { materialId: s.cement, receivedQty: 190, note: '10 missing' },
          { materialId: s.bricks, receivedQty: 5000, damagedQty: 200, note: 'broken' },
        ],
      })
      .expect(200);
    const list = (await api().get('/api/v1/shortages').set(s.auth)).body.data;
    const short = list.find((x: { kind: string }) => x.kind === 'DISPATCH_SHORT');
    const damaged = list.find((x: { kind: string }) => x.kind === 'DAMAGED');
    expect(short.allowedResolutions).toEqual(['SEND_REMAINING', 'RETURN_TO_STORE', 'ACCEPT_LOSS', 'RECOVER_FROM_DRIVER']);

    expect((await api().post(`/api/v1/shortages/${short.id}/resolve`).set(await pm()).send({ resolution: 'ACCEPT_LOSS', note: 'Accept it' })).status).toBe(403);
    const credit = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'SUPPLIER_CREDIT', note: 'not a purchase' });
    expect(credit.body.error.code).toBe('RESOLUTION_NOT_ALLOWED');
    const noAmount = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'RECOVER_FROM_DRIVER', note: 'driver pays' });
    expect(noAmount.status).toBe(400);

    const sent = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'SEND_REMAINING', note: 'Loaded short at the store' });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toMatchObject({ status: 'RESOLVED', resolution: 'SEND_REMAINING', newDispatch: { number: 'GP-0002' } });
    const newOne = await api().get(`/api/v1/dispatches/${sent.body.data.newDispatch.id}`).set(s.auth);
    expect(newOne.body.data).toMatchObject({ status: 'ON_THE_WAY', vehicleNo: 'LES-4521', items: [{ material: { id: s.cement }, sentQty: 10 }] });
    expect((await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'ACCEPT_LOSS', note: 'Accept it' })).body.error.code).toBe('SHORTAGE_RESOLVED');

    const bricksBefore = (await storeRow(s, s.bricks)).inStore;
    const back = await api().post(`/api/v1/shortages/${damaged.id}/resolve`).set(s.auth).send({ resolution: 'RETURN_TO_STORE', note: 'Broken bricks back for rubble' });
    expect(back.status).toBe(200);
    expect((await storeRow(s, s.bricks)).inStore).toBe(bricksBefore + 200);
  });

  it('RECOVER_FROM_DRIVER records the amount; ACCEPT_LOSS just closes it', async () => {
    const s = await setup();
    const d = (await send(s, s.auth, { items: [{ materialId: s.cement, qty: 100 }] })).body.data;
    await api().post(`/api/v1/dispatches/${d.id}/receive`).set(s.auth).send({ items: [{ materialId: s.cement, receivedQty: 95, note: '5 short' }] }).expect(200);
    const short = (await api().get('/api/v1/shortages').set(s.auth)).body.data[0];
    const res = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'RECOVER_FROM_DRIVER', note: 'Deducted from wages', recoveredAmountPaisa: '726665' });
    expect(res.body.data).toMatchObject({ status: 'RESOLVED', recoveredAmountPaisa: '726665' });
  });

  it('EXCESS counted at the site can go back to the store', async () => {
    const s = await setup();
    const d = (await send(s, s.auth, { items: [{ materialId: s.cement, qty: 100 }] })).body.data;
    const res = await api().post(`/api/v1/dispatches/${d.id}/receive`).set(s.auth).send({ items: [{ materialId: s.cement, receivedQty: 102 }] });
    expect(res.body.data.dispatch.status).toBe('RECEIVED_WITH_EXCESS');
    expect(res.body.data.comparison[0]).toMatchObject({ differenceQty: 2, result: 'EXCESS' });
    const excess = (await api().get('/api/v1/shortages').set(s.auth)).body.data[0];
    expect(excess).toMatchObject({ kind: 'EXCESS', qty: 2, allowedResolutions: ['RETURN_TO_STORE', 'ACCEPT_LOSS'] });
    await api().post(`/api/v1/shortages/${excess.id}/resolve`).set(s.auth).send({ resolution: 'RETURN_TO_STORE', note: 'Overloaded' }).expect(200);
    expect((await storeRow(s, s.cement)).inStore).toBe(502);
  });

  it('a direct site purchase: blind count for the munshi, receipt reveals the challan; SUPPLIER_CREDIT credits the supplier', async () => {
    const s = await setup();
    const chaudhry = await supplierId(s.t, 'Chaudhry Bricks Kiln');
    const p = await api()
      .post('/api/v1/purchases')
      .set(s.auth)
      .send({ supplierId: chaudhry, deliverTo: 'SITE', projectId: s.dha, challanNo: 'CB-1190', purchaseDate: '2026-10-04', challanAttachmentId: await attachment(s.auth), items: [{ materialId: s.bricks, challanQty: 10000, ratePaisa: '1700' }] });
    expect(p.status).toBe(201);
    const m = await munshi(s.t);
    const incoming = await api().get(`/api/v1/projects/${s.dha}/incoming`).set(m);
    expect(incoming.body.data.purchases[0]).toMatchObject({ number: p.body.data.number, challanNo: 'CB-1190' });
    expect(incoming.body.data.purchases[0].items[0]).not.toHaveProperty('challanQty');
    expect((await api().get(`/api/v1/purchases/${p.body.data.id}`).set(m)).body.data.items[0]).not.toHaveProperty('challanQty');

    const res = await api().post(`/api/v1/purchases/${p.body.data.id}/receive`).set(m).send({ items: [{ materialId: s.bricks, countedQty: 9800, note: 'Trolley short' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.comparison[0]).toMatchObject({ expectedQty: 10000, countedQty: 9800, differenceQty: -200, result: 'SHORT' });
    expect(res.body.data.purchase).toMatchObject({ status: 'RECEIVED_WITH_SHORTAGE', items: [{ challanQty: 10000, countedQty: 9800 }] });
    expect((await api().post(`/api/v1/purchases/${p.body.data.id}/receive`).set(m).send({ items: [{ materialId: s.bricks, countedQty: 1 }] })).body.error.code).toBe('ALREADY_RECEIVED');

    const balance = async () => (await api().get(`/api/v1/suppliers/${chaudhry}`).set(s.auth)).body.data.udhaarBalancePaisa;
    expect(await balance()).toBe('17000000'); // the bill: 10,000 × Rs 17
    const short = (await api().get('/api/v1/shortages?source=PURCHASE').set(s.auth)).body.data[0];
    expect(short).toMatchObject({ kind: 'SUPPLIER_SHORT', qty: 200, valuePaisa: '340000', allowedResolutions: ['SUPPLIER_CREDIT', 'ACCEPT_LOSS'] });
    await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.auth).send({ resolution: 'SUPPLIER_CREDIT', note: 'Chaudhry agreed' }).expect(200);
    expect(await balance()).toBe('16660000');
  });
});

describe('owner deliveries', () => {
  it('only owner-supplied categories, at cost 0, separate from contractor stock', async () => {
    const s = await setup();
    const tiles = await materialId(s.t, 'Floor tiles');
    const m = await munshi(s.t);
    // DHA is grey structure by contractor, finishing by owner
    const bad = await api().post(`/api/v1/projects/${s.dha}/owner-deliveries`).set(m).send({ deliveryDate: '2026-10-05', items: [{ materialId: s.cement, qty: 10 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('NOT_OWNER_SUPPLIED');

    const ok = await api().post(`/api/v1/projects/${s.dha}/owner-deliveries`).set(m).send({ deliveryDate: '2026-10-05', items: [{ materialId: tiles, qty: 1200 }], note: 'From the owner’s dealer' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.items).toEqual([{ material: expect.objectContaining({ id: tiles }), qty: 1200 }]);
    const list = await api().get(`/api/v1/projects/${s.dha}/owner-deliveries`).set(m);
    expect(list.body.data).toHaveLength(1);
    const stock = await api().get(`/api/v1/projects/${s.dha}/stock`).set(s.auth);
    expect(stock.body.data.items.find((i: { material: { id: string } }) => i.material.id === tiles)).toMatchObject({ receivedOwner: 1200, inStockOwner: 1200, inStockContractor: 0, valuePaisa: '0' });
  });
});
