/**
 * Step 13 · project schedule: generate from the APPROVED estimate (frozen baseline + plan v1),
 * read (Gantt data), re-plan (baseline untouched, new plan version), baseline, plan versions and
 * milestone edits (dates / effort / dependencies / billing link, with a dry-run preview).
 *
 * Permissions: schedule.plan.view (read) · schedule.plan.manage (generate, re-plan, edit).
 * Every write is audited. Nothing here carries money.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import { Prisma, type Project } from '../../generated/prisma/client.js';
import { loadRulebook } from '../estimate/rulebook.js';
import { caller, type Caller } from '../projects/access.js';
import { generate as generatePlan, stageOfBillingLabel, type GenLine, type GenMaterial, type GenResult } from './generator.js';
import type { GenerateInput, MilestoneEditInput, ReplanInput } from './schedule.schema.js';
import {
  audit,
  day,
  dtoContext,
  loadCalendar,
  loadMilestones,
  milestoneDto,
  milestoneInclude,
  milestoneNotFound,
  photosOf,
  PLAN_STATUSES,
  planEnd,
  projectFor,
  projection,
  recomputePlan,
  scheduleNotFound,
  today,
  type BaselineMilestone,
  type MilestoneRow,
} from './schedule.shared.js';
import { DependencyCycleError, isFinished, topoOrder } from './scheduler.js';
import { stoppageDtos, stoppageInclude } from './stoppages.service.js';
import { milestoneEditedNote, renderPlanNote } from './planNotes.js';
import { responseLang } from '../../core/i18n/requestLang.js';

type C = Pick<Caller, 'tenantId' | 'userId' | 'role'> & Partial<Pick<Caller, 'fields' | 'seesFinancials'>>;

// ─── Estimate → generator input ─────────────────────────────────────────────

async function approvedEstimate(tx: Tx, projectId: string) {
  return tx.estimate.findFirst({ where: { projectId, status: 'APPROVED' }, select: { id: true, revision: true, approvedAt: true, overridesSnapshot: true, coveredAreaSqft: true } });
}

const SCHEDULE_ONLY = /^(productivity|curing)/;

async function buildFromEstimate(tx: Tx, tenantId: string, estimate: { id: string; overridesSnapshot: unknown; coveredAreaSqft: Prisma.Decimal }, teams: number): Promise<GenResult> {
  const rows = await tx.estimateLine.findMany({ where: { estimateId: estimate.id }, orderBy: { sortOrder: 'asc' } });
  const lines: GenLine[] = rows.map((l) => ({
    lineKey: l.lineKey,
    section: l.section,
    stageKey: l.stageKey,
    kind: l.kind,
    material: l.material,
    materialId: l.materialId,
    description: l.description,
    unit: l.unit,
    quantity: Number(l.quantity),
    effectiveQuantity: Number(l.overrideQuantity ?? l.quantityWithWastage),
    suppliedBy: l.suppliedBy,
  }));
  // Productivity / curing: the company's current rulebook; physical factors: as frozen in the estimate.
  const params = { ...(await loadRulebook(tx, tenantId)).values };
  const snap = (estimate.overridesSnapshot ?? {}) as { parameters?: Record<string, { value: number }> };
  for (const [k, v] of Object.entries(snap.parameters ?? {})) if (!SCHEDULE_ONLY.test(k) && typeof v?.value === 'number') params[k] = v.value;
  const ids = [...new Set(lines.map((l) => l.materialId).filter((x): x is string => Boolean(x)))];
  const mats = await tx.material.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, unit: true, altUnits: true } });
  const materials = new Map<string, GenMaterial>(mats.map((m) => [m.id, { id: m.id, name: m.name, unit: m.unit, altUnits: (m.altUnits ?? []) as GenMaterial['altUnits'] }]));
  return generatePlan({ lines, params, teams, materials, coveredAreaSqft: Number(estimate.coveredAreaSqft) });
}

async function writeQuotas(tx: Tx, tenantId: string, milestoneId: string, quotas: GenResult['milestones'][number]['quotas']) {
  await tx.milestoneQuota.deleteMany({ where: { milestoneId } });
  if (!quotas.length) return;
  await tx.milestoneQuota.createMany({
    data: quotas.map((q, i) => ({ tenantId, milestoneId, materialId: q.materialId, material: q.material, description: q.description, unit: q.unit, plannedQty: new Prisma.Decimal(q.plannedQty), ownerSupplied: q.ownerSupplied, sortOrder: i + 1 })),
  });
}

async function writeDeps(tx: Tx, tenantId: string, milestoneId: string, deps: Array<{ dependsOnId: string; type: 'FS' | 'SS'; lagDays: number }>) {
  await tx.milestoneDependency.deleteMany({ where: { milestoneId } });
  if (deps.length) await tx.milestoneDependency.createMany({ data: deps.map((d) => ({ tenantId, milestoneId, dependsOnId: d.dependsOnId, type: d.type, lagDays: d.lagDays })) });
}

async function ensureStage(tx: Tx, s: { id: string; tenantId: string; projectId: string }, st: GenResult['stages'][number]) {
  return tx.scheduleStage.upsert({
    where: { tenantId_scheduleId_stageKey: { tenantId: s.tenantId, scheduleId: s.id, stageKey: st.stageKey } },
    create: { tenantId: s.tenantId, scheduleId: s.id, projectId: s.projectId, stageKey: st.stageKey, name: st.name, sortOrder: st.sortOrder },
    update: { name: st.name, sortOrder: st.sortOrder },
  });
}

/** Billing stages → the first milestone of their schedule stage (by label). */
async function autoLinkBillingStages(tx: Tx, tenantId: string, projectId: string, scheduleId: string) {
  const stages = await tx.projectBillingStage.findMany({ where: { tenantId, projectId, isRetention: false }, orderBy: { sortOrder: 'asc' } });
  const rows = await tx.milestone.findMany({ where: { scheduleId }, include: { stage: { select: { stageKey: true } } }, orderBy: { sortOrder: 'asc' } });
  const linked = new Set(rows.filter((m) => m.billingStageId).map((m) => m.id));
  for (const b of stages) {
    const key = stageOfBillingLabel(b.label);
    if (!key || rows.some((m) => m.billingStageId === b.id)) continue;
    const m = rows.find((x) => x.stage.stageKey === key && !linked.has(x.id));
    if (!m) continue;
    linked.add(m.id);
    await tx.milestone.update({ where: { id: m.id }, data: { billingStageId: b.id } });
  }
}

