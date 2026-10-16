/**
 * Shared pieces of the schedule module: access, the working calendar from the database, loading a
 * schedule, quota used, the milestone DTO and the plan recomputation (forward pass → stored plan +
 * plan version). Nothing here carries money.
 */
import { writeAudit } from '../../core/audit/audit.js';
import { assertPerm } from '../../core/auth/access.js';
import type { Tx } from '../../core/db/withTenant.js';
import { NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import type { Prisma, Project, ProjectStatus } from '../../generated/prisma/client.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { assertEditable, findProjectFor, type Caller } from '../projects/access.js';
import { addDays, diffDays, ramadanPeriodsOf, WorkCalendar, type CalendarHoliday } from './calendar.js';
import { forwardPass, paceOf, type PassOptions, type PlanItem } from './scheduler.js';

export const today = () => todayIn('Asia/Karachi');
export const day = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);
export const qty = (n: number) => Math.round(n * 1000) / 1000;

/** Statuses where the plan / progress may change. */
export const PLAN_STATUSES: ProjectStatus[] = ['DRAFT', 'ACTIVE'];
export const SITE_STATUSES: ProjectStatus[] = ['ACTIVE', 'CLOSEOUT'];

export const scheduleNotFound = () => new NotFound('SCHEDULE_NOT_FOUND', 'This project has no schedule yet — generate it from the approved estimate');
export const milestoneNotFound = () => new NotFound('MILESTONE_NOT_FOUND', 'Milestone not found');

export const audit = (tx: Tx, c: Pick<Caller, 'tenantId' | 'userId'>, action: string, entityType: string, entityId: string, details: Prisma.InputJsonValue) =>
  writeAudit(tx, { tenantId: c.tenantId, actorType: 'USER', actorId: c.userId, action, entityType, entityId, details });

/** The project, if the caller holds `perm` with it in scope (403 / 404). */
export async function projectFor(tx: Tx, c: Caller, projectId: string, perm: string, statuses?: ProjectStatus[]): Promise<Project> {
  assertPerm(perm, c);
  const p = await findProjectFor(tx, c, projectId, perm);
  if (statuses) assertEditable(p, statuses);
  return p;
}

// ─── Calendar ───────────────────────────────────────────────────────────────

export interface CalendarInfo {
  cal: WorkCalendar;
  workingDays: string[];
  ramadanDayFactor: number;
  ramadanPeriods: Array<{ start: string; end: string }>;
  holidays: CalendarHoliday[];
}

/** Company calendar (+ the project's APPROVED stoppage days when projectId is given). */
export async function loadCalendar(tx: Tx, tenantId: string, projectId?: string | null, extraStoppageDates: string[] = []): Promise<CalendarInfo> {
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId }, select: { workingDays: true, ramadanDayFactor: true, ramadanPeriods: true } });
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { region: true } });
  const platform = await tx.platformHoliday.findMany({ where: { OR: [{ region: null }, ...(tenant ? [{ region: tenant.region }] : [])] } });
  const company = await tx.companyHoliday.findMany({ where: { tenantId } });
  const holidays: CalendarHoliday[] = [
    ...platform.map((h) => ({ start: day(h.startDate)!, end: day(h.endDate), name: h.name, type: h.type, source: 'PLATFORM' as const })),
    ...company.map((h) => ({ start: day(h.startDate)!, end: day(h.endDate), name: h.name, type: h.type, source: 'COMPANY' as const })),
  ];
  const stoppageDates = projectId ? await approvedStoppageDates(tx, tenantId, projectId) : [];
  const workingDays = settings?.workingDays ?? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const ramadanDayFactor = settings ? Number(settings.ramadanDayFactor) : 0.75;
  const ramadanPeriods = ramadanPeriodsOf(settings?.ramadanPeriods ?? null);
  const cal = new WorkCalendar({ workingDays, holidays, ramadanPeriods, ramadanDayFactor, stoppageDates: [...stoppageDates, ...extraStoppageDates] });
  return { cal, workingDays, ramadanDayFactor, ramadanPeriods, holidays };
}

export async function approvedStoppageDates(tx: Tx, tenantId: string, projectId: string): Promise<string[]> {
  const rows = await tx.stoppageDay.findMany({ where: { tenantId, projectId, status: 'APPROVED' }, select: { dates: true } });
  return [...new Set(rows.flatMap((r) => r.dates.map((d) => formatDateOnly(d))))].sort();
}

// ─── Loading ────────────────────────────────────────────────────────────────

export const milestoneInclude = {
  stage: { select: { stageKey: true, name: true } },
  dependsOn: { include: { dependsOn: { select: { key: true } } } },
  quotas: { orderBy: { sortOrder: 'asc' } },
  billingStage: { select: { id: true, label: true, sortOrder: true } },
} as const satisfies Prisma.MilestoneInclude;
export type MilestoneRow = Prisma.MilestoneGetPayload<{ include: typeof milestoneInclude }>;

