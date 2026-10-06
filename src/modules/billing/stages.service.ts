/** B1 — payment-schedule stages (mark ready, expected date) and running-bill progress. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { ProjectBillingStage } from '../../generated/prisma/client.js';
import type { MarkReadyInput, ProgressInput, UpdateProgressInput, UpdateStageInput } from './billing.schema.js';
import { actor, assertOwner, audit, billingProject, daysBetween, paisa, today, ymd, type BillingActor } from './billing.shared.js';
import { recordEvent } from './ledger.js';

const num = (d: { toFixed: (n: number) => string } | null) => (d === null ? null : Number(d.toFixed(3)));

async function stageInvoices(tx: Tx, tenantId: string, stageIds: string[]) {
  const invoices = await tx.invoice.findMany({ where: { tenantId, billingStageId: { in: stageIds }, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' } });
  return new Map(stageIds.map((id) => [id, invoices.find((i) => i.billingStageId === id) ?? null]));
}

export function stageDto(s: ProjectBillingStage, inv: { id: string; number: string | null; status: string; dueDate: Date | null; balancePaisa: bigint; totalPaisa: bigint } | null) {
  return {
    id: s.id,
    sortOrder: s.sortOrder,
    label: s.label,
    percent: Number(s.percent),
    isRetention: s.isRetention,
    amountPaisa: s.amountPaisa.toString(),
    status: s.status,
    expectedDate: ymd(s.expectedDate),
    readyAt: s.readyAt?.toISOString() ?? null,
    readyById: s.readyById,
    readyNote: s.readyNote,
    proofAttachmentIds: s.proofAttachmentIds,
    invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, dueDate: ymd(inv.dueDate), totalPaisa: inv.totalPaisa.toString(), balancePaisa: inv.balancePaisa.toString() } : null,
  };
}

export async function listStages(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await billingProject(tx, a, projectId);
    const stages = await tx.projectBillingStage.findMany({ where: { tenantId: a.tenantId, projectId: project.id }, orderBy: { sortOrder: 'asc' } });
    const invs = await stageInvoices(
      tx,
      a.tenantId,
      stages.map((s) => s.id),
    );
    return stages.map((s) => stageDto(s, invs.get(s.id) ?? null));
  });
}

async function findStage(tx: Tx, a: BillingActor, id: string) {
  const s = await tx.projectBillingStage.findFirst({ where: { tenantId: a.tenantId, id } });
  if (!s) throw new NotFound('STAGE_NOT_FOUND', 'Stage not found');
  const project = await billingProject(tx, a, s.projectId).catch(() => {
    throw new NotFound('STAGE_NOT_FOUND', 'Stage not found');
  });
  return { stage: s, project };
}

/** Earlier stages whose invoice is past due and not fully paid. */
async function unpaidEarlier(tx: Tx, tenantId: string, stage: ProjectBillingStage) {
  const earlier = await tx.projectBillingStage.findMany({ where: { tenantId, projectId: stage.projectId, sortOrder: { lt: stage.sortOrder } }, select: { id: true, label: true } });
  const invs = await tx.invoice.findMany({
    where: { tenantId, billingStageId: { in: earlier.map((e) => e.id) }, status: { in: ['ISSUED', 'PARTLY_PAID'] }, dueDate: { lt: dateOnly(today()) } },
  });
  return invs.map((i) => ({
    stageId: i.billingStageId,
    label: earlier.find((e) => e.id === i.billingStageId)?.label ?? '',
    invoiceId: i.id,
    invoiceNumber: i.number,
    dueDate: ymd(i.dueDate),
    balancePaisa: i.balancePaisa.toString(),
    overdueDays: daysBetween(ymd(i.dueDate)!, today()),
  }));
}

