/** B3 — work measured for piece-rate sub-contracts; verifying one adds its value to the account. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { occurredAtFor } from '../inventory/stock.js';
import { findAssignment, UNIT_OF } from './assignments.service.js';
import type { MeasurementInput, MeasurementsQuery } from './labor.schema.js';
import { actor, assertOffice, audit, num, projectFor, times, today, type Actor, type Created } from './labor.shared.js';
import * as alerts from '../notifications/alerts.js';
import { postSubLedger } from './subcontractLedger.js';

const include = {
  assignment: { select: { id: true, scope: true, rateType: true, ratePaisa: true, subcontractor: { select: { id: true, name: true, trade: true } } } },
} as const;
type Row = Prisma.WorkMeasurementGetPayload<{ include: typeof include }>;

function toDto(m: Row, a: Pick<Actor, 'role'>, value?: bigint | null) {
  return {
    id: m.id,
    projectId: m.projectId,
    assignment: { id: m.assignment.id, scope: m.assignment.scope, rateType: m.assignment.rateType, subcontractor: m.assignment.subcontractor },
    date: formatDateOnly(m.date),
    description: m.description,
    quantity: num(m.quantity)!,
    unit: m.unit,
    attachmentIds: m.attachmentIds,
    status: m.status,
    ...(a.role !== 'MUNSHI'
      ? { ratePaisa: m.assignment.ratePaisa?.toString() ?? null, valuePaisa: (value ?? (m.assignment.ratePaisa ? times(m.quantity, m.assignment.ratePaisa) : 0n)).toString() }
      : {}),
    verifiedById: m.verifiedById,
    verifiedAt: m.verifiedAt?.toISOString() ?? null,
    note: m.note,
    clientId: m.clientId,
    deviceCreatedAt: m.deviceCreatedAt?.toISOString() ?? null,
    createdById: m.createdById,
    createdAt: m.createdAt.toISOString(),
  };
}

async function find(tx: Tx, a: Actor, id: string) {
  const m = await tx.workMeasurement.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!m) throw new NotFound('MEASUREMENT_NOT_FOUND', 'Measurement not found');
  await projectFor(tx, a, m.projectId).catch(() => {
    throw new NotFound('MEASUREMENT_NOT_FOUND', 'Measurement not found');
  });
  return m;
}

export async function recordMeasurementTx(tx: Tx, a: Actor, projectId: string, input: MeasurementInput, opts: { at?: Date } = {}): Promise<Created<ReturnType<typeof toDto>>> {
  if (input.clientId) {
    const dup = await tx.workMeasurement.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, include });
    if (dup) return { created: false, data: toDto(dup, a) };
  }
  const project = await projectFor(tx, a, projectId, true);
  if (input.date > today()) throw new BadRequest('FUTURE_DATE', "Work can't be measured on a future day");
  const s = await findAssignment(tx, a, input.assignmentId);
  if (s.projectId !== project.id) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is on another project');
  if (!s.isActive) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is closed');
  if (s.rateType === 'LUMPSUM') throw new BadRequest('LUMPSUM_USES_PROGRESS', 'A lump-sum contract is paid by % progress, not measurements');
  if (input.attachmentIds?.length) {
    const found = await tx.attachment.count({ where: { tenantId: a.tenantId, id: { in: input.attachmentIds } } });
    if (found !== new Set(input.attachmentIds).size) throw new BadRequest('INVALID_ATTACHMENT', 'A photo was not found — upload it again');
  }
  const m = await tx.workMeasurement.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      assignmentId: s.id,
      date: dateOnly(input.date),
      description: input.description,
      quantity: input.quantity,
      unit: UNIT_OF[s.rateType],
      attachmentIds: input.attachmentIds ?? [],
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
    include,
  });
  await audit(tx, a, 'measurement.record', 'WorkMeasurement', m.id, { assignmentId: s.id, quantity: num(m.quantity), unit: m.unit });
  await alerts.measurementRecorded(tx, {
    tenantId: a.tenantId,
    projectId: project.id,
    projectName: project.name,
    measurementId: m.id,
    subcontractor: s.subcontractor.name,
    quantity: String(num(m.quantity)),
    unit: m.unit,
    ...(opts.at ? { at: opts.at } : {}),
  });
  return { created: true, data: toDto(m, a) };
}

export async function recordMeasurement(projectId: string, input: MeasurementInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => recordMeasurementTx(tx, a, projectId, input));
}

export async function listMeasurements(projectId: string, query: MeasurementsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const where: Prisma.WorkMeasurementWhereInput = {
      tenantId: a.tenantId,
      projectId,
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await tx.workMeasurement.findMany({ where, include, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.workMeasurement.count({ where });
    const values = new Map(
      (
        await tx.subcontractLedgerEntry.findMany({
          where: { tenantId: a.tenantId, refType: 'MEASUREMENT', refId: { in: rows.map((r) => r.id) } },
          select: { refId: true, amountPaisa: true },
        })
      ).map((e) => [e.refId!, e.amountPaisa]),
    );
    const pending = await tx.workMeasurement.count({ where: { tenantId: a.tenantId, projectId, status: 'RECORDED' } });
    return { data: rows.map((r) => toDto(r, a, values.get(r.id))), meta: { ...pageMeta(query, total), pendingCount: pending } };
  });
}

export async function verifyMeasurementTx(tx: Tx, a: Actor, id: string, opts: { at?: Date } = {}) {
  assertOffice(a, 'Only the owner or a project manager can verify measurements');
  const m = await find(tx, a, id);
  if (m.status !== 'RECORDED') throw new Conflict('MEASUREMENT_NOT_PENDING', `This measurement is already ${m.status.toLowerCase()}`, { status: m.status });
  const rate = m.assignment.ratePaisa ?? 0n;
  const value = times(m.quantity, rate);
  const at = opts.at ?? new Date();
  await tx.workMeasurement.update({ where: { id: m.id }, data: { status: 'VERIFIED', verifiedById: a.userId, verifiedAt: at } });
  await postSubLedger(tx, a, {
    assignmentId: m.assignmentId,
    type: 'WORK_VALUE',
    amountPaisa: value,
    refType: 'MEASUREMENT',
    refId: m.id,
    occurredAt: opts.at ?? occurredAtFor(formatDateOnly(m.date)),
    note: `${num(m.quantity)} ${m.unit} × ${rate / 100n} — ${m.description}`,
  });
  await audit(tx, a, 'measurement.verify', 'WorkMeasurement', m.id, { valuePaisa: value.toString() });
  return toDto(await find(tx, a, id), a, value);
}

export async function verifyMeasurement(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => verifyMeasurementTx(tx, a, id));
}

export async function rejectMeasurement(id: string, note: string) {
  const a = actor();
  assertOffice(a, 'Only the owner or a project manager can reject measurements');
  return withTenant(a.tenantId, async (tx) => {
    const m = await find(tx, a, id);
    if (m.status !== 'RECORDED') throw new Conflict('MEASUREMENT_NOT_PENDING', `This measurement is already ${m.status.toLowerCase()}`, { status: m.status });
    await tx.workMeasurement.update({ where: { id: m.id }, data: { status: 'REJECTED', verifiedById: a.userId, verifiedAt: new Date(), note } });
    await audit(tx, a, 'measurement.reject', 'WorkMeasurement', m.id, { note });
    return toDto(await find(tx, a, id), a);
  });
}
