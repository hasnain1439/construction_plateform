/**
 * Shuttering demand planner + idle rent (Step 16 part 2): loads the schedule, the APPROVED estimate,
 * the equipment ledger and the rentals, then hands them to the pure planner (shuttering.ts) /
 * idle detection (idle.ts). The planner carries no money; idle costs need fields.rates.
 */
import { fieldsOf, visible } from '../../core/auth/fieldStrip.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import { findProjectFor, projectScope } from '../projects/access.js';
import { audit, actor, equipmentRef, today as todayPkt, visibleLocationIds, type Actor } from './equipment.shared.js';
import type { IdleQuery, ShutteringDemandQuery } from './equipment.schema.js';
import { idleRentals, idleThreshold, runIdleCheckTx } from './idle.js';
import {
  addDays,
  holdWindow,
  planShuttering,
  platesFor,
  SHUTTERING_DEFAULTS,
  SLAB_MILESTONE_KEYS,
  SLAB_MILESTONES,
  slabArea,
  weekStartOf,
  weightedCoverage,
  type AreaSource,
  type Category,
  type PlanDemand,
  type PlanSupply,
  type SlabStage,
} from './shuttering.js';

type ProjectRef = { id: string; code: string; name: string };
type LocationRef = { id: string; type: 'STORE' | 'TRANSIT' | 'SITE'; name: string; projectId: string | null };

interface EstimateBasis {
  coveredAreaSqft?: number;
  floors?: Array<{ level: string; footprintSqft: number }>;
}

export async function shutteringDemand(query: ShutteringDemandQuery) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => demandTx(tx, a, query));
}

export async function projectShutteringDemand(projectId: string, query: Omit<ShutteringDemandQuery, 'projectId'>) {
  return shutteringDemand({ ...query, projectId });
}

