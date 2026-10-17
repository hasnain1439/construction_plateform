/**
 * Snag list. Status flow OPEN → FIXED → VERIFIED (reopen → OPEN). Site accounts log snags and
 * mark them fixed (closeout.snag.create); the office assigns, verifies, reopens and decides who
 * pays (closeout.snag.manage, the cost also needs fields.amounts):
 *
 *   REWORK                   the amount counts in the project cost (cost engine source REWORK)
 *   SUBCONTRACTOR_DEDUCTION  a DEDUCTION on the sub-contract account (refType SNAG); a change or
 *                            removal posts the opposite entry (refType SNAG_REVERSAL)
 *   CHANGE_ORDER             stored flag + amount for the change-order module (Step 15)
 *
 * Snags logged after handover (project HANDED_OVER) are defect-period snags; once the retention
 * due date has passed no new ones are accepted.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma, Project, ProjectStatus, SnagCostAttribution, SnagStatus } from '../../generated/prisma/client.js';
import { postSubLedger } from '../labor/subcontractLedger.js';
import { assertEditable, assertProjectScope } from '../projects/access.js';
import type { Created } from '../labor/labor.shared.js';
import type { CreateSnagInput, FixSnagInput, ReopenSnagInput, SnagCostInput, SnagsQuery, UpdateSnagInput, VerifySnagInput } from './closeout.schema.js';
import { actor, assertAttachments, attachmentsById, audit, lockKey, peopleById, personOf, photosOf, today, ymd, type Actor } from './closeout.shared.js';

/** Snags can be logged / changed while the project runs, at closeout and in the defect period. */
export const SNAG_STATUSES: ProjectStatus[] = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER'];

const include = {
  worker: { select: { id: true, name: true } },
  subcontractor: { select: { id: true, name: true } },
} as const satisfies Prisma.SnagInclude;
type Row = Prisma.SnagGetPayload<{ include: typeof include }>;

export const snagCode = (n: number) => `SN-${String(n).padStart(3, '0')}`;

const POSTED_TO: Record<SnagCostAttribution, 'PROJECT_COST' | 'SUBCONTRACTOR_ACCOUNT' | 'CHANGE_ORDER_FLAG' | null> = {
  NONE: null,
  REWORK: 'PROJECT_COST',
  SUBCONTRACTOR_DEDUCTION: 'SUBCONTRACTOR_ACCOUNT',
  CHANGE_ORDER: 'CHANGE_ORDER_FLAG',
};

const isOverdue = (r: { status: SnagStatus; targetDate: Date | null }, day: string) => r.status === 'OPEN' && r.targetDate !== null && ymd(r.targetDate)! < day;

async function toDtos(tx: Tx, a: Actor, rows: Row[]) {
  const files = await attachmentsById(
    tx,
    a.tenantId,
    rows.flatMap((r) => [...r.beforePhotoIds, ...r.afterPhotoIds]),
  );
  const people = await peopleById(
    tx,
    a.tenantId,
    rows.flatMap((r) => [r.createdById, r.fixedById, r.verifiedById]),
  );
  const roomIds = [...new Set(rows.map((r) => r.roomId).filter((x): x is string => Boolean(x)))];
  const rooms = roomIds.length ? await tx.room.findMany({ where: { tenantId: a.tenantId, id: { in: roomIds } }, select: { id: true, name: true, floor: { select: { name: true } } } }) : [];
  const roomOf = new Map(rooms.map((r) => [r.id, { id: r.id, name: r.name, floor: r.floor.name }]));
  const day = today();
  const out = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      projectId: r.projectId,
      number: r.number,
      code: snagCode(r.number),
      roomId: r.roomId,
      room: r.roomId ? (roomOf.get(r.roomId) ?? null) : null,
      location: r.location,
      description: r.description,
      status: r.status,
      targetDate: ymd(r.targetDate),
      overdue: isOverdue(r, day),
      inDefectPeriod: r.inDefectPeriod,
      assignee: r.worker ? { type: 'WORKER' as const, ...r.worker } : r.subcontractor ? { type: 'SUBCONTRACTOR' as const, ...r.subcontractor } : null,
      beforePhotos: await photosOf(r.beforePhotoIds, files),
      afterPhotos: await photosOf(r.afterPhotoIds, files),
      fixNote: r.fixNote,
      fixedAt: r.fixedAt?.toISOString() ?? null,
      fixedBy: personOf(people, r.fixedById),
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      verifiedBy: personOf(people, r.verifiedById),
      reopenCount: r.reopenCount,
      lastReopenReason: r.lastReopenReason,
      cost: {
        attribution: r.costAttribution,
        ...(a.seesFinancials ? { amountPaisa: r.costAmountPaisa.toString() } : {}),
        note: r.costNote,
        subcontractAssignmentId: r.costAssignmentId,
        postedTo: POSTED_TO[r.costAttribution],
        postedAt: r.costPostedAt?.toISOString() ?? null,
      },
      clientId: r.clientId,
      createdBy: personOf(people, r.createdById),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return out;
}