// ─── Generate ───────────────────────────────────────────────────────────────

/** Generates the schedule of a project (no request context needed — the seed uses it too). */
export async function generateInTx(tx: Tx, c: C, project: Project, input: GenerateInput, opts: { audit?: boolean } = {}): Promise<string> {
  const existing = await tx.schedule.findFirst({ where: { projectId: project.id }, select: { id: true } });
  if (existing) throw new Conflict('SCHEDULE_EXISTS', 'This project already has a schedule — re-plan it instead', { scheduleId: existing.id });
  const estimate = await approvedEstimate(tx, project.id);
  if (!estimate) throw new Conflict('NO_APPROVED_ESTIMATE', 'Approve an estimate first — the schedule is made from its quantities');
  const startDate = input.startDate ?? day(project.startDate);
  if (!startDate) throw new BadRequest('NO_START_DATE', 'Set the project start date (or send startDate)');
  const teams = input.teams ?? 1;
  const gen = await buildFromEstimate(tx, c.tenantId, estimate, teams);

  const s = await tx.schedule.create({ data: { tenantId: c.tenantId, projectId: project.id, estimateId: estimate.id, startDate: dateOnly(startDate), teams, note: input.note ?? null, generatedById: c.userId, version: 0 } });
  const stageIds = new Map<string, string>();
  for (const st of gen.stages) stageIds.set(st.stageKey, (await ensureStage(tx, s, st)).id);
  const ids = new Map<string, string>();
  for (const m of gen.milestones) {
    const row = await tx.milestone.create({
      data: {
        tenantId: c.tenantId,
        projectId: project.id,
        scheduleId: s.id,
        stageId: stageIds.get(m.stageKey)!,
        key: m.key,
        name: m.name,
        sortOrder: m.sortOrder,
        workDays: new Prisma.Decimal(m.workDays),
        durationDays: 0,
        plannedStart: dateOnly(startDate),
        plannedEnd: dateOnly(startDate),
        curingDays: m.curingDays,
        basis: m.basis,
      },
    });
    ids.set(m.key, row.id);
    await writeQuotas(tx, c.tenantId, row.id, m.quotas);
  }
  for (const m of gen.milestones) {
    await writeDeps(tx, c.tenantId, ids.get(m.key)!, m.deps.filter((d) => ids.has(d.key)).map((d) => ({ dependsOnId: ids.get(d.key)!, type: d.type, lagDays: d.lagDays })));
  }
  await autoLinkBillingStages(tx, c.tenantId, project.id, s.id);
  const plan = await recomputePlan(tx, c, s.id, { reason: 'GENERATED', note: input.note ?? null, forceVersion: true });

  // The frozen baseline
  const rows = await loadMilestones(tx, s.id);
  const milestones: BaselineMilestone[] = rows.map((m) => ({
    key: m.key,
    name: m.name,
    stageKey: m.stage.stageKey,
    plannedStart: day(m.plannedStart)!,
    plannedEnd: day(m.plannedEnd)!,
    workDays: Number(m.workDays),
    durationDays: m.durationDays,
    curingDays: m.curingDays,
    dependsOn: m.dependsOn.map((d) => ({ key: d.dependsOn.key, type: d.type, lagDays: d.lagDays })),
  }));
  await tx.scheduleBaseline.create({
    data: { tenantId: c.tenantId, projectId: project.id, scheduleId: s.id, estimateId: estimate.id, startDate: dateOnly(startDate), plannedEnd: dateOnly(plan.plannedEnd.to), milestones, createdById: c.userId },
  });
  if (opts.audit !== false) {
    await audit(tx, c, 'schedule.generate', 'Schedule', s.id, { projectId: project.id, estimateId: estimate.id, revision: estimate.revision, startDate, teams, milestones: rows.length, plannedEnd: plan.plannedEnd.to });
  }
  return s.id;
}

