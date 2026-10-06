/** B1 — who works on a project: daily-wage workers (with the project's rate) and sub-contracts. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma, SubcontractRateType } from '../../generated/prisma/client.js';
import type { AssignSubcontractInput, AssignWorkerInput, UpdateProjectWorkerInput, UpdateSubcontractInput } from './labor.schema.js';
import { actor, assertOffice, audit, num, paisa, projectFor, today, type Actor } from './labor.shared.js';

export const UNIT_OF: Record<SubcontractRateType, string> = {
  PER_SQFT: 'sqft',
  PER_TON: 'ton',
  PER_BRICK: 'brick',
  PER_RFT: 'rft',
  PER_CFT: 'cft',
  LUMPSUM: '%',
};
const LABOR_UNIT: Partial<Record<SubcontractRateType, string>> = { PER_SQFT: 'SQFT', PER_TON: 'TON', PER_BRICK: 'BRICK', PER_RFT: 'RFT', LUMPSUM: 'LUMPSUM' };

// ─── Workers ────────────────────────────────────────────────────────────────

const workerInclude = { worker: { select: { id: true, name: true, type: true, phone: true, dailyRatePaisa: true, isActive: true } } } as const;
type ProjectWorkerRow = Prisma.ProjectWorkerGetPayload<{ include: typeof workerInclude }>;

export function toProjectWorkerDto(pw: ProjectWorkerRow) {
  return {
    id: pw.id,
    projectId: pw.projectId,
    worker: { id: pw.worker.id, name: pw.worker.name, type: pw.worker.type, phone: pw.worker.phone },
    dailyRatePaisa: pw.dailyRatePaisa.toString(),
    defaultRatePaisa: pw.worker.dailyRatePaisa.toString(),
    rateOverridden: pw.dailyRatePaisa !== pw.worker.dailyRatePaisa,
    startDate: formatDateOnly(pw.startDate),
    endDate: pw.endDate ? formatDateOnly(pw.endDate) : null,
    isActive: pw.isActive,
  };
}

async function findProjectWorker(tx: Tx, a: Actor, id: string) {
  const pw = await tx.projectWorker.findFirst({ where: { tenantId: a.tenantId, id }, include: workerInclude });
  if (!pw) throw new NotFound('PROJECT_WORKER_NOT_FOUND', 'Worker assignment not found');
  await projectFor(tx, a, pw.projectId).catch(() => {
    throw new NotFound('PROJECT_WORKER_NOT_FOUND', 'Worker assignment not found');
  });
  return pw;
}

export async function listProjectWorkers(projectId: string, query: { active?: boolean }) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const rows = await tx.projectWorker.findMany({
      where: { tenantId: a.tenantId, projectId, ...(query.active === undefined ? {} : { isActive: query.active }) },
      include: workerInclude,
      orderBy: [{ isActive: 'desc' }, { worker: { name: 'asc' } }],
    });
    return rows.map(toProjectWorkerDto);
  });
}

export async function assignWorkerTx(tx: Tx, a: Actor, projectId: string, input: AssignWorkerInput) {
  const project = await projectFor(tx, a, projectId, true);
  const worker = await tx.worker.findFirst({ where: { tenantId: a.tenantId, id: input.workerId } });
  if (!worker || !worker.isActive) throw new BadRequest('INVALID_WORKER', 'Choose an active worker');
  if (a.role === 'MUNSHI' && input.dailyRatePaisa !== undefined && input.dailyRatePaisa !== worker.dailyRatePaisa) {
    throw new Forbidden('RATE_CHANGE_NOT_ALLOWED', "A munshi assigns at the worker's normal rate — the office can change it");
  }
  const rate = input.dailyRatePaisa ?? worker.dailyRatePaisa;
  const startDate = dateOnly(input.startDate ?? today());

  const existing = await tx.projectWorker.findUnique({ where: { projectId_workerId: { projectId: project.id, workerId: worker.id } } });
  if (existing?.isActive) throw new Conflict('WORKER_ALREADY_ASSIGNED', `${worker.name} is already on this project`, { projectWorkerId: existing.id });
  const pw = existing
    ? await tx.projectWorker.update({ where: { id: existing.id }, data: { isActive: true, endDate: null, dailyRatePaisa: rate, startDate }, include: workerInclude })
    : await tx.projectWorker.create({
        data: { tenantId: a.tenantId, projectId: project.id, workerId: worker.id, dailyRatePaisa: rate, startDate, createdById: a.userId },
        include: workerInclude,
      });
  await audit(tx, a, existing ? 'labor.worker_reassigned' : 'labor.worker_assigned', 'ProjectWorker', pw.id, {
    projectId: project.id,
    worker: worker.name,
    dailyRatePaisa: rate.toString(),
  });
  return toProjectWorkerDto(pw);
}

export async function assignWorker(projectId: string, input: AssignWorkerInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => assignWorkerTx(tx, a, projectId, input));
}

export async function updateProjectWorker(id: string, input: UpdateProjectWorkerInput) {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const pw = await findProjectWorker(tx, a, id);
    const data: Prisma.ProjectWorkerUncheckedUpdateInput = {};
    if (input.dailyRatePaisa !== undefined) data.dailyRatePaisa = input.dailyRatePaisa;
    if (input.endDate !== undefined) {
      if (input.endDate && input.endDate < formatDateOnly(pw.startDate)) throw new BadRequest('INVALID_END_DATE', 'The end date is before the start date');
      data.endDate = input.endDate ? dateOnly(input.endDate) : null;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
      if (!input.isActive && input.endDate === undefined) data.endDate = dateOnly(today());
      if (input.isActive && input.endDate === undefined) data.endDate = null;
    }
    const updated = await tx.projectWorker.update({ where: { id: pw.id }, data, include: workerInclude });
    await audit(tx, a, 'labor.worker_updated', 'ProjectWorker', pw.id, {
      before: { dailyRatePaisa: pw.dailyRatePaisa.toString(), isActive: pw.isActive, endDate: pw.endDate ? formatDateOnly(pw.endDate) : null },
      after: { dailyRatePaisa: updated.dailyRatePaisa.toString(), isActive: updated.isActive, endDate: updated.endDate ? formatDateOnly(updated.endDate) : null },
    });
    return toProjectWorkerDto(updated);
  });
}

/** Removes a worker who never worked here; one with hazri / peshgi is only taken off (inactive). */
export async function removeProjectWorker(id: string) {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const pw = await findProjectWorker(tx, a, id);
    const used =
      (await tx.attendance.count({ where: { tenantId: a.tenantId, projectId: pw.projectId, workerId: pw.workerId } })) +
      (await tx.advance.count({ where: { tenantId: a.tenantId, projectId: pw.projectId, workerId: pw.workerId } }));
    if (used) {
      const updated = await tx.projectWorker.update({ where: { id: pw.id }, data: { isActive: false, endDate: pw.endDate ?? dateOnly(today()) }, include: workerInclude });
      await audit(tx, a, 'labor.worker_removed', 'ProjectWorker', pw.id, { kept: true });
      return { removed: false, deactivated: true, assignment: toProjectWorkerDto(updated) };
    }
    await tx.projectWorker.delete({ where: { id: pw.id } });
    await audit(tx, a, 'labor.worker_removed', 'ProjectWorker', pw.id, { kept: false, worker: pw.worker.name });
    return { removed: true, deactivated: false, assignment: null };
  });
}