export async function demandTx(tx: Tx, a: Actor, query: ShutteringDemandQuery, now = todayPkt()) {
  const today = now;
  const from = weekStartOf(query.from ?? today);
  const weeks = query.weeks ?? SHUTTERING_DEFAULTS.weeks;
  const to = addDays(from, weeks * 7 - 1);
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId: a.tenantId }, select: { shutteringPropsPerPlate: true, shutteringSparePercent: true } });

  // Projects: one (any status in scope) or every ACTIVE project in scope
  const projects = query.projectId
    ? [await findProjectFor(tx, a, query.projectId, 'equipment.view')]
    : await tx.project.findMany({ where: { tenantId: a.tenantId, status: 'ACTIVE', ...projectScope(a, 'equipment.view') }, orderBy: { code: 'asc' } });
  const projectIds = projects.map((p) => p.id);

  // Equipment: plates + props
  const equipment = await tx.equipment.findMany({ where: { tenantId: a.tenantId, category: { in: ['SHUTTERING_PLATE', 'PROP'] } }, orderBy: { name: 'asc' } });
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const categoryOf = (id: string) => eqById.get(id)!.category as Category;

  // Supply: what the caller can see
  const locationIds = await visibleLocationIds(tx, a);
  const rows = equipment.length
    ? (
        await tx.equipmentMovement.groupBy({
          by: ['locationId', 'equipmentId', 'rentalId'],
          where: { tenantId: a.tenantId, equipmentId: { in: equipment.map((e) => e.id) }, ...(locationIds ? { locationId: { in: locationIds } } : {}) },
          _sum: { quantity: true },
        })
      ).filter((r) => r._sum.quantity && r._sum.quantity.gt(0))
    : [];
  const locations = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.locationId))] } }, select: { id: true, type: true, name: true, projectId: true } });
  const yard = await tx.stockLocation.findFirst({ where: { tenantId: a.tenantId, systemKey: 'CENTRAL_STORE' }, select: { id: true, type: true, name: true, projectId: true } });
  const locById = new Map<string, LocationRef>([...locations, ...(yard ? [yard] : [])].map((l) => [l.id, l]));
  const rentalIds = [...new Set(rows.flatMap((r) => (r.rentalId ? [r.rentalId] : [])))];
  const rentals = await tx.equipmentRental.findMany({ where: { tenantId: a.tenantId, id: { in: rentalIds } }, select: { id: true, number: true, status: true, expectedEndDate: true } });
  const rentalById = new Map(rentals.map((r) => [r.id, r]));
  const supply: PlanSupply[] = rows.map((r) => {
    const loc = locById.get(r.locationId)!;
    const rental = r.rentalId ? rentalById.get(r.rentalId) : undefined;
    return {
      category: categoryOf(r.equipmentId),
      equipmentId: r.equipmentId,
      locationId: r.locationId,
      locationType: loc.type,
      projectId: loc.type === 'SITE' ? loc.projectId : null,
      rentalId: r.rentalId,
      rentalEnd: rental?.expectedEndDate ? formatDateOnly(rental.expectedEndDate) : null,
      qty: Number(r._sum.quantity!.toFixed(3)),
    };
  });

  // Parameters
  const plates = equipment.filter((e) => e.category === 'SHUTTERING_PLATE');
  const ownedPlates = (id: string) => supply.filter((s) => s.equipmentId === id && !s.rentalId).reduce((x, s) => x + s.qty, 0);
  const coverage = weightedCoverage(plates.map((e) => ({ qty: ownedPlates(e.id), coverageSqftPerUnit: e.coverageSqftPerUnit === null ? null : Number(e.coverageSqftPerUnit) })));
  const params = {
    plateCoverageSqft: coverage ?? SHUTTERING_DEFAULTS.plateCoverageSqft,
    plateCoverageSource: (coverage === null ? 'DEFAULT' : 'EQUIPMENT') as 'DEFAULT' | 'EQUIPMENT',
    propsPerPlate: settings ? Number(settings.shutteringPropsPerPlate) : SHUTTERING_DEFAULTS.propsPerPlate,
    sparePercent: settings?.shutteringSparePercent ?? SHUTTERING_DEFAULTS.sparePercent,
    beamSidesPercent: SHUTTERING_DEFAULTS.beamSidesPercent,
    defaultStrikeDays: SHUTTERING_DEFAULTS.defaultStrikeDays,
  };

  // Slab milestones + the APPROVED estimate's geometry
  const milestones = projectIds.length
    ? await tx.milestone.findMany({ where: { tenantId: a.tenantId, projectId: { in: projectIds }, key: { in: SLAB_MILESTONE_KEYS } }, orderBy: [{ projectId: 'asc' }, { sortOrder: 'asc' }] })
    : [];
  const scheduled = new Set((await tx.schedule.findMany({ where: { tenantId: a.tenantId, projectId: { in: projectIds } }, select: { projectId: true } })).map((s) => s.projectId));
  const estimates = await tx.estimate.findMany({ where: { tenantId: a.tenantId, projectId: { in: projectIds }, status: 'APPROVED' }, orderBy: { revision: 'desc' } });
  const estimateOf = new Map<string, (typeof estimates)[number]>();
  for (const e of estimates) if (!estimateOf.has(e.projectId)) estimateOf.set(e.projectId, e);
  const lines = estimateOf.size
    ? await tx.estimateLine.findMany({
        where: { tenantId: a.tenantId, estimateId: { in: [...estimateOf.values()].map((e) => e.id) }, lineKey: { in: Object.keys(SLAB_MILESTONES).map((s) => `GREY_LABOUR.${s}.SHUTTERING`) } },
        select: { estimateId: true, lineKey: true, trace: true },
      })
    : [];
  const traceOf = (estimateId: string, stage: string) => {
    const l = lines.find((x) => x.estimateId === estimateId && x.lineKey === `GREY_LABOUR.${stage}.SHUTTERING`);
    return l && Array.isArray(l.trace) ? (l.trace as unknown[]).map(String) : null;
  };

  const projectById = new Map<string, ProjectRef>(projects.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]));
  const warnings: Array<{ code: 'NO_PLATES' | 'NO_COVERAGE' | 'NO_SCHEDULE' | 'AREA_FALLBACK'; project?: ProjectRef }> = [];
  if (!plates.length) warnings.push({ code: 'NO_PLATES' });
  else if (coverage === null) warnings.push({ code: 'NO_COVERAGE' });
  for (const p of projects) if (!scheduled.has(p.id)) warnings.push({ code: 'NO_SCHEDULE', project: projectById.get(p.id)! });

  const demands: PlanDemand[] = [];
  const milestoneDtos = [];
  for (const m of milestones) {
    const stage = m.key.split('.')[0] as SlabStage;
    const est = estimateOf.get(m.projectId);
    const basis = (est?.basis ?? {}) as EstimateBasis;
    const level = SLAB_MILESTONES[stage].level;
    const slabFloors = milestones.filter((x) => x.projectId === m.projectId).length;
    const project = projects.find((p) => p.id === m.projectId)!;
    const covered = est ? Number(est.coveredAreaSqft) : project.coveredAreaSqft === null ? null : Number(project.coveredAreaSqft);
    const area = slabArea(
      {
        boqTrace: est ? traceOf(est.id, stage) : null,
        footprintSqft: basis.floors?.find((f) => f.level === level)?.footprintSqft ?? null,
        coveredAreaSqft: covered,
        slabFloors,
      },
      params.beamSidesPercent,
    );
    if (!area || area.source === 'COVERED_AREA') {
      if (!warnings.some((w) => w.code === 'AREA_FALLBACK' && w.project?.id === m.projectId)) warnings.push({ code: 'AREA_FALLBACK', project: projectById.get(m.projectId)! });
    }
    const need = area ? platesFor(area.totalSqft, params) : { plates: 0, props: 0 };
    const window = holdWindow(
      {
        status: m.status,
        plannedStart: formatDateOnly(m.plannedStart),
        plannedEnd: formatDateOnly(m.plannedEnd),
        actualStart: m.actualStart ? formatDateOnly(m.actualStart) : null,
        actualEnd: m.actualEnd ? formatDateOnly(m.actualEnd) : null,
        curingDays: m.curingDays,
      },
      today,
      params.defaultStrikeDays,
    );
    if (!window || window.until < from || window.from > to) continue; // struck already / outside the horizon
    demands.push({ projectId: m.projectId, milestoneId: m.id, from: window.from, until: window.until, qty: { SHUTTERING_PLATE: need.plates, PROP: need.props } });
    milestoneDtos.push({
      project: projectById.get(m.projectId)!,
      milestone: { id: m.id, key: m.key, name: m.name, stageKey: stage, status: m.status, plannedStart: formatDateOnly(m.plannedStart), plannedEnd: formatDateOnly(m.plannedEnd), curingDays: m.curingDays },
      holdFrom: window.from,
      holdUntil: window.until,
      area: area ?? { slabSqft: 0, beamSqft: 0, totalSqft: 0, source: 'COVERED_AREA' as AreaSource },
      plates: need.plates,
      props: need.props,
    });
  }

  // RENT suggestions name the main owned item and the yard last rented from
  const mainOwned = (category: Category) =>
    equipment
      .filter((e) => e.category === category)
      .map((e) => ({ id: e.id, qty: supply.filter((s) => s.equipmentId === e.id && !s.rentalId).reduce((x, s) => x + s.qty, 0) }))
      .sort((x, y) => y.qty - x.qty)[0]?.id;
  const rentEquipment: Partial<Record<Category, string>> = {};
  for (const c of ['SHUTTERING_PLATE', 'PROP'] as const) {
    const id = mainOwned(c);
    if (id) rentEquipment[c] = id;
  }
  const lastSupplier = new Map<Category, { id: string; name: string }>();
  for (const c of ['SHUTTERING_PLATE', 'PROP'] as const) {
    const r = await tx.equipmentRental.findFirst({
      where: { tenantId: a.tenantId, items: { some: { equipment: { category: c } } } },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      select: { supplier: { select: { id: true, name: true } } },
    });
    if (r) lastSupplier.set(c, r.supplier);
  }

  const plan = planShuttering({ today, from, weeks, projectId: query.projectId ?? null, demands, supply, yardLocationId: yard?.id ?? null, rentEquipment });

  // Projects named by suggestions (donor sites) that are not in the list
  const extra = [...new Set(plan.suggestions.flatMap((s) => [s.fromProjectId, s.toProjectId]).filter((id): id is string => !!id && !projectById.has(id)))];
  if (extra.length) for (const p of await tx.project.findMany({ where: { tenantId: a.tenantId, id: { in: extra } }, select: { id: true, code: true, name: true } })) projectById.set(p.id, p);
  const siteOf = async (projectId: string): Promise<LocationRef | null> => {
    for (const l of locById.values()) if (l.type === 'SITE' && l.projectId === projectId) return l;
    return tx.stockLocation.findFirst({ where: { tenantId: a.tenantId, type: 'SITE', projectId }, select: { id: true, type: true, name: true, projectId: true } });
  };
  const suggestions = [];
  for (const s of plan.suggestions) {
    const e = s.equipmentId ? eqById.get(s.equipmentId) : undefined;
    const rental = s.rentalId ? rentalById.get(s.rentalId) : undefined;
    suggestions.push({
      type: s.type,
      category: s.category,
      equipment: e ? equipmentRef(e) : null,
      qty: s.qty,
      fromWeek: s.fromWeek,
      toWeek: s.toWeek,
      from: s.fromLocationId ? (locById.get(s.fromLocationId) ?? null) : null,
      fromProject: s.fromProjectId ? (projectById.get(s.fromProjectId) ?? null) : null,
      idleAfterWeek: s.idleAfterWeek,
      toProject: s.toProjectId ? (projectById.get(s.toProjectId) ?? null) : null,
      toLocation: s.toProjectId ? await siteOf(s.toProjectId) : null,
      rental: rental ? { id: rental.id, number: rental.number } : null,
      supplier: s.type === 'RENT' ? (lastSupplier.get(s.category) ?? null) : null,
    });
  }

  return {
    scope: query.projectId ? ('PROJECT' as const) : ('COMPANY' as const),
    project: query.projectId ? projectById.get(query.projectId)! : null,
    from,
    to,
    today,
    weeks,
    parameters: params,
    equipment: { plates: plates.map(equipmentRef), props: equipment.filter((e) => e.category === 'PROP').map(equipmentRef) },
    milestones: milestoneDtos.sort((x, y) => x.holdFrom.localeCompare(y.holdFrom) || x.project.code.localeCompare(y.project.code)),
    series: plan.series,
    suggestions,
    warnings,
  };
}

