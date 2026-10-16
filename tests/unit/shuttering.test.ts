import { describe, expect, it } from 'vitest';
import {
  holdWindow,
  parseShutteringTrace,
  planShuttering,
  platesFor,
  slabArea,
  weekStartOf,
  weekStarts,
  weightedCoverage,
  type PlanDemand,
  type PlanInput,
  type PlanSupply,
} from '../../src/modules/equipment/shuttering.js';

const P = { plateCoverageSqft: 6, sparePercent: 5, propsPerPlate: 0.75 };

describe('shuttering planner — area and plates', () => {
  it('plates = ceil(area ÷ coverage × (1 + spare)); props = ceil(plates × props per plate)', () => {
    // 1,000 sq ft slab + 20 % beam sides = 1,200 sq ft ÷ 6 = 200 plates; + 5 % = 210; × 0.75 = 157.5 → 158 props
    const area = slabArea({ boqTrace: null, footprintSqft: 1000, coveredAreaSqft: null, slabFloors: 1 }, 20)!;
    expect(area).toEqual({ slabSqft: 1000, beamSqft: 200, totalSqft: 1200, source: 'ESTIMATE_FOOTPRINT' });
    expect(platesFor(area.totalSqft, P)).toEqual({ plates: 210, props: 158 });
    // exact multiples never round up: 600 sq ft ÷ 6 = 100, no spare → 100
    expect(platesFor(600, { ...P, sparePercent: 0, propsPerPlate: 1 })).toEqual({ plates: 100, props: 100 });
    expect(platesFor(0, P)).toEqual({ plates: 0, props: 0 });
  });

  it('reads slab soffit, sunshade and beam sides from the BoQ shuttering trace (detailed roof)', () => {
    const trace = [
      'Ground floor · walls: lintels 120 ft × (bottom 9″ + 2 sides × 6″) = 180 sqft',
      'Ground floor · slab: Slab soffit 1250 sq ft = 1250 sqft',
      'Ground floor · sunshade: Sunshade soffit 20 ft × 2 ft = 40 sqft',
      'Ground floor · beams: Beam sides 2 × 250 ft × (18″ − slab 5″) = 541.67 sqft',
      'Ground floor · columns: 12 columns × 2 × (9″ + 12″) × 10 ft = 420 sqft',
    ];
    expect(parseShutteringTrace(trace)).toEqual({ slab: 1290, beams: 541.67, frame: 0 });
    // slab 1,290 + beams 541.67 = 1,831.67 (columns and lintels are not plate work)
    expect(slabArea({ boqTrace: trace, footprintSqft: 1400, coveredAreaSqft: null, slabFloors: 2 }, 20)).toEqual({ slabSqft: 1290, beamSqft: 541.67, totalSqft: 1831.67, source: 'BOQ' });
  });

  it('% method frame line (beams + columns) → beam sides = slab × beamSidesPercent; no slab in the trace → footprint; → covered area', () => {
    const pct = ['Ground floor · slab: Slab soffit 1000 sq ft = 1000 sqft', 'Ground floor · beams + columns: 45 cft × 4 sq ft per cft = 180 sqft'];
    expect(slabArea({ boqTrace: pct, footprintSqft: null, coveredAreaSqft: null, slabFloors: 1 }, 20)).toEqual({ slabSqft: 1000, beamSqft: 200, totalSqft: 1200, source: 'BOQ' });
    // load-bearing (no frame) → no beams
    expect(slabArea({ boqTrace: ['First floor · slab: Slab soffit 900 sq ft = 900 sqft'], footprintSqft: null, coveredAreaSqft: null, slabFloors: 1 }, 20)!.beamSqft).toBe(0);
    expect(slabArea({ boqTrace: ['nothing useful'], footprintSqft: 800, coveredAreaSqft: 3000, slabFloors: 2 }, 25)).toEqual({ slabSqft: 800, beamSqft: 200, totalSqft: 1000, source: 'ESTIMATE_FOOTPRINT' });
    expect(slabArea({ boqTrace: null, footprintSqft: null, coveredAreaSqft: 3000, slabFloors: 2 }, 20)).toEqual({ slabSqft: 1500, beamSqft: 300, totalSqft: 1800, source: 'COVERED_AREA' });
    expect(slabArea({ boqTrace: null, footprintSqft: null, coveredAreaSqft: null, slabFloors: 2 }, 20)).toBeNull();
  });

  it('plate coverage = qty-weighted coverage of owned plates', () => {
    // 300 × 6 + 100 × 8 = 2,600 sq ft ÷ 400 = 6.5
    expect(weightedCoverage([{ qty: 300, coverageSqftPerUnit: 6 }, { qty: 100, coverageSqftPerUnit: 8 }, { qty: 50, coverageSqftPerUnit: null }])).toBe(6.5);
    expect(weightedCoverage([{ qty: 0, coverageSqftPerUnit: 6 }, { qty: 0, coverageSqftPerUnit: 4 }])).toBe(5);
    expect(weightedCoverage([{ qty: 10, coverageSqftPerUnit: null }])).toBeNull();
  });
});

