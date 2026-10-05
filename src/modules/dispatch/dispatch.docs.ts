import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, BRICKS, CEMENT, DHA_SITE, IDS, KHALID, RAFAQAT, READ_403, STORE, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import { createDispatchBody, listDispatchesQuery, listShortagesQuery, ownerDeliveriesQuery, ownerDeliveryBody, receiveDispatchBody, resolveShortageBody } from './dispatch.schema.js';

const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };

const dispatchExample = {
  id: IDS.dispatch,
  number: 'GP-0142',
  from: STORE,
  to: DHA_SITE,
  vehicleNo: 'LES-4521',
  driverName: 'Nadeem',
  driverPhone: '+923001112233',
  dispatchedAt: '2026-10-03T05:00:00.000Z',
  status: 'ON_THE_WAY',
  note: null,
  blindCount: false,
  loadPhotoUrl: null,
  items: [
    { id: '0199a8c0-0000-7000-8000-000000000811', material: CEMENT, sentQty: 200, receivedQty: null, damagedQty: null, goodQty: null, differenceQty: null, note: null, photoUrl: null, unitCostPaisa: '145333', valuePaisa: '29066600' },
    { id: '0199a8c0-0000-7000-8000-000000000812', material: BRICKS, sentQty: 5000, receivedQty: null, damagedQty: null, goodQty: null, differenceQty: null, note: null, photoUrl: null, unitCostPaisa: '1700', valuePaisa: '8500000' },
  ],
  totalValuePaisa: '37566600',
  shortages: [],
  receivedBy: null,
  receivedAt: null,
  receiveNote: null,
  cancelledAt: null,
  createdBy: KHALID,
  createdAt: '2026-10-03T05:00:00.000Z',
};

const shortageExample = {
  id: IDS.shortage,
  kind: 'DISPATCH_SHORT',
  source: 'DISPATCH',
  status: 'OPEN',
  material: CEMENT,
  qty: 10,
  valuePaisa: '1453330',
  location: DHA_SITE,
  project: DHA,
  dispatch: { id: IDS.dispatch, number: 'GP-0142', vehicleNo: 'LES-4521', driverName: 'Nadeem', driverPhone: '+923001112233' },
  purchase: null,
  note: '10 bags missing from the truck',
  allowedResolutions: ['SEND_REMAINING', 'RETURN_TO_STORE', 'ACCEPT_LOSS', 'RECOVER_FROM_DRIVER'],
  resolution: null,
  resolutionNote: null,
  recoveredAmountPaisa: null,
  newDispatch: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: '2026-10-03T09:00:00.000Z',
};