export type SnagDto = Awaited<ReturnType<typeof toDtos>>[number];

async function dto(tx: Tx, a: Actor, id: string): Promise<SnagDto> {
  const row = await tx.snag.findFirstOrThrow({ where: { tenantId: a.tenantId, id }, include });
  return (await toDtos(tx, a, [row]))[0]!;
}

async function findSnag(tx: Tx, a: Actor, id: string, perm: string): Promise<{ s: Row; project: Project }> {
  const s = await tx.snag.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!s) throw new NotFound('SNAG_NOT_FOUND', 'Snag not found');
  const project = await assertProjectScope(tx, perm, s.projectId, a).catch((err: unknown) => {
    if (err instanceof NotFound) throw new NotFound('SNAG_NOT_FOUND', 'Snag not found');
    throw err;
  });
  return { s, project };
}

async function assertRoom(tx: Tx, a: Actor, projectId: string, roomId: string | null | undefined) {
  if (!roomId) return;
  const room = await tx.room.findFirst({ where: { tenantId: a.tenantId, id: roomId, projectId }, select: { id: true } });
  if (!room) throw new BadRequest('INVALID_ROOM', 'This room is not in the project');
}

async function assertAssignee(tx: Tx, a: Actor, workerId: string | null | undefined, subcontractorId: string | null | undefined) {
  if (workerId) {
    const w = await tx.worker.findFirst({ where: { tenantId: a.tenantId, id: workerId, isActive: true }, select: { id: true } });
    if (!w) throw new BadRequest('INVALID_ASSIGNEE', 'Worker not found (or inactive)', { workerId });
  }
  if (subcontractorId) {
    const s = await tx.subcontractor.findFirst({ where: { tenantId: a.tenantId, id: subcontractorId, isActive: true }, select: { id: true } });
    if (!s) throw new BadRequest('INVALID_ASSIGNEE', 'Sub-contractor not found (or inactive)', { subcontractorId });
  }
}

/** HANDED_OVER: inside the defect period (until the retention due date) → true; after it → 409. */
async function defectPeriodFlag(tx: Tx, a: Actor, project: Project): Promise<boolean> {
  if (project.status !== 'HANDED_OVER') return false;
  const h = await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId: a.tenantId, projectId: project.id } }, select: { retentionDueDate: true } });
  const due = ymd(h?.retentionDueDate);
  if (due && today() > due) throw new Conflict('DEFECT_PERIOD_ENDED', `The defect period ended on ${due}`, { retentionDueDate: due });
  return true;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function list(projectId: string, q: SnagsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await assertProjectScope(tx, 'closeout.snag.view', projectId, a);
    const day = dateOnly(today());
    const base: Prisma.SnagWhereInput = { tenantId: a.tenantId, projectId };
    const where: Prisma.SnagWhereInput = {
      ...base,
      ...(q.status ? { status: q.status } : {}),
      ...(q.assigneeType === 'WORKER' ? { workerId: q.assigneeId ?? { not: null } } : {}),
      ...(q.assigneeType === 'SUBCONTRACTOR' ? { subcontractorId: q.assigneeId ?? { not: null } } : {}),
      ...(!q.assigneeType && q.assigneeId ? { OR: [{ workerId: q.assigneeId }, { subcontractorId: q.assigneeId }] } : {}),
      ...(q.roomId ? { roomId: q.roomId } : {}),
      ...(q.defectPeriod !== undefined ? { inDefectPeriod: q.defectPeriod } : {}),
      ...(q.overdue ? { status: 'OPEN', targetDate: { lt: day } } : {}),
      ...(q.q
        ? {
            AND: [{ OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { location: { contains: q.q, mode: 'insensitive' } }] }],
          }
        : {}),
    };
    const total = await tx.snag.count({ where });
    const rows = await tx.snag.findMany({ where, include, orderBy: [{ number: 'desc' }], ...skipTake(q) });
    const byStatus = await tx.snag.groupBy({ by: ['status'], where: base, _count: true });
    const count = (s: SnagStatus) => byStatus.find((b) => b.status === s)?._count ?? 0;
    const overdue = await tx.snag.count({ where: { ...base, status: 'OPEN', targetDate: { lt: day } } });
    const defectPeriodOpen = await tx.snag.count({ where: { ...base, inDefectPeriod: true, status: { not: 'VERIFIED' } } });
    let money = {};
    if (a.seesFinancials) {
      const sums = await tx.snag.groupBy({ by: ['costAttribution'], where: base, _sum: { costAmountPaisa: true } });
      const sum = (k: SnagCostAttribution) => (sums.find((x) => x.costAttribution === k)?._sum.costAmountPaisa ?? 0n).toString();
      money = { reworkPaisa: sum('REWORK'), deductionPaisa: sum('SUBCONTRACTOR_DEDUCTION'), changeOrderPaisa: sum('CHANGE_ORDER') };
    }
    return {
      data: {
        items: await toDtos(tx, a, rows),
        summary: { open: count('OPEN'), fixed: count('FIXED'), verified: count('VERIFIED'), overdue, defectPeriodOpen, ...money },
      },
      meta: pageMeta(q, total),
    };
  });
}