// ─── Idle rent ──────────────────────────────────────────────────────────────

export async function listIdle(query: IdleQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    if (query.projectId) await findProjectFor(tx, a, query.projectId, 'equipment.view');
    const today = todayPkt();
    const thresholdDays = await idleThreshold(tx, a.tenantId);
    const rows = (await idleRentals(tx, a.tenantId, today, { locationIds: await visibleLocationIds(tx, a), ...(query.projectId ? { projectId: query.projectId } : {}), threshold: thresholdDays })).filter((r) => query.all || r.idle);
    const f = fieldsOf(a);
    return {
      today,
      thresholdDays,
      items: rows.map((r) => ({
        rental: r.rental,
        project: r.project,
        location: r.location,
        items: r.items.map((i) => ({ equipment: i.equipment, qty: i.qty, ...visible(f, 'rates', { ratePaisaPerDay: i.ratePaisaPerDay.toString(), dailyCostPaisa: i.dailyCostPaisa.toString() }) })),
        qty: r.qty,
        since: r.since,
        lastActivity: r.lastActivity,
        hasSchedule: r.hasSchedule,
        idleDays: r.idleDays,
        thresholdDays: r.thresholdDays,
        idle: r.idle,
        ...visible(f, 'rates', { dailyCostPaisa: r.dailyCostPaisa.toString(), idleCostPaisa: (r.dailyCostPaisa * BigInt(r.idleDays)).toString() }),
      })),
      ...visible(f, 'rates', { totalDailyCostPaisa: rows.filter((r) => r.idle).reduce((s, r) => s + r.dailyCostPaisa, 0n).toString() }),
    };
  });
}

export async function runIdleCheck() {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const r = await runIdleCheckTx(tx, a.tenantId);
    await audit(tx, a, 'equipment.idle.check', 'EquipmentRental', a.tenantId, { date: r.date, thresholdDays: r.thresholdDays, checked: r.checked, idle: r.idle, notified: r.notified.map((n) => n.number) });
    return r;
  });
}
