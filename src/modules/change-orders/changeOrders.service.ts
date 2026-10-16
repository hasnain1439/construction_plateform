/**
 * Step 15 · Change orders: owner-requested extra (ADDITION) or omitted (DEDUCTION) work, priced
 * as a mini BoQ (material / labour / other lines + markup %), with days impact and proof of the
 * owner's approval.
 *
 *   DRAFT ─send→ SENT ─approve→ APPROVED ─start→ IN_PROGRESS ─complete→ COMPLETED
 *     │            └─reject→ REJECTED ─reopen→ DRAFT                           │
 *     └─approve / reject (owner agreed on site)          invoice issued → BILLED
 *
 * Approved ones (APPROVED / IN_PROGRESS / COMPLETED / BILLED) make the revised contract
 * (receivables `moneyOf`) and push the revised end date (Schedule.changeOrderDays).
 */
import { assertPerm } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { ChangeOrderSource, ChangeOrderStatus, Project } from '../../generated/prisma/client.js';
import { today } from '../labor/labor.shared.js';
import { assertEditable, assertProjectScope, contractTotalOf } from './projectLink.js';
import type { ApproveInput, ChangeOrdersQuery, ConvertInput, CreateChangeOrderInput, LineInput, RejectInput, UpdateChangeOrderInput } from './changeOrders.schema.js';
import {
  assertCoStatus,
  assertMilestones,
  assertProofFiles,
  assertVerbalNote,
  audit,
  buildLines,
  coActor,
  CO_PROJECT_STATUSES,
  detailDto,
  findCo,
  loadCo,
  lockKey,
  rateBook,
  repriceLines,
  seesCost,
  seesPrice,
  totalsOf,
  toDtos,
  writeLines,
  type CoActor,
  type LineRow,
} from './changeOrders.shared.js';
import { projectChangeSummary } from './summary.js';
import { APPROVED_SET, changeOrderCode, syncScheduleDays } from './totals.js';

const ZERO = new Prisma.Decimal(0);

// ─── Read ───────────────────────────────────────────────────────────────────

export async function list(projectId: string, q: ChangeOrdersQuery) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'changeorder.view', projectId, a);
    const rows = await tx.changeOrder.findMany({
      where: { tenantId: a.tenantId, projectId, ...(q.status ? { status: q.status } : {}) },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { number: 'desc' },
    });
    const byStatusRows = await tx.changeOrder.groupBy({ by: ['status'], where: { tenantId: a.tenantId, projectId }, _count: true, _sum: { totalPaisa: true } });
    const count = (s: ChangeOrderStatus) => byStatusRows.find((b) => b.status === s)?._count ?? 0;
    const sum = (ss: ChangeOrderStatus[]) => byStatusRows.filter((b) => ss.includes(b.status)).reduce((x, b) => x + (b._sum.totalPaisa ?? 0n), 0n);
    const snags = await tx.snag.findMany({
      where: { tenantId: a.tenantId, projectId, costAttribution: 'CHANGE_ORDER', changeOrders: { none: {} } },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, description: true, status: true, costAmountPaisa: true },
    });
    const newInstructions = await tx.siteInstruction.count({ where: { tenantId: a.tenantId, projectId, status: 'NEW' } });
    const summary = await projectChangeSummary(tx, a.tenantId, project, await contractTotalOf(tx, a.tenantId, project), a.fields);
    return {
      items: await toDtos(tx, a, rows),
      summary: {
        ...summary,
        byStatus: Object.fromEntries((['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'BILLED'] as const).map((s) => [s, count(s)])),
        newSiteInstructions: newInstructions,
        changeOrderSnags: snags.map((s) => ({
          id: s.id,
          code: `SN-${String(s.number).padStart(3, '0')}`,
          description: s.description,
          status: s.status,
          ...(a.fields.amounts ? { amountPaisa: s.costAmountPaisa.toString() } : {}),
        })),
        ...(seesPrice(a) ? { pendingPaisa: sum(['DRAFT', 'SENT']).toString() } : {}),
      },
    };
  });
}

export async function get(id: string) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, 'changeorder.view');
    return detailDto(tx, a, co, project);
  });
}

