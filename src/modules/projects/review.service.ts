/** Review (tab 6), activation and status transitions. */
import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { assertWithinLimit, lockPlanUsage } from '../../core/plan/planLimits.js';
import type { ProjectStatus } from '../../generated/prisma/client.js';
import { caller, findEditableProject, findProjectFor, type Caller } from './access.js';
import { contractTotalPaisa, floorTotals, num, projectCalculations } from './projects.dto.js';
import * as repo from './projects.repository.js';
import type { ChangeStatusInput } from './projects.schema.js';
import { audit, detail } from './projects.service.js';

export interface Issue {
  tab: 1 | 2 | 3 | 4 | 5;
  code: string;
  message: string;
}

/** Room floor area vs covered area beyond this → warning (walls and passages). */
const COVERAGE_GAP_RATIO = 0.15;
const MIN_DURATION_MONTHS = 3;

export function reviewProject(p: repo.ProjectFull, c: Caller) {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (tab: Issue['tab'], code: string, message: string) => errors.push({ tab, code, message });
  const warn = (tab: Issue['tab'], code: string, message: string) => warnings.push({ tab, code, message });
  const calc = projectCalculations(p);

  // Tab 1
  if (!p.clientId) err(1, 'CLIENT_MISSING', 'Choose the client');
  if (!p.siteAddress) err(1, 'SITE_ADDRESS_MISSING', 'Enter the site address');
  if (!p.city) err(1, 'CITY_MISSING', 'Enter the city');
  if (!p.startDate || !p.endDate) err(1, 'DATES_MISSING', 'Enter the start and end dates');

  // Tab 2
  if (!p.contractType || !p.billingModel) err(2, 'CONTRACT_MISSING', 'Choose the contract type and billing model');
  else if (p.contractType === 'LABOR_ONLY' ? p.ratePerSqftPaisa === null : p.contractValuePaisa === null) {
    err(2, 'CONTRACT_VALUE_MISSING', p.contractType === 'LABOR_ONLY' ? 'Enter the labour rate per sq ft' : 'Enter the contract value');
  }
  const stageTotal = Math.round(p.billingStages.reduce((s, x) => s + Number(x.percent), 0) * 100) / 100;
  if (!p.billingStages.length) err(2, 'BILLING_STAGES_MISSING', 'Add the billing stages');
  else if (stageTotal !== 100) err(2, 'BILLING_STAGES_TOTAL', `Billing stages add up to ${stageTotal}%, not 100%`);

  // Tab 3
  if (!p.plotUnit || p.plotSize === null || p.frontFt === null || p.depthFt === null || !p.structureType) {
    err(3, 'PLOT_STRUCTURE_MISSING', 'Fill in the plot size, dimensions and structure type');
  }
  if (!p.floors.some((f) => f.level === 'GROUND')) err(3, 'GROUND_FLOOR_MISSING', 'Add the ground floor');
  if (calc.plotAreaMismatch) {
    warn(3, 'PLOT_AREA_MISMATCH', `Plot area ${calc.plotAreaSqft} sq ft differs from front × depth ${calc.frontageAreaSqft} sq ft by more than 10%`);
  }

  // Tab 4
  if (p.coveredAreaSqft === null) err(4, 'COVERED_AREA_MISSING', 'Enter the covered area');

  // Tab 5
  if (calc.rooms === 0) err(5, 'NO_ROOMS', 'Add the rooms');
  const covered = num(p.coveredAreaSqft);
  if (covered && calc.rooms > 0 && Math.abs(calc.totalFloorAreaSqft - covered) / covered > COVERAGE_GAP_RATIO) {
    warn(
      5,
      'ROOM_AREA_VS_COVERED',
      `Rooms add up to ${calc.totalFloorAreaSqft} sq ft vs ${covered} sq ft covered — more than 15% apart (walls and passages?)`,
    );
  }

  // Team & schedule
  const active = p.userAccess.filter((a) => a.user.status === 'ACTIVE');
  if (!active.some((a) => a.user.role === 'PM')) warn(1, 'NO_PM', 'No project manager assigned');
  if (!active.some((a) => a.user.role === 'MUNSHI')) warn(1, 'NO_MUNSHI', 'No munshi assigned');
  if (p.startDate && p.endDate) {
    const minEnd = new Date(p.startDate);
    minEnd.setUTCMonth(minEnd.getUTCMonth() + MIN_DURATION_MONTHS);
    if (p.endDate < minEnd) warn(1, 'SHORT_SCHEDULE', 'The end date is less than 3 months after the start');
  }

  const total = contractTotalPaisa(p);
  const summary = {
    client: p.client ? { name: p.client.name, phone: p.client.phone } : null,
    contract: {
      contractType: p.contractType,
      billingModel: p.billingModel,
      ...(c.seesFinancials ? { contractTotalPaisa: total === null ? null : total.toString() } : {}),
      retentionPercent: Number(p.retentionPercent),
      defectPeriodMonths: p.defectPeriodMonths,
      billingStages: p.billingStages.length,
    },
    plot: { plotUnit: p.plotUnit, plotSize: num(p.plotSize), plotAreaSqft: calc.plotAreaSqft, frontFt: num(p.frontFt), depthFt: num(p.depthFt), cornerPlot: p.cornerPlot },
    structure: { structureType: p.structureType, hasBasement: p.hasBasement, floors: p.floors.length },
    coverage: { coveredAreaSqft: covered, semiCoveredSqft: Number(p.semiCoveredSqft), openAreaSqft: Number(p.openAreaSqft), boundaryWall: p.boundaryWall },
    roomsPerFloor: p.floors.map((f) => ({ level: f.level, name: f.name, ...floorTotals(f) })),
    supply: {
      contractor: p.supplyRules.filter((r) => r.suppliedBy === 'CONTRACTOR').length,
      owner: p.supplyRules.filter((r) => r.suppliedBy === 'OWNER').length,
    },
  };
  return { ready: errors.length === 0, errors, warnings, summary };
}