describe('shuttering planner — hold window (curing lag)', () => {
  const base = { plannedStart: '2026-10-05', plannedEnd: '2026-10-16', actualStart: null, actualEnd: null, curingDays: 14 } as const;
  it('planned: start → end + curing lag; no curing lag → default strike days', () => {
    expect(holdWindow({ ...base, status: 'PLANNED' }, '2026-10-01', 14)).toEqual({ from: '2026-10-05', until: '2026-10-30' });
    expect(holdWindow({ ...base, status: 'PLANNED', curingDays: 0 }, '2026-10-01', 10)).toEqual({ from: '2026-10-05', until: '2026-10-26' });
  });
  it('running late: held until today + lag; actual dates win; DONE / struck CURING hold nothing', () => {
    expect(holdWindow({ ...base, status: 'IN_PROGRESS', actualStart: '2026-10-07' }, '2026-10-20', 14)).toEqual({ from: '2026-10-07', until: '2026-11-03' });
    expect(holdWindow({ ...base, status: 'CURING', actualStart: '2026-10-06', actualEnd: '2026-10-12' }, '2026-10-20', 14)).toEqual({ from: '2026-10-06', until: '2026-10-26' });
    expect(holdWindow({ ...base, status: 'CURING', actualStart: '2026-09-01', actualEnd: '2026-09-10' }, '2026-10-20', 14)).toBeNull();
    expect(holdWindow({ ...base, status: 'DONE' }, '2026-10-01', 14)).toBeNull();
  });
  it('weeks start on Monday', () => {
    expect(weekStartOf('2026-10-16')).toBe('2026-10-12'); // Friday → Monday
    expect(weekStartOf('2026-10-12')).toBe('2026-10-12');
    expect(weekStartOf('2026-10-18')).toBe('2026-10-12'); // Sunday
    expect(weekStarts('2026-10-16', 3)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });
});

// Two projects, A (DHA) and B (Johar); yard Y.
const A = 'project-a';
const B = 'project-b';
const site = (p: string) => `site-${p}`;
const own = (category: PlanSupply['category'], at: string, project: string | null, qty: number, type: PlanSupply['locationType'] = 'SITE'): PlanSupply => ({ category, equipmentId: `${category}-own`, locationId: at, locationType: type, projectId: project, rentalId: null, rentalEnd: null, qty });
const rented = (category: PlanSupply['category'], at: string, project: string | null, qty: number, rentalId: string, rentalEnd: string | null): PlanSupply => ({ category, equipmentId: `${category}-own`, locationId: at, locationType: project ? 'SITE' : 'STORE', projectId: project, rentalId, rentalEnd, qty });
const slab = (projectId: string, milestoneId: string, from: string, until: string, plates: number, props: number): PlanDemand => ({ projectId, milestoneId, from, until, qty: { SHUTTERING_PLATE: plates, PROP: props } });
const input = (over: Partial<PlanInput>): PlanInput => ({ today: '2026-10-12', from: '2026-10-12', weeks: 4, projectId: null, demands: [], supply: [], yardLocationId: 'yard', rentEquipment: { SHUTTERING_PLATE: 'SHUTTERING_PLATE-own', PROP: 'PROP-own' }, ...over });
const plates = (out: ReturnType<typeof planShuttering>) => out.series.find((s) => s.category === 'SHUTTERING_PLATE')!.weeks;

describe('shuttering planner — weekly demand across projects', () => {
  it('weekly need = highest day (slab B starts after A is struck in the same week → plates reused)', () => {
    const out = planShuttering(
      input({
        demands: [slab(A, 'a-gf', '2026-10-12', '2026-10-21', 300, 200), slab(B, 'b-gf', '2026-10-22', '2026-11-05', 200, 150)],
        supply: [own('SHUTTERING_PLATE', 'yard', null, 100, 'STORE'), own('SHUTTERING_PLATE', site(A), A, 300), own('SHUTTERING_PLATE', site(B), B, 50)],
      }),
    );
    const w = plates(out);
    expect(w.map((x) => x.needed)).toEqual([300, 300, 200, 200]); // week 2: A 300 (Mon–Wed), B 200 (Thu–Sun) → max 300; B runs to 5 Nov
    expect(w[1]!.demand.map((d) => d.milestoneId).sort()).toEqual(['a-gf', 'b-gf']);
    expect(w[0]).toMatchObject({ ownedAvailable: 450, onRent: 0, available: 450, shortfall: 0, surplus: 150 });
    expect(w[3]).toMatchObject({ needed: 200, surplus: 250 });
  });

  it('company shortfall; overlapping slabs add up; rented units count until the expected end (overdue still counts)', () => {
    const out = planShuttering(
      input({
        demands: [slab(A, 'a-f1', '2026-10-14', '2026-11-10', 400, 300), slab(B, 'b-gf', '2026-10-20', '2026-11-02', 200, 150)],
        supply: [
          own('SHUTTERING_PLATE', site(A), A, 244),
          own('SHUTTERING_PLATE', site(B), B, 130),
          own('SHUTTERING_PLATE', 'yard', null, 20, 'STORE'),
          rented('SHUTTERING_PLATE', site(A), A, 100, 'r1', '2026-10-25'),
          rented('SHUTTERING_PLATE', site(B), B, 30, 'r-overdue', '2026-10-01'),
        ],
      }),
    );
    const w = plates(out);
    expect(w.map((x) => x.needed)).toEqual([400, 600, 600, 600]); // B's slab is held to 2 Nov (week 4, Monday)
    expect(w.map((x) => x.ownedAvailable)).toEqual([394, 394, 394, 394]);
    expect(w.map((x) => x.onRent)).toEqual([130, 130, 30, 30]); // r1 ends 25 Oct: counts in weeks of 12 and 19 Oct only
    expect(w.map((x) => x.shortfall)).toEqual([0, 76, 176, 176]); // 600 − (394 + 130) = 76; 600 − (394 + 30) = 176
    expect(w[0]!.surplus).toBe(124);
  });

  it('project view: owned at the site + yard, rented at the site; only that project’s demand', () => {
    const out = planShuttering(
      input({
        projectId: A,
        demands: [slab(A, 'a-f1', '2026-10-12', '2026-10-25', 400, 300), slab(B, 'b-gf', '2026-10-12', '2026-10-25', 200, 150)],
        supply: [own('SHUTTERING_PLATE', site(A), A, 244), own('SHUTTERING_PLATE', site(B), B, 130), own('SHUTTERING_PLATE', 'yard', null, 20, 'STORE'), rented('SHUTTERING_PLATE', site(A), A, 50, 'r1', null)],
      }),
    );
    expect(plates(out)[0]).toMatchObject({ needed: 400, ownedAvailable: 264, onRent: 50, available: 314, shortfall: 86 });
    expect(plates(out)[0]!.demand).toEqual([{ projectId: A, milestoneId: 'a-f1', qty: 400 }]);
  });
});

describe('shuttering planner — suggestions', () => {
  it('shortfall → TRANSFER from the yard, then from a site idle after its slab, then RENT the rest', () => {
    // A needs 400 from week 2 (19 Oct); has 244. Yard 20. B needs 130 only in week 1 → idle after week 1.
    const out = planShuttering(
      input({
        demands: [slab(A, 'a-f1', '2026-10-19', '2026-11-08', 400, 0), slab(B, 'b-gf', '2026-10-12', '2026-10-16', 130, 0)],
        supply: [own('SHUTTERING_PLATE', site(A), A, 244), own('SHUTTERING_PLATE', site(B), B, 130), own('SHUTTERING_PLATE', 'yard', null, 20, 'STORE')],
      }),
    );
    const s = out.suggestions.filter((x) => x.category === 'SHUTTERING_PLATE');
    expect(s).toEqual([
      expect.objectContaining({ type: 'TRANSFER', qty: 20, fromLocationId: 'yard', fromProjectId: null, toProjectId: A, fromWeek: '2026-10-19', toWeek: '2026-11-02' }),
      expect.objectContaining({ type: 'TRANSFER', qty: 130, fromLocationId: site(B), fromProjectId: B, idleAfterWeek: '2026-10-12', toProjectId: A, fromWeek: '2026-10-19' }),
      expect.objectContaining({ type: 'RENT', qty: 6, toProjectId: A, fromWeek: '2026-10-19', toWeek: '2026-11-02', equipmentId: 'SHUTTERING_PLATE-own' }),
    ]); // 400 − 244 = 156 = 20 + 130 + 6
  });

  it('a rental ending inside the horizon opens a shortfall from the week after its expected end', () => {
    // A needs 200 props all month; holds 60 owned + 150 rented until 25 Oct → 210, 210, 60, 60 → short 140 from 26 Oct
    const out = planShuttering(input({ demands: [slab(A, 'a-f1', '2026-10-12', '2026-11-08', 0, 200)], supply: [own('PROP', site(A), A, 60), rented('PROP', site(A), A, 150, 'rnt-1', '2026-10-25')] }));
    expect(out.series.find((s) => s.category === 'PROP')!.weeks.map((w) => w.shortfall)).toEqual([0, 0, 140, 140]);
    // extend the rental first (140 of its 150 props are needed after 25 Oct)
    expect(out.suggestions).toEqual([expect.objectContaining({ type: 'EXTEND_RENTAL', category: 'PROP', rentalId: 'rnt-1', qty: 140, fromProjectId: A, toProjectId: A, fromWeek: '2026-10-26', toWeek: '2026-11-02' })]);
    // 300 needed: extending all 150 still leaves 300 − 210 = 90 short every week → RENT 90 for the whole month
    const more = planShuttering(input({ demands: [slab(A, 'a-f1', '2026-10-12', '2026-11-08', 0, 300)], supply: [own('PROP', site(A), A, 60), rented('PROP', site(A), A, 150, 'rnt-1', '2026-10-25')] }));
    expect(more.suggestions).toEqual([
      expect.objectContaining({ type: 'EXTEND_RENTAL', rentalId: 'rnt-1', qty: 150, fromWeek: '2026-10-26' }),
      expect.objectContaining({ type: 'RENT', qty: 90, toProjectId: A, fromWeek: '2026-10-12', toWeek: '2026-11-02' }),
    ]);
  });

  it('a site that still needs its plates later is not a donor; rented props nobody needs → RETURN_RENTAL', () => {
    const out = planShuttering(
      input({
        demands: [slab(A, 'a-f1', '2026-10-12', '2026-10-25', 300, 200), slab(B, 'b-gf', '2026-10-26', '2026-11-08', 130, 100)],
        supply: [
          own('SHUTTERING_PLATE', site(A), A, 250),
          own('SHUTTERING_PLATE', site(B), B, 130),
          own('PROP', site(A), A, 60),
          rented('PROP', site(A), A, 150, 'rnt-1', null),
          rented('PROP', site(B), B, 100, 'rnt-2', null),
          own('PROP', site(B), B, 40),
        ],
      }),
    );
    const plateS = out.suggestions.filter((x) => x.category === 'SHUTTERING_PLATE');
    expect(plateS).toEqual([expect.objectContaining({ type: 'RENT', qty: 50, toProjectId: A, fromWeek: '2026-10-12', toWeek: '2026-10-19' })]);
    // props: A needs 200, holds 210 → 10 spare, but B needs 100 later and holds 140 → 40 spare → return 40 of rnt-2 and 10 of rnt-1
    const propS = out.suggestions.filter((x) => x.category === 'PROP');
    expect(propS).toEqual([
      expect.objectContaining({ type: 'RETURN_RENTAL', rentalId: 'rnt-1', qty: 10, fromProjectId: A, fromWeek: '2026-10-26', idleAfterWeek: '2026-10-19' }),
      expect.objectContaining({ type: 'RETURN_RENTAL', rentalId: 'rnt-2', qty: 40, fromProjectId: B }),
    ]);
  });

  it('rented units at an idle site: moved to a site short of them first, the rest returned; project view keeps its own', () => {
    const supply = [own('PROP', site(A), A, 60), rented('PROP', site(B), B, 100, 'rnt-2', null)];
    const demands = [slab(A, 'a-f1', '2026-10-12', '2026-11-08', 0, 120)];
    const out = planShuttering(input({ demands, supply }));
    const propS = out.suggestions.filter((x) => x.category === 'PROP');
    expect(propS).toEqual([
      expect.objectContaining({ type: 'TRANSFER', qty: 60, fromProjectId: B, toProjectId: A, idleAfterWeek: null }),
      expect.objectContaining({ type: 'RETURN_RENTAL', qty: 40, rentalId: 'rnt-2', fromProjectId: B }),
    ]);
    const onlyB = planShuttering(input({ demands, supply, projectId: B }));
    expect(onlyB.suggestions.map((x) => x.type)).toEqual(['TRANSFER', 'RETURN_RENTAL']);
    const nothing = planShuttering(input({ demands: [], supply: [own('SHUTTERING_PLATE', site(A), A, 10)] }));
    expect(nothing.suggestions).toEqual([]);
  });
});
