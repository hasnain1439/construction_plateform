/**
 * Demo procurement & inventory for Malik & Sons (Phase 1 · Step 6). Idempotent: skipped when
 * the company already has purchases. Every document goes through the real services, so the
 * stock ledger, supplier ledger, shortages and numbers are exactly what the API would write.
 *
 * Timeline (2026): September store purchases → store count (28 Sep) → October purchases →
 * dispatches GP-0140…0144 → DHA usage on the last three days.
 */
import { setNextNumber } from '../src/core/db/counters.js';
import type { Tx } from '../src/core/db/withTenant.js';
import { todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import { cancelDispatchTx, createDispatchTx, receiveDispatchTx } from '../src/modules/dispatch/dispatches.service.js';
import { createCountTx } from '../src/modules/inventory/counts.service.js';
import { D, systemLocations, type Actor } from '../src/modules/inventory/stock.js';
import { recordUsageTx } from '../src/modules/inventory/usage.service.js';
import { setLowStockLevelsTx } from '../src/modules/inventory/inventory.service.js';
import type { CreatePurchaseInput } from '../src/modules/procurement/procurement.schema.js';
import { createPurchaseTx, receivePurchaseTx } from '../src/modules/procurement/purchases.service.js';
import { createPaymentTx, postLedger, setChequeStatusTx } from '../src/modules/procurement/supplierLedger.service.js';

// 1×1 PNG used as the demo challan photo
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const rs = (rupees: number) => BigInt(Math.round(rupees * 100));
/** Calendar date at a Pakistan-time hour → UTC instant. */
const at = (date: string, hourPkt = 11) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
const DAY = 86_400_000;

export interface InventorySeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  projects: { dha: { id: string }; johar: { id: string }; bahria: { id: string } };
}