/** Builder pick lists: materials with their CO rate, labour rates, schedule milestones. */
export async function rateOptions(projectId: string) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    await assertProjectScope(tx, 'changeorder.create', projectId, a);
    const book = await rateBook(tx, a.tenantId, projectId);
    const materials = await tx.material.findMany({ where: { tenantId: a.tenantId, isHidden: false }, orderBy: { name: 'asc' }, select: { id: true, name: true, unit: true } });
    const labour = await tx.laborRate.findMany({ where: { tenantId: a.tenantId, isActive: true }, orderBy: [{ kind: 'asc' }, { label: 'asc' }] });
    const milestones = await tx.milestone.findMany({
      where: { tenantId: a.tenantId, projectId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, key: true, name: true, status: true, stage: { select: { stageKey: true } } },
    });
    return {
      estimate: book.estimate,
      materials: materials.map((m) => {
        const r = book.rateOf(m.id);
        return { materialId: m.id, name: m.name, unit: m.unit, rateSource: r?.source ?? null, ...(seesCost(a) ? { ratePaisa: r ? r.ratePaisa.toString() : null } : {}) };
      }),
      labour: labour.map((r) => ({ laborRateId: r.id, kind: r.kind, label: r.label, unit: r.unit.toLowerCase(), ...(seesCost(a) ? { ratePaisa: r.ratePaisa.toString() } : {}) })),
      milestones: milestones.map((m) => ({ id: m.id, key: m.key, name: m.name, stageKey: m.stage.stageKey, status: m.status })),
    };
  });
}

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateExtra {
  source: ChangeOrderSource;
  siteInstructionId?: string | null;
  snagId?: string | null;
  /** Lines the server made (snag amount) — no fields.rates check. */
  trustedLines?: LineInput[];
}

type CreateFields = Omit<CreateChangeOrderInput, 'title' | 'type'> & { title: string; type: CreateChangeOrderInput['type'] };

export async function createTx(tx: Tx, a: CoActor, project: Project, input: CreateFields, extra: CreateExtra = { source: 'MANUAL' }) {
  assertEditable(project, CO_PROJECT_STATUSES);
  if (input.markupPercent !== undefined && !input.markupPercent.eq(0)) assertPerm('fields.rates', a, 'Setting the markup needs the "See rates" permission');
  assertVerbalNote(input.proofType, input.proofNote);
  await assertProofFiles(tx, a.tenantId, input.proofAttachmentIds);
  await assertMilestones(tx, a.tenantId, project.id, input.affectedMilestoneIds);
  const markup = input.markupPercent ?? ZERO;
  const rows: LineRow[] = [
    ...(await buildLines(tx, a, project.id, input.lines ?? [], markup)),
    ...(extra.trustedLines?.length ? await buildLines(tx, a, project.id, extra.trustedLines, markup, { trusted: true }) : []),
  ];
  const totals = totalsOf(rows, input.type);
  const book = await tx.estimate.findFirst({ where: { tenantId: a.tenantId, projectId: project.id, status: 'APPROVED' }, select: { id: true } });
  await lockKey(tx, `change-order:${project.id}`);
  const last = await tx.changeOrder.findFirst({ where: { tenantId: a.tenantId, projectId: project.id }, orderBy: { number: 'desc' }, select: { number: true } });
  const co = await tx.changeOrder.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      number: (last?.number ?? 0) + 1,
      title: input.title,
      description: input.description ?? null,
      type: input.type,
      source: extra.source,
      siteInstructionId: extra.siteInstructionId ?? null,
      snagId: extra.snagId ?? null,
      estimateId: book?.id ?? null,
      markupPercent: markup,
      costPaisa: totals.costPaisa,
      totalPaisa: totals.totalPaisa,
      daysImpact: input.daysImpact ?? 0,
      affectedMilestoneIds: input.affectedMilestoneIds ?? [],
      proofType: input.proofType ?? null,
      proofNote: input.proofNote ?? null,
      proofAttachmentIds: input.proofAttachmentIds ?? [],
      createdById: a.userId,
    },
  });
  await writeLines(tx, a.tenantId, co.id, rows);
  await audit(tx, a, 'changeorder.create', 'ChangeOrder', co.id, {
    projectId: project.id,
    code: changeOrderCode(co.number),
    type: co.type,
    source: extra.source,
    lines: rows.length,
    costPaisa: totals.costPaisa.toString(),
    totalPaisa: totals.totalPaisa.toString(),
    daysImpact: co.daysImpact,
  });
  return detailDto(tx, a, await loadCo(tx, co.id), project);
}

