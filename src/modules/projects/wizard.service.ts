/** Wizard tabs 2–4: contract (supply rules + billing stages), plot & structure (floors), coverage. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import type { Prisma, SuppliedBy } from '../../generated/prisma/client.js';
import type { StageDef } from '../master-data/catalog.js';
import { checkStages } from '../master-data/labor.service.js';
import { caller, findEditableProject } from './access.js';
import { stageAmounts } from './calc.js';
import { FLOOR_LEVELS, FLOOR_NAMES, presetFor } from './presets.js';
import { contractTotalPaisa } from './projects.dto.js';
import type { UpdateContractInput, UpdateCoverageInput, UpdatePlotStructureInput } from './projects.schema.js';
import { audit, detail, markStep } from './projects.service.js';

// ─── Billing stage amounts ──────────────────────────────────────────────────

/**
 * Recomputes every stage's amountPaisa from the contract total (contract value, or
 * rate × covered area for labour-only): rounded to the rupee, last stage absorbs rounding.
 * 0 while the total is unknown.
 */
export async function recomputeStageAmounts(tx: Tx, projectId: string) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { contractType: true, contractValuePaisa: true, ratePerSqftPaisa: true, coveredAreaSqft: true, billingStages: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!project.billingStages.length) return;
  const total = contractTotalPaisa(project);
  const amounts = total === null ? project.billingStages.map(() => 0n) : stageAmounts(total, project.billingStages.map((s) => s.percent));
  for (const [i, stage] of project.billingStages.entries()) {
    if (stage.amountPaisa !== amounts[i]) await tx.projectBillingStage.update({ where: { id: stage.id }, data: { amountPaisa: amounts[i]! } });
  }
}

// ─── Tab 2 — contract ───────────────────────────────────────────────────────

async function resolveStages(tx: Tx, projectId: string, input: UpdateContractInput): Promise<StageDef[] | null> {
  if (input.billingStages) return input.billingStages;
  const fromTemplate = async (where: Prisma.PaymentScheduleTemplateWhereInput) => {
    const t = await tx.paymentScheduleTemplate.findFirst({ where });
    return t ? (t.stages as unknown as StageDef[]) : null;
  };
  if (input.templateId) {
    const stages = await fromTemplate({ id: input.templateId });
    if (!stages) throw new BadRequest('INVALID_TEMPLATE', 'Payment template not found');
    return stages;
  }
  // First save without stages → the company's default template
  if ((await tx.projectBillingStage.count({ where: { projectId } })) === 0) return fromTemplate({ isDefault: true });
  return null;
}

async function saveSupplyRules(tx: Tx, tenantId: string, projectId: string, input: UpdateContractInput, contractTypeChanged: boolean) {
  const existing = await tx.projectSupplyRule.findMany({ where: { projectId } });
  const defaultCategory = await tx.qualityCategory.findFirst({ where: { isDefault: true, isArchived: false }, select: { id: true } });

  // Start from the preset (new / changed contract type) or the current rules, then apply overrides
  const final = new Map<string, { suppliedBy: SuppliedBy; qualityCategoryId: string | null }>();
  if (contractTypeChanged || existing.length === 0) {
    for (const r of presetFor(input.contractType)) {
      final.set(r.categoryKey, { suppliedBy: r.suppliedBy, qualityCategoryId: r.suppliedBy === 'CONTRACTOR' ? (defaultCategory?.id ?? null) : null });
    }
  } else {
    for (const r of existing) final.set(r.categoryKey, { suppliedBy: r.suppliedBy, qualityCategoryId: r.qualityCategoryId });
  }
  for (const r of input.supplyRules ?? []) {
    if (r.suppliedBy === 'CONTRACTOR' && !r.qualityCategoryId) {
      throw new BadRequest('QUALITY_CATEGORY_REQUIRED', `${r.categoryKey}: choose a quality category when the contractor supplies it`, { categoryKey: r.categoryKey });
    }
    if (r.suppliedBy === 'OWNER' && r.qualityCategoryId) {
      throw new BadRequest('QUALITY_CATEGORY_NOT_ALLOWED', `${r.categoryKey}: no quality category when the owner supplies it`, { categoryKey: r.categoryKey });
    }
    final.set(r.categoryKey, { suppliedBy: r.suppliedBy, qualityCategoryId: r.qualityCategoryId ?? null });
  }

  const categoryIds = [...new Set([...final.values()].map((r) => r.qualityCategoryId).filter((x): x is string => Boolean(x)))];
  const valid = new Set((await tx.qualityCategory.findMany({ where: { id: { in: categoryIds }, isArchived: false }, select: { id: true } })).map((q) => q.id));
  const invalid = categoryIds.filter((id) => !valid.has(id));
  if (invalid.length) throw new BadRequest('INVALID_QUALITY_CATEGORY', 'Quality category not found (or archived)', { qualityCategoryIds: invalid });

  for (const row of existing.filter((r) => r.lockedAt)) {
    const next = final.get(row.categoryKey);
    if (!next || next.suppliedBy !== row.suppliedBy || next.qualityCategoryId !== row.qualityCategoryId) {
      throw new Conflict('SUPPLY_RULE_LOCKED', `${row.categoryKey} is locked — material has already been planned against it`, { categoryKey: row.categoryKey });
    }
  }

  for (const [categoryKey, r] of final) {
    await tx.projectSupplyRule.upsert({
      where: { projectId_categoryKey: { projectId, categoryKey } },
      create: { tenantId, projectId, categoryKey, ...r },
      update: r,
    });
  }
  await tx.projectSupplyRule.deleteMany({ where: { projectId, categoryKey: { notIn: [...final.keys()] }, lockedAt: null } });
}

