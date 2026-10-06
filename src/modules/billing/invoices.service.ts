/**
 * B2 — owner invoices. A DRAFT is built from its source (stage, running-bill progress,
 * owner-recoverable kharcha, retention, or manual lines); issuing numbers it, locks the
 * sources, applies any project credit and makes the PDF. Cancelling (no payments yet)
 * releases the sources again. Issued invoices never change otherwise.
 */
import { logger } from '../../config/logger.js';
import { nextNumber } from '../../core/db/counters.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta } from '../../core/http/pagination.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { invoiceHtml, rs } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { InvoiceLineSource, InvoiceStatus, Prisma as P } from '../../generated/prisma/client.js';
import type { CreateInvoiceInput, InvoicesQuery, ManualLine, UpdateInvoiceInput } from './billing.schema.js';
import {
  actor,
  addDays,
  assertOwner,
  audit,
  billingProject,
  billingSettings,
  daysBetween,
  NUMBER,
  paisa,
  percentOf,
  today,
  ymd,
  type BillingActor,
} from './billing.shared.js';
import { letterhead, salutation, shareOf, shortDay, storePdf, withinOrBackground } from './documents.js';
import { applyCredit, LIVE, recomputeInvoice, resolveBouncedFor, resolveEvent, syncStage } from './ledger.js';

const include = {
  project: { select: { id: true, code: true, name: true, siteAddress: true, status: true } },
  client: { select: { id: true, name: true, phone: true, address: true } },
  billingStage: { select: { id: true, label: true, percent: true, sortOrder: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
  allocations: { include: { payment: { select: { id: true, number: true, receivedOn: true, method: true, status: true, chequeNo: true } } }, orderBy: { createdAt: 'asc' } },
} as const;
type Row = P.InvoiceGetPayload<{ include: typeof include }>;

interface DraftLine {
  description: string;
  quantity?: Prisma.Decimal | null;
  unit?: string | null;
  ratePaisa?: bigint | null;
  amountPaisa: bigint;
  sourceType: InvoiceLineSource;
  sourceId?: string | null;
}

export function overdueOf(inv: { status: InvoiceStatus; dueDate: Date | null; balancePaisa: bigint }) {
  const due = ymd(inv.dueDate);
  const overdue = (inv.status === 'ISSUED' || inv.status === 'PARTLY_PAID') && !!due && due < today() && inv.balancePaisa > 0n;
  return { overdue, overdueDays: overdue ? daysBetween(due!, today()) : 0 };
}

export function invoiceDto(inv: Row) {
  return {
    id: inv.id,
    number: inv.number,
    type: inv.type,
    status: inv.status,
    project: { id: inv.project.id, code: inv.project.code, name: inv.project.name },
    client: inv.client,
    billingStage: inv.billingStage ? { id: inv.billingStage.id, label: inv.billingStage.label, percent: Number(inv.billingStage.percent) } : null,
    issueDate: ymd(inv.issueDate),
    dueDate: ymd(inv.dueDate),
    ...overdueOf(inv),
    subtotalPaisa: inv.subtotalPaisa.toString(),
    taxPaisa: inv.taxPaisa.toString(),
    taxLabel: inv.taxLabel,
    taxRatePercent: inv.taxRatePercent === null ? null : Number(inv.taxRatePercent),
    totalPaisa: inv.totalPaisa.toString(),
    paidPaisa: inv.paidPaisa.toString(),
    pendingPaisa: inv.pendingPaisa.toString(),
    balancePaisa: inv.balancePaisa.toString(),
    notes: inv.notes,
    forceNote: inv.forceNote,
    cancelReason: inv.cancelReason,
    cancelledAt: inv.cancelledAt?.toISOString() ?? null,
    pdfAttachmentId: inv.pdfAttachmentId,
    lines: inv.lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity === null ? null : Number(l.quantity.toFixed(3)),
      unit: l.unit,
      ratePaisa: paisa(l.ratePaisa),
      amountPaisa: l.amountPaisa.toString(),
      sourceType: l.sourceType,
      sourceId: l.sourceId,
    })),
    allocations: inv.allocations.map((al) => ({
      id: al.id,
      amountPaisa: al.amountPaisa.toString(),
      counts: al.payment.status !== 'BOUNCED',
      payment: { id: al.payment.id, number: al.payment.number, receivedOn: ymd(al.payment.receivedOn), method: al.payment.method, status: al.payment.status, chequeNo: al.payment.chequeNo },
    })),
    createdAt: inv.createdAt.toISOString(),
    issuedAt: inv.issuedAt?.toISOString() ?? null,
  };
}

