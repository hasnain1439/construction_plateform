/**
 * Equipment losses: MISSING (taken off the location's ledger when reported — a transfer gap never
 * arrived) or DAMAGED (still there; the value is the repair / replacement cost). Each stays
 * REPORTED until charged:
 *   PROJECT        → project P&L bucket LOSSES (cost source EQUIPMENT_LOSS)
 *   SUBCONTRACTOR  → the sub-contract's ledger, DEDUCTION (refType EQUIPMENT_LOSS)
 *   WRITE_OFF      → the company absorbs it (not in any project's cost)
 */
import { fieldsOf, visible } from '../../core/auth/fieldStrip.js';
import { can, scopeAll } from '../../core/auth/access.js';
import { nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import { assertAttachment } from '../inventory/stock.js';
import { findAssignment } from '../labor/assignments.service.js';
import { postSubLedger } from '../labor/subcontractLedger.js';
import { findProjectFor } from '../projects/access.js';
import {
  actor,
  assertAvailable,
  assertRentalItem,
  audit,
  EQUIPMENT_NUMBERS,
  equipmentRef,
  equipmentSelect,
  locationSelect,
  lockLocations,
  occurredAtFor,
  postMove,
  projectSelect,
  qn,
  resolveLocation,
  seesYard,
  userSelect,
  valueOf,
  type Actor,
} from './equipment.shared.js';
import type { ChargeLossInput, ListLossesQuery, ReportLossInput } from './equipment.schema.js';

const lossNotFound = () => new NotFound('LOSS_NOT_FOUND', 'Loss not found');

export const lossInclude = {
  equipment: equipmentSelect,
  rental: { select: { id: true, number: true } },
  location: locationSelect,
  project: projectSelect,
  transfer: { select: { id: true, number: true } },
  subcontractAssignment: { select: { id: true, subcontractor: { select: { id: true, name: true } } } },
  photo: { select: { id: true, storageKey: true } },
  reportedBy: userSelect,
  chargedBy: userSelect,
} as const satisfies Prisma.EquipmentLossInclude;

type LossRow = Prisma.EquipmentLossGetPayload<{ include: typeof lossInclude }>;

export async function lossDto(l: LossRow, a: Pick<Actor, 'seesRates'>) {
  return {
    id: l.id,
    number: l.number,
    kind: l.kind,
    status: l.status,
    source: l.source,
    equipment: equipmentRef(l.equipment),
    rental: l.rental,
    location: l.location,
    project: l.project,
    transfer: l.transfer,
    qty: qn(l.qty),
    ...visible(fieldsOf(a), 'rates', { valuePaisa: l.valuePaisa.toString() }),
    chargedTo: l.chargedTo,
    subcontract: l.subcontractAssignment ? { id: l.subcontractAssignment.id, subcontractorId: l.subcontractAssignment.subcontractor.id, name: l.subcontractAssignment.subcontractor.name } : null,
    note: l.note,
    photoUrl: await optionalSignedUrl(l.photo),
    reportedBy: l.reportedBy,
    reportedAt: l.reportedAt.toISOString(),
    chargedBy: l.chargedBy,
    chargedAt: l.chargedAt?.toISOString() ?? null,
    chargeNote: l.chargeNote,
  };
}

function scope(a: Actor): Prisma.EquipmentLossWhereInput {
  if (scopeAll('equipment.view', a)) return {};
  const own: Prisma.EquipmentLossWhereInput = { project: { userAccess: { some: { userId: a.userId } } } };
  return seesYard(a) ? { OR: [own, { projectId: null }] } : own;
}

async function findLoss(tx: Tx, a: Actor, id: string): Promise<LossRow> {
  const l = await tx.equipmentLoss.findFirst({ where: { tenantId: a.tenantId, id, ...scope(a) }, include: lossInclude });
  if (!l) throw lossNotFound();
  return l;
}

export async function lossDetail(tx: Tx, a: Actor, id: string) {
  return lossDto(await findLoss(tx, a, id), a);
}

export async function reportLossTx(tx: Tx, a: Actor, input: ReportLossInput, opts: { at?: Date } = {}) {
  const location = await resolveLocation(tx, a, input, 'equipment.loss.create');
  const equipment = await tx.equipment.findFirst({ where: { tenantId: a.tenantId, id: input.equipmentId } });
  if (!equipment) throw new BadRequest('INVALID_EQUIPMENT', 'Equipment not found', { equipmentIds: [input.equipmentId] });
  if (input.rentalId) await assertRentalItem(tx, a.tenantId, input.rentalId, equipment.id);
  if (input.photoAttachmentId) await assertAttachment(tx, a.tenantId, input.photoAttachmentId, ['SITE_PHOTO'], 'INVALID_ATTACHMENT', 'Photo');
  const at = opts.at ?? (input.date ? occurredAtFor(input.date) : new Date());
  const bucket = { locationId: location.id, equipmentId: equipment.id, rentalId: input.rentalId ?? null };
  await lockLocations(tx, [location.id]);
  await assertAvailable(tx, a.tenantId, [{ ...bucket, qty: input.qty }], new Map([[equipment.id, equipment]]));
  const loss = await tx.equipmentLoss.create({
    data: {
      tenantId: a.tenantId,
      number: await nextNumber(tx, a.tenantId, EQUIPMENT_NUMBERS.loss, at),
      kind: input.kind,
      source: 'REPORT',
      equipmentId: equipment.id,
      rentalId: input.rentalId ?? null,
      locationId: location.id,
      projectId: location.projectId,
      qty: input.qty,
      valuePaisa: valueOf(input.qty, equipment.replacementValuePaisa),
      photoAttachmentId: input.photoAttachmentId ?? null,
      note: input.note,
      reportedById: a.userId,
      reportedAt: at,
    },
  });
  if (input.kind === 'MISSING') {
    await postMove(tx, a.tenantId, bucket, input.qty.neg(), { type: 'LOSS_OUT', refType: 'EQUIPMENT_LOSS', refId: loss.id, occurredAt: at, createdById: a.userId, note: `${loss.number}: ${input.note}` });
  }
  await audit(tx, a, 'equipment.loss.report', 'EquipmentLoss', loss.id, {
    number: loss.number,
    kind: input.kind,
    equipment: equipment.name,
    qty: qn(input.qty),
    location: location.name,
    rentalId: input.rentalId ?? null,
    note: input.note,
  });
  return lossDetail(tx, a, loss.id);
}

export async function reportLoss(input: ReportLossInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => reportLossTx(tx, a, input));
}

