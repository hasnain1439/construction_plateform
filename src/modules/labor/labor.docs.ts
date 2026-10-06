import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, KHALID, RAFAQAT, READ_403, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import {
  advanceBody,
  advancesQuery,
  assignSubcontractBody,
  assignWorkerBody,
  attendanceBody,
  attendanceQuery,
  deductionBody,
  generateBody,
  lineBody,
  lineParams,
  measurementBody,
  measurementsQuery,
  payBody,
  progressBody,
  projectWorkersQuery,
  rejectBody,
  returnBody,
  settlementsQuery,
  subcontractPaymentBody,
  subcontractsQuery,
  updateProjectWorkerBody,
  updateSubcontractBody,
} from './labor.schema.js';

/** Example ids (look the real ones up with the list endpoints on a seeded database). */
export const LIDS = {
  akram: '0199a8c0-0000-7000-8000-000000000a01',
  riaz: '0199a8c0-0000-7000-8000-000000000a05',
  projectWorker: '0199a8c0-0000-7000-8000-000000000a11',
  sharif: '0199a8c0-0000-7000-8000-000000000b01',
  sharifAssignment: '0199a8c0-0000-7000-8000-000000000b11',
  latifAssignment: '0199a8c0-0000-7000-8000-000000000b12',
  measurement: '0199a8c0-0000-7000-8000-000000000b21',
  advance: '0199a8c0-0000-7000-8000-000000000c01',
  settlement: '0199a8c0-0000-7000-8000-000000000c11',
  line: '0199a8c0-0000-7000-8000-000000000c12',
  cashAccount: '0199a8c0-0000-7000-8000-000000000d01',
  cashEntry: '0199a8c0-0000-7000-8000-000000000d11',
  topup: '0199a8c0-0000-7000-8000-000000000d21',
  clientId: '0199a8c0-0000-7000-8000-00000000ff01',
} as const;

const PW_400 = ['VALIDATION_ERROR'];
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };
const AKRAM = { id: LIDS.akram, name: 'Ustad Akram', type: 'MISTRI' };
const SHARIF = { id: LIDS.sharif, name: 'Ustad Sharif Shuttering', trade: 'SHUTTERING', phone: '+923004440001' };

const projectWorker = {
  id: LIDS.projectWorker,
  projectId: IDS.dha,
  worker: { ...AKRAM, phone: '+923001110001' },
  dailyRatePaisa: '280000',
  defaultRatePaisa: '300000',
  rateOverridden: true,
  startDate: '2026-09-14',
  endDate: null,
  isActive: true,
};
const assignment = {
  id: LIDS.sharifAssignment,
  projectId: IDS.dha,
  subcontractor: SHARIF,
  scope: 'Slab shuttering — ground + first floor',
  rateType: 'PER_SQFT',
  unit: 'sqft',
  ratePaisa: '4500',
  contractValuePaisa: null,
  retentionPercent: 5,
  progressPercent: 0,
  startDate: '2026-09-01',
  isActive: true,
};
const account = {
  valuePaisa: '36900000',
  retentionPaisa: '1845000',
  retentionReleasedPaisa: '0',
  retentionHeldPaisa: '1845000',
  advancesPaisa: '0',
  paidPaisa: '32000000',
  deductionsPaisa: '0',
  balanceDuePaisa: '3055000',
  overpaid: false,
  overpaidPaisa: '0',
};
const line = {
  id: LIDS.line,
  worker: AKRAM,
  fullDays: 6,
  halfDays: 0,
  daysWorked: 6,
  dailyRatePaisa: '280000',
  overtimeHours: 0,
  overtimePaisa: '0',
  grossPaisa: '1680000',
  advanceAdjustedPaisa: '500000',
  advanceOverride: false,
  overrideNote: null,
  netPaisa: '1180000',
  paymentStatus: 'UNPAID',
  paidFrom: null,
  paidAt: null,
  cashEntryId: null,
  advances: [{ advanceId: LIDS.advance, date: '2026-09-22', amountPaisa: '500000' }],
};
const settlement = {
  id: LIDS.settlement,
  project: DHA,
  weekStart: '2026-09-21',
  weekEnd: '2026-09-27',
  status: 'SUBMITTED',
  workers: 8,
  daysWorked: 44.5,
  grossPaisa: '8360000',
  advancePaisa: '1250000',
  netPaisa: '7110000',
  paidPaisa: '0',
  unpaidPaisa: '7110000',
  fullyPaid: false,
  createdBy: RAFAQAT,
  createdAt: '2026-09-27T12:00:00.000Z',
  submittedBy: RAFAQAT,
  submittedAt: '2026-09-27T12:05:00.000Z',
  approvedBy: null,
  approvedAt: null,
  returnComment: null,
  lines: [line],
};