const load = (tx: Tx, id: string) => tx.invoice.findUniqueOrThrow({ where: { id }, include });

async function find(tx: Tx, a: BillingActor, id: string) {
  const inv = await tx.invoice.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!inv) throw new NotFound('INVOICE_NOT_FOUND', 'Invoice not found');
  await billingProject(tx, a, inv.projectId).catch(() => {
    throw new NotFound('INVOICE_NOT_FOUND', 'Invoice not found');
  });
  return inv;
}

// ─── Sources ────────────────────────────────────────────────────────────────

/** Sources already on another invoice that is not cancelled (drafts included). */
async function takenSources(tx: Tx, tenantId: string, type: InvoiceLineSource, ids: string[], exceptInvoiceId?: string) {
  if (!ids.length) return [];
  const lines = await tx.invoiceLine.findMany({
    where: { tenantId, sourceType: type, sourceId: { in: ids }, invoice: { status: { not: 'CANCELLED' }, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) } },
    select: { sourceId: true, invoice: { select: { id: true, number: true, status: true } } },
  });
  return lines.map((l) => ({ sourceId: l.sourceId!, invoice: l.invoice }));
}

async function recoverableLines(tx: Tx, a: BillingActor, projectId: string, ids: string[]): Promise<DraftLine[]> {
  const entries = await tx.cashEntry.findMany({ where: { tenantId: a.tenantId, id: { in: ids } } });
  const bad = ids.filter((id) => {
    const e = entries.find((x) => x.id === id);
    return !e || e.projectId !== projectId || e.type !== 'EXPENSE' || e.costBucket !== 'RECOVERABLE_FROM_OWNER' || e.status === 'REJECTED' || e.billedInvoiceId !== null;
  });
  if (bad.length) throw new BadRequest('INVALID_RECOVERABLE', 'Some items are not unbilled owner purchases on this project', { cashEntryIds: bad });
  const taken = await takenSources(tx, a.tenantId, 'CASH_ENTRY', ids);
  if (taken.length) throw new Conflict('SOURCE_ALREADY_BILLED', 'Some items are already on another invoice', { taken });
  return entries.map((e) => ({ description: `${e.description} (${ymd(e.occurredAt)})`, amountPaisa: -e.amountPaisa, sourceType: 'CASH_ENTRY', sourceId: e.id }));
}

function manualLines(lines: ManualLine[]): DraftLine[] {
  return lines.map((l, i) => {
    const amount = l.amountPaisa ?? (l.quantity !== undefined && l.ratePaisa !== undefined ? BigInt(l.quantity.mul(l.ratePaisa.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)) : undefined);
    if (amount === undefined) throw new BadRequest('LINE_AMOUNT_REQUIRED', `Line ${i + 1}: enter an amount (or quantity and rate)`, { line: i });
    return { description: l.description, quantity: l.quantity ?? null, unit: l.unit ?? null, ratePaisa: l.ratePaisa ?? null, amountPaisa: amount, sourceType: 'MANUAL' as const };
  });
}