export async function markReadyTx(tx: Tx, a: BillingActor, id: string, input: MarkReadyInput, opts: { at?: Date } = {}) {
  const { stage, project } = await findStage(tx, a, id);
  if (project.status === 'DRAFT') throw new Conflict('PROJECT_IS_DRAFT', 'Activate the project first');
  if (stage.status !== 'UPCOMING' && stage.status !== 'READY') {
    throw new Conflict('STAGE_ALREADY_INVOICED', `This stage is already ${stage.status.toLowerCase().replace('_', ' ')}`, { status: stage.status });
  }
  const found = await tx.attachment.count({ where: { tenantId: a.tenantId, id: { in: input.proofAttachmentIds } } });
  if (found !== new Set(input.proofAttachmentIds).size) throw new BadRequest('INVALID_ATTACHMENT', 'A photo was not found — upload it again');
  const at = opts.at ?? new Date();
  const updated = await tx.projectBillingStage.update({
    where: { id: stage.id },
    data: { status: 'READY', readyAt: at, readyById: a.userId, readyNote: input.note ?? null, proofAttachmentIds: input.proofAttachmentIds },
  });
  await recordEvent(tx, { tenantId: a.tenantId, projectId: project.id, type: 'STAGE_READY_UNBILLED', refType: 'STAGE', refId: stage.id, details: { label: stage.label, amountPaisa: stage.amountPaisa.toString() }, occurredAt: at });
  const unpaid = await unpaidEarlier(tx, a.tenantId, stage);
  if (unpaid.length) {
    await recordEvent(tx, { tenantId: a.tenantId, projectId: project.id, type: 'PREVIOUS_STAGE_UNPAID', refType: 'STAGE', refId: stage.id, details: { stages: unpaid }, occurredAt: at });
  }
  await audit(tx, a, 'billing.stage_ready', 'ProjectBillingStage', stage.id, { label: stage.label, proofs: input.proofAttachmentIds.length });
  return {
    stage: stageDto(updated, null),
    warning: unpaid.length
      ? { code: 'PREVIOUS_STAGE_UNPAID', message: `${unpaid.length === 1 ? 'An earlier stage is' : 'Earlier stages are'} still unpaid past the due date`, details: { stages: unpaid } }
      : null,
  };
}

export async function markReady(id: string, input: MarkReadyInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => markReadyTx(tx, a, id, input));
}

export async function updateStage(id: string, input: UpdateStageInput) {
  const a = actor();
  assertOwner(a, 'Only the owner can change the schedule');
  return withTenant(a.tenantId, async (tx) => {
    const { stage } = await findStage(tx, a, id);
    const updated = await tx.projectBillingStage.update({ where: { id: stage.id }, data: { expectedDate: input.expectedDate ? dateOnly(input.expectedDate) : null } });
    await audit(tx, a, 'billing.stage_update', 'ProjectBillingStage', stage.id, { expectedDate: input.expectedDate });
    const inv = (await stageInvoices(tx, a.tenantId, [stage.id])).get(stage.id) ?? null;
    return stageDto(updated, inv);
  });
}

// ─── Running-bill progress ──────────────────────────────────────────────────

type ProgressRow = Awaited<ReturnType<Tx['billingProgress']['findFirstOrThrow']>>;

function progressDto(p: ProgressRow, ratePaisa: bigint | null, onDraft: string | null) {
  return {
    id: p.id,
    projectId: p.projectId,
    date: formatDateOnly(p.date),
    quantity: num(p.quantity)!,
    unit: 'sqft',
    description: p.description,
    attachmentIds: p.attachmentIds,
    valuePaisa: ratePaisa === null ? null : BigInt(p.quantity.mul(ratePaisa.toString()).toDecimalPlaces(0).toFixed(0)).toString(),
    billedInvoiceId: p.billedInvoiceId,
    draftInvoiceId: onDraft,
    billed: p.billedInvoiceId !== null,
    createdAt: p.createdAt.toISOString(),
  };
}

async function runningProject(tx: Tx, a: BillingActor, projectId: string) {
  const project = await billingProject(tx, a, projectId);
  if (project.billingModel !== 'RUNNING_BILLS') throw new BadRequest('NOT_RUNNING_BILLS', 'This project is billed by stages, not running bills');
  return project;
}