export async function generate(projectId: string, input: GenerateInput) {
  const c = caller();
  return withTenant(
    c.tenantId,
    async (tx) => {
      const project = await projectFor(tx, c, projectId, 'schedule.plan.manage', PLAN_STATUSES);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`schedule:${projectId}`}))`;
      await generateInTx(tx, c, project, input);
      return detail(tx, c, project);
    },
    { timeout: 30_000 },
  );
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function detail(tx: Tx, c: C, project: Project) {
  const s = await tx.schedule.findFirst({ where: { projectId: project.id }, include: { estimate: { select: { id: true, revision: true } }, generatedBy: { select: { id: true, name: true } } } });
  const est = await approvedEstimate(tx, project.id);
  const info = await loadCalendar(tx, c.tenantId, project.id);
  const todayStr = today();
  const base = {
    project: { id: project.id, code: project.code, name: project.name, status: project.status, startDate: day(project.startDate), endDate: day(project.endDate) },
    approvedEstimate: est ? { id: est.id, revision: est.revision, approvedAt: est.approvedAt?.toISOString() ?? null } : null,
    canGenerate: Boolean(est) && !s,
    today: todayStr,
  };
  if (!s) {
    return {
      schedule: null,
      ...base,
      plannedEnd: null,
      baselineEnd: null,
      projectedEnd: null,
      calendar: { workingDays: info.workingDays, ramadanDayFactor: info.ramadanDayFactor, ramadanPeriods: info.ramadanPeriods, holidays: [] },
      stages: [],
      milestones: [],
      stoppages: [],
      baseline: null,
    };
  }
  const rows = await loadMilestones(tx, s.id);
  const ctx = await dtoContext(tx, c.tenantId, s.id, rows);
  const milestones = rows.map((m) => milestoneDto(m, ctx));
  const baseline = await tx.scheduleBaseline.findFirst({ where: { scheduleId: s.id }, select: { id: true, createdAt: true, startDate: true, plannedEnd: true } });
  const proj = projection(rows, info.cal, day(s.startDate)!, todayStr);
  const plannedEnd = milestones.length ? planEnd(milestones) : null;
  const spanEnd = [plannedEnd, proj.end, day(baseline?.plannedEnd)].filter((x): x is string => Boolean(x)).reduce((a, b) => (b > a ? b : a), day(s.startDate)!);
  const holidays = [...info.cal.holidayNames.entries()].filter(([d]) => d >= day(s.startDate)! && d <= spanEnd).map(([date, h]) => ({ date, ...h })).sort((a, b) => a.date.localeCompare(b.date));
  const stages = await tx.scheduleStage.findMany({ where: { scheduleId: s.id }, orderBy: { sortOrder: 'asc' } });
  const stoppages = await tx.stoppageDay.findMany({ where: { tenantId: c.tenantId, projectId: project.id, status: { in: ['PENDING', 'APPROVED'] } }, orderBy: { createdAt: 'desc' }, include: stoppageInclude });
  return {
    schedule: {
      id: s.id,
      version: s.version,
      startDate: day(s.startDate)!,
      teams: s.teams,
      note: s.note,
      changeOrderDays: s.changeOrderDays,
      estimate: s.estimate,
      generatedAt: s.generatedAt.toISOString(),
      generatedBy: s.generatedBy,
      replannedAt: s.replannedAt?.toISOString() ?? null,
      planFloor: day(s.planFloor),
    },
    ...base,
    plannedEnd,
    baselineEnd: day(baseline?.plannedEnd),
    projectedEnd: proj.end,
    calendar: { workingDays: info.workingDays, ramadanDayFactor: info.ramadanDayFactor, ramadanPeriods: info.ramadanPeriods, holidays },
    stages: stages.map((st) => {
      const ms = milestones.filter((m) => m.stageId === st.id);
      const bs = ms.filter((m) => m.baselineStart);
      const total = ms.reduce((a, m) => a + m.workDays, 0);
      const earned = ms.reduce((a, m) => a + (isFinished(m.status) ? m.workDays : (m.workDays * m.progressPercent) / 100), 0);
      const done = ms.length > 0 && ms.every((m) => isFinished(m.status));
      const started = ms.some((m) => m.status !== 'PLANNED' || m.progressPercent > 0);
      return {
        id: st.id,
        stageKey: st.stageKey,
        name: st.name,
        sortOrder: st.sortOrder,
        plannedStart: ms.length ? ms.map((m) => m.plannedStart).sort()[0]! : null,
        plannedEnd: ms.length ? planEnd(ms) : null,
        baselineStart: bs.length ? bs.map((m) => m.baselineStart!).sort()[0]! : null,
        baselineEnd: bs.length ? bs.map((m) => m.baselineEnd!).sort().at(-1)! : null,
        progressPercent: total > 0 ? Math.round((earned / total) * 100) : 0,
        status: done ? 'DONE' : started ? 'IN_PROGRESS' : 'PLANNED',
      };
    }),
    milestones,
    stoppages: await stoppageDtos(tx, c.tenantId, stoppages, info.cal),
    baseline: baseline ? { id: baseline.id, createdAt: baseline.createdAt.toISOString(), startDate: day(baseline.startDate)!, plannedEnd: day(baseline.plannedEnd)! } : null,
  };
}


export async function getSchedule(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => detail(tx, c, await projectFor(tx, c, projectId, 'schedule.plan.view')));
}

async function scheduleOf(tx: Tx, projectId: string) {
  const s = await tx.schedule.findFirst({ where: { projectId } });
  if (!s) throw scheduleNotFound();
  return s;
}

export async function baseline(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await projectFor(tx, c, projectId, 'schedule.plan.view');
    const s = await scheduleOf(tx, project.id);
    const b = await tx.scheduleBaseline.findFirst({ where: { scheduleId: s.id }, include: { createdBy: { select: { id: true, name: true } } } });
    if (!b) throw scheduleNotFound();
    return {
      id: b.id,
      scheduleId: b.scheduleId,
      estimateId: b.estimateId,
      startDate: day(b.startDate)!,
      plannedEnd: day(b.plannedEnd)!,
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy,
      milestones: b.milestones as BaselineMilestone[],
    };
  });
}

export async function versions(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await projectFor(tx, c, projectId, 'schedule.plan.view');
    const s = await scheduleOf(tx, project.id);
    const rows = await tx.schedulePlanVersion.findMany({ where: { scheduleId: s.id }, orderBy: { version: 'desc' }, include: { createdBy: { select: { id: true, name: true } } } });
    const lang = await responseLang(tx, c.userId);
    return rows.map((v) => ({ id: v.id, version: v.version, reason: v.reason, note: renderPlanNote(lang, v.note), plannedEnd: day(v.plannedEnd)!, createdAt: v.createdAt.toISOString(), createdBy: v.createdBy, milestones: v.milestones }));
  });
}

// ─── Re-plan ────────────────────────────────────────────────────────────────

/** Applies a fresh generator result to an existing schedule (milestones matched by key). */
async function applyGenerated(tx: Tx, c: C, s: { id: string; tenantId: string; projectId: string }, gen: GenResult, refreshQuotas: boolean) {
  const rows = await tx.milestone.findMany({ where: { scheduleId: s.id } });
  const byKey = new Map(rows.map((m) => [m.key, m]));
  const ids = new Map<string, string>();
  const stageIds = new Map<string, string>();
  for (const st of gen.stages) stageIds.set(st.stageKey, (await ensureStage(tx, s, st)).id);
  const added: string[] = [];
  for (const m of gen.milestones) {
    const old = byKey.get(m.key);
    if (old) {
      await tx.milestone.update({ where: { id: old.id }, data: { name: m.name, sortOrder: m.sortOrder, workDays: new Prisma.Decimal(m.workDays), curingDays: m.curingDays, basis: m.basis, stageId: stageIds.get(m.stageKey)! } });
      ids.set(m.key, old.id);
    } else {
      const row = await tx.milestone.create({
        data: { tenantId: c.tenantId, projectId: s.projectId, scheduleId: s.id, stageId: stageIds.get(m.stageKey)!, key: m.key, name: m.name, sortOrder: m.sortOrder, workDays: new Prisma.Decimal(m.workDays), durationDays: 0, plannedStart: dateOnly(today()), plannedEnd: dateOnly(today()), curingDays: m.curingDays, basis: m.basis },
      });
      ids.set(m.key, row.id);
      added.push(m.key);
    }
    if (refreshQuotas || !old) await writeQuotas(tx, c.tenantId, ids.get(m.key)!, m.quotas);
  }
  // Milestones the estimate no longer has: removed when nothing happened on them yet.
  const removed: string[] = [];
  const kept: string[] = [];
  for (const old of rows.filter((m) => !gen.milestones.some((g) => g.key === m.key))) {
    const touched = old.status !== 'PLANNED' || old.progressPercent > 0 || (await tx.milestoneUpdate.count({ where: { milestoneId: old.id } })) > 0 || (await tx.materialUsage.count({ where: { tenantId: c.tenantId, milestoneId: old.id } })) > 0;
    if (touched) kept.push(old.key);
    else {
      await tx.milestone.delete({ where: { id: old.id } });
      removed.push(old.key);
    }
  }
  for (const m of gen.milestones) {
    await writeDeps(tx, c.tenantId, ids.get(m.key)!, m.deps.filter((d) => ids.has(d.key)).map((d) => ({ dependsOnId: ids.get(d.key)!, type: d.type, lagDays: d.lagDays })));
  }
  await tx.scheduleStage.deleteMany({ where: { scheduleId: s.id, milestones: { none: {} } } });
  return { added, removed, kept };
}

export async function replan(projectId: string, input: ReplanInput) {
  const c = caller();
  return withTenant(
    c.tenantId,
    async (tx) => {
      const project = await projectFor(tx, c, projectId, 'schedule.plan.manage', PLAN_STATUSES);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`schedule:${projectId}`}))`;
      const s = await scheduleOf(tx, project.id);
      const details: Record<string, unknown> = { projectId: project.id, fromToday: input.fromToday !== false, refreshQuantities: Boolean(input.refreshQuantities) };
      let estimateId = s.estimateId;
      if (input.refreshQuantities || (input.teams !== undefined && input.teams !== s.teams)) {
        const est = input.refreshQuantities ? await approvedEstimate(tx, project.id) : await tx.estimate.findUnique({ where: { id: s.estimateId }, select: { id: true, revision: true, approvedAt: true, overridesSnapshot: true, coveredAreaSqft: true } });
        if (!est) throw new Conflict('NO_APPROVED_ESTIMATE', 'Approve an estimate first — the schedule is made from its quantities');
        const teams = input.teams ?? s.teams;
        const gen = await buildFromEstimate(tx, c.tenantId, est, teams);
        Object.assign(details, await applyGenerated(tx, c, s, gen, Boolean(input.refreshQuantities)), { teams, estimateId: est.id });
        estimateId = est.id;
      }
      const floor = input.fromToday === false ? null : today();
      await tx.schedule.update({ where: { id: s.id }, data: { planFloor: floor ? dateOnly(floor) : null, replannedAt: new Date(), estimateId, ...(input.teams !== undefined ? { teams: input.teams } : {}) } });
      const plan = await recomputePlan(tx, c, s.id, { reason: 'REPLANNED', note: input.note, forceVersion: true });
      await audit(tx, c, 'schedule.replan', 'Schedule', s.id, { ...details, note: input.note, version: plan.version, plannedEnd: plan.plannedEnd, shifted: plan.shifted.length } as Prisma.InputJsonValue);
      return detail(tx, c, project);
    },
    { timeout: 30_000 },
  );
}