export async function get(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { s } = await findSnag(tx, a, id, 'closeout.snag.view');
    return (await toDtos(tx, a, [s]))[0]!;
  });
}

// ─── Create / update ────────────────────────────────────────────────────────

export async function createTx(tx: Tx, a: Actor, projectId: string, input: CreateSnagInput, opts: { at?: Date } = {}): Promise<Created<SnagDto>> {
  if (input.clientId) {
    const dup = await tx.snag.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, select: { id: true } });
    if (dup) return { created: false, data: await dto(tx, a, dup.id) };
  }
  const project = await assertProjectScope(tx, 'closeout.snag.create', projectId, a);
  assertEditable(project, SNAG_STATUSES);
  if (!input.roomId && !input.location) throw new BadRequest('LOCATION_REQUIRED', 'Choose a room or write where the snag is');
  await assertRoom(tx, a, projectId, input.roomId);
  await assertAssignee(tx, a, input.workerId, input.subcontractorId);
  await assertAttachments(tx, a.tenantId, input.beforePhotoIds, ['SITE_PHOTO'], 'photo');
  const inDefectPeriod = await defectPeriodFlag(tx, a, project);
  await lockKey(tx, `snag:${projectId}`);
  const last = await tx.snag.findFirst({ where: { tenantId: a.tenantId, projectId }, orderBy: { number: 'desc' }, select: { number: true } });
  const s = await tx.snag.create({
    data: {
      tenantId: a.tenantId,
      projectId,
      number: (last?.number ?? 0) + 1,
      roomId: input.roomId ?? null,
      location: input.location ?? null,
      description: input.description,
      beforePhotoIds: input.beforePhotoIds ?? [],
      workerId: input.workerId ?? null,
      subcontractorId: input.subcontractorId ?? null,
      targetDate: input.targetDate ? dateOnly(input.targetDate) : null,
      inDefectPeriod,
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await audit(tx, a, 'snag.create', 'Snag', s.id, { projectId, number: s.number, inDefectPeriod, photos: s.beforePhotoIds.length, clientId: input.clientId ?? null });
  return { created: true, data: await dto(tx, a, s.id) };
}

export async function create(projectId: string, input: CreateSnagInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createTx(tx, a, projectId, input));
}

export async function update(id: string, input: UpdateSnagInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { s, project } = await findSnag(tx, a, id, 'closeout.snag.manage');
    assertEditable(project, SNAG_STATUSES);
    if (s.status === 'VERIFIED') throw new Conflict('SNAG_VERIFIED', 'A verified snag cannot be changed — reopen it first');
    await assertRoom(tx, a, s.projectId, input.roomId);
    await assertAssignee(tx, a, input.workerId, input.subcontractorId);
    await assertAttachments(tx, a.tenantId, input.beforePhotoIds, ['SITE_PHOTO'], 'photo');
    const data: Prisma.SnagUncheckedUpdateInput = {};
    if (input.roomId !== undefined) data.roomId = input.roomId;
    if (input.location !== undefined) data.location = input.location;
    if (input.description !== undefined) data.description = input.description;
    if (input.beforePhotoIds !== undefined) data.beforePhotoIds = input.beforePhotoIds;
    if (input.targetDate !== undefined) data.targetDate = input.targetDate ? dateOnly(input.targetDate) : null;
    // One assignee: setting a worker clears the sub-contractor and the other way round.
    if (input.workerId !== undefined) {
      data.workerId = input.workerId;
      if (input.workerId) data.subcontractorId = null;
    }
    if (input.subcontractorId !== undefined) {
      data.subcontractorId = input.subcontractorId;
      if (input.subcontractorId) data.workerId = null;
    }
    const roomId = input.roomId !== undefined ? input.roomId : s.roomId;
    const location = input.location !== undefined ? input.location : s.location;
    if (!roomId && !location) throw new BadRequest('LOCATION_REQUIRED', 'Choose a room or write where the snag is');
    await tx.snag.update({ where: { id: s.id }, data });
    await audit(tx, a, 'snag.update', 'Snag', s.id, {
      before: { roomId: s.roomId, location: s.location, description: s.description, workerId: s.workerId, subcontractorId: s.subcontractorId, targetDate: ymd(s.targetDate) },
      after: input as Prisma.InputJsonValue,
    });
    return dto(tx, a, s.id);
  });
}