export async function loadMilestones(tx: Tx, scheduleId: string): Promise<MilestoneRow[]> {
  return tx.milestone.findMany({ where: { scheduleId }, include: milestoneInclude, orderBy: { sortOrder: 'asc' } });
}

export type BaselineMilestone = {
  key: string;
  name: string;
  stageKey: string;
  plannedStart: string;
  plannedEnd: string;
  workDays: number;
  durationDays: number;
  curingDays: number;
  dependsOn: Array<{ key: string; type: string; lagDays: number }>;
};

export async function baselineMap(tx: Tx, scheduleId: string): Promise<Map<string, BaselineMilestone>> {
  const b = await tx.scheduleBaseline.findFirst({ where: { scheduleId }, select: { milestones: true } });
  return new Map(((b?.milestones ?? []) as BaselineMilestone[]).map((m) => [m.key, m]));
}

/** Quantity used per milestone × material (usage entries linked to the milestone), in the material's unit. */
export async function usedQuantities(tx: Tx, tenantId: string, milestoneIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!milestoneIds.length) return out;
  const usages = await tx.materialUsage.findMany({ where: { tenantId, milestoneId: { in: milestoneIds } }, select: { milestoneId: true, items: { select: { materialId: true, qty: true } } } });
  for (const u of usages) {
    const m = out.get(u.milestoneId!) ?? new Map<string, number>();
    for (const i of u.items) m.set(i.materialId, qty((m.get(i.materialId) ?? 0) + Number(i.qty)));
    out.set(u.milestoneId!, m);
  }
  return out;
}

export function quotaDto(q: MilestoneRow['quotas'][number], used: Map<string, number> | undefined) {
  const planned = qty(Number(q.plannedQty));
  const usedQty = q.materialId ? (used?.get(q.materialId) ?? 0) : 0;
  return {
    id: q.id,
    materialId: q.materialId,
    material: q.material,
    description: q.description,
    unit: q.unit,
    ownerSupplied: q.ownerSupplied,
    plannedQty: planned,
    usedQty,
    remainingQty: qty(Math.max(0, planned - usedQty)),
    usedPercent: planned > 0 ? Math.round((usedQty / planned) * 1000) / 10 : null,
    over: usedQty > planned + 1e-9,
  };
}

export interface DtoContext {
  today: string;
  baseline: Map<string, BaselineMilestone>;
  used: Map<string, Map<string, number>>;
  lastUpdates: Map<string, { at: string; by: { id: string; name: string } | null; note: string | null }>;
}