export async function getReview(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await findProjectFor(tx, c, id);
    return reviewProject(await repo.loadFull(tx, id), c);
  });
}

export async function activate(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findProjectFor(tx, c, id);
    if (project.status !== 'DRAFT') throw new Conflict('PROJECT_NOT_DRAFT', 'Only a draft project can be activated', { status: project.status });
    const review = reviewProject(await repo.loadFull(tx, id), c);
    if (!review.ready) throw new BadRequest('PROJECT_NOT_READY', 'Finish the wizard before activating', { errors: review.errors });

    await lockPlanUsage(tx, c.tenantId);
    await assertWithinLimit(tx, c.tenantId, 'activeProjects');
    await tx.project.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
    await audit(tx, c, 'project.activate', id, { code: project.code, warnings: review.warnings.map((w) => w.code) });
    return { ...(await detail(tx, c, id)), nextStep: 'ESTIMATE' as const };
  });
}

/** Allowed manual transitions. READ_ONLY is set only by the subscription job; DRAFT → ACTIVE is /activate. */
const TRANSITIONS: Partial<Record<ProjectStatus, ProjectStatus[]>> = {
  ACTIVE: ['CLOSEOUT'],
  CLOSEOUT: ['HANDED_OVER', 'ACTIVE'],
  HANDED_OVER: ['CLOSED'],
};

export async function changeStatus(id: string, input: ChangeStatusInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id, ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED', 'DRAFT', 'READ_ONLY']);
    const allowed = TRANSITIONS[project.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw new Conflict('INVALID_STATUS_TRANSITION', `A ${project.status} project can't move to ${input.status}`, { from: project.status, to: input.status, allowed });
    }
    if (input.status === 'ACTIVE') {
      // CLOSEOUT already counts against the plan; this catches a company that is over its limit after a downgrade
      await lockPlanUsage(tx, c.tenantId);
      await assertWithinLimit(tx, c.tenantId, 'activeProjects', 0);
    }
    await tx.project.update({ where: { id }, data: { status: input.status } });
    await audit(tx, c, 'project.status_change', id, { code: project.code, from: project.status, to: input.status, note: input.note ?? null });
    return detail(tx, c, id);
  });
}
