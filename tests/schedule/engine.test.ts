/**
 * Step 13 · pure schedule engine: working calendar (weekly off days, holidays, Ramadan factor,
 * stoppages), forward pass (FS / SS dependencies, curing lag in calendar days, stoppages push
 * successors, projection at pace) and the generator (efforts, curing, quotas from estimate lines).
 */
import { describe, expect, it } from 'vitest';
import { weekdayOf, WorkCalendar, type CalendarInput } from '../../src/modules/schedule/calendar.js';
import { generate, stageOfBillingLabel, type GenLine } from '../../src/modules/schedule/generator.js';
import { DependencyCycleError, forwardPass, paceOf, type PlanItem } from '../../src/modules/schedule/scheduler.js';

const MON_SAT = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const cal = (over: Partial<CalendarInput> = {}) => new WorkCalendar({ workingDays: MON_SAT, holidays: [], ramadanPeriods: [], ramadanDayFactor: 0.75, ...over });
const item = (id: string, workDays: number, deps: PlanItem['deps'] = [], over: Partial<PlanItem> = {}): PlanItem => ({
  id,
  workDays,
  deps,
  startNoEarlierThan: null,
  status: 'PLANNED',
  progressPercent: 0,
  actualStart: null,
  actualEnd: null,
  plannedStart: '2026-11-02',
  plannedEnd: '2026-11-02',
  ...over,
});

describe('working calendar', () => {
  it('skips the weekly off days (Sunday by default, Friday when the company is off on Fridays)', () => {
    // 2026-11-02 is a Monday
    expect(weekdayOf('2026-11-02')).toBe('MONDAY');
    expect(cal().walk('2026-11-02', 6)).toEqual({ end: '2026-11-07', durationDays: 6 });
    expect(cal().walk('2026-11-02', 7)).toEqual({ end: '2026-11-09', durationDays: 7 }); // Sunday skipped
    const fridayOff = cal({ workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'SATURDAY', 'SUNDAY'] });
    expect(fridayOff.isWorking('2026-11-06')).toBe(false);
    expect(fridayOff.walk('2026-11-02', 6)).toEqual({ end: '2026-11-08', durationDays: 6 }); // Friday skipped, Sunday worked
    expect(fridayOff.nextWorking('2026-11-06')).toBe('2026-11-07');
  });

  it('skips platform / company holidays; a PARTIAL holiday is half a day', () => {
    const c = cal({
      holidays: [
        { start: '2026-11-09', end: null, name: 'Iqbal Day', type: 'NON_WORKING', source: 'PLATFORM' },
        { start: '2026-11-11', end: '2026-11-12', name: 'Company picnic', type: 'NON_WORKING', source: 'COMPANY' },
        { start: '2026-11-14', end: null, name: 'Half day', type: 'PARTIAL', source: 'COMPANY' },
      ],
    });
    expect(c.isWorking('2026-11-09')).toBe(false);
    expect(c.capacity('2026-11-14')).toBe(0.5);
    // Mon 9 holiday, Tue 10 work, Wed 11 + Thu 12 off, Fri 13 work, Sat 14 half, Mon 16 work
    expect(c.walk('2026-11-09', 3)).toEqual({ end: '2026-11-16', durationDays: 4 });
    expect(c.workingDaysBetween('2026-11-08', '2026-11-14')).toBe(3);
    expect(c.holidayNames.get('2026-11-11')).toMatchObject({ name: 'Company picnic', source: 'COMPANY' });
  });

  it('Ramadan days give ramadanDayFactor of a day (3 days of work at 0.75 take 4 working days)', () => {
    const c = cal({ ramadanPeriods: [{ start: '2027-02-09', end: '2027-03-09' }], ramadanDayFactor: 0.75 });
    expect(c.capacity('2027-02-15')).toBe(0.75);
    expect(c.walk('2027-02-15', 3)).toEqual({ end: '2027-02-18', durationDays: 4 });
    expect(cal().walk('2027-02-15', 3)).toEqual({ end: '2027-02-17', durationDays: 3 });
    // after Ramadan it is a full day again
    expect(c.capacity('2027-03-10')).toBe(1);
  });

  it('approved stoppage days are non-working for the project but still count for the delay maths', () => {
    const c = cal({ stoppageDates: ['2026-11-03'] });
    expect(c.isWorking('2026-11-03')).toBe(false);
    expect(c.isWorking('2026-11-03', { ignoreStoppages: true })).toBe(true);
    expect(c.addWorkingDays('2026-11-02', 2)).toBe('2026-11-04');
  });
});

