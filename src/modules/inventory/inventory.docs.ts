import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, CEMENT, BRICKS, DHA_SITE, IDS, KHALID, RAFAQAT, READ_403, STORE, WRITE_403, createdResp, ex, idParam, ok, page, path } from './docs.shared.js';
import { locationParams, lowStockLevelsBody, movementsQuery, stockCountBody, stockCountsQuery, storeStockQuery, usageBody, usageListQuery } from './inventory.schema.js';

const storeRow = {
  material: { ...CEMENT, group: { code: 'CEMENT', name: 'Cement' } },
  inStore: 220,
  inTransit: 100,
  avgRatePaisa: '145302',
  valuePaisa: '31966440',
  lastPurchaseAt: '2026-10-02T07:00:00.000Z',
  minQty: 200,
  lowStock: false,
};

export function registerInventoryDocs(): void {
  const S = 'Stock';
  path(S, 'get', '/api/v1/stock-locations', {
    summary: 'Stock locations',
    description:
      'All roles. THEKEDAR sees every location; PM the Central Store, transit and their project sites; MUNSHI only their project sites. ' +
      'Every company has one Central Store and one in-transit location; every non-draft project has a site location.',
    responses: {
      ...ok('Locations', [
        { ...STORE, isActive: true, project: null },
        { id: IDS.transit, type: 'TRANSIT', name: 'In transit', projectId: null, isActive: true, project: null },
        { ...DHA_SITE, isActive: true, project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' } },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(S, 'get', '/api/v1/stores/{locationId}/stock', {
    summary: 'Store stock',
    description:
      'THEKEDAR, PM (rates.view). Per material: quantity in the store, quantity on the way to sites, weighted-average rate, value, ' +
      'last purchase and low-stock flag. Summary: total value, low-stock count, dispatches on the way.',
    request: { params: locationParams, query: storeStockQuery },
    responses: {
      ...ok('Store stock', { location: STORE, summary: { totalValuePaisa: '68420000', materials: 4, lowStockCount: 2, dispatchesOnTheWay: 2 }, items: [storeRow] }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['STORE_NOT_FOUND', 'LOCATION_NOT_FOUND'] }),
    },
  });
  path(S, 'put', '/api/v1/stores/{locationId}/low-stock-levels', {
    summary: 'Set low-stock levels',
    description: 'THEKEDAR. Below `minQty` a material shows as low stock. `minQty: 0` removes the level. Returns all levels of the location.',
    request: {
      params: locationParams,
      body: jsonBody(lowStockLevelsBody, {
        cement: ex('Cement 200 bags, bricks 5,000', [
          { materialId: IDS.cement, minQty: 200 },
          { materialId: IDS.bricks, minQty: 5000 },
        ]),
        remove: ex('Remove the bricks level', [{ materialId: IDS.bricks, minQty: 0 }]),
      }),
    },
    responses: {
      ...ok('Levels', [{ material: CEMENT, minQty: 200 }]),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['LOCATION_NOT_FOUND', 'INVALID_MATERIAL'] }),
    },
  });
  path(S, 'get', '/api/v1/stock/movements', {
    summary: 'Stock movement ledger',
    description:
      'THEKEDAR, PM (rates.view). The append-only ledger behind every balance, newest first. Filter by location, project (its site), ' +
      'material, type and date range (Pakistan time). PM only sees the store, transit and their sites.',
    request: { query: movementsQuery },
    responses: {
      ...ok(
        'Movements',
        [
          {
            id: '0199a8c0-0000-7000-8000-000000000a01',
            type: 'PURCHASE_IN',
            location: STORE,
            material: CEMENT,
            quantity: 400,
            ownerSupplied: false,
            unitCostPaisa: '143000',
            valuePaisa: '57200000',
            refType: 'PURCHASE',
            refId: IDS.purchase,
            note: null,
            occurredAt: '2026-10-02T07:00:00.000Z',
            createdBy: KHALID,
          },
        ],
        page(1),
      ),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'] }),
    },
  });
  path(S, 'get', '/api/v1/projects/{id}/stock', {
    summary: 'Site stock of a project',
    description:
      'All roles with access to the project. Per material: received (contractor / owner), used, transferred out, adjustments, in stock ' +
      'and last count. `avgRatePaisa` / `valuePaisa` only with rates.view (never for MUNSHI).',
    request: { params: idParam('Project') },
    responses: {
      ...ok('Site stock', {
        project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' },
        location: DHA_SITE,
        summary: { materials: 3, lastCountAt: null, totalValuePaisa: '35204500' },
        items: [
          {
            material: CEMENT,
            receivedContractor: 190,
            receivedOwner: 0,
            used: 53,
            transferredOut: 0,
            adjustments: 0,
            inStock: 137,
            inStockContractor: 137,
            inStockOwner: 0,
            lastCountAt: null,
            avgRatePaisa: '145333',
            valuePaisa: '19910621',
          },
        ],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });

  const U = 'Material Usage';
  const usageExample = {
    id: '0199a8c0-0000-7000-8000-000000000b01',
    projectId: IDS.dha,
    usageDate: '2026-10-05',
    note: 'Roof slab, first floor',
    milestoneId: null,
    items: [{ material: CEMENT, qty: 20, ownerSupplied: false, valuePaisa: '2906667' }],
    totalValuePaisa: '2906667',
    deviceCreatedAt: null,
    createdBy: RAFAQAT,
    createdAt: '2026-10-05T12:00:00.000Z',
  };
  path(U, 'get', '/api/v1/projects/{id}/material-usage', {
    summary: 'Material usage of a project',
    description: 'All roles with project access, newest first. Values only with rates.view.',
    request: { params: idParam('Project'), query: usageListQuery },
    responses: { ...ok('Usage', [usageExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(U, 'post', '/api/v1/projects/{id}/material-usage', {
    summary: 'Record material usage',
    description:
      'All roles with project access (ACTIVE / CLOSEOUT projects). Each quantity must be in the site stock (400 INSUFFICIENT_STOCK with ' +
      '`available`). Leaves at the average cost; owner-supplied stock (from the supply rules, or `ownerSupplied`) at 0.',
    request: {
      params: idParam('Project'),
      body: jsonBody(usageBody, {
        slab: ex('Cement and bricks for the day', {
          usageDate: '2026-10-05',
          items: [
            { materialId: IDS.cement, qty: 20 },
            { materialId: IDS.bricks, qty: 800 },
          ],
          note: 'Roof slab, first floor',
        }),
        offline: ex('Synced from the phone', { usageDate: '2026-10-04', items: [{ materialId: IDS.sand, qty: 40.5 }], deviceCreatedAt: '2026-10-04T16:20:00+05:00' }),
      }),
    },
    responses: {
      ...createdResp('Recorded', usageExample),
      ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_STOCK', 'INVALID_MATERIAL', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'] }),
    },
  });

  const C = 'Stock Counts';
  const countExample = {
    id: '0199a8c0-0000-7000-8000-000000000c01',
    number: 'SC-0002',
    location: DHA_SITE,
    countedAt: '2026-10-05T12:00:00.000Z',
    note: null,
    items: [
      { material: CEMENT, ownerSupplied: false, systemQty: 137, countedQty: 134, difference: -3, reason: 'HARDENED_IN_RAIN', note: 'Bags left open', valuePaisa: '-436000' },
      { material: BRICKS, ownerSupplied: false, systemQty: 3500, countedQty: 3500, difference: 0, reason: null, note: null, valuePaisa: '0' },
    ],
    summary: { materials: 2, withDifference: 1, differenceValuePaisa: '-436000' },
    createdBy: RAFAQAT,
    createdAt: '2026-10-05T12:00:00.000Z',
  };
  path(C, 'get', '/api/v1/stock-counts', {
    summary: 'Stock counts',
    description: 'All roles; PM / MUNSHI only see their locations. Filter by location or project.',
    request: { query: stockCountsQuery },
    responses: { ...ok('Counts', [countExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'] }) },
  });
  path(C, 'post', '/api/v1/stock-counts', {
    summary: 'Record a stock count',
    description:
      'Sites: THEKEDAR / PM / MUNSHI with access. The Central Store: THEKEDAR only (403). The system quantity is taken by the server; a ' +
      'non-zero difference needs a `reason` (400 REASON_REQUIRED) and becomes a COUNT_ADJUSTMENT. The response shows system vs counted.',
    request: {
      body: jsonBody(stockCountBody, {
        site: ex('Site count with a difference', {
          locationId: IDS.dhaSite,
          items: [
            { materialId: IDS.cement, countedQty: 134, reason: 'HARDENED_IN_RAIN', note: 'Bags left open' },
            { materialId: IDS.bricks, countedQty: 3500 },
          ],
        }),
        bad: ex('❌ Difference without a reason → 400', { locationId: IDS.dhaSite, items: [{ materialId: IDS.cement, countedQty: 1 }] }),
      }),
    },
    responses: {
      ...createdResp('Counted', countExample),
      ...errors({
        400: ['VALIDATION_ERROR', 'REASON_REQUIRED', 'INVALID_LOCATION', 'INVALID_MATERIAL', 'DATE_IN_FUTURE'],
        ...AUTH,
        403: WRITE_403,
        404: ['LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'],
        409: ['PROJECT_LOCKED'],
      }),
    },
  });
}
