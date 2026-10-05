import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, BRICKS, CEMENT, DHA_SITE, IDS, KHALID, READ_403, STORE, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import {
  chequeStatusBody,
  correctionBody,
  createPaymentBody,
  createPurchaseBody,
  createPurchaseOrderBody,
  ledgerQuery,
  listPaymentsQuery,
  listPurchaseOrdersQuery,
  listPurchasesQuery,
  listReturnsQuery,
  purchaseReturnBody,
  receivePurchaseBody,
  setRatesBody,
  updatePurchaseOrderBody,
} from './procurement.schema.js';

const ALMADINA = { id: IDS.almadina, name: 'Al-Madina Cement Agency', phone: '+924235761234' };
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };

const purchaseExample = {
  id: IDS.purchase,
  number: 'PUR-2026-0003',
  supplier: ALMADINA,
  deliverTo: 'STORE',
  location: STORE,
  project: null,
  purchaseOrder: null,
  challanNo: 'CH-2231',
  vehicleNo: 'LES-4521',
  purchaseDate: '2026-10-02',
  paymentMode: 'UDHAAR',
  status: 'SAVED',
  locked: true,
  blindCount: false,
  note: null,
  items: [
    { id: IDS.purchaseItem, material: CEMENT, challanQty: 400, countedQty: 400, damagedQty: 0, goodQty: 400, shortQty: 0, note: null, ratePaisa: '143000', amountPaisa: '57200000', correctedQty: null, correctedRatePaisa: null },
  ],
  totalPaisa: '57200000',
  correctedTotalPaisa: '57200000',
  paidNowPaisa: '0',
  paidFrom: null,
  udhaarAddedPaisa: '57200000',
  ledgerEffect: [{ type: 'PURCHASE', amountPaisa: '57200000', occurredAt: '2026-10-02T07:00:00.000Z', note: 'PUR-2026-0003' }],
  payments: [],
  challan: { id: IDS.challan, fileName: 'ch-2231.jpg', url: 'https://api.example.com/api/v1/attachments/…/file?…' },
  bill: null,
  corrections: [],
  returns: [],
  shortages: [],
  receivedBy: KHALID,
  receivedAt: '2026-10-02T07:00:00.000Z',
  createdBy: KHALID,
  createdAt: '2026-10-02T07:00:00.000Z',
};

const poExample = {
  id: IDS.purchaseOrder,
  number: 'PO-0001',
  supplier: ALMADINA,
  deliverTo: 'STORE',
  location: STORE,
  project: null,
  expectedDate: '2026-10-10',
  status: 'PARTLY_RECEIVED',
  note: null,
  items: [{ id: IDS.purchaseItem, material: CEMENT, orderedQty: 600, receivedQty: 400, pendingQty: 200, ratePaisa: '143000', amountPaisa: '85800000' }],
  totalPaisa: '85800000',
  purchases: [{ id: IDS.purchase, number: 'PUR-2026-0003', challanNo: 'CH-2231', purchaseDate: '2026-10-02', status: 'SAVED' }],
  cancelledAt: null,
  createdBy: KHALID,
  createdAt: '2026-09-30T07:00:00.000Z',
};

const paymentExample = {
  id: IDS.payment,
  supplier: { id: IDS.ittefaq, name: 'Ittefaq Steel Traders' },
  amountPaisa: '15000000',
  method: 'CHEQUE',
  reference: null,
  chequeNo: '00412377',
  chequeDate: '2026-10-04',
  status: 'PENDING',
  paidOn: '2026-10-04',
  note: null,
  project: null,
  purchase: null,
  statusChangedAt: null,
  createdBy: KHALID,
  createdAt: '2026-10-04T07:00:00.000Z',
};