export async function updateContract(id: string, input: UpdateContractInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id);
    const laborOnly = input.contractType === 'LABOR_ONLY';
    const contractValuePaisa = laborOnly ? null : (input.contractValuePaisa ?? (project.contractType === input.contractType ? project.contractValuePaisa : null));
    const ratePerSqftPaisa = laborOnly ? (input.ratePerSqftPaisa ?? (project.contractType === input.contractType ? project.ratePerSqftPaisa : null)) : null;
    if (!laborOnly && contractValuePaisa === null) throw new BadRequest('CONTRACT_VALUE_REQUIRED', 'contractValuePaisa is required for this contract type');
    if (laborOnly && ratePerSqftPaisa === null) throw new BadRequest('RATE_REQUIRED', 'ratePerSqftPaisa is required for a labour-only contract');

    const stages = await resolveStages(tx, id, input);
    if (stages) {
      checkStages(stages);
      if (await tx.projectBillingStage.count({ where: { projectId: id, status: { not: 'UPCOMING' } } })) {
        throw new Conflict('BILLING_STAGES_LOCKED', 'Some stages are already invoiced or paid');
      }
    }

    await tx.project.update({
      where: { id },
      data: {
        contractType: input.contractType,
        billingModel: input.billingModel,
        contractValuePaisa,
        ratePerSqftPaisa,
        ...(input.retentionPercent !== undefined ? { retentionPercent: input.retentionPercent } : {}),
        ...(input.defectPeriodMonths !== undefined ? { defectPeriodMonths: input.defectPeriodMonths } : {}),
      },
    });
    await saveSupplyRules(tx, c.tenantId, id, input, project.contractType !== input.contractType);
    if (stages) {
      await tx.projectBillingStage.deleteMany({ where: { projectId: id } });
      await tx.projectBillingStage.createMany({
        data: stages.map((s, i) => ({ tenantId: c.tenantId, projectId: id, sortOrder: i + 1, label: s.label, percent: s.percent, isRetention: Boolean(s.isRetention) })),
      });
    }
    await recomputeStageAmounts(tx, id);
    await markStep(tx, project, 2);
    await audit(tx, c, 'project.update_contract', id, { contractType: input.contractType, billingModel: input.billingModel, stages: stages?.length ?? null });
    return detail(tx, c, id);
  });
}

// ─── Tab 3 — plot & structure ───────────────────────────────────────────────

export async function updatePlotStructure(id: string, input: UpdatePlotStructureInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id);
    const existing = await tx.floor.findMany({ where: { projectId: id }, include: { _count: { select: { rooms: true } } } });
    const keep = new Set(input.floors.map((f) => f.level));
    const removed = existing.filter((f) => !keep.has(f.level));
    const withRooms = removed.filter((f) => f._count.rooms > 0);
    if (withRooms.length && !input.force) {
      throw new Conflict('FLOOR_HAS_ROOMS', 'Some floors you removed still have rooms — send force: true to delete them too', {
        levels: withRooms.map((f) => f.level),
      });
    }

    await tx.project.update({
      where: { id },
      data: {
        plotUnit: input.plotUnit,
        plotSize: input.plotSize,
        ...(input.marlaStandard !== undefined ? { marlaStandard: input.marlaStandard } : {}),
        frontFt: input.frontFt,
        depthFt: input.depthFt,
        cornerPlot: input.cornerPlot,
        structureType: input.structureType,
        hasBasement: input.hasBasement,
        basementHeightFt: input.hasBasement ? (input.basementHeightFt ?? null) : null,
      },
    });
    if (removed.length) await tx.floor.deleteMany({ where: { id: { in: removed.map((f) => f.id) } } }); // rooms + openings cascade
    for (const f of input.floors) {
      const data = { ceilingHeightFt: f.ceilingHeightFt, sortOrder: FLOOR_LEVELS.indexOf(f.level) + 1 };
      await tx.floor.upsert({
        where: { projectId_level: { projectId: id, level: f.level } },
        create: { tenantId: c.tenantId, projectId: id, level: f.level, name: FLOOR_NAMES[f.level], ...data },
        update: data,
      });
    }
    await markStep(tx, project, 3);
    await audit(tx, c, 'project.update_plot_structure', id, {
      plotUnit: input.plotUnit,
      plotSize: input.plotSize,
      floors: input.floors.map((f) => f.level),
      removedFloors: removed.map((f) => f.level),
    });
    return detail(tx, c, id);
  });
}

// ─── Tab 4 — coverage ───────────────────────────────────────────────────────

export async function updateCoverage(id: string, input: UpdateCoverageInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id);
    const b = input.boundaryWall;
    await tx.project.update({
      where: { id },
      data: {
        coveredAreaSqft: input.coveredAreaSqft,
        semiCoveredSqft: input.semiCoveredSqft,
        openAreaSqft: input.openAreaSqft,
        boundaryWall: b,
        boundaryLengthFt: b ? (input.boundaryLengthFt ?? null) : null,
        boundaryHeightFt: b ? (input.boundaryHeightFt ?? null) : null,
        boundaryThickness: b ? (input.boundaryThickness ?? null) : null,
        boundaryPlasterSides: b ? (input.boundaryPlasterSides ?? null) : null,
      },
    });
    await recomputeStageAmounts(tx, id); // labour-only totals depend on covered area
    await markStep(tx, project, 4);
    await audit(tx, c, 'project.update_coverage', id, { coveredAreaSqft: input.coveredAreaSqft, boundaryWall: b });
    return detail(tx, c, id);
  });
}