export async function remove(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { s, project } = await findSnag(tx, a, id, 'closeout.snag.manage');
    assertEditable(project, SNAG_STATUSES);
    if (s.status !== 'OPEN' || s.costAttribution !== 'NONE') {
      throw new Conflict('SNAG_NOT_DELETABLE', 'Only an open snag without a cost can be deleted', { status: s.status, attribution: s.costAttribution });
    }
    await tx.snag.delete({ where: { id: s.id } });
    await audit(tx, a, 'snag.delete', 'Snag', s.id, { projectId: s.projectId, number: s.number, description: s.description });
    return { id: s.id, deleted: true as const };
  });
}

// ─── Status flow ────────────────────────────────────────────────────────────

function assertStatus(s: { status: SnagStatus }, allowed: SnagStatus[]) {
  if (!allowed.includes(s.status)) throw new Conflict('INVALID_SNAG_STATUS', `A ${s.status.toLowerCase()} snag can't do this`, { status: s.status, allowed });
}

export async function fixTx(tx: Tx, a: Actor, id: string, input: FixSnagInput, opts: { at?: Date } = {}) {
  const { s, project } = await findSnag(tx, a, id, 'closeout.snag.create');
  assertEditable(project, SNAG_STATUSES);
  assertStatus(s, ['OPEN']);
  await assertAttachments(tx, a.tenantId, input.afterPhotoIds, ['SITE_PHOTO'], 'photo');
  const at = opts.at ?? new Date();
  await tx.snag.update({
    where: { id: s.id },
    data: { status: 'FIXED', fixedAt: at, fixedById: a.userId, fixNote: input.note ?? null, ...(input.afterPhotoIds ? { afterPhotoIds: input.afterPhotoIds } : {}) },
  });
  await audit(tx, a, 'snag.fix', 'Snag', s.id, { number: s.number, photos: input.afterPhotoIds?.length ?? 0, note: input.note ?? null });
  return dto(tx, a, s.id);
}

export async function fix(id: string, input: FixSnagInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => fixTx(tx, a, id, input));
}

export async function verifyTx(tx: Tx, a: Actor, id: string, input: VerifySnagInput, opts: { at?: Date } = {}) {
  const { s, project } = await findSnag(tx, a, id, 'closeout.snag.manage');
  assertEditable(project, SNAG_STATUSES);
  assertStatus(s, ['FIXED']);
  await tx.snag.update({ where: { id: s.id }, data: { status: 'VERIFIED', verifiedAt: opts.at ?? new Date(), verifiedById: a.userId } });
  await audit(tx, a, 'snag.verify', 'Snag', s.id, { number: s.number, note: input.note ?? null });
  return dto(tx, a, s.id);
}

export async function verify(id: string, input: VerifySnagInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => verifyTx(tx, a, id, input));
}