async function buildLines(tx: Tx, a: BillingActor, project: { id: string; status: string; billingModel: string | null; ratePerSqftPaisa: bigint | null }, input: CreateInvoiceInput) {
  let stageId: string | null = null;
  let forceNote: string | null = null;
  let lines: DraftLine[] = [];
  switch (input.type) {
    case 'STAGE': {
      const stage = await tx.projectBillingStage.findFirst({ where: { tenantId: a.tenantId, id: input.billingStageId!, projectId: project.id } });
      if (!stage) throw new NotFound('STAGE_NOT_FOUND', 'Stage not found');
      if (stage.isRetention) throw new BadRequest('USE_RETENTION_INVOICE', 'Bill the retention with a RETENTION invoice');
      if (stage.status !== 'READY' && !(stage.status === 'UPCOMING' && input.force)) {
        throw new Conflict(stage.status === 'UPCOMING' ? 'STAGE_NOT_READY' : 'STAGE_ALREADY_INVOICED', stage.status === 'UPCOMING' ? 'Mark the stage ready first (or force with a note)' : 'This stage is already invoiced', {
          status: stage.status,
        });
      }
      if ((await takenSources(tx, a.tenantId, 'BILLING_STAGE', [stage.id])).length) throw new Conflict('STAGE_ALREADY_INVOICED', 'This stage is already on an invoice');
      stageId = stage.id;
      forceNote = stage.status === 'UPCOMING' ? (input.forceNote ?? null) : null;
      lines = [{ description: `${stage.label} (${Number(stage.percent)}% of contract)`, amountPaisa: stage.amountPaisa, sourceType: 'BILLING_STAGE', sourceId: stage.id }];
      if (input.extraCashEntryIds?.length) lines.push(...(await recoverableLines(tx, a, project.id, input.extraCashEntryIds)));
      break;
    }
    case 'RUNNING_BILL': {
      if (project.billingModel !== 'RUNNING_BILLS') throw new BadRequest('NOT_RUNNING_BILLS', 'This project is billed by stages, not running bills');
      if (!project.ratePerSqftPaisa) throw new BadRequest('RATE_REQUIRED', 'Set the labour rate per sq ft in the contract first');
      const rows = await tx.billingProgress.findMany({
        where: { tenantId: a.tenantId, projectId: project.id, billedInvoiceId: null, date: { gte: dateOnly(input.from!), lte: dateOnly(input.to!) } },
        orderBy: { date: 'asc' },
      });
      const taken = new Set(
        (
          await takenSources(
            tx,
            a.tenantId,
            'BILLING_PROGRESS',
            rows.map((r) => r.id),
          )
        ).map((t) => t.sourceId),
      );
      const free = rows.filter((r) => !taken.has(r.id));
      if (!free.length) throw new BadRequest('NOTHING_TO_BILL', 'No unbilled progress in this period');
      const rate = project.ratePerSqftPaisa;
      lines = free.map((r) => ({
        description: `${ymd(r.date)} — ${r.description}`,
        quantity: r.quantity,
        unit: 'sqft',
        ratePaisa: rate,
        amountPaisa: BigInt(r.quantity.mul(rate.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)),
        sourceType: 'BILLING_PROGRESS',
        sourceId: r.id,
      }));
      const retention = await tx.projectBillingStage.findFirst({ where: { tenantId: a.tenantId, projectId: project.id, isRetention: true } });
      if (retention && Number(retention.percent) > 0) {
        const gross = lines.reduce((s, l) => s + l.amountPaisa, 0n);
        lines.push({ description: `Less retention held (${Number(retention.percent)}%)`, amountPaisa: -percentOf(gross, retention.percent), sourceType: 'RETENTION', sourceId: retention.id });
      }
      break;
    }
    case 'RECOVERABLE':
      lines = await recoverableLines(tx, a, project.id, input.cashEntryIds!);
      break;
    case 'RETENTION': {
      if (project.status !== 'HANDED_OVER' && project.status !== 'CLOSEOUT') throw new Conflict('RETENTION_NOT_DUE', 'Retention is billed after handover (closeout / handed over)');
      const stage = await tx.projectBillingStage.findFirst({ where: { tenantId: a.tenantId, projectId: project.id, isRetention: true } });
      if (!stage) throw new BadRequest('NO_RETENTION_STAGE', 'This project has no retention stage');
      if ((await takenSources(tx, a.tenantId, 'BILLING_STAGE', [stage.id])).length) throw new Conflict('STAGE_ALREADY_INVOICED', 'The retention is already on an invoice');
      // Running bills hold retention line by line; otherwise it is the stage amount.
      const held = await tx.invoiceLine.aggregate({ where: { tenantId: a.tenantId, sourceType: 'RETENTION', sourceId: stage.id, invoice: { status: { in: LIVE } } }, _sum: { amountPaisa: true } });
      const amount = held._sum.amountPaisa ? -held._sum.amountPaisa : stage.amountPaisa;
      if (amount <= 0n) throw new BadRequest('NOTHING_TO_BILL', 'No retention is held on this project');
      stageId = stage.id;
      lines = [{ description: `${stage.label} — release`, amountPaisa: amount, sourceType: 'BILLING_STAGE', sourceId: stage.id }];
      break;
    }
    case 'OTHER':
      assertOwner(a, 'Only the owner can make a manual invoice');
      lines = manualLines(input.lines!);
      break;
  }
  return { stageId, forceNote, lines };
}

