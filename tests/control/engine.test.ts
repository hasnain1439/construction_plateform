/**
 * Step 14 · pure control maths (no database): planned vs actual milestone progress, behind / late,
 * value-weighted physical progress, progress as of a past date, variance status, estimate line →
 * cost bucket, the projected margin (earned value) and the alert rule registry. Every expected
 * number is worked out by hand in the comments.
 */
import { describe, expect, it } from 'vitest';
import { mayReceiveRule } from '../../src/modules/control/alerts/engine.js';
import { alertRule, registerAlertRule, type AlertRule } from '../../src/modules/control/alerts/registry.js';
import { equipmentIdlePlaceholder } from '../../src/modules/control/alerts/rules/builtin.js';
import { equipmentIdleRule } from '../../src/modules/control/alerts/rules/equipmentIdle.js';
import { computeProjection, contractOf } from '../../src/modules/control/cost.service.js';
import { bucketOfLine, type EstimateData } from '../../src/modules/control/estimate.js';
import { behindOf, physicalProgress, plannedProgress, progressAsOf, type PlanMilestone } from '../../src/modules/control/plan.js';
import { statusOf } from '../../src/modules/control/variance.service.js';
import { WorkCalendar } from '../../src/modules/schedule/calendar.js';

const cal = new WorkCalendar({ workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'], holidays: [], ramadanPeriods: [], ramadanDayFactor: 0.75 });
const ms = (id: string, stageKey: string, workDays: number, progressPercent: number, over: Partial<PlanMilestone> = {}): PlanMilestone => ({
  id,
  key: `${stageKey}.${id}`,
  name: id,
  stageKey,
  sortOrder: 1,
  workDays,
  plannedStart: '2026-11-02',
  plannedEnd: '2026-11-07',
  baselineStart: null,
  baselineEnd: null,
  status: progressPercent >= 100 ? 'DONE' : progressPercent > 0 ? 'IN_PROGRESS' : 'PLANNED',
  progressPercent,
  actualStart: progressPercent > 0 ? '2026-11-02' : null,
  actualEnd: null,
  quotas: [],
  ...over,
});
const T = { behindPlanAlertPoints: 15, lateFinishGraceDays: 3 };

describe('milestone planned vs actual progress', () => {
  it('planned progress = working days elapsed ÷ working days of the window (Sunday off)', () => {
    // Mon 2 Nov → Sat 7 Nov = 6 working days
    const m = ms('a', 'GF_STRUCTURE', 6, 0);
    expect(plannedProgress(m, '2026-11-01', cal)).toBe(0); // before the start
    expect(plannedProgress(m, '2026-11-04', cal)).toBe(50); // Mon, Tue, Wed = 3 of 6
    expect(plannedProgress(m, '2026-11-07', cal)).toBe(100); // the last day
    // Thu 5 Nov → Tue 10 Nov spans Sunday 8: Thu, Fri, Sat, Mon, Tue = 5 working days; by Sun 8: 3 of 5 = 60 %
    expect(plannedProgress({ plannedStart: '2026-11-05', plannedEnd: '2026-11-10' }, '2026-11-08', cal)).toBe(60);
  });

  it('behind when planned − actual ≥ the points, late after the grace days; finished work is never behind', () => {
    const m = ms('a', 'GF_STRUCTURE', 6, 20);
    // on Wed 4 Nov: planned 50, actual 20 → 30 points behind (≥ 15)
    expect(behindOf(m, '2026-11-04', cal, T)).toMatchObject({ plannedProgressPercent: 50, actualProgressPercent: 20, behindPoints: 30, late: false, behind: true });
    // Mon 2 Nov: planned 1/6 = 16.7, actual 20 → not behind
    expect(behindOf(m, '2026-11-02', cal, T)).toMatchObject({ behindPoints: 0, behind: false });
    // 2 days after the planned end (Sat 7 → Mon 9): late 2 days ≤ grace 3 → behind only by points (100 − 20 = 80)
    expect(behindOf(m, '2026-11-09', cal, T)).toMatchObject({ lateDays: 2, late: true, behind: true });
    // 70 % done, 4 days late: points 30 ≥ 15 and late > grace
    expect(behindOf(ms('b', 'X', 6, 70), '2026-11-11', cal, { behindPlanAlertPoints: 50, lateFinishGraceDays: 3 })).toMatchObject({ lateDays: 4, behindPoints: 30, behind: true });
    // the same with grace 5: not late enough, 30 < 50 points → not behind
    expect(behindOf(ms('b', 'X', 6, 70), '2026-11-11', cal, { behindPlanAlertPoints: 50, lateFinishGraceDays: 5 }).behind).toBe(false);
    expect(behindOf(ms('c', 'X', 6, 100), '2026-11-20', cal, T)).toMatchObject({ behind: false, lateDays: 0, behindPoints: 0 });
  });
});

describe('physical progress', () => {
  const list = [ms('a1', 'A', 2, 100), ms('a2', 'A', 2, 0), ms('b1', 'B', 4, 0)];
  it('value-weighted by the estimate amount of each stage', () => {
    // stage A: (2 × 100 + 2 × 0) ÷ 4 = 50 %; stage B: 0 %; values A 300, B 100 → 300 × 50 % ÷ 400 = 37.5 %
    const p = physicalProgress(list, new Map([['A', 300n], ['B', 100n]]));
    expect(p.basis).toBe('ESTIMATE_VALUE');
    expect(p.percent).toBeCloseTo(37.5, 6);
    expect(p.stages.get('A')).toBeCloseTo(50, 6);
  });
  it('effort-weighted without estimate values; NONE without milestones', () => {
    // (2 × 100) ÷ (2 + 2 + 4) = 25 %
    expect(physicalProgress(list, null)).toMatchObject({ basis: 'EFFORT', percent: 25 });
    expect(physicalProgress(list, new Map())).toMatchObject({ basis: 'EFFORT', percent: 25 });
    expect(physicalProgress([], null)).toMatchObject({ basis: 'NONE', percent: 0 });
  });
  it('as of a past date from the milestone updates', () => {
    const m = ms('a1', 'A', 2, 100, { status: 'DONE' });
    const pick = progressAsOf(
      [
        { milestoneId: 'a1', date: '2026-10-01', status: 'IN_PROGRESS', progressPercent: 40, at: 1 },
        { milestoneId: 'a1', date: '2026-10-20', status: 'DONE', progressPercent: 100, at: 2 },
      ],
      '2026-10-10',
      [m],
    );
    expect(pick(m)).toBe(40);
    expect(progressAsOf([], '2026-10-10', [m])(ms('z', 'A', 1, 0, { plannedStart: '2026-12-01' }))).toBe(0);
  });
});

describe('material variance status', () => {
  const s = (estimatedTotalQty: number, estimatedToDateQty: number | null, consumedQty: number, variancePercent: number | null, schedule = true) => statusOf({ estimatedTotalQty, estimatedToDateQty, consumedQty, variancePercent }, 10, schedule);
  it('OVER / UNDER beyond the overuse %, else ON_TRACK; UNPLANNED, NOT_STARTED, NO_SCHEDULE', () => {
    // 366.148 due, 431.016 used → +64.868 = +17.7 % > 10 %
    expect(s(767.68, 366.148, 431.016, 17.7)).toBe('OVER');
    expect(s(100, 50, 44, -12)).toBe('UNDER');
    expect(s(100, 50, 54, 8)).toBe('ON_TRACK');
    expect(s(100, 50, 55, 10)).toBe('ON_TRACK'); // exactly the threshold is still on track
    expect(s(0, 0, 5, null)).toBe('UNPLANNED');
    expect(s(100, 0, 0, null)).toBe('NOT_STARTED');
    expect(s(100, 0, 3, null)).toBe('OVER'); // used before any progress was reported
    expect(s(100, null, 3, null, false)).toBe('NO_SCHEDULE');
  });
});

describe('estimate line → cost bucket', () => {
  it('maps kinds and sections', () => {
    expect(bucketOfLine({ kind: 'MATERIAL', section: 'CONCRETE' })).toBe('MATERIALS');
    expect(bucketOfLine({ kind: 'LABOUR', section: 'GREY_LABOUR' })).toBe('LABOUR');
    expect(bucketOfLine({ kind: 'LUMP_SUM', section: 'MEP_ROUGH_IN' })).toBe('SUBCONTRACT');
    expect(bucketOfLine({ kind: 'LUMP_SUM', section: 'EQUIPMENT_SHUTTERING' })).toBe('EQUIPMENT');
    expect(bucketOfLine({ kind: 'PERCENT', section: 'SITE_OVERHEADS' })).toBe('OVERHEADS');
    expect(bucketOfLine({ kind: 'PERCENT', section: 'CONTINGENCY' })).toBe('CONTINGENCY');
  });
});

describe('projected margin at completion (earned value)', () => {
  const est = (totalPaisa: bigint) => ({ id: 'e', revision: 1, totalPaisa, lines: [], stageValues: new Map(), rates: new Map() }) as EstimateData;
  const none = { pricePaisa: 0n, costPaisa: 0n, inContract: false };
  const base = { estimate: est(1_000_000n), progress: { percent: 40, basis: 'ESTIMATE_VALUE' as const, stages: new Map() }, actualPaisa: 500_000n, contractPaisa: 1_500_000n, changes: none };

  it('EAC = AC + (BAC − EV) ÷ CPI; margin = revised contract − EAC', () => {
    // EV = 1,000,000 × 40 % = 400,000; CPI = 400,000 ÷ 500,000 = 0.8; EAC = 500,000 + 600,000 ÷ 0.8 = 1,250,000
    // margin = 1,500,000 − 1,250,000 = 250,000 = 16.7 % of the contract
    expect(computeProjection(base)).toMatchObject({
      budgetAtCompletionPaisa: 1_000_000n,
      earnedValuePaisa: 400_000n,
      costPerformanceIndex: 0.8,
      estimateAtCompletionPaisa: 1_250_000n,
      remainingCostPaisa: 750_000n,
      projectedMarginPaisa: 250_000n,
      projectedMarginPercent: 16.7,
      basis: 'EARNED_VALUE',
    });
  });
  it('CPI is clamped to 0.5–1.5 and is 1 below 10 % progress', () => {
    // AC 100,000 for EV 400,000 → CPI 4 → 1.5; EAC = 100,000 + 600,000 ÷ 1.5 = 500,000
    expect(computeProjection({ ...base, actualPaisa: 100_000n })).toMatchObject({ costPerformanceIndex: 1.5, estimateAtCompletionPaisa: 500_000n });
    // 5 % done: EV 50,000, CPI 1 → EAC = 500,000 + 950,000 = 1,450,000
    expect(computeProjection({ ...base, progress: { ...base.progress, percent: 5 } })).toMatchObject({ costPerformanceIndex: 1, estimateAtCompletionPaisa: 1_450_000n, projectedMarginPaisa: 50_000n });
  });
  it('approved change orders (Step 15 hook) raise the contract and the budget', () => {
    // revised = 1,500,000 + 200,000; BAC = 1,000,000 + 100,000 → EV 440,000, CPI 0.88, EAC = 500,000 + 660,000 ÷ 0.88 = 1,250,000
    expect(computeProjection({ ...base, changes: { pricePaisa: 200_000n, costPaisa: 100_000n, inContract: false } })).toMatchObject({
      revisedContractPaisa: 1_700_000n,
      budgetAtCompletionPaisa: 1_100_000n,
      estimateAtCompletionPaisa: 1_250_000n,
      projectedMarginPaisa: 450_000n,
    });
    // already in the contract: not added twice
    expect(computeProjection({ ...base, changes: { pricePaisa: 200_000n, costPaisa: 0n, inContract: true } }).revisedContractPaisa).toBe(1_500_000n);
  });
  it('without an approved estimate: AC ÷ progress; not enough progress → null; no contract → no margin', () => {
    // 600,000 ÷ 50 % = 1,200,000
    expect(computeProjection({ ...base, estimate: null, progress: { ...base.progress, percent: 50 }, actualPaisa: 600_000n })).toMatchObject({ basis: 'PROGRESS_ONLY', estimateAtCompletionPaisa: 1_200_000n, projectedMarginPaisa: 300_000n });
    expect(computeProjection({ ...base, estimate: null, progress: { ...base.progress, percent: 5 } })).toMatchObject({ basis: 'NOT_ENOUGH_PROGRESS', estimateAtCompletionPaisa: null, projectedMarginPercent: null });
    expect(computeProjection({ ...base, contractPaisa: 0n })).toMatchObject({ basis: 'NO_CONTRACT', projectedMarginPaisa: null });
  });
});

describe('Step 15 hook: revised contract from the receivables', () => {
  it('uses moneyOf’s revised contract when present and never adds the approved changes twice', () => {
    const changes = { pricePaisa: 200n, costPaisa: 100n, inContract: false };
    expect(contractOf({ contract: 1000n }, changes)).toEqual({ contractPaisa: 1000n, changes });
    expect(contractOf({ contract: 1000n, revisedContractPaisa: '1200' }, changes)).toEqual({ contractPaisa: 1200n, changes: { ...changes, inContract: true } });
    expect(contractOf({ contract: 1000n, revisedContract: 1200n }, changes).contractPaisa).toBe(1200n);
    // the real moneyOf: contract = original + approved changes → split back, the price counts once
    const split = contractOf({ contract: 1200n, originalContract: 1000n, approvedChanges: 200n }, { ...changes, inContract: true });
    expect(split).toEqual({ contractPaisa: 1000n, changes: { pricePaisa: 200n, costPaisa: 100n, inContract: false } });
    expect(computeProjection({ estimate: null, progress: { percent: 0, basis: 'NONE', stages: new Map() }, actualPaisa: 0n, ...split }).revisedContractPaisa).toBe(1200n);
  });
});

describe('alert rule registry', () => {
  it('EQUIPMENT_IDLE is the Step 16 plug-in (wraps idleRentals, notify: false); a placeholder never replaces a real rule', () => {
    expect(alertRule('EQUIPMENT_IDLE')).toBe(equipmentIdleRule);
    expect(alertRule('EQUIPMENT_IDLE')).toMatchObject({ placeholder: false, notify: false }); // Step 16's own job notifies
    registerAlertRule(equipmentIdlePlaceholder);
    expect(alertRule('EQUIPMENT_IDLE')).toBe(equipmentIdleRule);
    const real: AlertRule = { ...equipmentIdlePlaceholder, placeholder: false, evaluate: async () => [] };
    registerAlertRule(real);
    registerAlertRule(equipmentIdlePlaceholder);
    expect(alertRule('EQUIPMENT_IDLE')).toBe(real);
    registerAlertRule(equipmentIdlePlaceholder); // (still the real one)
    expect(alertRule('EQUIPMENT_IDLE')!.evaluate).toBeDefined();
    registerAlertRule(equipmentIdleRule);
  });

  it('recipients: permission + money permissions + project scope; the owner always', () => {
    const rule = { permission: 'control.view', moneyPermissions: ['fields.amounts', 'fields.contract'] };
    const access = (keys: string[], scope: 'ASSIGNED_PROJECTS' | 'ALL_PROJECTS' = 'ASSIGNED_PROJECTS') => ({ owner: false, has: new Set(keys), scopes: { 'control.view': scope } as Record<string, 'ASSIGNED_PROJECTS' | 'ALL_PROJECTS'> });
    const assigned = (p: string) => p === 'P1';
    expect(mayReceiveRule({ owner: true, has: new Set(), scopes: {} }, rule, 'P2', assigned)).toBe(true);
    expect(mayReceiveRule(access(['control.view']), rule, 'P1', assigned)).toBe(false); // no money permissions
    expect(mayReceiveRule(access(['control.view', 'fields.amounts', 'fields.contract']), rule, 'P1', assigned)).toBe(true);
    expect(mayReceiveRule(access(['control.view', 'fields.amounts', 'fields.contract']), rule, 'P2', assigned)).toBe(false); // not assigned
    expect(mayReceiveRule(access(['control.view', 'fields.amounts', 'fields.contract'], 'ALL_PROJECTS'), rule, 'P2', assigned)).toBe(true);
    expect(mayReceiveRule(access(['fields.amounts', 'fields.contract'], 'ALL_PROJECTS'), rule, 'P1', assigned)).toBe(false); // no control.view
  });
});