export async function create(projectId: string, input: CreateChangeOrderInput) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'changeorder.create', projectId, a);
    return createTx(tx, a, project, input);
  });
}

// ─── Edit / delete ──────────────────────────────────────────────────────────

export async function update(id: string, input: UpdateChangeOrderInput) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, 'changeorder.edit');
    assertEditable(project, CO_PROJECT_STATUSES);
    if (co.status !== 'DRAFT') throw new Conflict('CHANGE_ORDER_LOCKED', 'Only a draft change order can be changed — reopen it first', { status: co.status });
    if (input.markupPercent !== undefined && !input.markupPercent.eq(co.markupPercent)) assertPerm('fields.rates', a, 'Setting the markup needs the "See rates" permission');
    const proofType = input.proofType !== undefined ? input.proofType : co.proofType;
    const proofNote = input.proofNote !== undefined ? input.proofNote : co.proofNote;
    assertVerbalNote(proofType, proofNote);
    await assertProofFiles(tx, a.tenantId, input.proofAttachmentIds);
    await assertMilestones(tx, a.tenantId, co.projectId, input.affectedMilestoneIds);
    const type = input.type ?? co.type;
    const markup = input.markupPercent ?? co.markupPercent;
    const linesChanged = input.lines !== undefined || !markup.eq(co.markupPercent) || type !== co.type;
    const rows = input.lines !== undefined ? await buildLines(tx, a, co.projectId, input.lines, markup) : repriceLines(co.lines, markup);
    const totals = totalsOf(rows, type);
    await tx.changeOrder.update({
      where: { id: co.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        type,
        markupPercent: markup,
        costPaisa: totals.costPaisa,
        totalPaisa: totals.totalPaisa,
        ...(input.daysImpact !== undefined ? { daysImpact: input.daysImpact } : {}),
        ...(input.affectedMilestoneIds !== undefined ? { affectedMilestoneIds: input.affectedMilestoneIds } : {}),
        proofType,
        proofNote,
        ...(input.proofAttachmentIds !== undefined ? { proofAttachmentIds: input.proofAttachmentIds } : {}),
      },
    });
    if (linesChanged) await writeLines(tx, a.tenantId, co.id, rows);
    await audit(tx, a, 'changeorder.update', 'ChangeOrder', co.id, {
      code: changeOrderCode(co.number),
      fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      before: { totalPaisa: co.totalPaisa.toString(), daysImpact: co.daysImpact, lines: co.lines.length },
      after: { totalPaisa: totals.totalPaisa.toString(), daysImpact: input.daysImpact ?? co.daysImpact, lines: rows.length },
    });
    return detailDto(tx, a, await loadCo(tx, co.id), project);
  });
}

export async function remove(id: string) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, 'changeorder.edit');
    assertEditable(project, CO_PROJECT_STATUSES);
    if (co.status !== 'DRAFT') throw new Conflict('CHANGE_ORDER_LOCKED', 'Only a draft change order can be deleted', { status: co.status });
    await tx.changeOrderLine.deleteMany({ where: { tenantId: a.tenantId, changeOrderId: co.id } });
    await tx.changeOrder.delete({ where: { id: co.id } });
    // The site instruction waits for the office again.
    if (co.siteInstructionId) await tx.siteInstruction.update({ where: { id: co.siteInstructionId }, data: { status: 'NEW', decidedAt: null, decidedById: null } });
    await audit(tx, a, 'changeorder.delete', 'ChangeOrder', co.id, { projectId: co.projectId, code: changeOrderCode(co.number), title: co.title, siteInstructionId: co.siteInstructionId, snagId: co.snagId });
    return { id: co.id, deleted: true as const };
  });
}

// ─── Status flow ────────────────────────────────────────────────────────────

