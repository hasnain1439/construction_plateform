/** OpenAPI docs · Step 14: control — material / cost variance, burn rate vs progress, delay analysis, alert engine, thresholds. */
import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, CEMENT, ex, IDS, idParam, ok, path, READ_403, WRITE_403 } from '../inventory/docs.shared.js';
import { alertsQuery, controlSettingsBody, materialVarianceQuery, projectAlertsQuery, runAlertsBody } from './control.schema.js';

const T = 'Control';
const projectParam = idParam('Project');
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' };
const M_ID = '0199a8c0-0000-7000-8000-000000001301';
const MONEY =
  'Rupee keys are LEFT OUT (not null) without the data-visibility permission: material rates / PKR impact need fields.rates; cost-variance money needs fields.amounts + fields.rates; burn-rate cost fields.amounts, contract value fields.contract, spent % fields.amounts + fields.contract; the projected margin fields.amounts + fields.rates + fields.contract + fields.profit.';
const SETTINGS = { overuseAlertPercent: 10, behindPlanAlertPoints: 15, lateFinishGraceDays: 3, quotaAlertPercent: 100, spendAheadAlertPoints: 10, controlAlertsEnabled: true };
const ALERT = {
  id: '0199a8c0-0000-7000-8000-000000001401',
  rule: 'MATERIAL_OVERUSE',
  severity: 'WARNING',
  status: 'OPEN',
  project: { id: DHA.id, code: DHA.code, name: DHA.name },
  title: 'DHA Phase 6 · 10 Marla: Cement OPC 14.2% over the estimate',
  body: '412 bags used (with counted losses) against 360.8 bags due for the work done so far. Check wastage, theft or a wrong entry.',
  refType: 'MATERIAL',
  refId: IDS.cement,
  details: { materialId: IDS.cement, material: 'Cement OPC', unit: 'bag', estimatedToDateQty: 360.8, consumedQty: 412, varianceQty: 51.2, variancePercent: 14.2, thresholdPercent: 10 },
  actionUrl: `/projects/${IDS.dha}/control/material-variance`,
  openedAt: '2026-10-14T01:30:00.000Z',
  lastSeenAt: '2026-10-16T01:30:00.000Z',
  resolvedAt: null,
  notifiedAt: '2026-10-14T01:30:00.000Z',
  occurrences: 1,
};
const PROJECTION = {
  contractPaisa: '1850000000',
  approvedChangesPaisa: '0',
  revisedContractPaisa: '1850000000',
  budgetAtCompletionPaisa: '1512000000',
  actualToDatePaisa: '640000000',
  earnedValuePaisa: '589680000',
  costPerformanceIndex: 0.921,
  estimateAtCompletionPaisa: '1641737000',
  remainingCostPaisa: '1001737000',
  projectedMarginPaisa: '208263000',
  projectedMarginPercent: 11.3,
  basis: 'EARNED_VALUE',
  note: 'Cost to date + the rest of the approved estimate (Rev 1) adjusted by performance so far (CPI 0.921).',
};

