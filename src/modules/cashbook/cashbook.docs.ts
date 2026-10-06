import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, KHALID, RAFAQAT, READ_403, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import { LIDS } from '../labor/labor.docs.js';
import {
  accountsQuery,
  approveTopupBody,
  cashbookQuery,
  countBody,
  countsQuery,
  decisionBody,
  entriesQuery,
  entryParams,
  expenseBody,
  expensesQuery,
  floatBody,
  handoverBody,
  rejectBody,
  topupBody,
  topupsQuery,
} from './cashbook.schema.js';

const T = 'Cash Book';
const BILAL = { id: '0199a8c0-0000-7000-8000-000000000002', name: 'Bilal Ahmed' };

const account = {
  id: LIDS.cashAccount,
  name: 'Rafaqat Ali — site cash',
  holder: { ...RAFAQAT, role: 'MUNSHI' },
  isActive: true,
  balancePaisa: '930000',
  pendingAckPaisa: '0',
  pendingApprovalPaisa: '0',
  recoverablePaisa: '0',
  lastCountAt: '2026-09-28T12:00:00.000Z',
  lastEntryAt: '2026-10-05T09:30:00.000Z',
};
const entry = {
  id: LIDS.cashEntry,
  accountId: LIDS.cashAccount,
  project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' },
  type: 'EXPENSE',
  amountPaisa: '-565000',
  category: 'FUEL',
  costBucket: 'EQUIPMENT',
  description: 'Diesel for the mixer',
  attachmentId: IDS.photo,
  status: 'APPROVED',
  method: null,
  reference: null,
  approvedById: null,
  approvedAt: null,
  reviewNote: null,
  recoverableFromHolder: false,
  refType: null,
  refId: null,
  clientId: LIDS.clientId,
  occurredAt: '2026-10-02T07:00:00.000Z',
  createdById: RAFAQAT.id,
  createdAt: '2026-10-02T07:00:00.000Z',
};
const float = {
  ...entry,
  type: 'FLOAT_IN',
  amountPaisa: '5000000',
  category: null,
  costBucket: null,
  description: 'Float via easypaisa',
  attachmentId: null,
  status: 'PENDING_ACK',
  method: 'EASYPAISA',
  reference: 'EP88213',
  clientId: null,
  createdById: KHALID.id,
};
const topup = {
  id: LIDS.topup,
  account: { id: LIDS.cashAccount, name: account.name },
  holder: RAFAQAT,
  amountPaisa: '4000000',
  note: 'Wages on Saturday',
  status: 'PENDING',
  balancePaisa: '930000',
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  floatEntryId: null,
  createdAt: '2026-10-05T10:00:00.000Z',
};