export async function reopen(id: string, input: ReopenSnagInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { s, project } = await findSnag(tx, a, id, 'closeout.snag.manage');
    assertEditable(project, SNAG_STATUSES);
    assertStatus(s, ['FIXED', 'VERIFIED']);
    await tx.snag.update({
      where: { id: s.id },
      data: { status: 'OPEN', reopenCount: { increment: 1 }, lastReopenReason: input.reason, fixedAt: null, fixedById: null, verifiedAt: null, verifiedById: null },
    });
    await audit(tx, a, 'snag.reopen', 'Snag', s.id, { number: s.number, from: s.status, reason: input.reason });
    return dto(tx, a, s.id);
  });
}

// ─── Cost attribution ───────────────────────────────────────────────────────

async function resolveAssignment(tx: Tx, a: Actor, s: Row, assignmentId: string | undefined) {
  if (assignmentId) {
    const g = await tx.subcontractAssignment.findFirst({ where: { tenantId: a.tenantId, id: assignmentId, projectId: s.projectId }, select: { id: true } });
    if (!g) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is not on the project');
    return g.id;
  }
  if (!s.subcontractorId) throw new BadRequest('NO_SUBCONTRACT_ASSIGNMENT', 'Choose the sub-contract to deduct from (the snag is not assigned to a sub-contractor)');
  const g = await tx.subcontractAssignment.findFirst({
    where: { tenantId: a.tenantId, projectId: s.projectId, subcontractorId: s.subcontractorId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!g) throw new BadRequest('NO_SUBCONTRACT_ASSIGNMENT', 'This sub-contractor has no sub-contract on the project');
  return g.id;
}

export async function setCostTx(tx: Tx, a: Actor, id: string, input: SnagCostInput, opts: { at?: Date } = {}) {
  const { s } = await findSnag(tx, a, id, 'closeout.snag.manage');
  const needsAmount = input.attribution === 'REWORK' || input.attribution === 'SUBCONTRACTOR_DEDUCTION';
  if (needsAmount && !(input.amountPaisa && input.amountPaisa > 0n)) throw new BadRequest('AMOUNT_REQUIRED', 'Enter the amount (more than 0)');
  const amount = input.attribution === 'NONE' ? 0n : (input.amountPaisa ?? 0n);
  const assignmentId = input.attribution === 'SUBCONTRACTOR_DEDUCTION' ? await resolveAssignment(tx, a, s, input.subcontractAssignmentId) : null;
  const at = opts.at ?? new Date();
  const same = s.costAttribution === input.attribution && s.costAmountPaisa === amount && s.costAssignmentId === assignmentId;
  await lockKey(tx, `snag-cost:${s.id}`);
  const ledger: string[] = [];
  if (!same) {
    // Undo the previous deduction (the sub-contract ledger is append-only).
    if (s.costAttribution === 'SUBCONTRACTOR_DEDUCTION' && s.costAssignmentId && s.costAmountPaisa > 0n) {
      const e = await postSubLedger(tx, a, {
        assignmentId: s.costAssignmentId,
        type: 'DEDUCTION',
        amountPaisa: s.costAmountPaisa,
        refType: 'SNAG_REVERSAL',
        refId: s.id,
        occurredAt: at,
        note: `Snag ${snagCode(s.number)} deduction reversed`,
      });
      ledger.push(e.id);
    }
    if (input.attribution === 'SUBCONTRACTOR_DEDUCTION') {
      const e = await postSubLedger(tx, a, {
        assignmentId: assignmentId!,
        type: 'DEDUCTION',
        amountPaisa: -amount,
        refType: 'SNAG',
        refId: s.id,
        occurredAt: at,
        note: `Snag ${snagCode(s.number)}: ${input.note ?? s.description}`.slice(0, 500),
      });
      ledger.push(e.id);
    }
  }
  await tx.snag.update({
    where: { id: s.id },
    data: {
      costAttribution: input.attribution,
      costAmountPaisa: amount,
      costAssignmentId: assignmentId,
      costNote: input.note ?? null,
      costPostedAt: input.attribution === 'NONE' ? null : same ? s.costPostedAt : at,
    },
  });
  await audit(tx, a, 'snag.cost', 'Snag', s.id, {
    number: s.number,
    before: { attribution: s.costAttribution, amountPaisa: s.costAmountPaisa.toString(), assignmentId: s.costAssignmentId },
    after: { attribution: input.attribution, amountPaisa: amount.toString(), assignmentId },
    ledgerEntryIds: ledger,
  });
  return dto(tx, a, s.id);
}

export async function setCost(id: string, input: SnagCostInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => setCostTx(tx, a, id, input));
}
