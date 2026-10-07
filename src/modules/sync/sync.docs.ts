import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, WRITE_403, ex, ok, path } from '../inventory/docs.shared.js';
import { pullQuery, pushBody } from './sync.schema.js';

export const SYNC_TAG = 'Sync';

export function registerSyncDocs(): void {
  path(SYNC_TAG, 'get', '/api/v1/sync/pull', {
    summary: 'Pull changes (mobile read model)',
    description:
      'Company bearer token of a device that is not revoked (else `401 DEVICE_REVOKED`). No `cursor` → full snapshot of the caller’s scope; with a cursor → rows changed after it (paged by `limit`, `hasMore`), and tombstones (`deletes`) for deleted rows. ' +
      '`resetRequired: true` when the cursor is older than the 30-day retention or the caller’s project access changed — wipe the local DB and pull without a cursor. ' +
      'Scope: assigned ACTIVE / CLOSEOUT projects (every running project for THEKEDAR), their site stock locations, materials, workers, attendance (3 weeks), settlements (8 weeks), advances, measurements, incoming dispatches / purchases, owner deliveries, usage, site stock (quantities), counts, daily logs (30 days), the caller’s OWN cash account / entries / top-ups, settings subset, holidays and own notifications. ' +
      'Never material rates, purchase amounts, supplier balances, contract values or other people’s cash; a MUNSHI gets no sub-contract rates or measured values, and with blind count on no sent / challan quantities until counted. ' +
      'A change is handed out once it is 30 s old (transactions commit out of order), so the cursor never skips one.',
    request: { query: pullQuery },
    responses: {
      ...ok('Changes', {
        cursor: '1842',
        hasMore: false,
        resetRequired: false,
        serverTime: '2026-10-06T12:00:00.000Z',
        changes: {
          attendance: {
            upserts: [{ id: '0199a8c0-0000-7000-8000-000000000c01', projectId: IDS.dha, workerId: '0199a8c0-0000-7000-8000-000000000c02', date: '2026-10-06', status: 'FULL', overtimeHours: 0, note: null, clientId: null, lateSync: false }],
            deletes: [],
          },
          dispatches: {
            upserts: [{ id: IDS.dispatch, number: 'GP-0144', status: 'ON_THE_WAY', projectId: IDS.dha, toLocationId: IDS.dhaSite, from: 'Central Store', blindCount: true, items: [{ id: IDS.purchaseItem, materialId: IDS.cement, receivedQty: null, damagedQty: null, note: null }] }],
            deletes: [],
          },
          cash_accounts: { upserts: [{ id: IDS.payment, name: 'Rafaqat Ali — site cash', isActive: true, balancePaisa: '930000', pendingAckPaisa: '0', pendingApprovalPaisa: '0', recoverablePaisa: '0' }], deletes: [] },
        },
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });

  const W = '0199a8c0-0000-7000-8000-00000000ab11';
  const A = '0199a8c0-0000-7000-8000-00000000ab12';
  path(SYNC_TAG, 'post', '/api/v1/sync/push', {
    summary: 'Push queued mutations',
    description:
      'Up to 100 mutations, applied in order, each through the same service and permission checks as its REST endpoint, each in its own transaction. ' +
      'Result per mutation: **APPLIED** (serverId) · **DUPLICATE** (clientId seen before — same serverId, nothing done again) · **REJECTED** (permanent: code, message, details — e.g. WEEK_LOCKED, INSUFFICIENT_CASH, ALREADY_RECEIVED, INSUFFICIENT_STOCK, VALIDATION_ERROR, DEPENDENCY_REJECTED) · **RETRY** (transient; everything after it is RETRY too). ' +
      'Payload = the REST body plus its path ids (projectId, settlementId, dispatchId, purchaseId, entryId); any id may be the clientId of an earlier mutation or of an attachment uploaded with a clientId. ' +
      'Header `X-Pending-Mutations` = items still queued on the phone (shown to the office). Entries reaching the server more than 48 h after `deviceCreatedAt` are flagged `lateSync`.',
    request: {
      body: jsonBody(pushBody, {
        newWorker: ex('New worker → assign → hazri', {
          deviceId: 'android-7f3c9a2e',
          mutations: [
            { clientId: W, type: 'WORKER_CREATE', payload: { name: 'Naveed', type: 'MAZDOOR' }, deviceCreatedAt: '2026-10-06T08:10:00+05:00' },
            { clientId: A, type: 'PROJECT_WORKER_ASSIGN', payload: { projectId: IDS.dha, workerId: W }, dependsOn: [W], deviceCreatedAt: '2026-10-06T08:10:05+05:00' },
            {
              clientId: '0199a8c0-0000-7000-8000-00000000ab13',
              type: 'ATTENDANCE_UPSERT',
              payload: { projectId: IDS.dha, date: '2026-10-06', entries: [{ workerId: W, status: 'FULL' }] },
              dependsOn: [A],
              deviceCreatedAt: '2026-10-06T08:11:00+05:00',
            },
          ],
        }),
      }),
    },
    responses: {
      ...ok('Per-mutation results', {
        results: [
          { clientId: W, type: 'WORKER_CREATE', status: 'APPLIED', serverId: '0199a8c0-0000-7000-8000-000000000c21', error: null },
          { clientId: A, type: 'PROJECT_WORKER_ASSIGN', status: 'DUPLICATE', serverId: '0199a8c0-0000-7000-8000-000000000c22', error: null },
          { clientId: '0199a8c0-0000-7000-8000-00000000ab13', type: 'ATTENDANCE_UPSERT', status: 'REJECTED', serverId: null, error: { code: 'WEEK_LOCKED', message: 'This week is already submitted' } },
        ],
        applied: 1,
        duplicates: 1,
        rejected: 1,
        retry: 0,
      }),
      ...errors({ 400: ['VALIDATION_ERROR', 'DEVICE_MISMATCH'], ...AUTH, 403: WRITE_403 }),
    },
  });
  path(SYNC_TAG, 'get', '/api/v1/sync/status', {
    summary: 'Device sync status',
    description: 'The caller’s devices (every device of the company for THEKEDAR): last sync, items waiting on the phone and the last 10 rejected mutations with their codes.',
    responses: {
      ...ok('Devices', [
        {
          id: '0199a8c0-0000-7000-8000-000000000c31',
          user: { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Asif Mehmood', role: 'MUNSHI' },
          platform: 'ANDROID',
          model: 'Tecno Spark 10',
          appVersion: '1.0.0',
          revoked: false,
          lastActiveAt: '2026-10-06T07:00:00.000Z',
          lastSyncAt: '2026-10-06T06:58:00.000Z',
          pendingUploads: 12,
          lastRejected: [{ clientId: '0199a8c0-0000-7000-8000-00000000ab21', type: 'CASH_EXPENSE_CREATE', code: 'INSUFFICIENT_CASH', message: 'Only Rs 2,150 is in hand', deviceCreatedAt: '2026-10-05T11:00:00.000Z', at: '2026-10-06T06:58:00.000Z' }],
        },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
}
