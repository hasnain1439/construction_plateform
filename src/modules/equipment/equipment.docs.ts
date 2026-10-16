import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, DHA_SITE, IDS, KHALID, RAFAQAT, READ_403, STORE, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import * as S from './equipment.schema.js';

const T = 'Equipment';
const E_IDS = {
  plates: '0199a8c0-0000-7000-8000-000000001601',
  props: '0199a8c0-0000-7000-8000-000000001602',
  mixer: '0199a8c0-0000-7000-8000-000000001603',
  transfer: '0199a8c0-0000-7000-8000-000000001611',
  transferItem: '0199a8c0-0000-7000-8000-000000001612',
  rental: '0199a8c0-0000-7000-8000-000000001621',
  rentalItem: '0199a8c0-0000-7000-8000-000000001622',
  loss: '0199a8c0-0000-7000-8000-000000001631',
  punjabYard: '0199a8c0-0000-7000-8000-0000000000f5',
  subcontract: '0199a8c0-0000-7000-8000-000000001641',
};
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };
const PLATES = { id: E_IDS.plates, name: 'Steel shuttering plate 2×3 ft', code: 'SP-23', unit: 'nos', kind: 'BULK', category: 'SHUTTERING_PLATE' };
const PROPS = { id: E_IDS.props, name: 'Steel prop (adjustable)', code: 'PR-01', unit: 'nos', kind: 'BULK', category: 'PROP' };

const equipmentExample = {
  ...PLATES,
  serialNo: null,
  coverageSqftPerUnit: 6,
  isActive: true,
  notes: null,
  hireRatePaisaPerDay: '500',
  replacementValuePaisa: '450000',
  ownedQty: 400,
  rentedQty: 0,
  atSitesQty: 380,
  atYardQty: 20,
  inTransitQty: 0,
  createdAt: '2026-09-01T05:00:00.000Z',
  updatedAt: '2026-09-01T05:00:00.000Z',
};
const detailExample = { ...equipmentExample, locations: [{ location: STORE, ownedQty: 20, rentedQty: 0 }, { location: DHA_SITE, ownedQty: 240, rentedQty: 0 }] };

const transferExample = {
  id: E_IDS.transfer,
  number: 'ET-0003',
  kind: 'DISPATCH',
  status: 'RECEIVED_WITH_GAP',
  from: STORE,
  to: DHA_SITE,
  vehicleNo: 'LES-4521',
  driverName: 'Nadeem',
  note: null,
  sentAt: '2026-10-10T05:00:00.000Z',
  blindCount: false,
  items: [{ id: E_IDS.transferItem, equipment: PLATES, rental: null, sentQty: 100, receivedQty: 96, damagedQty: 2, gapQty: 4, note: '4 plates missing, 2 bent', photoUrl: null, replacementValuePaisa: '450000' }],
  losses: [
    { id: E_IDS.loss, number: 'EL-0002', kind: 'MISSING', qty: 4 },
    { id: '0199a8c0-0000-7000-8000-000000001632', number: 'EL-0003', kind: 'DAMAGED', qty: 2 },
  ],
  receivedBy: RAFAQAT,
  receivedAt: '2026-10-10T09:00:00.000Z',
  receiveNote: null,
  cancelledAt: null,
  createdBy: KHALID,
  createdAt: '2026-10-10T05:00:00.000Z',
};

const rentalExample = {
  id: E_IDS.rental,
  number: 'RNT-0001',
  status: 'ACTIVE',
  supplier: { id: E_IDS.punjabYard, name: 'Punjab Shuttering Yard', phone: '+923214445566' },
  project: DHA,
  location: DHA_SITE,
  startDate: '2026-10-01',
  expectedEndDate: '2026-10-31',
  returnedDate: null,
  closedAt: null,
  reference: 'PSY-2231',
  note: null,
  items: [{ id: E_IDS.rentalItem, equipment: PROPS, qty: 150, returnedQty: 0, missingQty: 0, outstandingQty: 150, ratePaisaPerDay: '1500' }],
  depositPaisa: '2000000',
  depositRefundedPaisa: '0',
  damageChargesPaisa: '0',
  rentChargedPaisa: '0',
  accruedToDatePaisa: '3600000',
  postedPaisa: '3375000',
  daysOnRent: 16,
  overdue: false,
  returns: [],
  createdBy: KHALID,
  createdAt: '2026-10-01T05:00:00.000Z',
};