async function writeTotals(tx: Tx, a: BillingActor, invoiceId: string) {
  const s = await billingSettings(tx, a.tenantId);
  const lines = await tx.invoiceLine.findMany({ where: { tenantId: a.tenantId, invoiceId } });
  const subtotal = lines.reduce((sum, l) => sum + l.amountPaisa, 0n);
  const taxOn = s.taxEnabled && s.taxRatePercent.gt(0) && subtotal > 0n;
  const tax = taxOn ? percentOf(subtotal, s.taxRatePercent) : 0n;
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { subtotalPaisa: subtotal, taxPaisa: tax, taxLabel: taxOn ? (s.taxLabel ?? 'Sales tax') : null, taxRatePercent: taxOn ? s.taxRatePercent : null, totalPaisa: subtotal + tax, balancePaisa: subtotal + tax },
  });
}

async function writeLines(tx: Tx, tenantId: string, invoiceId: string, lines: DraftLine[]) {
  await tx.invoiceLine.createMany({
    data: lines.map((l, i) => ({
      tenantId,
      invoiceId,
      sortOrder: i + 1,
      description: l.description,
      quantity: l.quantity ?? null,
      unit: l.unit ?? null,
      ratePaisa: l.ratePaisa ?? null,
      amountPaisa: l.amountPaisa,
      sourceType: l.sourceType,
      sourceId: l.sourceId ?? null,
    })),
  });
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export async function createInvoiceTx(tx: Tx, a: BillingActor, projectId: string, input: CreateInvoiceInput, opts: { at?: Date } = {}) {
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Invoices are made by the office');
  const project = await billingProject(tx, a, projectId);
  if (project.status === 'DRAFT') throw new Conflict('PROJECT_IS_DRAFT', 'Activate the project first');
  const { stageId, forceNote, lines } = await buildLines(tx, a, project, input);
  const inv = await tx.invoice.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      clientId: project.clientId,
      type: input.type,
      billingStageId: stageId,
      notes: input.notes ?? null,
      forceNote,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await writeLines(tx, a.tenantId, inv.id, lines);
  await writeTotals(tx, a, inv.id);
  await audit(tx, a, 'invoice.create', 'Invoice', inv.id, { type: input.type, lines: lines.length });
  return invoiceDto(await load(tx, inv.id));
}

export async function createInvoice(projectId: string, input: CreateInvoiceInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createInvoiceTx(tx, a, projectId, input));
}

async function findDraft(tx: Tx, a: BillingActor, id: string) {
  const inv = await find(tx, a, id);
  if (inv.status !== 'DRAFT') throw new Conflict('INVOICE_LOCKED', 'An issued invoice cannot be changed — cancel it instead', { status: inv.status });
  if (a.role === 'PM' && inv.createdById !== a.userId) throw new Forbidden('FORBIDDEN', "Only the owner can change someone else's draft");
  return inv;
}

export async function updateInvoice(id: string, input: UpdateInvoiceInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const inv = await findDraft(tx, a, id);
    if (input.lines) {
      if (inv.type !== 'OTHER') throw new BadRequest('LINES_LOCKED', 'Only a manual (OTHER) invoice has editable lines');
      assertOwner(a, 'Only the owner can change manual lines');
      await tx.invoiceLine.deleteMany({ where: { tenantId: a.tenantId, invoiceId: inv.id } });
      await writeLines(tx, a.tenantId, inv.id, manualLines(input.lines));
      await writeTotals(tx, a, inv.id);
    }
    await tx.invoice.update({
      where: { id: inv.id },
      data: { ...(input.notes !== undefined ? { notes: input.notes } : {}), ...(input.dueDate ? { dueDate: dateOnly(input.dueDate) } : {}) },
    });
    await audit(tx, a, 'invoice.update', 'Invoice', inv.id, { fields: Object.keys(input) });
    return invoiceDto(await load(tx, inv.id));
  });
}

export async function deleteInvoice(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const inv = await findDraft(tx, a, id);
    await tx.invoiceLine.deleteMany({ where: { tenantId: a.tenantId, invoiceId: inv.id } });
    await tx.invoice.delete({ where: { id: inv.id } });
    await audit(tx, a, 'invoice.delete_draft', 'Invoice', inv.id, { type: inv.type });
    return { deleted: true };
  });
}