async function transition(
  id: string,
  perm: string,
  allowed: ChangeOrderStatus[],
  action: string,
  change: (tx: Tx, a: CoActor, co: Awaited<ReturnType<typeof findCo>>['co'], project: Project) => Promise<{ data: Prisma.ChangeOrderUncheckedUpdateInput; details?: Record<string, unknown> }>,
) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, perm);
    assertEditable(project, CO_PROJECT_STATUSES);
    assertCoStatus(co, allowed);
    const { data, details } = await change(tx, a, co, project);
    const updated = await tx.changeOrder.update({ where: { id: co.id }, data });
    if (APPROVED_SET.includes(updated.status) !== APPROVED_SET.includes(co.status)) await syncScheduleDays(tx, a.tenantId, co.projectId);
    await audit(tx, a, action, 'ChangeOrder', co.id, { code: changeOrderCode(co.number), from: co.status, to: updated.status, ...(details ?? {}) } as Prisma.InputJsonValue);
    return detailDto(tx, a, await loadCo(tx, co.id), project);
  });
}

const notEmpty = (co: { daysImpact: number; lines: unknown[] }) => {
  if (!co.lines.length && co.daysImpact === 0) throw new BadRequest('EMPTY_CHANGE_ORDER', 'Add at least one line (or the days impact) first');
};

export const send = (id: string) =>
  transition(id, 'changeorder.edit', ['DRAFT'], 'changeorder.send', async (_tx, _a, co) => {
    notEmpty(co);
    return { data: { status: 'SENT', sentAt: new Date() } };
  });

export const approve = (id: string, input: ApproveInput) =>
  transition(id, 'changeorder.approve', ['DRAFT', 'SENT'], 'changeorder.approve', async (tx, a, co) => {
    notEmpty(co);
    const approvedOn = input.approvedOn ?? today();
    if (approvedOn > today()) throw new BadRequest('FUTURE_DATE', 'The approval date cannot be in the future');
    const proofType = input.proofType ?? co.proofType;
    const proofNote = input.proofNote ?? co.proofNote;
    const proofIds = input.proofAttachmentIds ?? co.proofAttachmentIds;
    if (!proofType) throw new BadRequest('PROOF_REQUIRED', 'How did the owner approve? Choose WhatsApp screenshot, signed slip or verbal');
    assertVerbalNote(proofType, proofNote);
    if (proofType !== 'VERBAL' && !proofIds.length) throw new BadRequest('PROOF_FILE_REQUIRED', 'Attach the WhatsApp screenshot / signed slip');
    await assertProofFiles(tx, a.tenantId, input.proofAttachmentIds);
    return {
      data: {
        status: 'APPROVED',
        approvedOn: dateOnly(approvedOn),
        approvedAt: new Date(),
        approvedById: a.userId,
        proofType,
        proofNote,
        proofAttachmentIds: proofIds,
        ...(input.billingMode ? { billingMode: input.billingMode } : {}),
        rejectedAt: null,
        rejectionReason: null,
      },
      details: { approvedOn, proofType, proofFiles: proofIds.length, totalPaisa: co.totalPaisa.toString(), daysImpact: co.daysImpact, billingMode: input.billingMode ?? co.billingMode },
    };
  });

export const reject = (id: string, input: RejectInput) =>
  transition(id, 'changeorder.approve', ['DRAFT', 'SENT'], 'changeorder.reject', async () => ({
    data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: input.reason },
    details: { reason: input.reason },
  }));

export const reopen = (id: string) =>
  transition(id, 'changeorder.edit', ['SENT', 'REJECTED'], 'changeorder.reopen', async () => ({ data: { status: 'DRAFT', rejectedAt: null, rejectionReason: null } }));

export const start = (id: string) => transition(id, 'changeorder.edit', ['APPROVED'], 'changeorder.start', async () => ({ data: { status: 'IN_PROGRESS', startedAt: new Date() } }));

export const complete = (id: string) =>
  transition(id, 'changeorder.edit', ['APPROVED', 'IN_PROGRESS'], 'changeorder.complete', async (_tx, _a, co) => ({
    data: { status: 'COMPLETED', completedAt: new Date(), ...(co.startedAt ? {} : { startedAt: new Date() }) },
  }));

/** For the convert flows: CO body → create fields (defaults filled). */
export function convertFields(input: ConvertInput, defaults: { title: string; description?: string | null }): CreateFields {
  return {
    ...input,
    title: input.title ?? defaults.title,
    type: input.type ?? 'ADDITION',
    ...(input.description ?? defaults.description ? { description: (input.description ?? defaults.description)! } : {}),
  };
}