export async function seedMalikInventory(db: PrismaClient, s: InventorySeedInput, now = new Date()): Promise<{ skipped: boolean }> {
  if ((await db.purchase.count({ where: { tenantId: s.tenantId } })) > 0) return { skipped: true };

  const khalid: Actor = { tenantId: s.tenantId, userId: s.ownerId, role: 'THEKEDAR', seesRates: true, seesFinancials: true };
  const bilal: Actor = { tenantId: s.tenantId, userId: s.bilalId, role: 'PM', seesRates: true, seesFinancials: false };
  const rafaqat: Actor = { tenantId: s.tenantId, userId: s.rafaqatId, role: 'MUNSHI', seesRates: false, seesFinancials: false };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => db.$transaction(fn, { timeout: 60_000 });

  const material = async (name: string) => (await db.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId: s.tenantId, name } } })).id;
  const supplier = async (name: string) => (await db.supplier.findUniqueOrThrow({ where: { tenantId_name: { tenantId: s.tenantId, name } } })).id;
  const cement = await material('Cement OPC');
  const bricks = await material('Clay bricks Class-1');
  const steel = await material('Steel Grade-60 #4');
  const sand = await material('Chenab sand');
  const ppr = await material('PPR pipe 1"');
  const almadina = await supplier('Al-Madina Cement Agency');
  const ittefaq = await supplier('Ittefaq Steel Traders');
  const chaudhry = await supplier('Chaudhry Bricks Kiln');
  const bilalTraders = await supplier('Bilal Traders');
  const punjab = await supplier('Punjab Shuttering Yard');
  // The demo buys from these five; re-activate them if they were switched off while trying the app.
  await db.supplier.updateMany({ where: { tenantId: s.tenantId, id: { in: [almadina, ittefaq, chaudhry, bilalTraders, punjab] } }, data: { isActive: true } });

  /** A small challan image in the configured storage (a bare row if storage is unreachable). */
  const challan = async (fileName: string) => {
    const id = uuidv7();
    let key = `${s.tenantId}/2026/10/${id}.png`;
    try {
      key = await storage().put(key, PNG, 'image/png');
    } catch {
      // keep the local-style key; only the image preview is missing
    }
    await db.attachment.create({ data: { id, tenantId: s.tenantId, kind: 'CHALLAN', storageKey: key, fileName, mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: s.ownerId } });
    return id;
  };

  const purchase = async (a: Actor, input: Omit<CreatePurchaseInput, 'challanAttachmentId' | 'paymentMode'> & Partial<Pick<CreatePurchaseInput, 'paymentMode'>>, when: Date) => {
    const challanAttachmentId = await challan(`${input.challanNo}.png`);
    return run((tx) => createPurchaseTx(tx, a, { paymentMode: 'UDHAAR', ...input, challanAttachmentId }, { at: when }));
  };

  // Opening udhaar carried over from before the app (1 Sep)
  await run(async (tx) => {
    for (const [supplierId, rupees] of [
      [almadina, 1_68_000],
      [ittefaq, 8_40_000],
      [bilalTraders, 1_15_000],
      [punjab, 86_000],
    ] as const) {
      await postLedger(tx, khalid, { supplierId, type: 'OPENING', amountPaisa: rs(rupees), occurredAt: at('2026-09-01', 9), note: 'Opening balance' });
    }
  });

  // ─── September: store stock + the bounced cheque + the store count ───────
  await purchase(
    khalid,
    { supplierId: almadina, deliverTo: 'STORE', challanNo: 'CH-2198', purchaseDate: '2026-09-15', paymentMode: 'CASH', paidFrom: 'OFFICE_CASH', items: [{ materialId: cement, challanQty: D(200), ratePaisa: rs(1500) }] },
    at('2026-09-15'),
  );
  await purchase(khalid, { supplierId: chaudhry, deliverTo: 'STORE', challanNo: 'CB-1150', purchaseDate: '2026-09-18', items: [{ materialId: bricks, challanQty: D(17000), ratePaisa: rs(17) }] }, at('2026-09-18'));
  const cheque = await run((tx) =>
    createPaymentTx(tx, khalid, { supplierId: ittefaq, amountPaisa: rs(1_50_000), method: 'CHEQUE', chequeNo: '00412377', chequeDate: '2026-09-25', paidOn: '2026-09-25' }, { at: at('2026-09-25') }),
  );
  await run((tx) => setChequeStatusTx(tx, khalid, cheque.id, { status: 'BOUNCED', note: 'Returned — insufficient funds' }, { at: at('2026-09-27') }));
  const { store } = await run((tx) => systemLocations(tx, s.tenantId));
  await run((tx) =>
    createCountTx(
      tx,
      khalid,
      {
        locationId: store.id,
        items: [
          { materialId: cement, countedQty: D(196), reason: 'HARDENED_IN_RAIN', note: '4 bags hardened after the rain' },
          { materialId: bricks, countedQty: D(16950), reason: 'BREAKAGE', note: '50 broken while stacking' },
        ],
      },
      { at: at('2026-09-28', 17) },
    ),
  );

  // ─── October purchases ──────────────────────────────────────────────────
  await purchase(
    khalid,
    { supplierId: almadina, deliverTo: 'STORE', challanNo: 'CH-2231', vehicleNo: 'LES-4521', purchaseDate: '2026-10-02', items: [{ materialId: cement, challanQty: D(400), ratePaisa: rs(1430) }] },
    at('2026-10-02', 10),
  );
  await purchase(
    khalid,
    {
      supplierId: ittefaq,
      deliverTo: 'STORE',
      challanNo: 'IT-8812',
      purchaseDate: '2026-10-02',
      paymentMode: 'PARTIAL',
      paidNowPaisa: rs(2_00_000),
      paidFrom: 'BANK',
      items: [{ materialId: steel, challanQty: D(2), ratePaisa: rs(2_85_000) }],
    },
    at('2026-10-02', 12),
  );
  const sandBuy = await purchase(
    khalid,
    {
      supplierId: bilalTraders,
      deliverTo: 'SITE',
      projectId: s.projects.dha.id,
      challanNo: 'BT-451',
      purchaseDate: '2026-10-02',
      paymentMode: 'CASH',
      paidFrom: 'OFFICE_CASH',
      items: [{ materialId: sand, challanQty: D(400), ratePaisa: rs(70) }],
    },
    at('2026-10-02', 13),
  );
  await run((tx) => receivePurchaseTx(tx, rafaqat, sandBuy.id, { items: [{ materialId: sand, countedQty: D(400) }] }, { at: at('2026-10-02', 16) }));

  // ─── Dispatches (gate passes continue from the paper book: GP-0140) ─────
  await run((tx) => setNextNumber(tx, s.tenantId, 'GP', 140));
  const dispatch = (a: Actor, input: Parameters<typeof createDispatchTx>[2], when: Date) => run((tx) => createDispatchTx(tx, a, input, { at: when }));

  const gp140 = await dispatch(khalid, { fromLocationId: store.id, toProjectId: s.projects.johar.id, vehicleNo: 'LEB-7781', driverName: 'Akbar', driverPhone: '+923004445566', items: [{ materialId: cement, qty: D(80) }] }, at('2026-10-03', 8));
  await run((tx) => receiveDispatchTx(tx, bilal, gp140.id, { items: [{ materialId: cement, receivedQty: D(80) }] }, { at: at('2026-10-03', 10) }));

  const gp141 = await dispatch(khalid, { fromLocationId: store.id, toProjectId: s.projects.bahria.id, vehicleNo: 'LEB-7781', items: [{ materialId: cement, qty: D(50) }], note: 'Wrong site — cancelled' }, at('2026-10-03', 9));
  await run((tx) => cancelDispatchTx(tx, khalid, gp141.id, { at: at('2026-10-03', 9) }));

  const gp142 = await dispatch(
    khalid,
    {
      fromLocationId: store.id,
      toProjectId: s.projects.dha.id,
      vehicleNo: 'LES-4521',
      driverName: 'Nadeem',
      driverPhone: '+923001112233',
      items: [
        { materialId: cement, qty: D(200) },
        { materialId: bricks, qty: D(5000) },
      ],
    },
    at('2026-10-03', 10),
  );
  await run((tx) =>
    receiveDispatchTx(
      tx,
      rafaqat,
      gp142.id,
      {
        items: [
          { materialId: cement, receivedQty: D(190), note: '10 bags missing from the truck' },
          { materialId: bricks, receivedQty: D(5000), damagedQty: D(200), note: '200 bricks broken while unloading' },
        ],
      },
      { at: at('2026-10-03', 13) },
    ),
  );

  await dispatch(khalid, { fromLocationId: store.id, toProjectId: s.projects.bahria.id, vehicleNo: 'LHR-3390', driverName: 'Sajid', items: [{ materialId: steel, qty: D(1) }] }, at('2026-10-04', 9));
  await purchase(
    khalid,
    {
      supplierId: chaudhry,
      deliverTo: 'SITE',
      projectId: s.projects.bahria.id,
      challanNo: 'CB-1190',
      purchaseDate: '2026-10-04',
      paymentMode: 'PARTIAL',
      paidNowPaisa: rs(1_34_000),
      paidFrom: 'BANK',
      items: [{ materialId: bricks, challanQty: D(10000), ratePaisa: rs(17) }],
    },
    at('2026-10-04', 12),
  );
  const gp144At = new Date(Math.min(now.getTime() - 60_000, at('2026-10-05', 9).getTime()));
  await dispatch(khalid, { fromLocationId: store.id, toProjectId: s.projects.dha.id, vehicleNo: 'LEA-1029', driverName: 'Nadeem', driverPhone: '+923001112233', items: [{ materialId: cement, qty: D(100) }] }, gp144At);

  // ─── DHA usage on the last three days (never before the 3 Oct receipt) ────
  const usage: Array<[number, number, number]> = [
    [20, 800, 60],
    [15, 600, 40],
    [18, 700, 50],
  ];
  for (const [i, [c, b, sd]] of usage.entries()) {
    const day = todayIn('Asia/Karachi', new Date(now.getTime() - (2 - i) * DAY));
    if (day < '2026-10-03') continue;
    const when = i === 2 ? now : at(day, 17);
    await run((tx) =>
      recordUsageTx(
        tx,
        rafaqat,
        s.projects.dha.id,
        {
          usageDate: day,
          items: [
            { materialId: cement, qty: D(c) },
            { materialId: bricks, qty: D(b) },
            { materialId: sand, qty: D(sd) },
          ],
          note: ['Ground floor columns', 'First floor brickwork', 'Roof slab shuttering'][i],
        },
        { at: when },
      ),
    );
  }

  // Low-stock levels for the store
  await run((tx) =>
    setLowStockLevelsTx(tx, khalid, store.id, [
      { materialId: cement, minQty: D(200) },
      { materialId: sand, minQty: D(500) },
      { materialId: ppr, minQty: D(100) },
    ]),
  );
  return { skipped: false };
}