export async function issueTx(tx: Tx, a: BillingActor, id: string, input: { issueDate?: string | undefined }, opts: { at?: Date } = {}) {
  assertOwner(a, 'Only the owner issues invoices');
  const inv = await find(tx, a, id);
  if (inv.status !== 'DRAFT') throw new Conflict('INVOICE_NOT_DRAFT', 'This invoice is already issued', { status: inv.status });
  if (inv.totalPaisa <= 0n) throw new BadRequest('EMPTY_INVOICE', 'The invoice total must be more than zero');
  const issueDate = input.issueDate ?? today();
  if (issueDate > today()) throw new BadRequest('FUTURE_DATE', "An invoice can't be issued in the future");

  // Sources must still be free (another invoice may have taken them since the draft).
  for (const type of ['BILLING_STAGE', 'BILLING_PROGRESS', 'CASH_ENTRY'] as const) {
    const ids = inv.lines.filter((l) => l.sourceType === type).map((l) => l.sourceId!);
    const taken = (await takenSources(tx, a.tenantId, type, ids, inv.id)).filter((t) => t.invoice.status !== 'DRAFT');
    if (taken.length) throw new Conflict('SOURCE_ALREADY_BILLED', 'Part of this invoice is already billed on another invoice', { taken });
  }
  await writeTotals(tx, a, inv.id);
  const s = await billingSettings(tx, a.tenantId);
  const number = await nextNumber(tx, a.tenantId, NUMBER.invoice, dateOnly(issueDate));
  const dueDate = ymd(inv.dueDate) ?? addDays(issueDate, s.paymentTermsDays);
  const at = opts.at ?? new Date();
  await tx.invoice.update({ where: { id: inv.id }, data: { number, status: 'ISSUED', issueDate: dateOnly(issueDate), dueDate: dateOnly(dueDate), issuedById: a.userId, issuedAt: at } });
  const progressIds = inv.lines.filter((l) => l.sourceType === 'BILLING_PROGRESS').map((l) => l.sourceId!);
  if (progressIds.length) await tx.billingProgress.updateMany({ where: { tenantId: a.tenantId, id: { in: progressIds } }, data: { billedInvoiceId: inv.id } });
  const cashIds = inv.lines.filter((l) => l.sourceType === 'CASH_ENTRY').map((l) => l.sourceId!);
  if (cashIds.length) await tx.cashEntry.updateMany({ where: { tenantId: a.tenantId, id: { in: cashIds } }, data: { billedInvoiceId: inv.id } });
  await recomputeInvoice(tx, a.tenantId, inv.id);
  if (inv.billingStageId) {
    await syncStage(tx, a.tenantId, inv.billingStageId);
    await resolveEvent(tx, a.tenantId, 'STAGE_READY_UNBILLED', inv.billingStageId);
  }
  const credit = await applyCredit(tx, a.tenantId, inv.id);
  await audit(tx, a, 'invoice.issue', 'Invoice', inv.id, { number, totalPaisa: inv.totalPaisa.toString(), creditAppliedPaisa: credit.toString() });
  return invoiceDto(await load(tx, inv.id));
}

/** Issues, then makes the PDF outside the transaction (a PDF failure never undoes the issue). */
export async function issue(id: string, input: { issueDate?: string | undefined }) {
  const a = actor();
  await withTenant(a.tenantId, (tx) => issueTx(tx, a, id, input));
  await withinOrBackground(
    () => withTenant(a.tenantId, (tx) => makeInvoicePdf(tx, a, id)),
    (err) => logger.warn({ err, invoiceId: id }, 'invoice PDF not made on issue — it is made on first download'),
  );
  return withTenant(a.tenantId, async (tx) => invoiceDto(await load(tx, id)));
}

export async function cancelTx(tx: Tx, a: BillingActor, id: string, reason: string, opts: { at?: Date } = {}) {
  assertOwner(a, 'Only the owner cancels invoices');
  const inv = await find(tx, a, id);
  if (inv.status === 'DRAFT') throw new Conflict('INVOICE_NOT_ISSUED', 'Delete a draft instead of cancelling it');
  if (inv.status === 'CANCELLED') throw new Conflict('INVOICE_CANCELLED', 'This invoice is already cancelled');
  const live = inv.allocations.filter((al) => al.payment.status !== 'BOUNCED');
  if (live.length) throw new Conflict('INVOICE_HAS_PAYMENTS', 'Payments are recorded against this invoice — it cannot be cancelled', { payments: live.map((al) => al.payment.number) });
  await tx.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: opts.at ?? new Date(), cancelledById: a.userId, balancePaisa: 0n } });
  await tx.billingProgress.updateMany({ where: { tenantId: a.tenantId, billedInvoiceId: inv.id }, data: { billedInvoiceId: null } });
  await tx.cashEntry.updateMany({ where: { tenantId: a.tenantId, billedInvoiceId: inv.id }, data: { billedInvoiceId: null } });
  if (inv.billingStageId) await syncStage(tx, a.tenantId, inv.billingStageId);
  await resolveEvent(tx, a.tenantId, 'INVOICE_OVERDUE', inv.id);
  await resolveBouncedFor(tx, a.tenantId, inv.id);
  await audit(tx, a, 'invoice.cancel', 'Invoice', inv.id, { number: inv.number, reason });
  return invoiceDto(await load(tx, inv.id));
}

