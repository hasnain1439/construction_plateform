/** Workers (daily-wage labour) and sub-contractors (piece-rate teams). */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma, Subcontractor, Worker } from '../../generated/prisma/client.js';
import type {
  CreateSubcontractorInput,
  CreateWorkerInput,
  ListSubcontractorsQuery,
  ListWorkersQuery,
  UpdateSubcontractorInput,
  UpdateWorkerInput,
} from './master-data.schema.js';
import { audit, conflictOn, current } from './master-data.shared.js';

const definedOnly = <T extends object>(input: T) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

function searchWhere(search: string | undefined) {
  if (!search) return [];
  const digits = search.replace(/\D/g, '').replace(/^0+/, '').replace(/^92/, '');
  return [
    {
      OR: [{ name: { contains: search, mode: 'insensitive' as const } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])],
    },
  ];
}

// ─── Workers ────────────────────────────────────────────────────────────────

const workerNotFound = () => new NotFound('WORKER_NOT_FOUND', 'Worker not found');
const phoneTaken = conflictOn('WORKER_PHONE_TAKEN', 'Another worker already has this phone number');

function toWorkerDto(w: Worker) {
  return {
    id: w.id,
    name: w.name,
    type: w.type,
    phone: w.phone,
    dailyRatePaisa: w.dailyRatePaisa.toString(),
    isActive: w.isActive,
    notes: w.notes,
    createdAt: w.createdAt.toISOString(),
  };
}

async function findWorker(tx: Tx, id: string) {
  const worker = await tx.worker.findUnique({ where: { id } });
  if (!worker) throw workerNotFound();
  return worker;
}

/** The company's DAILY labour rate for a worker type (OTHER has none). */
async function defaultDailyRate(tx: Tx, type: Worker['type']) {
  if (type === 'OTHER') return null;
  return (await tx.laborRate.findFirst({ where: { kind: 'DAILY', key: type } }))?.ratePaisa ?? null;
}

export async function listWorkers(query: ListWorkersQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const and: Prisma.WorkerWhereInput[] = [...searchWhere(query.search)];
    if (query.type) and.push({ type: query.type });
    if (query.isActive !== undefined) and.push({ isActive: query.isActive });
    const where: Prisma.WorkerWhereInput = and.length ? { AND: and } : {};
    const rows = await tx.worker.findMany({ where, orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }], ...skipTake(query) });
    return { data: rows.map(toWorkerDto), meta: pageMeta(query, await tx.worker.count({ where })) };
  });
}

export async function createWorker(input: CreateWorkerInput) {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const dailyRatePaisa = input.dailyRatePaisa ?? (await defaultDailyRate(tx, input.type));
    if (dailyRatePaisa === null) throw new BadRequest('DAILY_RATE_REQUIRED', 'Enter a daily rate — there is no labour rate for this worker type');
    const worker = await tx.worker.create({
      data: { tenantId, name: input.name, type: input.type, phone: input.phone ?? null, dailyRatePaisa, notes: input.notes ?? null, createdById: userId },
    });
    await audit(tx, 'worker.create', 'Worker', worker.id, { name: worker.name, type: worker.type, dailyRatePaisa: worker.dailyRatePaisa.toString() });
    return toWorkerDto(worker);
  }).catch(phoneTaken);
}

export async function updateWorker(id: string, input: UpdateWorkerInput) {
  return withTenant(current().tenantId, async (tx) => {
    await findWorker(tx, id);
    const data = definedOnly(input) as Prisma.WorkerUpdateInput;
    const updated = await tx.worker.update({ where: { id }, data });
    await audit(tx, 'worker.update', 'Worker', id, { name: updated.name, fields: Object.keys(data) });
    return toWorkerDto(updated);
  }).catch(phoneTaken);
}

export async function setWorkerActive(id: string, isActive: boolean) {
  return withTenant(current().tenantId, async (tx) => {
    const worker = await findWorker(tx, id);
    if (worker.isActive === isActive) return toWorkerDto(worker);
    const updated = await tx.worker.update({ where: { id }, data: { isActive } });
    await audit(tx, isActive ? 'worker.activate' : 'worker.deactivate', 'Worker', id, { name: worker.name });
    return toWorkerDto(updated);
  });
}

// ─── Sub-contractors ────────────────────────────────────────────────────────

const subNotFound = () => new NotFound('SUBCONTRACTOR_NOT_FOUND', 'Sub-contractor not found');
const subExists = conflictOn('SUBCONTRACTOR_EXISTS', 'A sub-contractor with this name already exists');

function toSubDto(s: Subcontractor) {
  return { id: s.id, name: s.name, trade: s.trade, phone: s.phone, notes: s.notes, isActive: s.isActive, createdAt: s.createdAt.toISOString() };
}

async function findSub(tx: Tx, id: string) {
  const sub = await tx.subcontractor.findUnique({ where: { id } });
  if (!sub) throw subNotFound();
  return sub;
}

export async function listSubcontractors(query: ListSubcontractorsQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const and: Prisma.SubcontractorWhereInput[] = [...searchWhere(query.search)];
    if (query.trade) and.push({ trade: query.trade });
    if (query.isActive !== undefined) and.push({ isActive: query.isActive });
    const where: Prisma.SubcontractorWhereInput = and.length ? { AND: and } : {};
    const rows = await tx.subcontractor.findMany({ where, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], ...skipTake(query) });
    return { data: rows.map(toSubDto), meta: pageMeta(query, await tx.subcontractor.count({ where })) };
  });
}

export async function createSubcontractor(input: CreateSubcontractorInput) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const sub = await tx.subcontractor.create({ data: { tenantId, name: input.name, trade: input.trade, phone: input.phone ?? null, notes: input.notes ?? null } });
    await audit(tx, 'subcontractor.create', 'Subcontractor', sub.id, { name: sub.name, trade: sub.trade });
    return toSubDto(sub);
  }).catch(subExists);
}

export async function updateSubcontractor(id: string, input: UpdateSubcontractorInput) {
  return withTenant(current().tenantId, async (tx) => {
    await findSub(tx, id);
    const data = definedOnly(input) as Prisma.SubcontractorUpdateInput;
    const updated = await tx.subcontractor.update({ where: { id }, data });
    await audit(tx, 'subcontractor.update', 'Subcontractor', id, { name: updated.name, fields: Object.keys(data) });
    return toSubDto(updated);
  }).catch(subExists);
}

export async function setSubcontractorActive(id: string, isActive: boolean) {
  return withTenant(current().tenantId, async (tx) => {
    const sub = await findSub(tx, id);
    if (sub.isActive === isActive) return toSubDto(sub);
    const updated = await tx.subcontractor.update({ where: { id }, data: { isActive } });
    await audit(tx, isActive ? 'subcontractor.activate' : 'subcontractor.deactivate', 'Subcontractor', id, { name: sub.name });
    return toSubDto(updated);
  });
}