const lossExample = {
  id: E_IDS.loss,
  number: 'EL-0001',
  kind: 'MISSING',
  status: 'REPORTED',
  source: 'REPORT',
  equipment: PLATES,
  rental: null,
  location: DHA_SITE,
  project: DHA,
  transfer: null,
  qty: 6,
  valuePaisa: '2700000',
  chargedTo: null,
  subcontract: null,
  note: '6 plates not found after the GF slab de-shuttering',
  photoUrl: null,
  reportedBy: RAFAQAT,
  reportedAt: '2026-10-12T10:00:00.000Z',
  chargedBy: null,
  chargedAt: null,
  chargeNote: null,
};

const ERR_LOC = { 404: ['LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'] };

export function registerEquipmentDocs(): void {
  const money = 'Rates, values and amounts are left out without fields.rates (Munshi never sees them).';

  path(T, 'get', '/api/v1/equipment', {
    summary: 'Equipment register',
    description: `equipment.view. Machines and bulk items with company-wide totals (owned / on rent / at sites / at the yard / in transit). ${money}`,
    request: { query: S.listEquipmentQuery },
    responses: { ...ok('Equipment', [equipmentExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/equipment', {
    summary: 'Add equipment',
    description: 'equipment.manage. Name unique per company (409 EQUIPMENT_EXISTS). Quantities come in through stock-in (opening / purchase) or rentals.',
    request: {
      body: jsonBody(S.createEquipmentBody, {
        plates: ex('Shuttering plates', { name: 'Steel shuttering plate 2×3 ft', code: 'SP-23', kind: 'BULK', category: 'SHUTTERING_PLATE', hireRatePaisaPerDay: '500', replacementValuePaisa: '450000', coverageSqftPerUnit: 6 }),
        mixer: ex('Concrete mixer', { name: 'Concrete mixer 1 bag (diesel)', code: 'MX-01', kind: 'MACHINE', category: 'MIXER', serialNo: 'KM-77812', hireRatePaisaPerDay: '250000', replacementValuePaisa: '45000000' }),
      }),
    },
    responses: { ...createdResp('Created', detailExample), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 409: ['EQUIPMENT_EXISTS'] }) },
  });
  path(T, 'get', '/api/v1/equipment/{id}', {
    summary: 'Equipment detail',
    description: `equipment.view. Totals plus quantity per location the caller can see. ${money}`,
    request: { params: idParam('Equipment') },
    responses: { ...ok('Equipment', detailExample), ...errors({ ...AUTH, 403: READ_403, 404: ['EQUIPMENT_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/equipment/{id}', {
    summary: 'Edit equipment',
    description: 'equipment.manage. A new hire rate applies to days not charged yet (posted days keep their rate).',
    request: { params: idParam('Equipment'), body: jsonBody(S.updateEquipmentBody, { rate: ex('New hire rate', { hireRatePaisaPerDay: '600' }), off: ex('Retire', { isActive: false }) }) },
    responses: { ...ok('Updated', detailExample), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['EQUIPMENT_NOT_FOUND'], 409: ['EQUIPMENT_EXISTS'] }) },
  });
  path(T, 'post', '/api/v1/equipment/{id}/stock-in', {
    summary: 'Stock in (opening / purchase)',
    description: 'equipment.manage. Owned units into the yard (default) or a site: OPENING_IN / PURCHASE_IN ledger row.',
    request: { params: idParam('Equipment'), body: jsonBody(S.stockInBody, { opening: ex('Opening: 400 plates at the yard', { qty: 400, type: 'OPENING', date: '2026-09-01' }) }) },
    responses: { ...createdResp('Stocked in', detailExample), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_LOCATION', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, 404: ['EQUIPMENT_NOT_FOUND', 'LOCATION_NOT_FOUND', 'PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/equipment/{id}/adjust', {
    summary: 'Adjust a location (count correction, disposal, found)',
    description: 'equipment.manage. Signed quantity → ADJUSTMENT ledger row with the reason (audit). Negative needs the units to be there.',
    request: { params: idParam('Equipment'), body: jsonBody(S.adjustBody, { scrap: ex('4 bent plates scrapped', { locationId: IDS.store, qty: -4, reason: 'Bent beyond repair — sold as scrap' }) }) },
    responses: { ...ok('Adjusted', detailExample), ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_EQUIPMENT', 'INVALID_RENTAL'], ...AUTH, 403: WRITE_403, 404: ['EQUIPMENT_NOT_FOUND', 'LOCATION_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/equipment/balances', {
    summary: 'Allocation map — what is where',
    description: 'equipment.view. Per location the caller can see (yard, transit, sites): owned and rented quantity per equipment, with the rentals; plus totals per equipment. Zero rows are left out.',
    request: { query: S.balancesQuery },
    responses: {
      ...ok('Allocation', {
        locations: [
          { location: STORE, project: null, items: [{ equipment: PLATES, ownedQty: 20, rentedQty: 0, totalQty: 20, rentals: [] }] },
          { location: DHA_SITE, project: DHA, items: [{ equipment: PLATES, ownedQty: 240, rentedQty: 0, totalQty: 240, rentals: [] }, { equipment: PROPS, ownedQty: 60, rentedQty: 150, totalQty: 210, rentals: [{ id: E_IDS.rental, number: 'RNT-0001', qty: 150 }] }] },
        ],
        totals: [{ equipment: PLATES, ownedQty: 400, rentedQty: 0, atYardQty: 20, atSitesQty: 380, inTransitQty: 0 }],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/equipment/movements', {
    summary: 'Equipment ledger',
    description: 'equipment.view. Append-only movements (signed quantity) at the locations the caller can see.',
    request: { query: S.movementsQuery },
    responses: {
      ...ok('Movements', [{ id: '0199a8c0-0000-7000-8000-000000001651', type: 'RECEIPT_IN', equipment: PLATES, location: DHA_SITE, rental: null, quantity: 96, refType: 'EQUIPMENT_TRANSFER', refId: E_IDS.transfer, occurredAt: '2026-10-10T09:00:00.000Z', note: 'ET-0003', createdBy: RAFAQAT }], page(1)),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/equipment', {
    summary: 'Equipment on site',
    description: `equipment.view + project scope. Owned / rented units at the site, transfers on the way, active rentals, losses not charged yet, hire and rent posted to date. ${money}`,
    request: { params: idParam('Project') },
    responses: {
      ...ok('On site', {
        site: DHA_SITE,
        items: [{ equipment: PLATES, ownedQty: 240, rentedQty: 0, hireRatePaisaPerDay: '500', dailyHirePaisa: '120000' }],
        incoming: [],
        rentals: [rentalExample],
        openLosses: [lossExample],
        hireToDatePaisa: '1800000',
        rentalToDatePaisa: '3375000',
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });

  // Transfers
  path(T, 'get', '/api/v1/equipment/transfers', {
    summary: 'Transfers (dispatch / transfer / return)',
    description: 'equipment.view. To or from the locations the caller can see. With blind count on, a Munshi does not see sentQty while on the way.',
    request: { query: S.listTransfersQuery },
    responses: { ...ok('Transfers', [transferExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/equipment/transfers', {
    summary: 'Send equipment',
    description:
      'equipment.transfer.create. From the yard (also needs equipment.manage unless ALL_PROJECTS) or a site in scope, to the yard or an ACTIVE / CLOSEOUT site. Kind: DISPATCH (yard → site), RETURN (site → yard), TRANSFER (otherwise). Units go into transit until received. Rented units carry their rentalId.',
    request: {
      body: jsonBody(S.createTransferBody, {
        dispatch: ex('100 plates to DHA', { fromLocationId: IDS.store, toProjectId: IDS.dha, vehicleNo: 'LES-4521', driverName: 'Nadeem', items: [{ equipmentId: E_IDS.plates, qty: 100 }] }),
        back: ex('Return to the yard', { fromLocationId: IDS.dhaSite, toLocationId: IDS.store, items: [{ equipmentId: E_IDS.plates, qty: 40 }] }),
      }),
    },
    responses: {
      ...createdResp('Sent', { ...transferExample, status: 'ON_THE_WAY', losses: [], receivedBy: null, receivedAt: null }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_EQUIPMENT', 'INVALID_LOCATION', 'SAME_LOCATION', 'INVALID_EQUIPMENT', 'INVALID_RENTAL', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, ...ERR_LOC, 409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'] }),
    },
  });
  path(T, 'get', '/api/v1/equipment/transfers/{id}', {
    summary: 'Transfer detail',
    request: { params: idParam('Transfer') },
    responses: { ...ok('Transfer', transferExample), ...errors({ ...AUTH, 403: READ_403, 404: ['TRANSFER_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/equipment/transfers/{id}/receive', {
    summary: 'Receive with counts',
    description: 'equipment.receiving.create (Munshi on his site). Count every item: sent − received → MISSING loss, damaged → DAMAGED loss (source TRANSFER_GAP, REPORTED). A note is required for any gap. Offline: sync mutation EQUIPMENT_RECEIVE.',
    request: {
      params: idParam('Transfer'),
      body: jsonBody(S.receiveTransferBody, { gap: ex('96 arrived, 2 bent', { items: [{ itemId: E_IDS.transferItem, receivedQty: 96, damagedQty: 2, note: '4 plates missing, 2 bent' }] }) }),
    },
    responses: {
      ...ok('Received', transferExample),
      ...errors({ 400: ['VALIDATION_ERROR', 'ITEMS_MISMATCH', 'NOTE_REQUIRED', 'DAMAGED_EXCEEDS_COUNTED', 'RECEIVED_EXCEEDS_SENT', 'INVALID_ATTACHMENT', 'INVALID_DATES'], ...AUTH, 403: WRITE_403, 404: ['TRANSFER_NOT_FOUND'], 409: ['TRANSFER_CANCELLED', 'ALREADY_RECEIVED'] }),
    },
  });
  path(T, 'post', '/api/v1/equipment/transfers/{id}/cancel', {
    summary: 'Cancel a transfer on the way',
    description: 'equipment.transfer.create (same rules as sending). Units go back to the source.',
    request: { params: idParam('Transfer') },
    responses: { ...ok('Cancelled', { ...transferExample, status: 'CANCELLED' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['TRANSFER_NOT_FOUND', 'LOCATION_NOT_FOUND'], 409: ['TRANSFER_NOT_CANCELLABLE'] }) },
  });

  // Rentals
  path(T, 'get', '/api/v1/equipment/rentals', {
    summary: 'Rentals from yards',
    description: `equipment.view (rentals of projects in scope; yard rentals for equipment managers). accruedToDatePaisa = days × outstanding × rate up to today (live); postedPaisa = daily charges posted. ${money}`,
    request: { query: S.listRentalsQuery },
    responses: { ...ok('Rentals', [rentalExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/equipment/rentals', {
    summary: 'Hire from a yard',
    description: 'equipment.rental.manage. Items arrive at the site (or yard) on startDate (RENTAL_IN). Deposit → supplier ledger credit (ADJUSTMENT, refType RENTAL_DEPOSIT). Rent accrues daily to the project (P&L EQUIPMENT).',
    request: {
      body: jsonBody(S.createRentalBody, {
        props: ex('150 props for the DHA slab', { supplierId: E_IDS.punjabYard, projectId: IDS.dha, startDate: '2026-10-01', expectedEndDate: '2026-10-31', depositPaisa: '2000000', reference: 'PSY-2231', items: [{ equipmentId: E_IDS.props, qty: 150, ratePaisaPerDay: '1500' }] }),
      }),
    },
    responses: { ...createdResp('Created', rentalExample), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_SUPPLIER', 'INVALID_EQUIPMENT', 'INVALID_LOCATION', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, ...ERR_LOC, 409: ['PROJECT_LOCKED', 'PROJECT_IS_DRAFT'] }) },
  });
  path(T, 'get', '/api/v1/equipment/rentals/{id}', {
    summary: 'Rental detail',
    request: { params: idParam('Rental') },
    responses: { ...ok('Rental', rentalExample), ...errors({ ...AUTH, 403: READ_403, 404: ['RENTAL_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/equipment/rentals/{id}/extend', {
    summary: 'Extend the expected end date',
    request: { params: idParam('Rental'), body: jsonBody(S.extendRentalBody, { more: ex('Two more weeks', { expectedEndDate: '2026-11-14', note: 'First floor slab' }) }) },
    responses: { ...ok('Extended', rentalExample), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_DATES'], ...AUTH, 403: WRITE_403, 404: ['RENTAL_NOT_FOUND'], 409: ['RENTAL_NOT_ACTIVE'] }) },
  });
  path(T, 'post', '/api/v1/equipment/rentals/{id}/return', {
    summary: 'Return to the yard (partly or fully), with damage charges',
    description:
      'equipment.rental.manage. `qty` leaves the location (RENTAL_RETURN_OUT); `missingQty` = never handed back and must already be reported as a MISSING loss (400 MISSING_NOT_REPORTED). Damage charges → supplier ledger (RENTAL_DAMAGE). When nothing is outstanding: the remaining days are posted, rent = Σ daily RENTAL charges → supplier ledger (RENTAL_CHARGE), status RETURNED. Return day is not charged.',
    request: {
      params: idParam('Rental'),
      body: jsonBody(S.returnRentalBody, { all: ex('All back, 5 bent', { returnDate: '2026-10-16', items: [{ rentalItemId: E_IDS.rentalItem, qty: 150, damagedQty: 5 }], damageChargesPaisa: '450000', note: '5 props bent' }) }),
    },
    responses: {
      ...ok('Returned', { ...rentalExample, status: 'RETURNED', returnedDate: '2026-10-16', rentChargedPaisa: '3375000', damageChargesPaisa: '450000' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_RENTAL_ITEM', 'RETURN_EXCEEDS_OUTSTANDING', 'INSUFFICIENT_EQUIPMENT', 'MISSING_NOT_REPORTED', 'INVALID_DATES', 'INVALID_LOCATION', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, 404: ['RENTAL_NOT_FOUND', 'LOCATION_NOT_FOUND'], 409: ['RENTAL_NOT_ACTIVE'] }),
    },
  });
  path(T, 'post', '/api/v1/equipment/rentals/{id}/close', {
    summary: 'Close (settle the deposit)',
    description: 'equipment.rental.manage. RETURNED only. Cash refunded by the yard → supplier ledger (RENTAL_DEPOSIT_REFUND); the rest of the deposit stays as credit against the charges.',
    request: { params: idParam('Rental'), body: jsonBody(S.closeRentalBody, { refund: ex('Rs 5,000 back in cash', { depositRefundPaisa: '500000' }), adjust: ex('Deposit adjusted in full', {}) }) },
    responses: { ...ok('Closed', { ...rentalExample, status: 'CLOSED' }), ...errors({ 400: ['VALIDATION_ERROR', 'REFUND_EXCEEDS_DEPOSIT'], ...AUTH, 403: WRITE_403, 404: ['RENTAL_NOT_FOUND'], 409: ['RENTAL_NOT_RETURNED'] }) },
  });

  // Losses
  path(T, 'get', '/api/v1/equipment/losses', {
    summary: 'Loss & damage',
    description: `equipment.view (projects in scope; yard losses for equipment managers). ${money}`,
    request: { query: S.listLossesQuery },
    responses: { ...ok('Losses', [lossExample], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/equipment/losses', {
    summary: 'Report missing / damaged equipment',
    description: 'equipment.loss.create (Munshi on his site). MISSING takes the units off the location (LOSS_OUT); DAMAGED keeps them there. Value estimate = qty × replacement value. Offline: sync mutation EQUIPMENT_LOSS_REPORT.',
    request: { body: jsonBody(S.reportLossBody, { missing: ex('6 plates missing', { projectId: IDS.dha, equipmentId: E_IDS.plates, kind: 'MISSING', qty: 6, note: '6 plates not found after the GF slab de-shuttering', photoAttachmentId: IDS.photo }) }) },
    responses: { ...createdResp('Reported', lossExample), ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_EQUIPMENT', 'INVALID_EQUIPMENT', 'INVALID_RENTAL', 'INVALID_ATTACHMENT', 'INVALID_LOCATION', 'DATE_IN_FUTURE'], ...AUTH, 403: WRITE_403, ...ERR_LOC }) },
  });
  path(T, 'get', '/api/v1/equipment/losses/{id}', {
    summary: 'Loss detail',
    request: { params: idParam('Loss') },
    responses: { ...ok('Loss', lossExample), ...errors({ ...AUTH, 403: READ_403, 404: ['LOSS_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/equipment/losses/{id}/charge', {
    summary: 'Charge a loss',
    description: 'equipment.loss.approve. PROJECT → project P&L (LOSSES); SUBCONTRACTOR → sub-contract ledger DEDUCTION; WRITE_OFF → the company (no project cost). valuePaisa defaults to the estimate.',
    request: {
      params: idParam('Loss'),
      body: jsonBody(S.chargeLossBody, {
        sub: ex('Charge the shuttering mistri', { chargedTo: 'SUBCONTRACTOR', subcontractAssignmentId: E_IDS.subcontract, note: 'His team de-shuttered without counting' }),
        project: ex('Project bears it', { chargedTo: 'PROJECT', valuePaisa: '2400000', note: 'Lost during the storm' }),
      }),
    },
    responses: {
      ...ok('Charged', { ...lossExample, status: 'CHARGED', chargedTo: 'PROJECT', chargedBy: KHALID, chargedAt: '2026-10-13T06:00:00.000Z', chargeNote: 'Lost during the storm' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'NOTHING_TO_CHARGE', 'NO_PROJECT', 'INVALID_ASSIGNMENT'], ...AUTH, 403: WRITE_403, 404: ['LOSS_NOT_FOUND'], 409: ['LOSS_ALREADY_CHARGED'] }),
    },
  });

  // Charges
  path(T, 'get', '/api/v1/equipment/charges', {
    summary: 'Daily hire and rent charges',
    description: `equipment.view (projects in scope). One row per day × site × equipment (INTERNAL_HIRE) or day × rental item (RENTAL); correction rows have correction: true. meta.totalPaisa = Σ amount of the filter. ${money}`,
    request: { query: S.listChargesQuery },
    responses: {
      ...ok('Charges', [{ id: '0199a8c0-0000-7000-8000-000000001661', date: '2026-10-15', kind: 'INTERNAL_HIRE', project: DHA, location: DHA_SITE, equipment: PLATES, rental: null, qty: 240, correction: false, ratePaisa: '500', amountPaisa: '120000' }], { ...page(1), totalPaisa: '120000' }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'post', '/api/v1/equipment/accruals/run', {
    summary: 'Post hire and rent (accrual run)',
    description: 'equipment.manage. Same as the daily 01:30 job, for this company: posts complete days through `through` (≤ yesterday). Idempotent — a second run posts nothing.',
    request: { body: jsonBody(S.accrualBody, { yesterday: ex('Through yesterday', {}), date: ex('Through a date', { through: '2026-10-15' }) }) },
    responses: {
      ...ok('Posted', { through: '2026-10-15', internalHire: { rows: 3, amountPaisa: '247500' }, rental: { rows: 1, amountPaisa: '225000' } }),
      ...errors({ 400: ['VALIDATION_ERROR', 'DATE_NOT_COMPLETE'], ...AUTH, 403: WRITE_403 }),
    },
  });
}