export function registerControlDocs(): void {
  path(T, 'get', '/api/v1/projects/{id}/control/material-variance', {
    summary: 'Material variance (estimated vs delivered vs used vs stock vs loss)',
    description:
      'Per material at the project site: estimated total (APPROVED estimate quantities through the milestone quotas, material units) and estimated to date (× each milestone’s progress), delivered (receipts + site purchases + owner deliveries − returns), used (usage entries), counted loss (stock-count shortfall), in stock, consumed = used + loss, variance = consumed − estimated to date (qty and %). ' +
      'Status OVER / UNDER beyond the company overuse % (Alerts & Limits), ON_TRACK, UNPLANNED (not in the estimate), NOT_STARTED, NO_SCHEDULE (no schedule → nothing can be prorated). ' +
      'PKR impact (fields.rates): quantity variance × estimate rate + (actual average cost − estimate rate) × consumed. `?milestoneId=`: that milestone’s quotas × its progress vs the usage linked to it (site-level delivered / stock / loss are null). Owner-supplied materials: quantities only. ' +
      MONEY +
      ' Permission control.view (project in scope).',
    request: { params: projectParam, query: materialVarianceQuery },
    responses: {
      ...ok('Material variance', {
        project: DHA,
        milestone: null,
        asOf: '2026-10-16',
        estimate: { id: '0199a8c0-0000-7000-8000-000000000e11', revision: 1 },
        hasSchedule: true,
        progress: { percent: 46.8, basis: 'ESTIMATE_VALUE' },
        thresholdPercent: 10,
        items: [
          {
            materialId: IDS.cement,
            material: CEMENT,
            estimateKey: 'cement',
            description: 'Cement OPC',
            unit: 'bag',
            ownerSupplied: false,
            estimatedTotalQty: 812.4,
            estimatedToDateQty: 360.8,
            deliveredQty: 450,
            usedQty: 408,
            lossQty: 4,
            inStockQty: 38,
            consumedQty: 412,
            varianceQty: 51.2,
            variancePercent: 14.2,
            status: 'OVER',
            estimateRatePaisa: '142000',
            actualAvgCostPaisa: '145500',
            quantityImpactPaisa: '7270400',
            priceImpactPaisa: '1442000',
            impactPaisa: '8712400',
          },
        ],
        counts: { over: 1, under: 0, onTrack: 4, unplanned: 0, notStarted: 3 },
        totals: { quantityImpactPaisa: '7270400', priceImpactPaisa: '1442000', impactPaisa: '8712400' },
        milestones: [{ id: M_ID, key: 'F1_STRUCTURE.SLAB', name: 'First floor — roof slab (lenter)', stageKey: 'F1_STRUCTURE', status: 'IN_PROGRESS', progressPercent: 20 }],
      }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'INVALID_MILESTONE'], 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/control/cost-variance', {
    summary: 'Cost variance by bucket vs the estimate to date + projected margin',
    description:
      'Buckets MATERIALS, LABOUR (wages), SUBCONTRACT (theka payments; estimate LUMP_SUM lines such as MEP), EQUIPMENT, OVERHEADS, LOSSES, CONTINGENCY: estimate total, estimate to date (each APPROVED estimate line × its stage’s progress; lines without a stage × physical progress), actual (cost engine), variance (actual − estimate to date; positive = over). ' +
      '`labourCombined` = LABOUR + SUBCONTRACT (piece-rate labour is often paid as a theka). Physical progress is weighted by the estimate value of each stage (`ESTIMATE_VALUE`), else by effort (`EFFORT`). ' +
      '`projection` = projected margin at completion: EAC = cost to date + (budget − earned value) ÷ CPI (CPI = earned value ÷ cost, 0.5–1.5; 1 below 10 % progress); margin = revised contract − EAC. ' +
      MONEY +
      ' Permission control.view.',
    request: { params: projectParam },
    responses: {
      ...ok('Cost variance', {
        project: DHA,
        asOf: '2026-10-16',
        estimate: { id: '0199a8c0-0000-7000-8000-000000000e11', revision: 1 },
        hasSchedule: true,
        progress: { percent: 39, basis: 'ESTIMATE_VALUE' },
        thresholdPercent: 10,
        buckets: [
          { bucket: 'MATERIALS', status: 'OVER', estimateTotalPaisa: '980000000', estimateToDatePaisa: '382200000', actualPaisa: '431000000', variancePaisa: '48800000', variancePercent: 12.8 },
          { bucket: 'LABOUR', status: 'UNDER', estimateTotalPaisa: '260000000', estimateToDatePaisa: '101400000', actualPaisa: '61000000', variancePaisa: '-40400000', variancePercent: -39.8 },
        ],
        totals: { estimateTotalPaisa: '1512000000', estimateToDatePaisa: '589680000', actualPaisa: '640000000', variancePaisa: '50320000', variancePercent: 8.5 },
        labourCombined: { estimateToDatePaisa: '140000000', actualPaisa: '150000000', variancePaisa: '10000000', variancePercent: 7.1 },
        stages: [{ stageKey: 'GF_STRUCTURE', progressPercent: 100, estimatePaisa: '320000000', estimateToDatePaisa: '320000000' }],
        projection: PROJECTION,
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/control/burn-rate', {
    summary: 'Burn rate (cost % of contract) vs physical progress by month',
    description:
      'One row per Karachi month from the first cost / plan month to this month: cost of the month and cumulative (fields.amounts), cumulative cost as % of the revised contract (`spentPercent`), physical progress at month end (milestone updates up to that date; this month = live) and `gapPoints` = spent − progress; `ahead` when the gap is above the spend-ahead points (Alerts & Limits). `current.plannedProgressPercent` = where the plan says the work should be today. ' +
      MONEY +
      ' Permission control.view.',
    request: { params: projectParam },
    responses: {
      ...ok('Burn rate', {
        project: DHA,
        asOf: '2026-10-16',
        thresholdPoints: 10,
        progressBasis: 'ESTIMATE_VALUE',
        hasSchedule: true,
        contractPaisa: '1850000000',
        months: [
          { month: '2026-09', progressPercent: 33.5, costPaisa: '62000000', cumulativeCostPaisa: '590000000', spentPercent: 31.9, gapPoints: -1.6, ahead: false },
          { month: '2026-10', progressPercent: 39, costPaisa: '50000000', cumulativeCostPaisa: '640000000', spentPercent: 34.6, gapPoints: -4.4, ahead: false },
        ],
        current: { progressPercent: 39, plannedProgressPercent: 44.2, spentPercent: 34.6, gapPoints: -4.4, ahead: false },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/control/delay-analysis', {
    summary: 'Delay analysis (Step 13 delays + planned vs actual per milestone + timeline)',
    description:
      '`delays` = the Step 13 delay breakdown (original / revised / projected end, owner / excusable / contractor days with reasons, pending stoppages). Each milestone: planned progress today (working days elapsed of its window) vs actual, `behindPoints`, `lateDays` (past its planned end, not finished) and `behind` (the MILESTONE_BEHIND_PLAN condition with the company thresholds). `timeline`: stoppages, plan versions and site updates, newest first (≤ 100). Without a schedule: `hasSchedule: false`, `delays: null`. No money. Permission control.view.',
    request: { params: projectParam },
    responses: {
      ...ok('Delay analysis', {
        project: DHA,
        asOf: '2026-10-16',
        thresholdPoints: 15,
        graceDays: 3,
        hasSchedule: true,
        delays: { originalEnd: '2027-02-15', baselineEnd: '2027-01-12', plannedEnd: '2027-02-02', revisedEnd: '2027-02-17', projectedEnd: '2027-03-01', pace: 0.86, progressPercent: 41.2, days: { owner: 0, excusable: 2, contractor: 10, changeOrders: 0, total: 12 }, aheadDays: 0, calendarDaysLate: 14, categories: [], pending: [], changeOrders: { days: 0, items: [] } },
        milestones: [
          { id: M_ID, key: 'F1_STRUCTURE.SLAB', name: 'First floor — roof slab (lenter)', stageKey: 'F1_STRUCTURE', status: 'IN_PROGRESS', plannedStart: '2026-10-08', plannedEnd: '2026-10-28', baselineStart: '2026-07-20', baselineEnd: '2026-08-14', varianceDays: 75, actualStart: '2026-10-14', actualEnd: null, progressPercent: 20, plannedProgressPercent: 44.4, behindPoints: 24.4, late: false, lateDays: 0, behind: true },
        ],
        timeline: [{ date: '2026-10-15', kind: 'MILESTONE_UPDATE', title: 'First floor — roof slab (lenter)', detail: null, category: null, status: 'IN_PROGRESS', days: null, refId: M_ID, plannedEnd: null, progressPercent: 20 }],
        summary: { behind: 1, late: 0, finished: 8, total: 13 },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/control/alerts', {
    summary: 'Control alerts of a project',
    description: 'Alerts the caller may see (rules whose permission + money permissions they hold), OPEN by default. Title / body in the reader’s language; never money. Permission control.view.',
    request: { params: projectParam, query: projectAlertsQuery },
    responses: { ...ok('Alerts', { items: [ALERT] }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/control/summary', {
    summary: 'Company control summary (dashboard card)',
    description:
      'Every ACTIVE / CLOSEOUT project in the caller’s control.view scope: physical vs planned progress, behind / late milestones, materials over the estimate, exhausted quotas, open alerts by severity; `spentPercent` / `gapPoints` with fields.amounts + fields.contract, `projectedMarginPercent` / `projectedMarginPaisa` with the projected-margin permissions. Permission control.view.',
    responses: {
      ...ok('Summary', {
        asOf: '2026-10-16',
        thresholds: SETTINGS,
        projects: [{ project: DHA, hasSchedule: true, progressPercent: 39, plannedProgressPercent: 44.2, behindMilestones: 1, lateMilestones: 0, overuseMaterials: 1, quotasExhausted: 1, openAlerts: { critical: 0, warning: 3, info: 0 }, spentPercent: 34.6, gapPoints: -4.4, projectedMarginPercent: 11.3, projectedMarginPaisa: '208263000' }],
        alerts: { open: 3, critical: 0, warning: 3, info: 0, byRule: { MATERIAL_OVERUSE: 1, MILESTONE_BEHIND_PLAN: 1, QUOTA_EXHAUSTED: 1 } },
      }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'get', '/api/v1/control/alerts', {
    summary: 'Control alerts (company)',
    description: 'Paged, newest `lastSeenAt` first; only projects in the caller’s control.view scope and rules the caller may see. Filters: project, rule, severity, status (OPEN default / RESOLVED / ALL). Permission control.view.',
    request: { query: alertsQuery },
    responses: { ...ok('Alerts', [ALERT], { page: 1, limit: 25, total: 1, totalPages: 1 }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/control/alerts/rules', {
    summary: 'Alert rule registry',
    description:
      'Every rule the engine knows: source (CONTROL / EXTERNAL job), trigger (DAILY 06:30 PKT, ON_WRITE = usage / stock count / milestone progress), default severity, recipients (permission + money permissions, project scope; the owner always), threshold setting and value, dedupe key + renotify window, link, status (ACTIVE / DISABLED / PENDING_PLUGIN — EQUIPMENT_IDLE until Step 16 plugs it in). Permission control.view.',
    responses: {
      ...ok('Rules', [
        { rule: 'MATERIAL_OVERUSE', source: 'CONTROL', trigger: 'DAILY_AND_ON_WRITE', severity: 'WARNING', permission: 'control.view', moneyPermissions: [], threshold: { setting: 'overuseAlertPercent', value: 10 }, dedupe: { key: 'MATERIAL_OVERUSE:<projectId>:<materialId>', renotifyHours: 168 }, actionUrl: '/projects/:projectId/control/material-variance', status: 'ACTIVE', description: 'A material is used …' },
        { rule: 'EQUIPMENT_IDLE', source: 'CONTROL', trigger: 'DAILY', severity: 'WARNING', permission: 'equipment.rental.manage', moneyPermissions: [], threshold: { setting: 'equipmentIdleDays', value: null }, dedupe: { key: 'EQUIPMENT_IDLE:<rentalId>', renotifyHours: 24 }, actionUrl: '/equipment/rentals', status: 'PENDING_PLUGIN', description: 'Rented equipment …' },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'post', '/api/v1/control/alerts/run', {
    summary: 'Run the alert engine now',
    description:
      'Evaluates the rules (default all) for one project or every ACTIVE / CLOSEOUT project now — what the daily job does. New findings open alerts and notify (CONTROL_ALERT) the permitted users; findings that are gone resolve their alert. Permission control.manage. Audited `control.alerts_run`.',
    request: {
      body: jsonBody(runAlertsBody, {
        all: ex('Every project, every rule', {}),
        one: ex('One project, overuse only', { projectId: IDS.dha, rules: ['MATERIAL_OVERUSE'] }),
        bad: ex('❌ Unknown field → 400', { project: 'x' }),
      }),
    },
    responses: { ...ok('Ran', { ranAt: '2026-10-16T09:00:00.000Z', projects: 2, evaluated: 3, opened: 1, updated: 2, resolved: 0, notified: 3, alerts: [ALERT] }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'UNKNOWN_RULE'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['ALERTS_DISABLED'] }) },
  });
  path(T, 'get', '/api/v1/control/settings', {
    summary: 'Alert thresholds',
    description: 'The company thresholds of the control alerts (also in GET /company/settings for the owner). Permission control.view.',
    responses: { ...ok('Thresholds', SETTINGS), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'put', '/api/v1/control/settings', {
    summary: 'Change alert thresholds',
    description: 'overuseAlertPercent 1–20, behindPlanAlertPoints 5–50, lateFinishGraceDays 0–30, quotaAlertPercent 50–150, spendAheadAlertPoints 1–50, controlAlertsEnabled. Permission control.manage. Audited `control.settings_update` (before / after).',
    request: {
      body: jsonBody(controlSettingsBody, {
        stricter: ex('Stricter overuse', { overuseAlertPercent: 5, behindPlanAlertPoints: 10 }),
        off: ex('Switch alerts off', { controlAlertsEnabled: false }),
        bad: ex('❌ Out of range → 400', { quotaAlertPercent: 300 }),
      }),
    },
    responses: { ...ok('Thresholds', { ...SETTINGS, overuseAlertPercent: 5, behindPlanAlertPoints: 10 }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: WRITE_403 }) },
  });
}