export async function getLoss(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => lossDetail(tx, a, id));
}

export async function listLosses(query: ListLossesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const and: Prisma.EquipmentLossWhereInput[] = [{ tenantId: a.tenantId }, scope(a)];
    if (query.status) and.push({ status: query.status });
    if (query.kind) and.push({ kind: query.kind });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.equipmentId) and.push({ equipmentId: query.equipmentId });
    const where = { AND: and };
    const rows = await tx.equipmentLoss.findMany({ where, include: lossInclude, orderBy: [{ reportedAt: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.equipmentLoss.count({ where });
    const data = [];
    for (const l of rows) data.push(await lossDto(l, a));
    return { data, meta: pageMeta(query, total) };
  });
}

export async function chargeLossTx(tx: Tx, a: Actor, id: string, input: ChargeLossInput) {
  const l = await findLoss(tx, a, id);
  if (l.projectId) {
    await findProjectFor(tx, a, l.projectId, 'equipment.loss.approve').catch(() => {
      throw lossNotFound();
    });
  } else if (!scopeAll('equipment.loss.approve', a) && !can('equipment.manage', a)) throw lossNotFound();
  if (l.status === 'CHARGED') throw new Conflict('LOSS_ALREADY_CHARGED', 'This loss has already been charged', { chargedTo: l.chargedTo });
  const value = input.valuePaisa ?? l.valuePaisa;
  if (input.chargedTo !== 'WRITE_OFF' && value <= 0n) throw new BadRequest('NOTHING_TO_CHARGE', 'Enter the value to charge (the equipment has no replacement value)');
  if (input.chargedTo === 'PROJECT' && !l.projectId) throw new BadRequest('NO_PROJECT', 'This loss is not at a project site — write it off or charge a sub-contractor');
  const at = new Date();
  let assignmentId: string | null = null;
  if (input.chargedTo === 'SUBCONTRACTOR') {
    const s = await findAssignment(tx, a, input.subcontractAssignmentId!).catch(() => {
      throw new BadRequest('INVALID_ASSIGNMENT', 'Sub-contract not found');
    });
    if (l.projectId && s.projectId !== l.projectId) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is on another project');
    assignmentId = s.id;
    await postSubLedger(tx, a, {
      assignmentId: s.id,
      type: 'DEDUCTION',
      amountPaisa: -value,
      refType: 'EQUIPMENT_LOSS',
      refId: l.id,
      occurredAt: at,
      note: `${l.number}: ${qn(l.qty)} ${l.equipment.unit} ${l.equipment.name} ${l.kind === 'MISSING' ? 'missing' : 'damaged'} — ${input.note}`,
    });
  }
  await tx.equipmentLoss.update({
    where: { id },
    data: { status: 'CHARGED', chargedTo: input.chargedTo, valuePaisa: value, subcontractAssignmentId: assignmentId, chargedById: a.userId, chargedAt: at, chargeNote: input.note },
  });
  await audit(tx, a, 'equipment.loss.charge', 'EquipmentLoss', id, {
    number: l.number,
    chargedTo: input.chargedTo,
    valuePaisa: value.toString(),
    estimatePaisa: l.valuePaisa.toString(),
    subcontractAssignmentId: assignmentId,
    note: input.note,
  });
  return lossDetail(tx, a, id);
}

export async function chargeLoss(id: string, input: ChargeLossInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => chargeLossTx(tx, a, id, input));
}