export function registerCashbookDocs(): void {
  path(T, 'get', '/api/v1/cash-accounts', {
    summary: 'Cash accounts',
    description:
      'THEKEDAR: every holder; PM: their own and the munshis on their projects; MUNSHI: only their own. Balance = Σ entries except floats not yet acknowledged; ' +
      'kharcha waiting for approval is already out of the balance (`pendingApprovalPaisa`); rejected kharcha is owed back (`recoverablePaisa`).',
    request: { query: accountsQuery },
    responses: {
      ...ok('Accounts', { items: [account], totals: { balancePaisa: '930000', pendingAckPaisa: '0', pendingApprovalPaisa: '0', recoverablePaisa: '0' } }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'get', '/api/v1/cash-accounts/{id}', {
    summary: 'Cash account',
    description: 'Same visibility as the list (else 404).',
    request: { params: idParam('CashAccount') },
    responses: { ...ok('Account', account), ...errors({ ...AUTH, 403: READ_403, 404: ['CASH_ACCOUNT_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/cash-accounts/{id}/entries', {
    summary: 'Cash book entries',
    description: 'Newest first in posting order, each with `runningBalancePaisa` after it. `meta.balancePaisa` is the current balance.',
    request: { params: idParam('CashAccount'), query: entriesQuery },
    responses: { ...ok('Entries', [{ ...entry, runningBalancePaisa: '930000' }], { ...page(1), balancePaisa: '930000' }), ...errors({ ...AUTH, 403: READ_403, 404: ['CASH_ACCOUNT_NOT_FOUND'] }) },
  });

  path(T, 'post', '/api/v1/cash-floats', {
    summary: 'Send a float',
    description: 'THEKEDAR. Cash for a munshi / PM (their account opens on the first float). Waits as PENDING_ACK — not in the balance — until the holder acknowledges. The holder gets an SMS.',
    request: {
      body: jsonBody(floatBody, {
        easypaisa: ex('Rs 50,000 by Easypaisa', { holderUserId: RAFAQAT.id, amountPaisa: '5000000', method: 'EASYPAISA', reference: 'EP88213', projectId: IDS.dha }),
      }),
    },
    responses: { ...createdResp('Float (PENDING_ACK)', float), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_HOLDER'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/cash-floats/{entryId}/acknowledge', {
    summary: 'Acknowledge a float',
    description: 'The holder only (anyone else → 404). PENDING_ACK → POSTED; the amount joins the balance.',
    request: { params: entryParams },
    responses: { ...ok('Acknowledged', { ...float, status: 'POSTED', approvedById: RAFAQAT.id }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['FLOAT_NOT_FOUND'], 409: ['ALREADY_ACKNOWLEDGED'] }) },
  });

  path(T, 'get', '/api/v1/cash-expenses', {
    summary: 'Kharcha list',
    description: 'Visible accounts only. `?status=PENDING_APPROVAL` is the approval queue. Amounts are positive here; `meta.totalPaisa` sums them.',
    request: { query: expensesQuery },
    responses: { ...ok('Kharcha', [{ ...entry, amountPaisa: '565000', holder: RAFAQAT }], { ...page(1), totalPaisa: '565000' }), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/cash-expenses', {
    summary: 'Record kharcha',
    description:
      'Any cash holder, from their own cash, on a project they can see (offline-safe via `clientId`). Above the company kharcha limit → PENDING_APPROVAL (the cash is still counted as spent). ' +
      'Not enough cash → 400 INSUFFICIENT_CASH. Cost bucket follows the category (OWNER_PURCHASE → RECOVERABLE_FROM_OWNER). ' +
      'URGENT_MATERIAL with `supplierId` + `items` also enters the goods into site stock as a purchase (rates added later by the office; that purchase is then paid from this site cash).',
    request: {
      body: jsonBody(expenseBody, {
        fuel: ex('Diesel Rs 5,650 with the receipt', {
          projectId: IDS.dha,
          category: 'FUEL',
          amountPaisa: '565000',
          description: 'Diesel for the mixer',
          attachmentId: IDS.photo,
          clientId: LIDS.clientId,
        }),
        urgent: ex('Urgent PPR fittings with items', {
          projectId: IDS.dha,
          category: 'URGENT_MATERIAL',
          amountPaisa: '435000',
          description: 'PPR fittings — plumber waiting',
          attachmentId: IDS.photo,
          supplierId: IDS.almadina,
          items: [{ materialId: IDS.cement, qty: 3 }],
        }),
      }),
    },
    responses: {
      ...createdResp('Recorded', entry),
      ...ok('Already saved (same clientId)', entry),
      ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_CASH', 'NO_CASH_ACCOUNT', 'FUTURE_DATE', 'INVALID_ATTACHMENT', 'CHALLAN_REQUIRED'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }),
    },
  });
  path(T, 'post', '/api/v1/cash-expenses/{id}/approve', {
    summary: 'Approve kharcha',
    description: 'THEKEDAR, PM (their projects; not their own kharcha). PENDING_APPROVAL only.',
    request: { params: idParam('CashEntry'), body: jsonBody(decisionBody, { ok: ex('Approve', { note: 'Checked the bill' }) }) },
    responses: { ...ok('Approved', { ...entry, approvedById: BILAL.id }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: [...WRITE_403, 'OWN_EXPENSE'], 404: ['EXPENSE_NOT_FOUND'], 409: ['EXPENSE_NOT_PENDING'] }) },
  });
  path(T, 'post', '/api/v1/cash-expenses/{id}/reject', {
    summary: 'Reject kharcha',
    description: 'THEKEDAR, PM. A note is required. The money stays spent and is owed back by the holder (`recoverableFromHolder`).',
    request: { params: idParam('CashEntry'), body: jsonBody(rejectBody, { nobill: ex('No bill', { note: 'No bill for this trolley' }) }) },
    responses: { ...ok('Rejected', { ...entry, status: 'REJECTED', recoverableFromHolder: true }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['EXPENSE_NOT_FOUND'], 409: ['EXPENSE_NOT_PENDING'] }) },
  });

  path(T, 'get', '/api/v1/topup-requests', {
    summary: 'Top-up requests',
    description: 'Visible accounts only, with each holder’s current balance.',
    request: { query: topupsQuery },
    responses: { ...ok('Requests', [topup], page(1)), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/topup-requests', {
    summary: 'Ask for a top-up',
    description: 'A munshi / PM for their own cash. One open request at a time (409 TOPUP_PENDING). Offline-safe via `clientId`.',
    request: { body: jsonBody(topupBody, { wages: ex('Rs 40,000 for Saturday wages', { amountPaisa: '4000000', note: 'Wages on Saturday' }) }) },
    responses: { ...createdResp('Requested', topup), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 409: ['TOPUP_PENDING'] }) },
  });
  path(T, 'post', '/api/v1/topup-requests/{id}/approve', {
    summary: 'Approve a top-up',
    description: 'THEKEDAR. Sends a float (amount defaults to the request) that the holder acknowledges.',
    request: { params: idParam('TopupRequest'), body: jsonBody(approveTopupBody, { jazz: ex('Rs 30,000 by JazzCash', { amountPaisa: '3000000', method: 'JAZZCASH', reference: 'JC-77' }) }) },
    responses: { ...ok('Approved', { ...topup, status: 'APPROVED', floatEntryId: LIDS.cashEntry }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['TOPUP_NOT_FOUND'], 409: ['TOPUP_DECIDED'] }) },
  });
  path(T, 'post', '/api/v1/topup-requests/{id}/reject', {
    summary: 'Reject a top-up',
    description: 'THEKEDAR. A note is required; the holder gets an SMS.',
    request: { params: idParam('TopupRequest'), body: jsonBody(rejectBody, { enough: ex('Enough cash in hand', { note: 'You still have Rs 9,300' }) }) },
    responses: { ...ok('Rejected', { ...topup, status: 'REJECTED' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['TOPUP_NOT_FOUND'], 409: ['TOPUP_DECIDED'] }) },
  });

  const count = {
    id: '0199a8c0-0000-7000-8000-000000000d31',
    accountId: LIDS.cashAccount,
    systemPaisa: '840000',
    countedPaisa: '830000',
    differencePaisa: '-10000',
    note: 'Change to tea boy',
    adjustmentEntryId: LIDS.cashEntry,
    countedById: RAFAQAT.id,
    countedAt: '2026-09-28T12:00:00.000Z',
  };
  path(T, 'get', '/api/v1/cash-counts', {
    summary: 'Cash counts',
    request: { query: countsQuery },
    responses: { ...ok('Counts', [count], page(1)), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/cash-counts', {
    summary: 'Count the cash in hand',
    description: 'Own cash (or, THEKEDAR / PM, a visible account). A difference from the book needs a note (400 NOTE_REQUIRED) and becomes a COUNT_ADJUSTMENT entry.',
    request: { body: jsonBody(countBody, { short: ex('Rs 100 short', { countedPaisa: '830000', note: 'Change to tea boy' }) }) },
    responses: { ...createdResp('Counted', count), ...errors({ 400: ['VALIDATION_ERROR', 'NOTE_REQUIRED', 'NO_CASH_ACCOUNT'], ...AUTH, 403: WRITE_403, 404: ['CASH_ACCOUNT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/cash-handovers', {
    summary: 'Hand cash over',
    description:
      'From your own cash (THEKEDAR: anyone’s) to another active team member: HANDOVER_OUT on one book, HANDOVER_IN on the other. Needed before a holder can be deactivated (409 CASH_BALANCE_OPEN).',
    request: { body: jsonBody(handoverBody, { leaving: ex('Munshi leaving: all cash to Bilal', { toUserId: BILAL.id, amountPaisa: '930000', note: 'Leaving the site' }) }) },
    responses: {
      ...createdResp('Handed over', { out: { ...entry, type: 'HANDOVER_OUT', amountPaisa: '-930000' }, in: { ...entry, type: 'HANDOVER_IN', amountPaisa: '930000' } }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INSUFFICIENT_CASH', 'INVALID_RECEIVER', 'NO_CASH_ACCOUNT'], ...AUTH, 403: WRITE_403, 404: ['CASH_ACCOUNT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/cashbook', {
    summary: 'Project cash book',
    description: 'All roles with project access (MUNSHI: only their own entries). Entries with holder, spend by category / type, kharcha this week, and the cash accounts on the project.',
    request: { params: idParam('Project'), query: cashbookQuery },
    responses: {
      ...ok(
        'Cash book',
        {
          entries: [{ ...entry, holder: RAFAQAT }],
          summary: {
            spentByCategory: [{ category: 'FUEL', amountPaisa: '565000' }],
            spentByType: [{ type: 'EXPENSE', amountPaisa: '565000' }],
            kharchaThisWeekPaisa: '565000',
            week: { weekStart: '2026-10-05', weekEnd: '2026-10-11' },
          },
          accounts: [account],
        },
        page(1),
      ),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
}
