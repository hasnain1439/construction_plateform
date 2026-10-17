/** OpenAPI docs · Step 13: schedule (Gantt), baseline, re-plan, milestones, site progress, stoppage days, delays, quotas. */
import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, createdResp, ex, IDS, idParam, ok, path, READ_403, WRITE_403 } from '../inventory/docs.shared.js';
import { approveStoppageBody, generateScheduleBody, milestoneEditBody, progressBody, rejectStoppageBody, replanBody, stoppageBody, stoppagesQuery, todayQuery } from './schedule.schema.js';

const T = 'Schedule';
const projectParam = idParam('Project');
const milestoneParam = idParam('Milestone');
const stoppageParam = idParam('Stoppage');
const M_ID = '0199a8c0-0000-7000-8000-000000001301';
const M2_ID = '0199a8c0-0000-7000-8000-000000001302';
const S_ID = '0199a8c0-0000-7000-8000-000000001311';
const NO_MONEY = 'Quantities only — nothing in the schedule carries money.';

const QUOTA = { id: '0199a8c0-0000-7000-8000-000000001321', materialId: IDS.cement, material: 'cement', description: 'Cement OPC', unit: 'bag', ownerSupplied: false, plannedQty: 201.6, usedQty: 120, remainingQty: 81.6, usedPercent: 59.5, over: false };
const MILESTONE = {
  id: M_ID,
  projectId: IDS.dha,
  scheduleId: '0199a8c0-0000-7000-8000-000000001300',
  stageId: '0199a8c0-0000-7000-8000-000000001331',
  stageKey: 'F1_STRUCTURE',
  key: 'F1_STRUCTURE.SLAB',
  name: 'First floor — roof slab (lenter)',
  sortOrder: 6,
  workDays: 23,
  durationDays: 23,
  plannedStart: '2026-10-14',
  plannedEnd: '2026-11-10',
  baselineStart: '2026-07-20',
  baselineEnd: '2026-08-14',
  varianceDays: 88,
  curingDays: 14,
  curingUntil: '2026-11-24',
  startNoEarlierThan: null,
  status: 'IN_PROGRESS',
  progressPercent: 20,
  actualStart: '2026-10-14',
  actualEnd: null,
  late: false,
  dependsOn: [{ milestoneId: M2_ID, key: 'F1_STRUCTURE.WALLS', type: 'FS', lagDays: 7 }],
  billingStage: { id: '0199a8c0-0000-7000-8000-000000001341', label: 'Grey structure — first floor & roof', sortOrder: 4 },
  quotas: [QUOTA],
  basis: ['Concrete ≈ crush 988.5 cft ÷ (1.54 dry × 0.6) = 1,123.3 cft', 'Shuttering: 3,253.7 sq ft ÷ 300 sq ft per team-day = 10.8 days', '→ 23 days'],
  lastUpdate: { at: '2026-10-15T12:10:00.000Z', by: { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Rafaqat Ali' }, note: 'Shuttering half done' },
  updatedAt: '2026-10-15T12:10:00.000Z',
};
const STOPPAGE = {
  id: S_ID,
  projectId: IDS.dha,
  dates: ['2026-10-07', '2026-10-08'],
  from: '2026-10-07',
  to: '2026-10-08',
  days: 2,
  warning: null,
  reason: 'RAIN',
  category: 'EXCUSABLE',
  status: 'APPROVED',
  note: 'Heavy rain, site flooded',
  photos: [{ id: IDS.photo, url: 'https://…', thumbUrl: 'https://…' }],
  clientId: null,
  reportedBy: { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Rafaqat Ali' },
  reportedAt: '2026-10-07T08:30:00.000Z',
  decidedBy: { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' },
  decidedAt: '2026-10-08T15:00:00.000Z',
  decisionNote: null,
};
const DETAIL = {
  schedule: { id: MILESTONE.scheduleId, version: 2, startDate: '2026-03-16', teams: 1, note: null, changeOrderDays: 0, estimate: { id: '0199a8c0-0000-7000-8000-000000000e11', revision: 1 }, generatedAt: '2026-03-10T09:00:00.000Z', generatedBy: { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' }, replannedAt: null, planFloor: null },
  project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE', startDate: '2026-03-15', endDate: '2027-02-15' },
  approvedEstimate: { id: '0199a8c0-0000-7000-8000-000000000e11', revision: 1, approvedAt: '2026-03-04T11:30:00.000Z' },
  canGenerate: false,
  today: '2026-10-16',
  plannedEnd: '2027-02-02',
  baselineEnd: '2027-01-12',
  projectedEnd: '2027-03-01',
  calendar: { workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'], ramadanDayFactor: 0.75, ramadanPeriods: [{ start: '2026-02-19', end: '2026-03-20' }], holidays: [{ date: '2026-11-09', name: 'Iqbal Day', type: 'NON_WORKING', source: 'PLATFORM' }] },
  stages: [{ id: MILESTONE.stageId, stageKey: 'F1_STRUCTURE', name: 'First floor structure', sortOrder: 3, plannedStart: '2026-09-08', plannedEnd: '2026-11-10', baselineStart: '2026-06-20', baselineEnd: '2026-08-14', progressPercent: 62, status: 'IN_PROGRESS' }],
  milestones: [MILESTONE],
  stoppages: [STOPPAGE],
  baseline: { id: '0199a8c0-0000-7000-8000-000000001351', createdAt: '2026-03-10T09:00:00.000Z', startDate: '2026-03-16', plannedEnd: '2027-01-12' },
};
const SHIFT = { id: M_ID, key: 'F1_STRUCTURE.SLAB', name: 'First floor — roof slab (lenter)', plannedStart: { from: '2026-10-14', to: '2026-10-14' }, plannedEnd: { from: '2026-11-08', to: '2026-11-10' } };

export function registerScheduleDocs(): void {
  path(T, 'get', '/api/v1/projects/{id}/schedule', {
    summary: 'Schedule (Gantt data)',
    description: `Stages, milestones (planned / baseline / actual dates, curing, dependencies, progress, quotas), the working calendar (off days, holidays in the span, Ramadan), PENDING + APPROVED stoppage days, planned / baseline / projected end. Without a schedule: \`schedule: null\` and \`canGenerate\` (an APPROVED estimate exists). Permission schedule.plan.view. ${NO_MONEY}`,
    request: { params: projectParam },
    responses: { ...ok('Schedule', DETAIL), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/schedule/generate', {
    summary: 'Generate the schedule from the approved estimate',
    description:
      'Milestones per build stage from the APPROVED estimate quantities ÷ rulebook productivity (÷ teams), curing as FS lags (columns → slab, slab → next floor, plaster → tiles), dates on the company calendar (weekly off days, platform + company holidays, Ramadan × ramadanDayFactor). Saves the frozen baseline and plan version 1; billing stages are linked by label. ' +
      'Permission schedule.plan.manage; project DRAFT / ACTIVE. Audited `schedule.generate`.',
    request: { params: projectParam, body: jsonBody(generateScheduleBody, { plain: ex('From the project start date', {}), custom: ex('Own start, two teams', { startDate: '2026-03-16', teams: 2, note: 'Plan shared with the owner' }) }) },
    responses: { ...createdResp('Generated', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'NO_START_DATE'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['NO_APPROVED_ESTIMATE', 'SCHEDULE_EXISTS', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/schedule/replan', {
    summary: 'Re-plan (baseline kept)',
    description:
      'Recomputes the plan and records a new plan version; the baseline never changes. `fromToday` (default true): nothing not started is planned before today and in-progress work needs its remaining effort from today. `refreshQuantities`: re-reads the current APPROVED estimate (efforts, quotas, new milestones; unused vanished ones removed). Permission schedule.plan.manage. Audited `schedule.replan`.',
    request: {
      params: projectParam,
      body: jsonBody(replanBody, { replan: ex('Re-plan from today', { note: 'Rain week and late steel delivery' }), refresh: ex('New estimate revision', { note: 'Rev 3 approved', refreshQuantities: true }), bad: ex('❌ No reason → 400', {}) }),
    },
    responses: { ...ok('Re-planned', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'], 409: ['NO_APPROVED_ESTIMATE', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'get', '/api/v1/projects/{id}/schedule/baseline', {
    summary: 'Frozen baseline',
    description: 'The first plan as generated (immutable). Permission schedule.plan.view.',
    request: { params: projectParam },
    responses: {
      ...ok('Baseline', { id: DETAIL.baseline.id, scheduleId: MILESTONE.scheduleId, estimateId: DETAIL.approvedEstimate.id, startDate: '2026-03-16', plannedEnd: '2027-01-12', createdAt: '2026-03-10T09:00:00.000Z', createdBy: { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' }, milestones: [{ key: 'F1_STRUCTURE.SLAB', name: 'First floor — roof slab (lenter)', stageKey: 'F1_STRUCTURE', plannedStart: '2026-07-20', plannedEnd: '2026-08-14', workDays: 23, durationDays: 23, curingDays: 14, dependsOn: [{ key: 'F1_STRUCTURE.WALLS', type: 'FS', lagDays: 7 }] }] }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/schedule/versions', {
    summary: 'Plan versions',
    description: 'Every revised plan, newest first: GENERATED, REPLANNED, MILESTONE_EDITED, STOPPAGE_APPROVED. Permission schedule.plan.view.',
    request: { params: projectParam },
    responses: { ...ok('Versions', [{ id: '0199a8c0-0000-7000-8000-000000001361', version: 2, reason: 'STOPPAGE_APPROVED', note: 'RAIN · 2026-10-07 – 2026-10-08', plannedEnd: '2027-02-02', createdAt: '2026-10-08T15:00:00.000Z', createdBy: { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' }, milestones: [{ key: 'F1_STRUCTURE.SLAB', plannedStart: '2026-10-14', plannedEnd: '2026-11-10' }] }]), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/projects/{id}/schedule/delays', {
    summary: 'Delay breakdown',
    description:
      'Original end (contract end date, else baseline), revised end (+ approved OWNER and EXCUSABLE stoppage working days + change-order days — Step 15 hook), projected end (remaining effort from today at the current pace) and the days per category: owner, excusable, contractor (projected past revised: contractor stoppages + SLOW_PROGRESS) with the reasons. Pending stoppages are listed, not counted. Permission schedule.plan.view.',
    request: { params: projectParam },
    responses: {
      ...ok('Delays', {
        originalEnd: '2027-02-15',
        baselineEnd: '2027-01-12',
        plannedEnd: '2027-02-02',
        revisedEnd: '2027-02-17',
        projectedEnd: '2027-03-01',
        pace: 0.82,
        progressPercent: 41.3,
        days: { owner: 0, excusable: 2, contractor: 10, changeOrders: 0, total: 12 },
        aheadDays: 0,
        calendarDaysLate: 14,
        categories: [
          { category: 'OWNER', days: 0, reasons: [] },
          { category: 'EXCUSABLE', days: 2, reasons: [{ stoppageId: S_ID, reason: 'RAIN', dates: ['2026-10-07', '2026-10-08'], days: 2, note: 'Heavy rain, site flooded' }] },
          { category: 'CONTRACTOR', days: 10, reasons: [{ stoppageId: null, reason: 'SLOW_PROGRESS', dates: [], days: 10, note: 'Progress 41.3% at 82% of the planned pace' }] },
        ],
        pending: [{ stoppageId: '0199a8c0-0000-7000-8000-000000001312', reason: 'SMOG_BAN', category: 'EXCUSABLE', dates: ['2026-10-14'], days: 1 }],
        changeOrders: { days: 0, items: [] },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/schedule/quotas', {
    summary: 'Milestones & Quotas',
    description: `Material quota of each milestone (from the APPROVED estimate's lines of its stage, in the material's unit) vs used (usage entries linked to the milestone), project totals and usage not linked to a milestone. Permission schedule.plan.view. ${NO_MONEY}`,
    request: { params: projectParam },
    responses: {
      ...ok('Quotas', {
        milestones: [{ milestone: { id: M_ID, key: MILESTONE.key, name: MILESTONE.name, stageKey: 'F1_STRUCTURE', status: 'IN_PROGRESS', progressPercent: 20, plannedStart: '2026-10-14', plannedEnd: '2026-11-10' }, quotas: [QUOTA] }],
        materials: [{ materialId: IDS.cement, material: 'cement', description: 'Cement OPC', unit: 'bag', plannedQty: 812.4, usedQty: 655, remainingQty: 157.4, usedPercent: 80.6, over: false }],
        unlinked: [{ materialId: IDS.sand, name: 'Ravi sand', unit: 'cft', usedQty: 300 }],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/schedule/today', {
    summary: 'Aaj — today’s milestones',
    description: `For the site: milestones whose window covers the date or that are IN_PROGRESS / CURING / BLOCKED (\`today\`), PLANNED ones starting in the next 7 days (\`upcoming\`) and those past their planned end (\`late\`), with quota left. Permission schedule.plan.view. ${NO_MONEY}`,
    request: { params: projectParam, query: todayQuery },
    responses: { ...ok('Today', { date: '2026-10-16', today: [MILESTONE], upcoming: [], late: [] }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: READ_403, 404: ['PROJECT_NOT_FOUND', 'SCHEDULE_NOT_FOUND'] }) },
  });

  path(T, 'get', '/api/v1/milestones/{id}', {
    summary: 'Milestone',
    description: 'Milestone with its site updates (newest first, 50). Permission schedule.plan.view (project in scope, else 404).',
    request: { params: milestoneParam },
    responses: {
      ...ok('Milestone', { ...MILESTONE, updates: [{ id: '0199a8c0-0000-7000-8000-000000001371', at: '2026-10-15T12:10:00.000Z', date: '2026-10-15', status: 'IN_PROGRESS', progressPercent: 20, previousStatus: 'IN_PROGRESS', previousProgress: 10, note: 'Shuttering half done', photos: [], by: { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Rafaqat Ali' } }] }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['MILESTONE_NOT_FOUND'] }),
    },
  });
  path(T, 'patch', '/api/v1/milestones/{id}', {
    summary: 'Edit a milestone (Gantt drag)',
    description:
      'Name, effort (`workDays`), curing days, `startNoEarlierThan` (drag), dependencies (FS / SS + lag in calendar days) and the payment stage it starts. The plan is recomputed (successors pushed / pulled) and a plan version is written when dates moved; `dryRun: true` returns the shifts without saving (for the confirmation dialog). Dates of a DONE / CURING milestone come from the site (409 MILESTONE_DONE). Permission schedule.plan.manage. Audited `milestone.update`.',
    request: {
      params: milestoneParam,
      body: jsonBody(milestoneEditBody, {
        drag: ex('Drag (preview)', { startNoEarlierThan: '2026-10-20', dryRun: true }),
        effort: ex('Two more days', { workDays: 25 }),
        deps: ex('Start with the walls + 3 days', { dependsOn: [{ milestoneId: M2_ID, type: 'SS', lagDays: 3 }] }),
        bad: ex('❌ Nothing to change → 400', { dryRun: true }),
      }),
    },
    responses: { ...ok('Edited', { milestone: MILESTONE, shifted: [SHIFT], plannedEnd: { from: '2027-01-31', to: '2027-02-02' }, dryRun: false }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'DEPENDENCY_CYCLE', 'INVALID_DEPENDENCY', 'INVALID_BILLING_STAGE'], 403: WRITE_403, 404: ['MILESTONE_NOT_FOUND'], 409: ['MILESTONE_DONE', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/milestones/{id}/progress', {
    summary: 'Update progress / status from site',
    description:
      'PLANNED → IN_PROGRESS (progress > 0 starts it) → CURING (milestones with curing days) → DONE; progress 100 finishes it; BLOCKED needs a note. `date` = the actual start / end (≤ today). Same `clientId` again → the first update. Also the sync mutation MILESTONE_PROGRESS. ' +
      'Warnings never block: PREDECESSOR_NOT_DONE, and PREVIOUS_STAGE_UNPAID (stage lock) when the milestone starts a payment stage while an earlier stage invoice still has a balance — a billing event + a notification to the owner / PMs with billing; `balancePaisa` only with fields.amounts. Permission schedule.progress.edit. Audited `milestone.progress`.',
    request: {
      params: milestoneParam,
      body: jsonBody(progressBody, {
        start: ex('Started today', { status: 'IN_PROGRESS', note: 'Shuttering started' }),
        progress: ex('60 % with a photo', { progressPercent: 60, photoAttachmentIds: [IDS.photo] }),
        cast: ex('Slab cast (curing starts)', { progressPercent: 100, date: '2026-10-15' }),
        blocked: ex('Blocked', { status: 'BLOCKED', note: 'Steel not delivered' }),
        bad: ex('❌ Nothing → 400', { note: 'x' }),
      }),
    },
    responses: {
      ...ok('Updated', {
        id: '0199a8c0-0000-7000-8000-000000001371',
        milestone: MILESTONE,
        warnings: [{ code: 'PREVIOUS_STAGE_UNPAID', message: '"Grey structure — first floor & roof" is starting but an earlier stage is still unpaid', details: { billingStage: { id: MILESTONE.billingStage.id, label: MILESTONE.billingStage.label }, stages: [{ stageId: '0199a8c0-0000-7000-8000-000000001342', label: 'Grey structure — ground floor', invoiceId: '0199a8c0-0000-7000-8000-000000001381', invoiceNumber: 'INV-2026-0012', dueDate: '2026-09-03', balancePaisa: '110000000' }] } }],
      }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'NOTE_REQUIRED', 'DATE_IN_FUTURE', 'INVALID_ATTACHMENT'], 403: WRITE_403, 404: ['MILESTONE_NOT_FOUND'], 409: ['INVALID_STATUS_CHANGE', 'PROJECT_LOCKED'] }),
    },
  });

  path(T, 'get', '/api/v1/projects/{id}/stoppages', {
    summary: 'Stoppage days of a project',
    description: 'Newest first, with the approved working days per category and the pending count. Permission schedule.plan.view.',
    request: { params: projectParam, query: stoppagesQuery },
    responses: { ...ok('Stoppages', { items: [STOPPAGE], summary: { pending: 1, approvedDays: { OWNER: 0, EXCUSABLE: 2, CONTRACTOR: 0 } } }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/stoppages', {
    summary: 'Log a stoppage day',
    description:
      'Days the site could not work (`dates`, or `from` + `to`, ≤ 31 days, ≤ today + 60). A SITE_PHOTO is required except for HOLIDAY; OTHER needs a note. Category defaults from the reason (RAIN / SMOG_BAN / HOLIDAY → EXCUSABLE, OWNER_HOLD → OWNER, shortages / other → CONTRACTOR). A day already in a PENDING / APPROVED stoppage → 409 STOPPAGE_OVERLAP. Same `clientId` again → 200 with the first one. Also the sync mutation STOPPAGE_LOG. Permission schedule.stoppage.create. Audited `stoppage.create`.',
    request: {
      params: projectParam,
      body: jsonBody(stoppageBody, {
        rain: ex('Rain today', { dates: ['2026-10-16'], reason: 'RAIN', note: 'Heavy rain since morning', photoAttachmentIds: [IDS.photo] }),
        smog: ex('Smog ban (range)', { from: '2026-11-10', to: '2026-11-12', reason: 'SMOG_BAN', photoAttachmentIds: [IDS.photo] }),
        holiday: ex('Local holiday (no photo)', { dates: ['2026-10-20'], reason: 'HOLIDAY', note: 'Urs holiday in the area' }),
        bad: ex('❌ Rain without a photo → 400', { dates: ['2026-10-16'], reason: 'RAIN' }),
      }),
    },
    responses: { ...createdResp('Logged (PENDING)', { ...STOPPAGE, status: 'PENDING', decidedBy: null, decidedAt: null }), ...ok('Already logged (same clientId)', STOPPAGE), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'PHOTO_REQUIRED', 'NOTE_REQUIRED', 'INVALID_ATTACHMENT', 'DATE_TOO_FAR'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['STOPPAGE_OVERLAP', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'get', '/api/v1/stoppages/{id}', {
    summary: 'Stoppage',
    description: 'Permission schedule.plan.view (project in scope, else 404).',
    request: { params: stoppageParam },
    responses: { ...ok('Stoppage', STOPPAGE), ...errors({ ...AUTH, 403: READ_403, 404: ['STOPPAGE_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/stoppages/{id}/approve', {
    summary: 'Approve a stoppage',
    description:
      'PENDING → APPROVED (optionally another category). The days become non-working for the project: not-done milestones and their successors are pushed and a plan version (STOPPAGE_APPROVED) is written when a date moved; the revised end moves for OWNER / EXCUSABLE days. Permission schedule.stoppage.approve. Audited `stoppage.approve`.',
    request: { params: stoppageParam, body: jsonBody(approveStoppageBody, { approve: ex('Approve', {}), owner: ex('Charge to the owner', { category: 'OWNER', note: 'Owner asked to stop for the design change' }) }) },
    responses: { ...ok('Approved', { stoppage: STOPPAGE, shifted: [SHIFT], plannedEnd: { from: '2027-01-31', to: '2027-02-02' } }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: WRITE_403, 404: ['STOPPAGE_NOT_FOUND'], 409: ['STOPPAGE_NOT_PENDING'] }) },
  });
  path(T, 'post', '/api/v1/stoppages/{id}/reject', {
    summary: 'Reject a stoppage',
    description: 'PENDING → REJECTED with a note. Permission schedule.stoppage.approve. Audited `stoppage.reject`.',
    request: { params: stoppageParam, body: jsonBody(rejectStoppageBody, { reject: ex('Reject', { note: 'Work went on in the afternoon' }), bad: ex('❌ No note → 400', {}) }) },
    responses: { ...ok('Rejected', { ...STOPPAGE, status: 'REJECTED' }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: WRITE_403, 404: ['STOPPAGE_NOT_FOUND'], 409: ['STOPPAGE_NOT_PENDING'] }) },
  });
}