describe('forward pass', () => {
  it('FS with curing lag (calendar days) then the next working day; SS from the predecessor start', () => {
    const c = cal();
    const w = forwardPass(
      [
        item('slab', 3),
        item('walls', 2, [{ id: 'slab', type: 'FS', lagDays: 14 }]),
        item('mep', 4, [{ id: 'walls', type: 'FS', lagDays: 0 }]),
        item('plaster', 2, [{ id: 'mep', type: 'SS', lagDays: 2 }]),
      ],
      c,
      { mode: 'PLAN', start: '2026-11-02' },
    );
    expect(w.get('slab')).toMatchObject({ start: '2026-11-02', end: '2026-11-04' });
    // end 4 Nov + 1 + 14 = 19 Nov (Thursday)
    expect(w.get('walls')).toMatchObject({ start: '2026-11-19', end: '2026-11-20' });
    expect(w.get('mep')).toMatchObject({ start: '2026-11-21', end: '2026-11-25' }); // Sunday 22 skipped
    expect(w.get('plaster')).toMatchObject({ start: '2026-11-23', end: '2026-11-24' }); // SS: 21 + 2 = 23
  });

  it('a lag landing on an off day moves to the next working day', () => {
    const w = forwardPass([item('a', 1), item('b', 1, [{ id: 'a', type: 'FS', lagDays: 5 }])], cal(), { mode: 'PLAN', start: '2026-11-02' });
    // a ends Mon 2 → 2 + 1 + 5 = Sun 8 → Mon 9
    expect(w.get('b')!.start).toBe('2026-11-09');
  });

  it('an approved stoppage inside a window pushes the milestone and its successors', () => {
    const items = [item('a', 3), item('b', 2, [{ id: 'a', type: 'FS', lagDays: 0 }])];
    const before = forwardPass(items, cal(), { mode: 'PLAN', start: '2026-11-02' });
    const after = forwardPass(items, cal({ stoppageDates: ['2026-11-03', '2026-11-04'] }), { mode: 'PLAN', start: '2026-11-02' });
    expect(before.get('a')!.end).toBe('2026-11-04');
    expect(after.get('a')!.end).toBe('2026-11-06');
    expect(before.get('b')).toMatchObject({ start: '2026-11-05', end: '2026-11-06' });
    expect(after.get('b')).toMatchObject({ start: '2026-11-07', end: '2026-11-09' });
  });

  it('done / curing milestones sit on their actual dates; start-no-earlier-than and the re-plan floor hold back the rest', () => {
    const items = [
      item('a', 3, [], { status: 'DONE', actualStart: '2026-11-02', actualEnd: '2026-11-10' }),
      item('b', 2, [{ id: 'a', type: 'FS', lagDays: 0 }]),
      item('c', 1, [], { startNoEarlierThan: '2026-11-20' }),
    ];
    const w = forwardPass(items, cal(), { mode: 'PLAN', start: '2026-11-02' });
    expect(w.get('a')).toMatchObject({ start: '2026-11-02', end: '2026-11-10' });
    expect(w.get('b')!.start).toBe('2026-11-11');
    expect(w.get('c')!.start).toBe('2026-11-20');
    const floored = forwardPass(items, cal(), { mode: 'PLAN', start: '2026-11-02', floor: '2026-11-25' });
    expect(floored.get('b')!.start).toBe('2026-11-25');
  });

  it('a dependency loop is refused', () => {
    expect(() => forwardPass([item('a', 1, [{ id: 'b', type: 'FS', lagDays: 0 }]), item('b', 1, [{ id: 'a', type: 'FS', lagDays: 0 }])], cal(), { mode: 'PLAN', start: '2026-11-02' })).toThrow(
      DependencyCycleError,
    );
  });

  it('projection: remaining effort from today at the current pace', () => {
    const items = [item('a', 10, [], { status: 'IN_PROGRESS', progressPercent: 50, actualStart: '2026-11-02', plannedStart: '2026-11-02', plannedEnd: '2026-11-12' })];
    const c = cal();
    // planned 10 days by 12 Nov; on 12 Nov only 5 done → pace 0.5
    const { pace } = paceOf(items, c, '2026-11-12');
    expect(pace).toBe(0.5);
    const w = forwardPass(items, c, { mode: 'PROJECT', start: '2026-11-02', today: '2026-11-12', pace });
    // 5 days remaining ÷ 0.5 = 10 working days from 12 Nov
    expect(w.get('a')!.end).toBe('2026-11-23');
  });
});