/** Workers on the project (hazri, peshgi); 400 WORKER_NOT_ASSIGNED for anyone who isn't. */
export async function assignedWorkers(tx: Tx, tenantId: string, projectId: string, workerIds: string[], date?: string) {
  const rows = await tx.projectWorker.findMany({ where: { tenantId, projectId, workerId: { in: workerIds } }, include: workerInclude });
  // Active now, or taken off after `date` (back-filling the days they did work).
  const valid = rows.filter((r) => r.isActive || (date !== undefined && r.endDate !== null && formatDateOnly(r.endDate) >= date));
  const missing = workerIds.filter((id) => !valid.some((r) => r.workerId === id));
  if (missing.length) {
    throw new BadRequest('WORKER_NOT_ASSIGNED', 'Some workers are not on this project on that day — assign them first', { workerIds: missing });
  }
  return new Map(valid.map((r) => [r.workerId, r]));
}

// ─── Sub-contracts ──────────────────────────────────────────────────────────

const subInclude = { subcontractor: { select: { id: true, name: true, trade: true, phone: true } } } as const;
type AssignmentRow = Prisma.SubcontractAssignmentGetPayload<{ include: typeof subInclude }>;

/** MUNSHI never sees rates / contract value / retention. */
export function toAssignmentDto(s: AssignmentRow, a: Pick<Actor, 'role'>) {
  const money = a.role !== 'MUNSHI';
  return {
    id: s.id,
    projectId: s.projectId,
    subcontractor: s.subcontractor,
    scope: s.scope,
    rateType: s.rateType,
    unit: UNIT_OF[s.rateType],
    ...(money
      ? { ratePaisa: paisa(s.ratePaisa), contractValuePaisa: paisa(s.contractValuePaisa), retentionPercent: num(s.retentionPercent) }
      : {}),
    progressPercent: num(s.progressPercent),
    startDate: formatDateOnly(s.startDate),
    isActive: s.isActive,
  };
}