export function registerProcurementDocs(): void {
  // ─── Purchases ───────────────────────────────────────────────────────────
  const P = 'Purchases';
  path(P, 'get', '/api/v1/purchases', {
    summary: 'List purchases',
    description:
      'THEKEDAR all; PM store purchases + their sites; MUNSHI only purchases delivered to their sites (no amounts). Filters: supplier, ' +
      'location, project, payment mode, status, date range, number / challan search. `meta.totalPaisa` sums the filtered bills (rates.view).',
    request: { query: listPurchasesQuery },
    responses: {
      ...ok(
        'Purchases',
        [{ id: IDS.purchase, number: 'PUR-2026-0003', supplier: { id: IDS.almadina, name: ALMADINA.name }, deliverTo: 'STORE', location: STORE, project: null, challanNo: 'CH-2231', purchaseDate: '2026-10-02', paymentMode: 'UDHAAR', status: 'SAVED', materials: ['Cement OPC'], openShortages: 0, totalPaisa: '57200000', paidNowPaisa: '0', createdAt: '2026-10-02T07:00:00.000Z' }],
        { ...page(1), totalPaisa: '57200000', paidNowPaisa: '0' },
      ),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });
  path(P, 'post', '/api/v1/purchases', {
    summary: 'Record a purchase (challan)',
    description:
      '**STORE** (THEKEDAR, PM): counted on arrival → SAVED, stock in at the rate. **SITE** (office): PENDING_RECEIPT until the site counts it ' +
      '(`POST /purchases/{id}/receive`). **MUNSHI**: SITE only, no rates or payment → PENDING_RATE until the office adds rates.\n\n' +
      'Rates default from the purchase order, then the supplier’s agreed rate (400 RATE_REQUIRED if none). Good quantity (counted − damaged) ' +
      'below the challan needs an item `note` (400 SHORTAGE_NOTE_REQUIRED) and creates SUPPLIER_SHORT / DAMAGED shortages.\n\n' +
      'Payment: UDHAAR → whole bill to the supplier ledger; CASH → bill + payment; PARTIAL → bill + payment of `paidNowPaisa` (0 < paid < bill). ' +
      'The challan photo is required (upload with kind CHALLAN).',
    request: {
      body: jsonBody(createPurchaseBody, {
        store: ex('Store purchase on udhaar (Al-Madina, 400 cement)', {
          supplierId: IDS.almadina,
          deliverTo: 'STORE',
          challanNo: 'CH-2231',
          vehicleNo: 'LES-4521',
          purchaseDate: '2026-10-02',
          paymentMode: 'UDHAAR',
          challanAttachmentId: IDS.challan,
          items: [{ materialId: IDS.cement, challanQty: 400 }],
        }),
        partial: ex('Steel, part paid by bank', {
          supplierId: IDS.ittefaq,
          deliverTo: 'STORE',
          challanNo: 'IT-8812',
          purchaseDate: '2026-10-02',
          paymentMode: 'PARTIAL',
          paidNowPaisa: '20000000',
          paidFrom: 'BANK',
          challanAttachmentId: IDS.challan,
          items: [{ materialId: IDS.steel, challanQty: 2, ratePaisa: '28500000' }],
        }),
        short: ex('Counted less than the challan (note required)', {
          supplierId: IDS.almadina,
          deliverTo: 'STORE',
          challanNo: 'CH-2240',
          purchaseDate: '2026-10-04',
          challanAttachmentId: IDS.challan,
          items: [{ materialId: IDS.cement, challanQty: 200, countedQty: 196, damagedQty: 2, note: '4 bags missing, 2 torn' }],
        }),
        site: ex('Direct to site (counted there)', {
          supplierId: IDS.almadina,
          deliverTo: 'SITE',
          projectId: IDS.dha,
          challanNo: 'CH-2241',
          purchaseDate: '2026-10-05',
          paymentMode: 'CASH',
          paidFrom: 'OFFICE_CASH',
          challanAttachmentId: IDS.challan,
          items: [{ materialId: IDS.cement, challanQty: 100 }],
        }),
      }),
    },
    responses: {
      ...createdResp('Saved', purchaseExample),
      ...errors({
        400: ['VALIDATION_ERROR', 'RATE_REQUIRED', 'SHORTAGE_NOTE_REQUIRED', 'DAMAGED_EXCEEDS_COUNTED', 'INVALID_PAID_AMOUNT', 'CHALLAN_REQUIRED', 'INVALID_MATERIAL', 'SUPPLIER_INACTIVE', 'PO_SUPPLIER_MISMATCH', 'RATES_NOT_ALLOWED', 'DATE_IN_FUTURE'],
        ...AUTH,
        403: WRITE_403,
        404: ['SUPPLIER_NOT_FOUND', 'PROJECT_NOT_FOUND', 'PURCHASE_ORDER_NOT_FOUND'],
        409: ['PO_CLOSED', 'PROJECT_LOCKED', 'PROJECT_IS_DRAFT'],
      }),
    },
  });
  path(P, 'get', '/api/v1/purchases/{id}', {
    summary: 'Purchase detail',
    description:
      'Items, payment, attachments (signed links), ledger effect, corrections, returns and shortages. Amounts only with rates.view. ' +
      'While a site delivery waits for its count, MUNSHI does not see `challanQty` (blind count).',
    request: { params: idParam('Purchase') },
    responses: { ...ok('Purchase', purchaseExample), ...errors({ ...AUTH, 403: READ_403, 404: ['PURCHASE_NOT_FOUND'] }) },
  });
  path(P, 'patch', '/api/v1/purchases/{id}/rates', {
    summary: 'Add rates to a munshi purchase',
    description:
      'THEKEDAR, PM (rates.view). PENDING_RATE only (409 RATES_ALREADY_SET). Missing rates default from the supplier’s agreed rate. Posts the bill ' +
      '(and payment) to the supplier ledger and adds the stock value. Status → RECEIVED / RECEIVED_WITH_SHORTAGE.',
    request: {
      params: idParam('Purchase'),
      body: jsonBody(setRatesBody, {
        udhaar: ex('Rates, on udhaar', { items: [{ materialId: IDS.cement, ratePaisa: '143000' }] }),
        cash: ex('Paid from site cash', { items: [{ materialId: IDS.cement, ratePaisa: '143000' }], paymentMode: 'CASH', paidFrom: 'SITE_CASH' }),
      }),
    },
    responses: {
      ...ok('Priced', { ...purchaseExample, deliverTo: 'SITE', location: DHA_SITE, project: DHA, status: 'RECEIVED' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'RATE_REQUIRED', 'NOT_IN_PURCHASE', 'INVALID_PAID_AMOUNT'], ...AUTH, 403: WRITE_403, 404: ['PURCHASE_NOT_FOUND'], 409: ['RATES_ALREADY_SET'] }),
    },
  });
  path(P, 'post', '/api/v1/purchases/{id}/corrections', {
    summary: 'Correct a saved purchase',
    description:
      'THEKEDAR. The original lines stay as they were; the correction is a visible entry with a reason. Each line gets its correct ' +
      '`qty` and/or `ratePaisa`: the stock gets a CORRECTION movement and the supplier ledger an ADJUSTMENT of the bill difference.',
    request: {
      params: idParam('Purchase'),
      body: jsonBody(correctionBody, {
        rate: ex('Wrong rate entered', { reason: 'Agreed rate was Rs 1,420', items: [{ purchaseItemId: IDS.purchaseItem, ratePaisa: '142000' }] }),
        qty: ex('Wrong quantity entered', { reason: 'Typed 400, challan says 390', items: [{ purchaseItemId: IDS.purchaseItem, qty: 390 }] }),
      }),
    },
    responses: {
      ...createdResp('Corrected', { ...purchaseExample, correctedTotalPaisa: '56800000' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'NOT_IN_PURCHASE', 'NOTHING_TO_CORRECT', 'INSUFFICIENT_STOCK'], ...AUTH, 403: WRITE_403, 404: ['PURCHASE_NOT_FOUND'], 409: ['PURCHASE_NOT_FINAL'] }),
    },
  });
  const returnExample = {
    id: '0199a8c0-0000-7000-8000-000000000704',
    number: 'PRN-0001',
    purchase: { id: IDS.purchase, number: 'PUR-2026-0003', challanNo: 'CH-2231' },
    supplier: { id: IDS.almadina, name: ALMADINA.name },
    location: STORE,
    reason: 'Hardened bags',
    note: null,
    attachmentId: null,
    items: [{ material: CEMENT, qty: 10, ratePaisa: '143000', amountPaisa: '1430000' }],
    totalPaisa: '1430000',
    createdBy: KHALID,
    createdAt: '2026-10-05T07:00:00.000Z',
  };
  path(P, 'post', '/api/v1/purchases/{id}/returns', {
    summary: 'Return goods to the supplier',
    description:
      'THEKEDAR, PM (rates.view). Saved / received purchases only. Quantity ≤ what is left of the purchase (400 RETURN_EXCEEDS_PURCHASE) and ≤ ' +
      'the stock at its location (400 RETURN_EXCEEDS_STOCK). Leaves stock at the purchase rate and credits the supplier.',
    request: {
      params: idParam('Purchase'),
      body: jsonBody(purchaseReturnBody, {
        hardened: ex('10 hardened bags back', { reason: 'Hardened bags', items: [{ materialId: IDS.cement, qty: 10 }] }),
        bad: ex('❌ More than in stock → 400', { reason: 'Test', items: [{ materialId: IDS.cement, qty: 100000 }] }),
      }),
    },
    responses: {
      ...createdResp('Returned', returnExample),
      ...errors({ 400: ['VALIDATION_ERROR', 'NOT_IN_PURCHASE', 'RETURN_EXCEEDS_PURCHASE', 'RETURN_EXCEEDS_STOCK', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['PURCHASE_NOT_FOUND'], 409: ['PURCHASE_NOT_FINAL'] }),
    },
  });
  path(P, 'get', '/api/v1/purchase-returns', {
    summary: 'Purchase returns',
    description: 'THEKEDAR, PM (rates.view). Filter by supplier or purchase.',
    request: { query: listReturnsQuery },
    responses: { ...ok('Returns', [returnExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });

  // ─── Receiving: direct site purchases ────────────────────────────────────
  path('Receiving', 'post', '/api/v1/purchases/{id}/receive', {
    summary: 'Receive a direct site delivery (blind count)',
    description:
      'THEKEDAR, PM, MUNSHI with access to the site. Count every material (`countedQty`, `damagedQty`); good quantity below the challan ' +
      'needs a note. Stock goes in at the purchase rate; differences become SUPPLIER_SHORT / DAMAGED shortages. The response reveals challan ' +
      'vs counted vs difference. A second receive → 409 ALREADY_RECEIVED.',
    request: {
      params: idParam('Purchase'),
      body: jsonBody(receivePurchaseBody, {
        complete: ex('All 10,000 bricks arrived', { items: [{ materialId: IDS.bricks, countedQty: 10000 }] }),
        short: ex('Short and broken bricks', { items: [{ materialId: IDS.bricks, countedQty: 9800, damagedQty: 150, note: 'Trolley short, 150 broken' }] }),
      }),
    },
    responses: {
      ...ok('Received', {
        purchase: { ...purchaseExample, deliverTo: 'SITE', location: DHA_SITE, project: DHA, status: 'RECEIVED_WITH_SHORTAGE' },
        comparison: [{ material: BRICKS, expectedQty: 10000, countedQty: 9800, damagedQty: 150, goodQty: 9650, differenceQty: -350, result: 'SHORT_AND_DAMAGED' }],
      }),
      ...errors({ 400: ['VALIDATION_ERROR', 'ITEMS_MISMATCH', 'SHORTAGE_NOTE_REQUIRED', 'DAMAGED_EXCEEDS_COUNTED'], ...AUTH, 403: WRITE_403, 404: ['PURCHASE_NOT_FOUND', 'PROJECT_NOT_FOUND'], 409: ['ALREADY_RECEIVED'] }),
    },
  });

  // ─── Purchase orders ─────────────────────────────────────────────────────
  const O = 'Purchase Orders';
  path(O, 'get', '/api/v1/purchase-orders', {
    summary: 'List purchase orders',
    description: 'THEKEDAR, PM (rates.view). Status follows the linked purchases: OPEN → PARTLY_RECEIVED → RECEIVED (or CANCELLED).',
    request: { query: listPurchaseOrdersQuery },
    responses: { ...ok('Orders', [poExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(O, 'post', '/api/v1/purchase-orders', {
    summary: 'Create a purchase order',
    description: 'THEKEDAR, PM. Purchases can link to it (`purchaseOrderId`) and take its rates.',
    request: {
      body: jsonBody(createPurchaseOrderBody, {
        store: ex('600 bags for the store', { supplierId: IDS.almadina, deliverTo: 'STORE', expectedDate: '2026-10-10', items: [{ materialId: IDS.cement, orderedQty: 600, ratePaisa: '143000' }] }),
        site: ex('Steel straight to Bahria', { supplierId: IDS.ittefaq, deliverTo: 'SITE', projectId: IDS.bahria, items: [{ materialId: IDS.steel, orderedQty: 3, ratePaisa: '28500000' }] }),
      }),
    },
    responses: {
      ...createdResp('Created', { ...poExample, status: 'OPEN', purchases: [] }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_MATERIAL', 'SUPPLIER_INACTIVE'], ...AUTH, 403: WRITE_403, 404: ['SUPPLIER_NOT_FOUND', 'PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'] }),
    },
  });
  path(O, 'get', '/api/v1/purchase-orders/{id}', {
    summary: 'Purchase order detail',
    description: 'THEKEDAR, PM. Ordered vs received vs pending per material, and the linked purchases.',
    request: { params: idParam('Purchase order') },
    responses: { ...ok('Order', poExample), ...errors({ ...AUTH, 403: READ_403, 404: ['PURCHASE_ORDER_NOT_FOUND'] }) },
  });
  path(O, 'patch', '/api/v1/purchase-orders/{id}', {
    summary: 'Edit an open purchase order',
    description: 'THEKEDAR, PM. OPEN orders only (409 PURCHASE_ORDER_LOCKED). `items` replaces all lines.',
    request: {
      params: idParam('Purchase order'),
      body: jsonBody(updatePurchaseOrderBody, {
        date: ex('Move the expected date', { expectedDate: '2026-10-12' }),
        items: ex('Change the quantity', { items: [{ materialId: IDS.cement, orderedQty: 800, ratePaisa: '143000' }] }),
      }),
    },
    responses: { ...ok('Updated', { ...poExample, status: 'OPEN' }), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_MATERIAL'], ...AUTH, 403: WRITE_403, 404: ['PURCHASE_ORDER_NOT_FOUND'], 409: ['PURCHASE_ORDER_LOCKED'] }) },
  });
  path(O, 'post', '/api/v1/purchase-orders/{id}/cancel', {
    summary: 'Cancel a purchase order',
    description: 'THEKEDAR, PM. Only OPEN orders without any linked purchase (409 PURCHASE_ORDER_HAS_RECEIPTS).',
    request: { params: idParam('Purchase order') },
    responses: { ...ok('Cancelled', { ...poExample, status: 'CANCELLED', purchases: [] }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['PURCHASE_ORDER_NOT_FOUND'], 409: ['PURCHASE_ORDER_HAS_RECEIPTS', 'PURCHASE_ORDER_CANCELLED'] }) },
  });

  // ─── Supplier ledger + payments ──────────────────────────────────────────
  const L = 'Supplier Ledger';
  path(L, 'get', '/api/v1/suppliers/{id}/ledger', {
    summary: 'Supplier ledger (udhaar)',
    description:
      'THEKEDAR, PM (rates.view). Entries newest first with the running balance of the whole account; filter by project or dates. ' +
      '`oldestUnpaidDays`: payments settle the oldest debits first (FIFO).',
    request: { params: idParam('Supplier'), query: ledgerQuery },
    responses: {
      ...ok(
        'Ledger',
        {
          supplier: ALMADINA,
          udhaarBalancePaisa: '74000000',
          oldestUnpaidDays: 34,
          openingBalancePaisa: '0',
          totals: { debitPaisa: '74000000', creditPaisa: '0' },
          entries: [{ id: '0199a8c0-0000-7000-8000-000000000d01', type: 'PURCHASE', amountPaisa: '57200000', runningBalancePaisa: '74000000', refType: 'PURCHASE', refId: IDS.purchase, project: null, occurredAt: '2026-10-02T07:00:00.000Z', note: 'PUR-2026-0003', createdBy: KHALID }],
        },
        page(2),
      ),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['SUPPLIER_NOT_FOUND', 'PROJECT_NOT_FOUND'] }),
    },
  });
  path(L, 'get', '/api/v1/supplier-payments', {
    summary: 'Supplier payments',
    description: 'THEKEDAR, PM (rates.view). Filter by supplier, method, status and date. `meta.totalPaidPaisa` excludes bounced cheques.',
    request: { query: listPaymentsQuery },
    responses: { ...ok('Payments', [paymentExample], { ...page(1), totalPaidPaisa: '15000000' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(L, 'post', '/api/v1/supplier-payments', {
    summary: 'Record a supplier payment',
    description: 'THEKEDAR. Credits the supplier ledger. Cheques start PENDING (cheque number required) until marked cleared or bounced.',
    request: {
      body: jsonBody(createPaymentBody, {
        cash: ex('Cash Rs 1,00,000', { supplierId: IDS.almadina, amountPaisa: '10000000', method: 'CASH', paidOn: '2026-10-05' }),
        cheque: ex('Cheque Rs 1,50,000', { supplierId: IDS.ittefaq, amountPaisa: '15000000', method: 'CHEQUE', chequeNo: '00412377', chequeDate: '2026-10-04', paidOn: '2026-10-04' }),
        bad: ex('❌ Cheque without number → 400', { supplierId: IDS.ittefaq, amountPaisa: '100', method: 'CHEQUE', paidOn: '2026-10-04' }),
      }),
    },
    responses: { ...createdResp('Recorded', paymentExample), ...errors({ 400: ['VALIDATION_ERROR', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, 404: ['SUPPLIER_NOT_FOUND', 'PROJECT_NOT_FOUND'] }) },
  });
  path(L, 'patch', '/api/v1/supplier-payments/{id}/cheque-status', {
    summary: 'Mark a cheque cleared or bounced',
    description: 'THEKEDAR. PENDING cheques only. BOUNCED adds a PAYMENT_REVERSAL to the ledger (the supplier is owed the amount again).',
    request: {
      params: idParam('Payment'),
      body: jsonBody(chequeStatusBody, { cleared: ex('Cleared', { status: 'CLEARED' }), bounced: ex('Bounced', { status: 'BOUNCED', note: 'Insufficient funds' }) }),
    },
    responses: {
      ...ok('Updated', { ...paymentExample, status: 'BOUNCED', statusChangedAt: '2026-10-05T07:00:00.000Z' }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['PAYMENT_NOT_FOUND'], 409: ['NOT_A_CHEQUE', 'CHEQUE_ALREADY_SETTLED'] }),
    },
  });
}