export async function dtoContext(tx: Tx, tenantId: string, scheduleId: string, rows: MilestoneRow[]): Promise<DtoContext> {
  const ids = rows.map((r) => r.id);
  const last = ids.length
    ? await tx.milestoneUpdate.findMany({ where: { tenantId, milestoneId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['milestoneId'], include: { createdBy: { select: { id: true, name: true } } } })
    : [];
  return {
    today: today(),
    baseline: await baselineMap(tx, scheduleId),
    used: await usedQuantities(tx, tenantId, ids),
    lastUpdates: new Map(last.map((u) => [u.milestoneId, { at: u.createdAt.toISOString(), by: u.createdBy, note: u.note }])),
  };
}

export function milestoneDto(m: MilestoneRow, ctx: DtoContext) {
  const b = ctx.baseline.get(m.key);
  const plannedStart = day(m.plannedStart)!;
  const plannedEnd = day(m.plannedEnd)!;
  const actualEnd = day(m.actualEnd);
  const finished = m.status === 'DONE' || m.status === 'CURING';
  return {
    id: m.id,
    projectId: m.projectId,
    scheduleId: m.scheduleId,
    stageId: m.stageId,
    stageKey: m.stage.stageKey,
    key: m.key,
    name: m.name,
    sortOrder: m.sortOrder,
    workDays: Number(m.workDays),
    durationDays: m.durationDays,
    plannedStart,
    plannedEnd,
    baselineStart: b?.plannedStart ?? null,
    baselineEnd: b?.plannedEnd ?? null,
    varianceDays: b ? diffDays(b.plannedEnd, plannedEnd) : 0,
    curingDays: m.curingDays,
    curingUntil: m.curingDays > 0 ? addDays(actualEnd ?? plannedEnd, m.curingDays) : null,
    startNoEarlierThan: day(m.startNoEarlierThan),
    status: m.status,
    progressPercent: m.progressPercent,
    actualStart: day(m.actualStart),
    actualEnd,
    late: !finished && plannedEnd < ctx.today,
    dependsOn: m.dependsOn.map((d) => ({ milestoneId: d.dependsOnId, key: d.dependsOn.key, type: d.type, lagDays: d.lagDays })),
    billingStage: m.billingStage,
    quotas: m.quotas.map((q) => quotaDto(q, ctx.used.get(m.id))),
    basis: (m.basis ?? []) as string[],
    lastUpdate: ctx.lastUpdates.get(m.id) ?? null,
    updatedAt: m.updatedAt.toISOString(),
  };
}
export type MilestoneDto = ReturnType<typeof milestoneDto>;

export async function photosOf(tx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.attachment.findMany({ where: { tenantId, id: { in: ids } } });
  const out = [];
  for (const r of rows) out.push({ id: r.id, url: (await signedUrlFor(r)).url, thumbUrl: (await signedUrlFor(r, { thumbnailWidth: 320 })).url });
  return out;
}

// ─── Plan recomputation ─────────────────────────────────────────────────────

export function planItems(rows: MilestoneRow[]): PlanItem[] {
  return rows.map((m) => ({
    id: m.id,
    workDays: Number(m.workDays),
    deps: m.dependsOn.map((d) => ({ id: d.dependsOnId, type: d.type, lagDays: d.lagDays })),
    startNoEarlierThan: day(m.startNoEarlierThan),
    status: m.status,
    progressPercent: m.progressPercent,
    actualStart: day(m.actualStart),
    actualEnd: day(m.actualEnd),
    plannedStart: day(m.plannedStart)!,
    plannedEnd: day(m.plannedEnd)!,
  }));
}

export interface Shift {
  id: string;
  key: string;
  name: string;
  plannedStart: { from: string; to: string };
  plannedEnd: { from: string; to: string };
}

export const planEnd = (rows: Array<{ plannedEnd: string }>) => rows.reduce((a, r) => (r.plannedEnd > a ? r.plannedEnd : a), '0000-01-01');

/** Runs the forward pass and returns the new windows + what moved (nothing is saved). */
export function previewPlan(rows: MilestoneRow[], cal: WorkCalendar, opts: Omit<PassOptions, 'mode'>) {
  const windows = forwardPass(planItems(rows), cal, { ...opts, mode: 'PLAN' });
  const shifted: Shift[] = [];
  for (const m of rows) {
    const w = windows.get(m.id)!;
    const from = { start: day(m.plannedStart)!, end: day(m.plannedEnd)! };
    if (from.start !== w.start || from.end !== w.end) shifted.push({ id: m.id, key: m.key, name: m.name, plannedStart: { from: from.start, to: w.start }, plannedEnd: { from: from.end, to: w.end } });
  }
  const before = planEnd(rows.map((m) => ({ plannedEnd: day(m.plannedEnd)! })));
  const after = planEnd([...windows.values()].map((w) => ({ plannedEnd: w.end })));
  return { windows, shifted, plannedEnd: { from: before, to: after } };
}

/**
 * Recomputes and stores the plan of a schedule. A new plan version is written when something
 * moved, or always with `forceVersion` (generate / re-plan).
 */
export async function recomputePlan(
  tx: Tx,
  c: Pick<Caller, 'tenantId' | 'userId'>,
  scheduleId: string,
  opts: { reason: 'GENERATED' | 'REPLANNED' | 'MILESTONE_EDITED' | 'STOPPAGE_APPROVED'; note?: string | null; forceVersion?: boolean; calendar?: WorkCalendar },
) {
  const s = await tx.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
  const rows = await loadMilestones(tx, scheduleId);
  const cal = opts.calendar ?? (await loadCalendar(tx, s.tenantId, s.projectId)).cal;
  const preview = previewPlan(rows, cal, { start: day(s.startDate)!, floor: day(s.planFloor) });
  for (const m of rows) {
    const w = preview.windows.get(m.id)!;
    if (day(m.plannedStart) === w.start && day(m.plannedEnd) === w.end && m.durationDays === w.durationDays) continue;
    await tx.milestone.update({ where: { id: m.id }, data: { plannedStart: dateOnly(w.start), plannedEnd: dateOnly(w.end), durationDays: w.durationDays } });
  }
  let version = s.version;
  if (opts.forceVersion || preview.shifted.length) {
    const last = await tx.schedulePlanVersion.aggregate({ where: { scheduleId }, _max: { version: true } });
    version = (last._max.version ?? 0) + 1;
    await tx.schedulePlanVersion.create({
      data: {
        tenantId: s.tenantId,
        projectId: s.projectId,
        scheduleId,
        version,
        reason: opts.reason,
        note: opts.note ?? null,
        plannedEnd: dateOnly(preview.plannedEnd.to),
        milestones: rows.map((m) => ({ key: m.key, plannedStart: preview.windows.get(m.id)!.start, plannedEnd: preview.windows.get(m.id)!.end })),
        createdById: c.userId,
      },
    });
    await tx.schedule.update({ where: { id: scheduleId }, data: { version } });
  }
  return { ...preview, version };
}

/** Projected windows from today at the current pace (nothing is saved). */
export function projection(rows: MilestoneRow[], cal: WorkCalendar, start: string, todayStr: string) {
  const items = planItems(rows);
  const { pace, earned, planned } = paceOf(items, cal, todayStr);
  const windows = forwardPass(items, cal, { mode: 'PROJECT', start, today: todayStr, pace });
  const end = planEnd([...windows.values()].map((w) => ({ plannedEnd: w.end })));
  const total = items.reduce((a, m) => a + m.workDays, 0);
  return { pace, earned, planned, windows, end: rows.length ? end : null, progressPercent: total > 0 ? Math.round((earned / total) * 1000) / 10 : 0 };
}
