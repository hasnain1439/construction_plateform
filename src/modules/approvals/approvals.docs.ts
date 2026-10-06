import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, WRITE_403, ex, ok, path } from '../inventory/docs.shared.js';
import { bulkBody } from './approvals.schema.js';

const T = 'Approvals';
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };
const EXPENSE = '0199a8c0-0000-7000-8000-000000000a41';
const MEASUREMENT = '0199a8c0-0000-7000-8000-000000000a51';

export function registerApprovalsDocs(): void {
  path(T, 'get', '/api/v1/approvals', {
    summary: 'My approvals (one inbox)',
    description:
      'THEKEDAR sees everything; a PM only items of assigned projects and only the actions they may take (not their own kharcha). ' +
      'Groups: SETTLEMENT_SUBMITTED, EXPENSE_PENDING_APPROVAL, TOPUP_PENDING (owner), MEASUREMENT_TO_VERIFY, SHORTAGE_OPEN, PURCHASE_PENDING_RATE, ' +
      'and with billing.view STAGE_READY_UNBILLED, INVOICE_DRAFT, CHEQUE_PENDING. Each item has its page (`actionUrl`) and the `quickActions` the caller may run here.',
    responses: {
      ...ok('Grouped items', {
        total: 2,
        groups: [
          {
            type: 'EXPENSE_PENDING_APPROVAL',
            label: 'Kharcha above the limit',
            count: 1,
            totalPaisa: '1500000',
            items: [
              {
                type: 'EXPENSE_PENDING_APPROVAL',
                id: EXPENSE,
                title: 'Rafaqat Ali: Generator repair',
                subtitle: 'repairs',
                project: DHA,
                amountPaisa: '1500000',
                createdAt: '2026-10-04T07:00:00.000Z',
                ageDays: 2,
                actionUrl: `/projects/${IDS.dha}/cash-book/kharcha`,
                quickActions: [
                  { action: 'approve', label: 'Approve', needsNote: false, needsMethod: false },
                  { action: 'reject', label: 'Reject', needsNote: true, needsMethod: false },
                ],
              },
            ],
          },
          {
            type: 'MEASUREMENT_TO_VERIFY',
            label: 'Measurements to verify',
            count: 1,
            totalPaisa: '6219000',
            items: [
              {
                type: 'MEASUREMENT_TO_VERIFY',
                id: MEASUREMENT,
                title: 'Ali Electric Works: 1382.5 sqft',
                subtitle: 'Ground floor wiring',
                project: DHA,
                amountPaisa: '6219000',
                createdAt: '2026-10-03T09:00:00.000Z',
                ageDays: 3,
                actionUrl: `/projects/${IDS.dha}/labor/measurements`,
                quickActions: [
                  { action: 'approve', label: 'Verify', needsNote: false, needsMethod: false },
                  { action: 'reject', label: 'Reject', needsNote: true, needsMethod: false },
                ],
              },
            ],
          },
        ],
      }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'post', '/api/v1/approvals/bulk', {
    summary: 'Run quick actions on several items',
    description:
      'Calls the owning module for each item (approve / return settlements, approve / reject kharcha, send / reject top-ups (owner, `method` needed), approve (= verify) / reject measurements, issue draft invoices (owner), clear / bounce cheques (owner)). ' +
      'reject / return / bounce need a `note`. Items are independent: the answer lists each result; one failure does not undo the others.',
    request: {
      body: jsonBody(bulkBody, {
        approve: ex('Approve kharcha + verify a measurement', {
          items: [
            { type: 'EXPENSE_PENDING_APPROVAL', id: EXPENSE, action: 'approve' },
            { type: 'MEASUREMENT_TO_VERIFY', id: MEASUREMENT, action: 'verify' },
          ],
        }),
      }),
    },
    responses: {
      ...ok('Per-item results', {
        succeeded: 1,
        failed: 1,
        results: [
          { type: 'EXPENSE_PENDING_APPROVAL', id: EXPENSE, action: 'approve', ok: true, error: null },
          { type: 'MEASUREMENT_TO_VERIFY', id: MEASUREMENT, action: 'verify', ok: false, error: { code: 'MEASUREMENT_NOT_PENDING', message: 'This measurement is already verified' } },
        ],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403 }),
    },
  });
}