/** Progress rows put on a draft (not yet issued) invoice. */
async function draftLinks(tx: Tx, tenantId: string, ids: string[]) {
  const lines = await tx.invoiceLine.findMany({
    where: { tenantId, sourceType: 'BILLING_PROGRESS', sourceId: { in: ids }, invoice: { status: 'DRAFT' } },
    select: { sourceId: true, invoiceId: true },
  });
  return new Map(lines.map((l) => [l.sourceId!, l.invoiceId]));
}

export async function listProgress(projectId: string, query: { billed?: boolean }) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await runningProject(tx, a, projectId);
    const rows = await tx.billingProgress.findMany({
      where: { tenantId: a.tenantId, projectId: project.id, ...(query.billed === undefined ? {} : query.billed ? { billedInvoiceId: { not: null } } : { billedInvoiceId: null }) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    const drafts = await draftLinks(
      tx,
      a.tenantId,
      rows.map((r) => r.id),
    );
    const items = rows.map((r) => progressDto(r, project.ratePerSqftPaisa, drafts.get(r.id) ?? null));
    const unbilled = items.filter((i) => !i.billed);
    return {
      items,
      ratePerSqftPaisa: paisa(project.ratePerSqftPaisa),
      unbilledQuantity: unbilled.reduce((s, i) => s + i.quantity, 0),
      unbilledValuePaisa: unbilled.reduce((s, i) => s + BigInt(i.valuePaisa ?? '0'), 0n).toString(),
    };
  });
}

export async function addProgressTx(tx: Tx, a: BillingActor, projectId: string, input: ProgressInput, opts: { at?: Date } = {}) {
  const project = await runningProject(tx, a, projectId);
  if (input.date > today()) throw new BadRequest('FUTURE_DATE', "Progress can't be dated in the future");
  const row = await tx.billingProgress.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      date: dateOnly(input.date),
      quantity: input.quantity,
      description: input.description,
      attachmentIds: input.attachmentIds ?? [],
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await audit(tx, a, 'billing.progress_add', 'BillingProgress', row.id, { date: input.date, quantity: Number(input.quantity) });
  return progressDto(row, project.ratePerSqftPaisa, null);
}

export async function addProgress(projectId: string, input: ProgressInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => addProgressTx(tx, a, projectId, input));
}

async function editableProgress(tx: Tx, a: BillingActor, id: string) {
  const row = await tx.billingProgress.findFirst({ where: { tenantId: a.tenantId, id } });
  if (!row) throw new NotFound('PROGRESS_NOT_FOUND', 'Progress entry not found');
  const project = await runningProject(tx, a, row.projectId).catch((e: unknown) => {
    throw e instanceof NotFound ? new NotFound('PROGRESS_NOT_FOUND', 'Progress entry not found') : e;
  });
  if (row.billedInvoiceId) throw new Conflict('PROGRESS_BILLED', 'This progress is already billed — it can no longer change', { invoiceId: row.billedInvoiceId });
  const draft = (await draftLinks(tx, a.tenantId, [row.id])).get(row.id);
  if (draft) throw new Conflict('PROGRESS_ON_DRAFT', 'This progress is on a draft invoice — delete the draft first', { invoiceId: draft });
  return { row, project };
}

export async function updateProgress(id: string, input: UpdateProgressInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { row, project } = await editableProgress(tx, a, id);
    if (input.date && input.date > today()) throw new BadRequest('FUTURE_DATE', "Progress can't be dated in the future");
    const updated = await tx.billingProgress.update({
      where: { id: row.id },
      data: {
        ...(input.date ? { date: dateOnly(input.date) } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
      },
    });
    await audit(tx, a, 'billing.progress_update', 'BillingProgress', row.id, { before: { quantity: num(row.quantity), date: formatDateOnly(row.date) }, after: { quantity: num(updated.quantity), date: formatDateOnly(updated.date) } });
    return progressDto(updated, project.ratePerSqftPaisa, null);
  });
}

export async function deleteProgress(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { row } = await editableProgress(tx, a, id);
    await tx.billingProgress.delete({ where: { id: row.id } });
    await audit(tx, a, 'billing.progress_delete', 'BillingProgress', row.id, { quantity: num(row.quantity), date: formatDateOnly(row.date) });
    return { deleted: true };
  });
}