export async function findAssignment(tx: Tx, a: Actor, id: string) {
  const s = await tx.subcontractAssignment.findFirst({ where: { tenantId: a.tenantId, id }, include: subInclude });
  if (!s) throw new NotFound('ASSIGNMENT_NOT_FOUND', 'Sub-contract not found');
  await projectFor(tx, a, s.projectId).catch(() => {
    throw new NotFound('ASSIGNMENT_NOT_FOUND', 'Sub-contract not found');
  });
  return s;
}

export async function listSubcontracts(projectId: string, query: { active?: boolean }) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const rows = await tx.subcontractAssignment.findMany({
      where: { tenantId: a.tenantId, projectId, ...(query.active === undefined ? {} : { isActive: query.active }) },
      include: subInclude,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => toAssignmentDto(r, a));
  });
}

export async function assignSubcontractTx(tx: Tx, a: Actor, projectId: string, input: AssignSubcontractInput) {
  assertOffice(a);
  const project = await projectFor(tx, a, projectId, true);
  const sub = await tx.subcontractor.findFirst({ where: { tenantId: a.tenantId, id: input.subcontractorId } });
  if (!sub || !sub.isActive) throw new BadRequest('INVALID_SUBCONTRACTOR', 'Choose an active sub-contractor');
  // Rate (or lump-sum value) defaults to the company's SUBCONTRACT labour rate for the trade.
  const given = input.rateType === 'LUMPSUM' ? input.contractValuePaisa : input.ratePaisa;
  let amount = given ?? null;
  if (amount === null) {
    const rate = await tx.laborRate.findFirst({ where: { tenantId: a.tenantId, kind: 'SUBCONTRACT', key: sub.trade } });
    if (!rate || rate.unit !== LABOR_UNIT[input.rateType]) {
      const what = input.rateType === 'LUMPSUM' ? 'lump-sum value' : `${UNIT_OF[input.rateType]} rate`;
      throw new BadRequest('RATE_REQUIRED', `There is no ${what} for ${sub.trade.toLowerCase().replace(/_/g, ' ')} — enter it`);
    }
    amount = rate.ratePaisa;
  }
  const s = await tx.subcontractAssignment.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      subcontractorId: sub.id,
      scope: input.scope,
      rateType: input.rateType,
      ratePaisa: input.rateType === 'LUMPSUM' ? null : amount,
      contractValuePaisa: input.rateType === 'LUMPSUM' ? amount : null,
      retentionPercent: input.retentionPercent ?? 5,
      startDate: dateOnly(input.startDate ?? today()),
      createdById: a.userId,
    },
    include: subInclude,
  });
  await audit(tx, a, 'labor.subcontract_assigned', 'SubcontractAssignment', s.id, {
    projectId: project.id,
    subcontractor: sub.name,
    rateType: s.rateType,
    ratePaisa: paisa(s.ratePaisa),
    contractValuePaisa: paisa(s.contractValuePaisa),
  });
  return toAssignmentDto(s, a);
}

export async function assignSubcontract(projectId: string, input: AssignSubcontractInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => assignSubcontractTx(tx, a, projectId, input));
}

export async function updateSubcontract(id: string, input: UpdateSubcontractInput) {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const s = await findAssignment(tx, a, id);
    if (input.ratePaisa !== undefined && s.rateType === 'LUMPSUM') throw new BadRequest('LUMPSUM_HAS_NO_RATE', 'A lump-sum contract has a value, not a rate');
    if (input.contractValuePaisa !== undefined && s.rateType !== 'LUMPSUM') throw new BadRequest('NOT_LUMPSUM', 'Only a lump-sum contract has a value');
    const updated = await tx.subcontractAssignment.update({
      where: { id: s.id },
      data: {
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.ratePaisa !== undefined ? { ratePaisa: input.ratePaisa } : {}),
        ...(input.contractValuePaisa !== undefined ? { contractValuePaisa: input.contractValuePaisa } : {}),
        ...(input.retentionPercent !== undefined ? { retentionPercent: input.retentionPercent } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      include: subInclude,
    });
    await audit(tx, a, 'labor.subcontract_updated', 'SubcontractAssignment', s.id, {
      before: { scope: s.scope, ratePaisa: paisa(s.ratePaisa), contractValuePaisa: paisa(s.contractValuePaisa), retentionPercent: num(s.retentionPercent), isActive: s.isActive },
      after: {
        scope: updated.scope,
        ratePaisa: paisa(updated.ratePaisa),
        contractValuePaisa: paisa(updated.contractValuePaisa),
        retentionPercent: num(updated.retentionPercent),
        isActive: updated.isActive,
      },
    });
    return toAssignmentDto(updated, a);
  });
}