export function registerDispatchDocs(): void {
  const D = 'Dispatch';
  path(D, 'get', '/api/v1/dispatches', {
    summary: 'List dispatches (gate passes)',
    description: 'All roles. PM / MUNSHI only see dispatches to or from their sites. Values only with rates.view; sent quantities are hidden from MUNSHI while on the way (blind count).',
    request: { query: listDispatchesQuery },
    responses: { ...ok('Dispatches', [dispatchExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(D, 'post', '/api/v1/dispatches', {
    summary: 'Dispatch stock to a site',
    description:
      'THEKEDAR from the store or any site; PM only from a site they manage (to the store or another of their sites). Every item must be in ' +
      'stock at the source (400 INSUFFICIENT_STOCK with `available`). Stock leaves at the average cost into transit; the destination PM and ' +
      'munshis get an SMS, e.g. “GP-0142: 200 bags cement aur 5,000 eent aap ki site par aa rahe hain (LES-4521).”',
    request: {
      body: jsonBody(createDispatchBody, {
        dha: ex('Cement and bricks to DHA', {
          fromLocationId: IDS.store,
          toProjectId: IDS.dha,
          vehicleNo: 'LES-4521',
          driverName: 'Nadeem',
          driverPhone: '0300-1112233',
          items: [
            { materialId: IDS.cement, qty: 200 },
            { materialId: IDS.bricks, qty: 5000 },
          ],
        }),
        transfer: ex('Site-to-site transfer', { fromLocationId: IDS.dhaSite, toProjectId: IDS.bahria, items: [{ materialId: IDS.cement, qty: 20 }], note: 'Extra bags from DHA' }),
      }),
    },
    responses: {
      ...createdResp('Dispatched', dispatchExample),
      ...errors({
        400: ['VALIDATION_ERROR', 'INSUFFICIENT_STOCK', 'INVALID_LOCATION', 'SAME_LOCATION', 'INVALID_MATERIAL', 'INVALID_ATTACHMENT', 'DATE_IN_FUTURE'],
        ...AUTH,
        403: WRITE_403,
        404: ['LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'],
        409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'],
      }),
    },
  });
  path(D, 'get', '/api/v1/dispatches/{id}', {
    summary: 'Dispatch detail',
    description: 'Sent vs received vs damaged per material, shortages found, photos.',
    request: { params: idParam('Dispatch') },
    responses: { ...ok('Dispatch', dispatchExample), ...errors({ ...AUTH, 403: READ_403, 404: ['DISPATCH_NOT_FOUND'] }) },
  });
  path(D, 'post', '/api/v1/dispatches/{id}/cancel', {
    summary: 'Cancel a dispatch on the way',
    description: 'THEKEDAR (PM for their own site transfers). ON_THE_WAY only (409 DISPATCH_NOT_CANCELLABLE). The stock comes out of transit back to the source at the same value.',
    request: { params: idParam('Dispatch') },
    responses: { ...ok('Cancelled', { ...dispatchExample, status: 'CANCELLED', cancelledAt: '2026-10-03T06:00:00.000Z' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['DISPATCH_NOT_FOUND', 'LOCATION_NOT_FOUND'], 409: ['DISPATCH_NOT_CANCELLABLE'] }) },
  });

  const R = 'Receiving';
  path(R, 'get', '/api/v1/projects/{id}/incoming', {
    summary: 'Incoming material for a site',
    description:
      'All roles with project access. Dispatches on the way and direct purchases waiting for the count. With blind count on (company setting, ' +
      'default) `sentQty` / `challanQty` are left out, so the site counts what really arrived. Never shows values.',
    request: { params: idParam('Project') },
    responses: {
      ...ok('Incoming', {
        blindCount: true,
        count: 2,
        dispatches: [{ type: 'DISPATCH', id: IDS.dispatch, number: 'GP-0144', from: STORE, vehicleNo: 'LEA-1029', driverName: 'Akbar', driverPhone: '+923004445566', dispatchedAt: '2026-10-05T05:00:00.000Z', items: [{ material: CEMENT }] }],
        purchases: [{ type: 'PURCHASE', id: IDS.purchase, number: 'PUR-2026-0006', supplier: { id: IDS.almadina, name: 'Chaudhry Bricks Kiln', phone: '+923216549870' }, challanNo: 'CB-1190', vehicleNo: null, purchaseDate: '2026-10-04', items: [{ material: BRICKS }] }],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(R, 'post', '/api/v1/dispatches/{id}/receive', {
    summary: 'Receive a dispatch (blind count)',
    description:
      'THEKEDAR, PM, MUNSHI with access to the destination site. Count every material: `receivedQty` (all that arrived) and `damagedQty`. ' +
      'Good quantity below the sent quantity needs a note (400 SHORTAGE_NOTE_REQUIRED). Transit is cleared, the good quantity enters the site at ' +
      'the dispatch cost, and each difference becomes a shortage (DISPATCH_SHORT / DAMAGED / EXCESS) with its value. The response reveals sent vs ' +
      'counted vs difference. A second receive → 409 ALREADY_RECEIVED.',
    request: {
      params: idParam('Dispatch'),
      body: jsonBody(receiveDispatchBody, {
        complete: ex('Everything arrived', { items: [{ materialId: IDS.cement, receivedQty: 200 }, { materialId: IDS.bricks, receivedQty: 5000 }] }),
        short: ex('10 bags short, 200 bricks broken', {
          items: [
            { materialId: IDS.cement, receivedQty: 190, note: '10 bags missing from the truck' },
            { materialId: IDS.bricks, receivedQty: 5000, damagedQty: 200, note: '200 broken in unloading', photoAttachmentId: IDS.photo },
          ],
        }),
      }),
    },
    responses: {
      ...ok('Received', {
        dispatch: { ...dispatchExample, status: 'RECEIVED_WITH_SHORTAGE', receivedBy: RAFAQAT, receivedAt: '2026-10-03T09:00:00.000Z' },
        comparison: [
          { material: CEMENT, expectedQty: 200, countedQty: 190, damagedQty: 0, goodQty: 190, differenceQty: -10, result: 'SHORT' },
          { material: BRICKS, expectedQty: 5000, countedQty: 5000, damagedQty: 200, goodQty: 4800, differenceQty: -200, result: 'DAMAGED' },
        ],
      }),
      ...errors({ 400: ['VALIDATION_ERROR', 'ITEMS_MISMATCH', 'SHORTAGE_NOTE_REQUIRED', 'DAMAGED_EXCEEDS_COUNTED', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['DISPATCH_NOT_FOUND', 'PROJECT_NOT_FOUND'], 409: ['ALREADY_RECEIVED', 'DISPATCH_CANCELLED'] }),
    },
  });

  const S = 'Shortages';
  path(S, 'get', '/api/v1/shortages', {
    summary: 'Shortages',
    description: 'THEKEDAR all; PM read-only for their projects. OPEN first. `meta.openCount` / `openValuePaisa` for the dashboard. `allowedResolutions` lists the valid decisions.',
    request: { query: listShortagesQuery },
    responses: { ...ok('Shortages', [shortageExample], { ...page(1), openCount: 2, openValuePaisa: '1793330' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(S, 'post', '/api/v1/shortages/{id}/resolve', {
    summary: 'Decide on a shortage',
    description:
      'THEKEDAR. `note` required. **SEND_REMAINING** — a new dispatch of the quantity from the same source (stock checked). **RETURN_TO_STORE** — ' +
      'the goods go back to the source (EXCESS: back from the site). **ACCEPT_LOSS** — accepted as is. **RECOVER_FROM_DRIVER** — ' +
      '`recoveredAmountPaisa` required. **SUPPLIER_CREDIT** — purchase shortages only: the supplier ledger is credited with the value. ' +
      'Already resolved → 409.',
    request: {
      params: idParam('Shortage'),
      body: jsonBody(resolveShortageBody, {
        send: ex('Send the remaining 10 bags', { resolution: 'SEND_REMAINING', note: 'Loaded short at the store', vehicleNo: 'LES-4521' }),
        driver: ex('Driver pays for the bags', { resolution: 'RECOVER_FROM_DRIVER', note: 'Nadeem admitted, pays from wages', recoveredAmountPaisa: '1453330' }),
        accept: ex('Accept the breakage', { resolution: 'ACCEPT_LOSS', note: 'Normal breakage in unloading' }),
        credit: ex('Supplier credits the short bags', { resolution: 'SUPPLIER_CREDIT', note: 'Al-Madina agreed on phone' }),
      }),
    },
    responses: {
      ...ok('Resolved', { ...shortageExample, status: 'RESOLVED', resolution: 'SEND_REMAINING', resolutionNote: 'Loaded short at the store', newDispatch: { id: IDS.dispatch, number: 'GP-0145' }, resolvedBy: KHALID, resolvedAt: '2026-10-04T05:00:00.000Z' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'RESOLUTION_NOT_ALLOWED', 'INSUFFICIENT_STOCK'], ...AUTH, 403: WRITE_403, 404: ['SHORTAGE_NOT_FOUND'], 409: ['SHORTAGE_RESOLVED'] }),
    },
  });

  const O = 'Owner Deliveries';
  const deliveryExample = {
    id: '0199a8c0-0000-7000-8000-000000000e01',
    projectId: IDS.dha,
    deliveryDate: '2026-10-05',
    note: 'Owner sent tiles from his dealer',
    items: [{ material: { id: IDS.tiles, name: 'Floor tiles', unit: 'sqft' }, qty: 1200 }],
    photos: [],
    createdBy: RAFAQAT,
    createdAt: '2026-10-05T10:00:00.000Z',
  };
  path(O, 'get', '/api/v1/projects/{id}/owner-deliveries', {
    summary: 'Owner deliveries of a project',
    description: 'All roles with project access.',
    request: { params: idParam('Project'), query: ownerDeliveriesQuery },
    responses: { ...ok('Deliveries', [deliveryExample], page(1)), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(O, 'post', '/api/v1/projects/{id}/owner-deliveries', {
    summary: 'Record an owner delivery',
    description:
      'All roles with project access (ACTIVE / CLOSEOUT). Only materials in a category the owner supplies on this project (400 NOT_OWNER_SUPPLIED). ' +
      'Enters the site’s owner-supplied stock at cost 0.',
    request: {
      params: idParam('Project'),
      body: jsonBody(ownerDeliveryBody, {
        tiles: ex('Tiles from the owner', { deliveryDate: '2026-10-05', items: [{ materialId: IDS.tiles, qty: 1200 }], note: 'Owner sent tiles from his dealer' }),
        bad: ex('❌ Cement is ours to supply → 400', { deliveryDate: '2026-10-05', items: [{ materialId: IDS.cement, qty: 10 }] }),
      }),
    },
    responses: {
      ...createdResp('Recorded', deliveryExample),
      ...errors({ 400: ['VALIDATION_ERROR', 'NOT_OWNER_SUPPLIED', 'INVALID_MATERIAL', 'INVALID_ATTACHMENT', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'] }),
    },
  });
}