describe('generator', () => {
  const L = (o: Partial<GenLine> & Pick<GenLine, 'lineKey' | 'section' | 'stageKey' | 'kind'>): GenLine => ({
    material: null,
    materialId: null,
    description: 'x',
    unit: 'nos',
    quantity: 0,
    effectiveQuantity: 0,
    suppliedBy: 'CONTRACTOR',
    ...o,
  });
  const lines: GenLine[] = [
    L({ lineKey: 'MASONRY.GF_STRUCTURE.bricks', section: 'MASONRY', stageKey: 'GF_STRUCTURE', kind: 'MATERIAL', material: 'bricks', materialId: 'b', unit: 'nos', quantity: 15000, effectiveQuantity: 15750 }),
    L({ lineKey: 'CONCRETE.GF_STRUCTURE.crush', section: 'CONCRETE', stageKey: 'GF_STRUCTURE', kind: 'MATERIAL', material: 'crush', materialId: null, unit: 'cft', quantity: 924, effectiveQuantity: 970 }),
    L({ lineKey: 'STEEL.GF_STRUCTURE.steel', section: 'STEEL', stageKey: 'GF_STRUCTURE', kind: 'MATERIAL', material: 'steel', materialId: 's', unit: 'kg', quantity: 4000, effectiveQuantity: 4160 }),
    L({ lineKey: 'GREY_LABOUR.GF_STRUCTURE.SHUTTERING', section: 'GREY_LABOUR', stageKey: 'GF_STRUCTURE', kind: 'LABOUR', material: 'SHUTTERING', unit: 'sqft', quantity: 3000, effectiveQuantity: 3000 }),
    L({ lineKey: 'GREY_LABOUR.PLASTER_MEP.PLASTER', section: 'GREY_LABOUR', stageKey: 'PLASTER_MEP', kind: 'LABOUR', material: 'PLASTER', unit: 'sqft', quantity: 5000, effectiveQuantity: 5000 }),
    L({ lineKey: 'FLOORING_TILES.FINISHING.floorTiles', section: 'FLOORING_TILES', stageKey: 'FINISHING', kind: 'MATERIAL', material: 'floorTiles', materialId: 't', unit: 'sqft', quantity: 1200, effectiveQuantity: 1284, suppliedBy: 'OWNER' }),
  ];
  const materials = new Map([
    ['b', { id: 'b', name: 'Bricks', unit: 'nos', altUnits: [] }],
    ['s', { id: 's', name: 'Steel #4', unit: 'ton', altUnits: [] }],
    ['t', { id: 't', name: 'Floor tiles', unit: 'sqft', altUnits: [] }],
  ]);
  const params = { productivityBricksPerDay: 1500, productivitySteelKgPerDay: 400, productivityConcreteCftPerDay: 400, productivityShutteringSqftPerDay: 300, productivityPlasterSqftPerDay: 250, productivityTileSqftPerDay: 120, curingDaysSlab: 14, curingDaysColumns: 7, curingDaysPlaster: 7 };

  it('efforts from quantities ÷ productivity, curing as FS lags, quotas in the material unit', () => {
    const g = generate({ lines, params, teams: 1, materials, coveredAreaSqft: 3000 });
    const by = new Map(g.milestones.map((m) => [m.key, m]));
    expect(g.stages.map((s) => s.stageKey)).toEqual(['FOUNDATION_PLINTH', 'GF_STRUCTURE', 'PLASTER_MEP', 'FINISHING']);
    // walls: 15 000 bricks ÷ 1500 = 10 days, cures 7 days before the slab
    expect(by.get('GF_STRUCTURE.WALLS')).toMatchObject({ workDays: 10, curingDays: 7 });
    // slab: 3000 ÷ 300 + 4000 ÷ 400 + 1050 cft ÷ 400 = 22.6 → 23 days; curing 14
    expect(by.get('GF_STRUCTURE.SLAB')).toMatchObject({ workDays: 23, curingDays: 14, deps: [{ key: 'GF_STRUCTURE.WALLS', type: 'FS', lagDays: 7 }] });
    expect(by.get('PLASTER_MEP.MEP')!.deps).toEqual([{ key: 'GF_STRUCTURE.SLAB', type: 'FS', lagDays: 14 }]);
    expect(by.get('PLASTER_MEP.PLASTER')).toMatchObject({ workDays: 20, deps: [{ key: 'PLASTER_MEP.MEP', type: 'SS', lagDays: 7 }] });
    expect(by.get('FINISHING.TILES')).toMatchObject({ workDays: 10, deps: [{ key: 'PLASTER_MEP.PLASTER', type: 'FS', lagDays: 7 }] });
    // foundation without quantities → defaults, flagged
    expect(by.get('FOUNDATION_PLINTH.FOUNDATION')!.basis.join(' ')).toContain('default');
    // quotas: masonry → walls, steel → slab converted kg → ton, owner tiles flagged
    expect(by.get('GF_STRUCTURE.WALLS')!.quotas).toEqual([{ materialId: 'b', material: 'bricks', description: 'Bricks', unit: 'nos', plannedQty: 15750, ownerSupplied: false }]);
    expect(by.get('GF_STRUCTURE.SLAB')!.quotas.find((q) => q.material === 'steel')).toMatchObject({ unit: 'ton', plannedQty: 4.16 });
    expect(by.get('FINISHING.TILES')!.quotas[0]).toMatchObject({ materialId: 't', ownerSupplied: true, plannedQty: 1284 });
  });

  it('teams divide the effort', () => {
    const g = generate({ lines, params, teams: 2, materials, coveredAreaSqft: 3000 });
    expect(g.milestones.find((m) => m.key === 'GF_STRUCTURE.WALLS')!.workDays).toBe(5);
  });

  it('billing stage labels map to schedule stages', () => {
    expect(stageOfBillingLabel('Foundation & plinth')).toBe('FOUNDATION_PLINTH');
    expect(stageOfBillingLabel('Grey structure — ground floor')).toBe('GF_STRUCTURE');
    expect(stageOfBillingLabel('Grey structure — first floor & roof')).toBe('F1_STRUCTURE');
    expect(stageOfBillingLabel('Plaster & MEP rough-in')).toBe('PLASTER_MEP');
    expect(stageOfBillingLabel('Flooring & tiles')).toBe('FINISHING');
    expect(stageOfBillingLabel('Agreement & mobilisation')).toBeNull();
    expect(stageOfBillingLabel('Retention (after defect period)')).toBeNull();
  });
});