// ─── Milestones ─────────────────────────────────────────────────────────────

/** A milestone whose project is in the caller's scope for `perm` (else 404 MILESTONE_NOT_FOUND). */
export async function findMilestone(tx: Tx, c: C, id: string, perm: string): Promise<{ m: MilestoneRow; project: Project }> {
  const m = await tx.milestone.findFirst({ where: { tenantId: c.tenantId, id }, include: milestoneInclude });
  if (!m) throw milestoneNotFound();
  try {
    const project = await projectFor(tx, c as Caller, m.projectId, perm);
    return { m, project };
  } catch (err) {
    if (err instanceof NotFound) throw milestoneNotFound();
    throw err;
  }
}

export async function getMilestone(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const { m } = await findMilestone(tx, c, id, 'schedule.plan.view');
    return milestoneDetail(tx, c, m.id);
  });
}

export async function milestoneDetail(tx: Tx, c: C, id: string) {
  const m = await tx.milestone.findUniqueOrThrow({ where: { id }, include: milestoneInclude });
  const ctx = await dtoContext(tx, c.tenantId, m.scheduleId, [m]);
  const updates = await tx.milestoneUpdate.findMany({ where: { milestoneId: id }, orderBy: { createdAt: 'desc' }, take: 50, include: { createdBy: { select: { id: true, name: true } } } });
  const out = [];
  for (const u of updates) {
    out.push({
      id: u.id,
      at: u.createdAt.toISOString(),
      date: day(u.date)!,
      status: u.status,
      progressPercent: u.progressPercent,
      previousStatus: u.previousStatus,
      previousProgress: u.previousProgress,
      note: u.note,
      photos: await photosOf(tx, c.tenantId, u.photoAttachmentIds),
      by: u.createdBy,
    });
  }
  return { ...milestoneDto(m, ctx), updates: out };
}