export async function cancel(id: string, reason: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => cancelTx(tx, a, id, reason));
}

export async function listInvoices(projectId: string, query: InvoicesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await billingProject(tx, a, projectId);
    const where: P.InvoiceWhereInput = {
      tenantId: a.tenantId,
      projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to ? { issueDate: { ...(query.from ? { gte: dateOnly(query.from) } : {}), ...(query.to ? { lte: dateOnly(query.to) } : {}) } } : {}),
    };
    const rows = await tx.invoice.findMany({ where, include, orderBy: [{ issueDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], skip: (query.page - 1) * query.limit, take: query.limit });
    const total = await tx.invoice.count({ where });
    const sums = await tx.invoice.aggregate({ where: { ...where, status: { in: LIVE } }, _sum: { totalPaisa: true, paidPaisa: true, balancePaisa: true } });
    return {
      data: rows.map(invoiceDto),
      meta: {
        ...pageMeta(query, total),
        invoicedPaisa: (sums._sum.totalPaisa ?? 0n).toString(),
        paidPaisa: (sums._sum.paidPaisa ?? 0n).toString(),
        balancePaisa: (sums._sum.balancePaisa ?? 0n).toString(),
      },
    };
  });
}

export async function getInvoice(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => invoiceDto(await find(tx, a, id)));
}

// ─── PDF ────────────────────────────────────────────────────────────────────

export async function makeInvoicePdf(tx: Tx, a: BillingActor, id: string) {
  const inv = await load(tx, id);
  const html = invoiceHtml({
    company: await letterhead(tx, a.tenantId),
    number: inv.number!,
    issueDate: ymd(inv.issueDate)!,
    dueDate: ymd(inv.dueDate),
    client: inv.client,
    project: inv.project,
    lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity === null ? null : l.quantity.toFixed(2).replace(/\.00$/, ''), unit: l.unit, ratePaisa: l.ratePaisa, amountPaisa: l.amountPaisa })),
    subtotalPaisa: inv.subtotalPaisa,
    taxPaisa: inv.taxPaisa,
    taxLabel: inv.taxLabel,
    taxRatePercent: inv.taxRatePercent?.toString() ?? null,
    totalPaisa: inv.totalPaisa,
    paidPaisa: inv.paidPaisa,
    balancePaisa: inv.balancePaisa,
    notes: inv.notes,
  });
  const attachmentId = await storePdf(tx, a.tenantId, a.userId, 'INVOICE_PDF', `${inv.number}.pdf`, html, `${inv.number} · ${inv.project.name}`);
  await tx.invoice.update({ where: { id }, data: { pdfAttachmentId: attachmentId } });
  return attachmentId;
}

export const invoiceWhatsapp = (inv: { number: string | null; totalPaisa: bigint; dueDate: Date | null; project: { name: string }; client: { name: string } | null }) => (url: string) =>
  `${salutation(inv.client?.name)}, ${inv.project.name} ka invoice ${inv.number} (${rs(inv.totalPaisa)}), due ${shortDay(ymd(inv.dueDate))}. Link: ${url}`;

export async function invoicePdf(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const inv = await find(tx, a, id);
    if (inv.status === 'DRAFT') throw new Conflict('INVOICE_NOT_ISSUED', 'Issue the invoice to get its PDF');
    let attachmentId = inv.pdfAttachmentId;
    let share = attachmentId ? await shareOf(tx, a.tenantId, attachmentId, invoiceWhatsapp(inv)) : null;
    if (!share) {
      attachmentId = await makeInvoicePdf(tx, a, inv.id);
      share = await shareOf(tx, a.tenantId, attachmentId, invoiceWhatsapp(inv));
    }
    return { ...share!, clientPhone: inv.client?.phone ?? null };
  });
}