export function registerLaborDocs(): void {
  // ─── Labor Assignments ────────────────────────────────────────────────────
  const A = 'Labor Assignments';
  path(A, 'get', '/api/v1/projects/{id}/labor/workers', {
    summary: 'Workers on the project',
    description: 'All roles with project access (PM / MUNSHI: assigned projects, else 404). Each row has the project rate and the worker’s own default rate.',
    request: { params: idParam('Project'), query: projectWorkersQuery },
    responses: { ...ok('Workers', [projectWorker]), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(A, 'post', '/api/v1/projects/{id}/labor/workers', {
    summary: 'Assign a worker',
    description:
      'THEKEDAR, PM, MUNSHI. The rate defaults to the worker’s daily rate; only the office may set another (MUNSHI → 403 RATE_CHANGE_NOT_ALLOWED). ' +
      'A worker taken off earlier is put back on. Project must be ACTIVE / CLOSEOUT.',
    request: {
      params: idParam('Project'),
      body: jsonBody(assignWorkerBody, {
        office: ex('Office: Akram at Rs 2,800 on this project', { workerId: LIDS.akram, dailyRatePaisa: '280000', startDate: '2026-09-14' }),
        munshi: ex('Munshi: default rate', { workerId: LIDS.riaz }),
      }),
    },
    responses: {
      ...createdResp('Assigned', projectWorker),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_WORKER'], ...AUTH, 403: [...WRITE_403, 'RATE_CHANGE_NOT_ALLOWED'], 404: ['PROJECT_NOT_FOUND'], 409: ['WORKER_ALREADY_ASSIGNED', 'PROJECT_LOCKED'] }),
    },
  });
  path(A, 'patch', '/api/v1/project-workers/{id}', {
    summary: 'Change a worker’s project rate / dates',
    description: 'THEKEDAR, PM. A new rate applies to settlements generated from now on. `isActive: false` takes the worker off (end date today).',
    request: {
      params: idParam('ProjectWorker'),
      body: jsonBody(updateProjectWorkerBody, { rate: ex('New rate Rs 2,900', { dailyRatePaisa: '290000' }), off: ex('Taken off the site', { isActive: false }) }),
    },
    responses: { ...ok('Updated', projectWorker), ...errors({ 400: PW_400, ...AUTH, 403: WRITE_403, 404: ['PROJECT_WORKER_NOT_FOUND'] }) },
  });
  path(A, 'delete', '/api/v1/project-workers/{id}', {
    summary: 'Remove a worker from the project',
    description: 'THEKEDAR, PM. A worker with hazri or peshgi here is only taken off (kept for history); otherwise the row is deleted.',
    request: { params: idParam('ProjectWorker') },
    responses: { ...ok('Removed', { removed: false, deactivated: true, assignment: { ...projectWorker, isActive: false, endDate: '2026-10-06' } }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['PROJECT_WORKER_NOT_FOUND'] }) },
  });
  path(A, 'get', '/api/v1/projects/{id}/labor/subcontracts', {
    summary: 'Sub-contracts on the project',
    description: 'All roles with project access. MUNSHI gets no `ratePaisa`, `contractValuePaisa` or `retentionPercent`.',
    request: { params: idParam('Project'), query: subcontractsQuery },
    responses: { ...ok('Sub-contracts', [assignment]), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(A, 'post', '/api/v1/projects/{id}/labor/subcontracts', {
    summary: 'Give work to a sub-contractor',
    description:
      'THEKEDAR, PM. Unit (sqft, ton, brick, rft, cft) follows `rateType`. The rate — or a LUMPSUM value — defaults to the company’s SUBCONTRACT labour rate for the trade (400 RATE_REQUIRED when there is none in that unit). Retention defaults to 5%.',
    request: {
      params: idParam('Project'),
      body: jsonBody(assignSubcontractBody, {
        sqft: ex('Shuttering at the list rate', { subcontractorId: LIDS.sharif, scope: 'Slab shuttering — ground + first floor', rateType: 'PER_SQFT' }),
        lump: ex('Plumbing lump sum Rs 1,20,000', { subcontractorId: LIDS.sharif, scope: 'Plumbing rough-in', rateType: 'LUMPSUM', contractValuePaisa: '12000000', retentionPercent: 5 }),
      }),
    },
    responses: {
      ...createdResp('Assigned', assignment),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_SUBCONTRACTOR', 'RATE_REQUIRED'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }),
    },
  });
  path(A, 'patch', '/api/v1/subcontract-assignments/{id}', {
    summary: 'Change a sub-contract',
    description: 'THEKEDAR, PM. A new rate applies to measurements verified from now on (verified work keeps its value).',
    request: {
      params: idParam('SubcontractAssignment'),
      body: jsonBody(updateSubcontractBody, { rate: ex('Rate Rs 48 / sqft, retention 10%', { ratePaisa: '4800', retentionPercent: 10 }) }),
    },
    responses: { ...ok('Updated', assignment), ...errors({ 400: ['VALIDATION_ERROR', 'LUMPSUM_HAS_NO_RATE', 'NOT_LUMPSUM'], ...AUTH, 403: WRITE_403, 404: ['ASSIGNMENT_NOT_FOUND'] }) },
  });

  path(A, 'get', '/api/v1/labor/overview', {
    summary: 'Labour & cash overview (dashboard)',
    description:
      'THEKEDAR, PM (their ACTIVE / CLOSEOUT projects). Hazri today, peshgi and kharcha this week, cash with site staff, and counts waiting for approval (submitted settlements, kharcha above the limit, top-ups — THEKEDAR — and measurements to verify).',
    responses: {
      ...ok('Overview', {
        date: '2026-10-06',
        week: { weekStart: '2026-10-05', weekEnd: '2026-10-11' },
        hazriToday: { assigned: 8, full: 6, half: 1, absent: 1, unmarked: 0 },
        peshgiThisWeekPaisa: '150000',
        kharchaThisWeekPaisa: '475000',
        cashWithSiteStaffPaisa: '3080000',
        pending: { settlements: 1, kharcha: 1, topups: 1, measurements: 1 },
        lastWeekStart: '2026-09-28',
      }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(A, 'get', '/api/v1/workers/{id}/labor-summary', {
    summary: 'Worker across projects',
    description: 'THEKEDAR, PM (their projects). Sites and rates, days this week, outstanding peshgi, recent advances and the last 12 settlement lines.',
    request: { params: idParam('Worker') },
    responses: {
      ...ok('Worker summary', {
        worker: { ...AKRAM, phone: '+923001110001', dailyRatePaisa: '300000', isActive: true },
        projects: [{ projectWorkerId: LIDS.projectWorker, project: { ...DHA, status: 'ACTIVE' }, dailyRatePaisa: '280000', startDate: '2026-09-14', endDate: null, isActive: true }],
        thisWeek: { weekStart: '2026-10-05', daysWorked: 2 },
        outstandingAdvancePaisa: '500000',
        advances: [{ id: LIDS.advance, project: { ...DHA, status: 'ACTIVE' }, date: '2026-09-22', amountPaisa: '500000', paidFrom: 'OFFICE_CASH', note: 'Child sick' }],
        settlements: [{ settlementId: LIDS.settlement, project: { ...DHA, status: 'ACTIVE' }, weekStart: '2026-09-21', status: 'SUBMITTED', daysWorked: 6, grossPaisa: '1680000', advanceAdjustedPaisa: '500000', netPaisa: '1180000', paymentStatus: 'UNPAID' }],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['WORKER_NOT_FOUND'] }),
    },
  });
  path(A, 'get', '/api/v1/subcontractors/{id}/labor-summary', {
    summary: 'Sub-contractor across projects',
    description: 'THEKEDAR, PM (their projects). Every sub-contract with its account and the totals.',
    request: { params: idParam('Subcontractor') },
    responses: {
      ...ok('Sub-contractor summary', {
        subcontractor: { ...SHARIF, isActive: true },
        assignments: [{ ...assignment, project: { ...DHA, status: 'ACTIVE' }, account }],
        totals: { valuePaisa: '36900000', paidPaisa: '32000000', retentionHeldPaisa: '1845000', balanceDuePaisa: '3055000' },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['SUBCONTRACTOR_NOT_FOUND'] }),
    },
  });

  // ─── Attendance ───────────────────────────────────────────────────────────
  const H = 'Attendance';
  const day = {
    date: '2026-10-06',
    weekday: 'TUESDAY',
    assigned: 8,
    marked: 8,
    full: 6,
    half: 1,
    absent: 1,
    unmarked: 0,
    overtimeHours: 2,
    workers: [{ worker: AKRAM, status: 'FULL', overtimeHours: 2, note: null }],
  };
  path(H, 'post', '/api/v1/projects/{id}/attendance', {
    summary: 'Mark hazri (bulk upsert)',
    description:
      'THEKEDAR, PM, MUNSHI. One call per day; marking a worker again overwrites the mark. Rules: every worker must be on the project (400 WORKER_NOT_ASSIGNED), ' +
      'no future days (400 FUTURE_DATE), MUNSHI at most 7 days back (400 DATE_TOO_OLD), and a week with a submitted / approved settlement is locked (409 WEEK_LOCKED). ' +
      'ABSENT clears overtime.',
    request: {
      params: idParam('Project'),
      body: jsonBody(attendanceBody, {
        today: ex('Today: Akram full + 2h OT, Riaz half', {
          date: '2026-10-06',
          entries: [
            { workerId: LIDS.akram, status: 'FULL', overtimeHours: 2 },
            { workerId: LIDS.riaz, status: 'HALF', note: 'Left at 1 pm' },
          ],
          clientId: LIDS.clientId,
          deviceCreatedAt: '2026-10-06T08:15:00+05:00',
        }),
      }),
    },
    responses: {
      ...ok('Saved — the day after saving', { date: '2026-10-06', created: 1, updated: 1, day }),
      ...errors({ 400: ['VALIDATION_ERROR', 'WORKER_NOT_ASSIGNED', 'FUTURE_DATE', 'DATE_TOO_OLD'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['WEEK_LOCKED', 'PROJECT_LOCKED'] }),
    },
  });
  path(H, 'get', '/api/v1/projects/{id}/attendance', {
    summary: 'Hazri register (grid)',
    description: 'All roles with project access. Rows = workers, columns = days. Default: the current settlement week; at most 62 days. `weeks` lists settlements in the range (locked = submitted / approved).',
    request: { params: idParam('Project'), query: attendanceQuery },
    responses: {
      ...ok('Grid', {
        from: '2026-09-21',
        to: '2026-09-27',
        dates: ['2026-09-21', '2026-09-22'],
        weekStart: 'MONDAY',
        workers: [
          {
            projectWorkerId: LIDS.projectWorker,
            worker: AKRAM,
            dailyRatePaisa: '280000',
            isActive: true,
            days: { '2026-09-21': { status: 'FULL', overtimeHours: 0, note: null } },
            totals: { full: 6, half: 0, absent: 0, daysWorked: 6, overtimeHours: 0 },
          },
        ],
        dayTotals: [{ date: '2026-09-21', weekday: 'MONDAY', workingDay: true, full: 8, half: 0, absent: 0, unmarked: 0 }],
        totals: { daysWorked: 44.5, overtimeHours: 0 },
        weeks: [{ settlementId: LIDS.settlement, weekStart: '2026-09-21', status: 'SUBMITTED', locked: true }],
      }),
      ...errors({ 400: ['VALIDATION_ERROR', 'RANGE_TOO_LONG'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(H, 'get', '/api/v1/projects/{id}/attendance/today', {
    summary: 'Today’s hazri',
    description: 'All roles with project access. Everyone on the project with today’s mark (`status: null` = not marked yet).',
    request: { params: idParam('Project') },
    responses: { ...ok('Today', { ...day, workingDay: true, locked: false }), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });

  // ─── Work Measurements ────────────────────────────────────────────────────
  const W = 'Work Measurements';
  const measurement = {
    id: LIDS.measurement,
    projectId: IDS.dha,
    assignment: { id: LIDS.sharifAssignment, scope: 'Slab shuttering', rateType: 'PER_SQFT', subcontractor: SHARIF },
    date: '2026-10-04',
    description: 'First-floor slab',
    quantity: 1250.5,
    unit: 'sqft',
    attachmentIds: [IDS.photo],
    status: 'VERIFIED',
    ratePaisa: '4500',
    valuePaisa: '5627250',
    verifiedById: KHALID.id,
    verifiedAt: '2026-10-05T10:00:00.000Z',
    note: null,
    clientId: LIDS.clientId,
    deviceCreatedAt: '2026-10-04T16:00:00.000Z',
    createdById: RAFAQAT.id,
    createdAt: '2026-10-04T16:00:05.000Z',
  };
  path(W, 'post', '/api/v1/projects/{id}/work-measurements', {
    summary: 'Record a measurement',
    description:
      'THEKEDAR, PM, MUNSHI (offline-safe: a repeated `clientId` returns the saved record with 200). Unit comes from the sub-contract. LUMPSUM contracts use % progress instead (400 LUMPSUM_USES_PROGRESS). MUNSHI never sees rates or values.',
    request: {
      params: idParam('Project'),
      body: jsonBody(measurementBody, {
        slab: ex('1,250.5 sqft slab shuttering with a photo', {
          assignmentId: LIDS.sharifAssignment,
          date: '2026-10-04',
          description: 'First-floor slab',
          quantity: 1250.5,
          attachmentIds: [IDS.photo],
          clientId: LIDS.clientId,
        }),
      }),
    },
    responses: {
      ...createdResp('Recorded', { ...measurement, status: 'RECORDED', verifiedById: null, verifiedAt: null }),
      ...ok('Already saved (same clientId)', measurement),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ASSIGNMENT', 'LUMPSUM_USES_PROGRESS', 'FUTURE_DATE', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND', 'ASSIGNMENT_NOT_FOUND'] }),
    },
  });
  path(W, 'get', '/api/v1/projects/{id}/work-measurements', {
    summary: 'Measurements',
    description: 'All roles with project access (money hidden from MUNSHI). `meta.pendingCount` = waiting for verification.',
    request: { params: idParam('Project'), query: measurementsQuery },
    responses: { ...ok('Measurements', [measurement], { ...page(1), pendingCount: 2 }), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(W, 'post', '/api/v1/work-measurements/{id}/verify', {
    summary: 'Verify a measurement',
    description: 'THEKEDAR, PM. Adds quantity × rate to the sub-contractor’s account (WORK_VALUE). Only RECORDED ones (409 MEASUREMENT_NOT_PENDING).',
    request: { params: idParam('WorkMeasurement') },
    responses: { ...ok('Verified', measurement), ...errors({ ...AUTH, 403: WRITE_403, 404: ['MEASUREMENT_NOT_FOUND'], 409: ['MEASUREMENT_NOT_PENDING'] }) },
  });
  path(W, 'post', '/api/v1/work-measurements/{id}/reject', {
    summary: 'Reject a measurement',
    description: 'THEKEDAR, PM. A note is required.',
    request: { params: idParam('WorkMeasurement'), body: jsonBody(rejectBody, { twice: ex('Measured twice', { note: 'Same slab was measured on Saturday' }) }) },
    responses: { ...ok('Rejected', { ...measurement, status: 'REJECTED' }), ...errors({ 400: PW_400, ...AUTH, 403: WRITE_403, 404: ['MEASUREMENT_NOT_FOUND'], 409: ['MEASUREMENT_NOT_PENDING'] }) },
  });

  // ─── Advances ─────────────────────────────────────────────────────────────
  const P = 'Advances';
  const advance = {
    id: LIDS.advance,
    projectId: IDS.dha,
    payeeType: 'WORKER',
    worker: AKRAM,
    assignment: null,
    amountPaisa: '500000',
    adjustedPaisa: '0',
    outstandingPaisa: '500000',
    status: 'OUTSTANDING',
    settlements: [],
    date: '2026-09-22',
    paidFrom: 'SITE_CASH',
    cashAccountId: LIDS.cashAccount,
    reference: null,
    note: 'Child sick',
    clientId: LIDS.clientId,
    deviceCreatedAt: null,
    createdById: RAFAQAT.id,
    createdAt: '2026-09-22T09:00:00.000Z',
  };
  path(P, 'post', '/api/v1/projects/{id}/advances', {
    summary: 'Give peshgi',
    description:
      'THEKEDAR, PM, MUNSHI (MUNSHI from SITE_CASH only — 403 PAID_FROM_NOT_ALLOWED). SITE_CASH leaves the holder’s cash book (400 INSUFFICIENT_CASH). ' +
      'A worker’s peshgi is cut from weekly wages (oldest first); a sub-contractor’s goes to their account at once. Offline-safe via `clientId`.',
    request: {
      params: idParam('Project'),
      body: jsonBody(advanceBody, {
        worker: ex('Munshi: Rs 5,000 to Akram from site cash', {
          payeeType: 'WORKER',
          workerId: LIDS.akram,
          amountPaisa: '500000',
          date: '2026-09-22',
          paidFrom: 'SITE_CASH',
          note: 'Child sick',
          clientId: LIDS.clientId,
        }),
        sub: ex('Office: Rs 50,000 to a sub-contractor by bank', {
          payeeType: 'SUBCONTRACTOR',
          assignmentId: LIDS.sharifAssignment,
          amountPaisa: '5000000',
          date: '2026-09-25',
          paidFrom: 'BANK',
          reference: 'HBL-2231',
        }),
      }),
    },
    responses: {
      ...createdResp('Given', advance),
      ...ok('Already saved (same clientId)', advance),
      ...errors({
        400: ['VALIDATION_ERROR', 'WORKER_NOT_ASSIGNED', 'INVALID_ASSIGNMENT', 'INSUFFICIENT_CASH', 'NO_CASH_ACCOUNT', 'FUTURE_DATE'],
        ...AUTH,
        403: [...WRITE_403, 'PAID_FROM_NOT_ALLOWED'],
        404: ['PROJECT_NOT_FOUND', 'CASH_ACCOUNT_NOT_FOUND', 'ASSIGNMENT_NOT_FOUND'],
      }),
    },
  });
  path(P, 'get', '/api/v1/projects/{id}/advances', {
    summary: 'Peshgi register',
    description: 'All roles with project access. Status: OUTSTANDING → PARTLY_ADJUSTED → ADJUSTED (cut in an approved settlement). Totals in `meta`.',
    request: { params: idParam('Project'), query: advancesQuery },
    responses: { ...ok('Advances', [advance], { ...page(1), totalPaisa: '500000', outstandingPaisa: '500000' }), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });

  // ─── Settlements ──────────────────────────────────────────────────────────
  const S = 'Settlements';
  const NOT_FOUND = { 404: ['SETTLEMENT_NOT_FOUND'] };
  path(S, 'post', '/api/v1/projects/{id}/settlements/generate', {
    summary: 'Generate / regenerate a week',
    description:
      'THEKEDAR, PM, MUNSHI. From hazri: days = full + ½ half; gross = days × rate + OT hours × rate / hoursPerDay × OT multiplier; peshgi cut oldest-first up to gross (hand overrides are kept); net = gross − peshgi. ' +
      'Regenerates a DRAFT / RETURNED week; SUBMITTED / APPROVED → 409 SETTLEMENT_LOCKED. `weekStart` must be the company’s week start day.',
    request: { params: idParam('Project'), body: jsonBody(generateBody, { week: ex('Week of 21 Sep', { weekStart: '2026-09-21' }) }) },
    responses: {
      ...ok('Settlement (DRAFT)', { ...settlement, status: 'DRAFT', submittedBy: null, submittedAt: null }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_WEEK_START', 'FUTURE_WEEK'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['SETTLEMENT_LOCKED', 'PROJECT_LOCKED'] }),
    },
  });
  path(S, 'get', '/api/v1/projects/{id}/settlements', {
    summary: 'Settlements of a project',
    description: 'All roles with project access. Newest week first, without lines.',
    request: { params: idParam('Project'), query: settlementsQuery },
    responses: { ...ok('Settlements', [{ ...settlement, lines: undefined }], page(1)), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(S, 'get', '/api/v1/settlements', {
    summary: 'Settlements across projects',
    description: 'THEKEDAR, PM (their projects). E.g. `?status=SUBMITTED` for “My approvals”.',
    request: { query: settlementsQuery },
    responses: { ...ok('Settlements', [{ ...settlement, lines: undefined }], page(1)), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(S, 'get', '/api/v1/settlements/{id}', {
    summary: 'Settlement detail',
    description: 'All roles with project access. KPIs, lines (with the advances each line cuts) and who submitted / approved.',
    request: { params: idParam('WageSettlement') },
    responses: { ...ok('Settlement', settlement), ...errors({ ...AUTH, 403: READ_403, ...NOT_FOUND }) },
  });
  path(S, 'patch', '/api/v1/settlements/{id}/lines/{lineId}', {
    summary: 'Override the peshgi cut on a line',
    description: 'THEKEDAR, PM. DRAFT / RETURNED only; a note is required; at most the outstanding peshgi and the gross (400 ADVANCE_TOO_HIGH). Kept when the week is regenerated.',
    request: { params: lineParams, body: jsonBody(lineBody, { less: ex('Cut only Rs 2,000 this week', { advanceAdjustedPaisa: '200000', note: 'Wedding at home' }) }) },
    responses: { ...ok('Settlement', settlement), ...errors({ 400: ['VALIDATION_ERROR', 'ADVANCE_TOO_HIGH'], ...AUTH, 403: WRITE_403, 404: ['SETTLEMENT_NOT_FOUND', 'LINE_NOT_FOUND'], 409: ['SETTLEMENT_LOCKED'] }) },
  });
  path(S, 'post', '/api/v1/settlements/{id}/submit', {
    summary: 'Submit for approval',
    description: 'THEKEDAR, PM, MUNSHI. DRAFT / RETURNED → SUBMITTED; the week’s hazri is locked from now on.',
    request: { params: idParam('WageSettlement') },
    responses: { ...ok('Submitted', settlement), ...errors({ 400: ['EMPTY_SETTLEMENT'], ...AUTH, 403: WRITE_403, ...NOT_FOUND, 409: ['SETTLEMENT_LOCKED'] }) },
  });
  path(S, 'post', '/api/v1/settlements/{id}/approve', {
    summary: 'Approve',
    description: 'THEKEDAR, PM (their projects). SUBMITTED → APPROVED: hazri and the peshgi it cut are locked; wages can be paid.',
    request: { params: idParam('WageSettlement') },
    responses: { ...ok('Approved', { ...settlement, status: 'APPROVED', approvedBy: { id: '0199a8c0-0000-7000-8000-000000000002', name: 'Bilal Ahmed' }, approvedAt: '2026-09-28T06:00:00.000Z' }), ...errors({ ...AUTH, 403: WRITE_403, ...NOT_FOUND, 409: ['SETTLEMENT_NOT_SUBMITTED'] }) },
  });
  path(S, 'post', '/api/v1/settlements/{id}/return', {
    summary: 'Return with a comment',
    description: 'THEKEDAR, PM. SUBMITTED / APPROVED → RETURNED (unlocks it) while nothing is paid (409 SETTLEMENT_PAID).',
    request: { params: idParam('WageSettlement'), body: jsonBody(returnBody, { leave: ex('Akram was on leave Wednesday', { comment: 'Akram was on leave Wednesday — fix hazri' }) }) },
    responses: { ...ok('Returned', { ...settlement, status: 'RETURNED', returnComment: 'Akram was on leave Wednesday — fix hazri' }), ...errors({ 400: PW_400, ...AUTH, 403: WRITE_403, ...NOT_FOUND, 409: ['SETTLEMENT_NOT_SUBMITTED', 'SETTLEMENT_PAID'] }) },
  });
  path(S, 'post', '/api/v1/settlements/{id}/pay', {
    summary: 'Pay wages',
    description:
      'THEKEDAR, PM, MUNSHI (MUNSHI from SITE_CASH only). APPROVED only. SITE_CASH posts one WAGE_PAYMENT per line to the holder’s cash book (400 INSUFFICIENT_CASH checks the total first).',
    request: {
      params: idParam('WageSettlement'),
      body: jsonBody(payBody, {
        site: ex('Munshi pays two workers from site cash', { lineIds: [LIDS.line], paidFrom: 'SITE_CASH' }),
        bank: ex('Office pays by bank', { lineIds: [LIDS.line], paidFrom: 'BANK', reference: 'IBFT 88213' }),
      }),
    },
    responses: {
      ...ok('Settlement after payment', { ...settlement, status: 'APPROVED', paidPaisa: '1180000', unpaidPaisa: '5930000' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'LINE_NOT_FOUND', 'INSUFFICIENT_CASH', 'NO_CASH_ACCOUNT'], ...AUTH, 403: [...WRITE_403, 'PAID_FROM_NOT_ALLOWED'], ...NOT_FOUND, 409: ['SETTLEMENT_NOT_APPROVED', 'ALREADY_PAID'] }),
    },
  });

  // ─── Subcontract Accounts ─────────────────────────────────────────────────
  const C = 'Subcontract Accounts';
  path(C, 'get', '/api/v1/projects/{id}/subcontract-accounts', {
    summary: 'Sub-contractor accounts',
    description:
      'THEKEDAR, PM. Per sub-contract: value of verified work (+ adjustments), retention held, paid (advances + running payments), deductions and balance due = value − retention − paid − deductions. Negative → `overpaid`.',
    request: { params: idParam('Project') },
    responses: {
      ...ok('Accounts', {
        items: [{ ...assignment, verifiedQty: 8200, pendingMeasurements: 1, account }],
        totals: { valuePaisa: '36900000', paidPaisa: '32000000', retentionHeldPaisa: '1845000', balanceDuePaisa: '3055000', overpaidCount: 1 },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(C, 'get', '/api/v1/subcontract-assignments/{id}/ledger', {
    summary: 'Sub-contractor ledger',
    description: 'THEKEDAR, PM. Entries newest first with running balance (+ owed to them, − paid / deducted) and the account summary.',
    request: { params: idParam('SubcontractAssignment') },
    responses: {
      ...ok('Ledger', {
        assignment,
        account,
        entries: [{ id: LIDS.cashEntry, type: 'WORK_VALUE', amountPaisa: '5627250', runningPaisa: '5627250', refType: 'MEASUREMENT', refId: LIDS.measurement, occurredAt: '2026-10-05T07:00:00.000Z', note: '1250.5 sqft × 45', createdById: KHALID.id }],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['ASSIGNMENT_NOT_FOUND'] }),
    },
  });
  const accountResp = { assignment, account };
  path(C, 'post', '/api/v1/subcontract-assignments/{id}/progress', {
    summary: 'Post lump-sum progress',
    description: 'THEKEDAR, PM. LUMPSUM only. `percent` is the cumulative total (must move ahead, ≤ 100); the increase × contract value becomes WORK_VALUE.',
    request: { params: idParam('SubcontractAssignment'), body: jsonBody(progressBody, { forty: ex('40% done', { percent: 40, note: 'Ground floor rough-in done' }) }) },
    responses: { ...ok('Account', accountResp), ...errors({ 400: ['VALIDATION_ERROR', 'NOT_LUMPSUM', 'PROGRESS_NOT_AHEAD'], ...AUTH, 403: WRITE_403, 404: ['ASSIGNMENT_NOT_FOUND'] }) },
  });
  path(C, 'post', '/api/v1/subcontract-assignments/{id}/payments', {
    summary: 'Pay a sub-contractor',
    description:
      'THEKEDAR; PM only when the company setting `subcontractPaymentsByPm` is on. RUNNING / FINAL up to the balance due (400 EXCEEDS_BALANCE unless `allowAdvance`); FINAL also closes the sub-contract. ' +
      'RETENTION_RELEASE up to the retention held (400 EXCEEDS_RETENTION). SITE_CASH also leaves the cash book.',
    request: {
      params: idParam('SubcontractAssignment'),
      body: jsonBody(subcontractPaymentBody, {
        running: ex('Running payment Rs 30,000 by bank', { type: 'RUNNING', amountPaisa: '3000000', paidFrom: 'BANK', reference: 'HBL-2240' }),
        retention: ex('Release retention', { type: 'RETENTION_RELEASE', amountPaisa: '1845000', paidFrom: 'OFFICE_CASH' }),
      }),
    },
    responses: {
      ...createdResp('Account after payment', accountResp),
      ...errors({ 400: ['VALIDATION_ERROR', 'EXCEEDS_BALANCE', 'EXCEEDS_RETENTION', 'INSUFFICIENT_CASH', 'NO_CASH_ACCOUNT'], ...AUTH, 403: WRITE_403, 404: ['ASSIGNMENT_NOT_FOUND', 'CASH_ACCOUNT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }),
    },
  });
  path(C, 'post', '/api/v1/subcontract-assignments/{id}/deductions', {
    summary: 'Deduct from a sub-contractor',
    description: 'THEKEDAR. E.g. material wasted or work redone. (A shortage can also be charged here via `chargeToAssignmentId` when it is resolved as ACCEPT_LOSS.)',
    request: { params: idParam('SubcontractAssignment'), body: jsonBody(deductionBody, { waste: ex('Wasted shuttering plywood', { amountPaisa: '450000', reason: '3 plywood sheets cut wrong' }) }) },
    responses: { ...createdResp('Account', accountResp), ...errors({ 400: PW_400, ...AUTH, 403: WRITE_403, 404: ['ASSIGNMENT_NOT_FOUND'] }) },
  });
}