class DryRun extends Error {
  constructor(readonly result: unknown) {
    super('dry run');
  }
}

export async function editMilestone(id: string, input: MilestoneEditInput) {
  const c = caller();
  try {
    return await withTenant(
      c.tenantId,
      async (tx) => {
        const { m, project } = await findMilestone(tx, c, id, 'schedule.plan.manage');
        if (!PLAN_STATUSES.includes(project.status)) throw new Conflict('PROJECT_LOCKED', `This project is ${project.status.replace('_', ' ').toLowerCase()} and can't be edited`, { status: project.status });
        const datesChange = input.startNoEarlierThan !== undefined || input.workDays !== undefined;
        if (datesChange && isFinished(m.status)) throw new Conflict('MILESTONE_DONE', 'This milestone is finished — its dates come from the site');
        const data: Prisma.MilestoneUncheckedUpdateInput = {};
        const changes: Record<string, unknown> = {};
        if (input.name !== undefined) data.name = changes['name'] = input.name;
        if (input.workDays !== undefined) {
          data.workDays = new Prisma.Decimal(input.workDays);
          changes['workDays'] = { from: Number(m.workDays), to: input.workDays };
        }
        if (input.curingDays !== undefined) {
          data.curingDays = input.curingDays;
          changes['curingDays'] = { from: m.curingDays, to: input.curingDays };
        }
        if (input.startNoEarlierThan !== undefined) {
          data.startNoEarlierThan = input.startNoEarlierThan ? dateOnly(input.startNoEarlierThan) : null;
          changes['startNoEarlierThan'] = { from: day(m.startNoEarlierThan), to: input.startNoEarlierThan };
        }
        if (input.billingStageId !== undefined) {
          if (input.billingStageId) {
            const b = await tx.projectBillingStage.findFirst({ where: { tenantId: c.tenantId, id: input.billingStageId, projectId: m.projectId } });
            if (!b) throw new BadRequest('INVALID_BILLING_STAGE', 'Choose a payment stage of this project');
          }
          data.billingStageId = input.billingStageId;
          changes['billingStageId'] = { from: m.billingStageId, to: input.billingStageId };
        }
        if (Object.keys(data).length) await tx.milestone.update({ where: { id: m.id }, data });
        if (input.dependsOn !== undefined) {
          const ids = input.dependsOn.map((d) => d.milestoneId);
          if (new Set(ids).size !== ids.length || ids.includes(m.id)) throw new BadRequest('INVALID_DEPENDENCY', 'A milestone cannot depend on itself or twice on the same one');
          const found = await tx.milestone.count({ where: { scheduleId: m.scheduleId, id: { in: ids } } });
          if (found !== ids.length) throw new BadRequest('INVALID_DEPENDENCY', 'Every dependency must be a milestone of the same schedule');
          await writeDeps(tx, c.tenantId, m.id, input.dependsOn.map((d) => ({ dependsOnId: d.milestoneId, type: d.type, lagDays: d.lagDays })));
          changes['dependsOn'] = input.dependsOn;
          const all = await loadMilestones(tx, m.scheduleId);
          try {
            topoOrder(all.map((x) => ({ id: x.id, deps: x.dependsOn.map((d) => ({ id: d.dependsOnId, type: d.type, lagDays: d.lagDays })) })) as never);
          } catch (err) {
            if (err instanceof DependencyCycleError) throw new BadRequest('DEPENDENCY_CYCLE', 'These dependencies make a loop', { milestoneIds: err.ids });
            throw err;
          }
        }
        // QA-B-09: what changed with its values (rendered per reader: planNotes.ts), not the field names.
        const plan = await recomputePlan(tx, c, m.scheduleId, { reason: 'MILESTONE_EDITED', note: input.dryRun ? null : milestoneEditedNote(m.name, changes) });
        const after = await milestoneDetail(tx, c, m.id);
        const { updates: _u, ...milestone } = after;
        void _u;
        const result = { milestone, shifted: plan.shifted, plannedEnd: plan.plannedEnd, dryRun: Boolean(input.dryRun) };
        if (input.dryRun) throw new DryRun(result);
        await audit(tx, c, 'milestone.update', 'Milestone', m.id, { projectId: m.projectId, key: m.key, changes, shifted: plan.shifted.length, plannedEnd: plan.plannedEnd } as Prisma.InputJsonValue);
        return result;
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof DryRun) return err.result;
    throw err;
  }
}

