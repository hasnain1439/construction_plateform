/**
 * B3 — money received from the owner. A payment is allocated to invoices (given, or the
 * oldest due first); what is left stays as project credit and settles the next invoice.
 * Cheques start PENDING (counted as pending, not paid); CLEARED moves them to paid,
 * BOUNCED makes their allocations stop counting. Payments are never edited or deleted.
 */
import { logger } from '../../config/logger.js';
import { nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta } from '../../core/http/pagination.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { receiptHtml, rs } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma as P } from '../../generated/prisma/client.js';
import { smsProvider } from '../auth/sms.provider.js';
import type { ChequeStatusInput, PaymentInput, PaymentsQuery } from './billing.schema.js';
import { actor, assertOwner, audit, billingProject, billingSettings, NUMBER, today, ymd, type BillingActor } from './billing.shared.js';
import { letterhead, salutation, shareOf, storePdf, withinOrBackground } from './documents.js';
import { openAmount, openInvoices, recomputeInvoice, recordEvent } from './ledger.js';

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
  RAAST: 'Raast',
};

const include = {
  project: { select: { id: true, code: true, name: true } },
  client: { select: { id: true, name: true, phone: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, type: true, status: true } } }, orderBy: { createdAt: 'asc' } },
} as const;
type Row = P.ClientPaymentGetPayload<{ include: typeof include }>;

export function paymentDto(p: Row) {
  const allocated = p.allocations.reduce((s, al) => s + al.amountPaisa, 0n);
  return {
    id: p.id,
    number: p.number,
    project: p.project,
    client: p.client ? { id: p.client.id, name: p.client.name } : null,
    receivedOn: ymd(p.receivedOn),
    amountPaisa: p.amountPaisa.toString(),
    whtDeductedPaisa: p.whtDeductedPaisa.toString(),
    method: p.method,
    bankName: p.bankName,
    reference: p.reference,
    chequeNo: p.chequeNo,
    chequeDate: ymd(p.chequeDate),
    status: p.status,
    allocatedPaisa: allocated.toString(),
    creditPaisa: p.status === 'BOUNCED' ? '0' : (p.amountPaisa + p.whtDeductedPaisa - allocated).toString(),
    allocations: p.allocations.map((al) => ({ id: al.id, amountPaisa: al.amountPaisa.toString(), invoice: al.invoice })),
    attachmentId: p.attachmentId,
    receiptAttachmentId: p.receiptAttachmentId,
    note: p.note,
    bounceReason: p.bounceReason,
    clearedAt: p.clearedAt?.toISOString() ?? null,
    bouncedAt: p.bouncedAt?.toISOString() ?? null,
    receivedById: p.receivedById,
    createdAt: p.createdAt.toISOString(),
  };
}

const load = (tx: Tx, id: string) => tx.clientPayment.findUniqueOrThrow({ where: { id }, include });

async function find(tx: Tx, a: BillingActor, id: string) {
  const p = await tx.clientPayment.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!p) throw new NotFound('PAYMENT_NOT_FOUND', 'Payment not found');
  await billingProject(tx, a, p.projectId).catch(() => {
    throw new NotFound('PAYMENT_NOT_FOUND', 'Payment not found');
  });
  return p;
}

export async function recordPaymentTx(tx: Tx, a: BillingActor, projectId: string, input: PaymentInput, opts: { at?: Date } = {}) {
  const s = await billingSettings(tx, a.tenantId);
  if (a.role === 'MUNSHI' || (a.role === 'PM' && !s.pmCanRecordPayments)) throw new Forbidden('FORBIDDEN', 'Only the owner records owner payments (a company setting can allow project managers)');
  const project = await billingProject(tx, a, projectId);
  if (input.receivedOn > today()) throw new BadRequest('FUTURE_DATE', "A payment can't be dated in the future");
  const wht = input.whtDeductedPaisa ?? 0n;
  if (wht > 0n && !s.taxEnabled) throw new BadRequest('WHT_NOT_ENABLED', 'Withholding tax applies only when tax is switched on in settings');
  if (input.attachmentId && !(await tx.attachment.count({ where: { tenantId: a.tenantId, id: input.attachmentId } }))) throw new BadRequest('INVALID_ATTACHMENT', 'The slip photo was not found');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${project.id}`}))`;

  const settles = input.amountPaisa + wht;
  const open = await openInvoices(tx, a.tenantId, project.id);
  let plan: Array<{ invoiceId: string; amountPaisa: bigint }>;
  if (input.allocations?.length) {
    plan = input.allocations;
    const bad = plan.filter((al) => !open.some((o) => o.id === al.invoiceId));
    if (bad.length) throw new BadRequest('INVALID_ALLOCATION', 'Some invoices are not open invoices of this project', { invoiceIds: bad.map((b) => b.invoiceId) });
    const over = plan.filter((al) => al.amountPaisa > openAmount(open.find((o) => o.id === al.invoiceId)!));
    if (over.length) {
      throw new BadRequest('ALLOCATION_EXCEEDS_BALANCE', 'More than the open balance is put against an invoice', {
        invoices: over.map((o) => ({ invoiceId: o.invoiceId, openPaisa: openAmount(open.find((x) => x.id === o.invoiceId)!).toString() })),
      });
    }
    const total = plan.reduce((sum, al) => sum + al.amountPaisa, 0n);
    if (total > settles) throw new BadRequest('ALLOCATION_EXCEEDS_PAYMENT', 'The allocations add up to more than the payment (+ WHT)', { allocatedPaisa: total.toString(), paymentPaisa: settles.toString() });
  } else {
    // Oldest due first.
    plan = [];
    let left = settles;
    for (const inv of open) {
      if (left <= 0n) break;
      const take = openAmount(inv) < left ? openAmount(inv) : left;
      plan.push({ invoiceId: inv.id, amountPaisa: take });
      left -= take;
    }
  }

  const cheque = input.method === 'CHEQUE';
  const number = await nextNumber(tx, a.tenantId, NUMBER.receipt, dateOnly(input.receivedOn));
  const payment = await tx.clientPayment.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      clientId: project.clientId,
      number,
      receivedOn: dateOnly(input.receivedOn),
      amountPaisa: input.amountPaisa,
      method: input.method,
      bankName: input.bankName ?? null,
      reference: input.reference ?? null,
      chequeNo: input.chequeNo ?? null,
      chequeDate: input.chequeDate ? dateOnly(input.chequeDate) : null,
      status: cheque ? 'PENDING' : 'CLEARED',
      whtDeductedPaisa: wht,
      receivedById: a.userId,
      attachmentId: input.attachmentId ?? null,
      note: input.note ?? null,
      clearedAt: cheque ? null : (opts.at ?? new Date()),
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  for (const al of plan) await tx.paymentAllocation.create({ data: { tenantId: a.tenantId, paymentId: payment.id, invoiceId: al.invoiceId, amountPaisa: al.amountPaisa, ...(opts.at ? { createdAt: opts.at } : {}) } });
  for (const al of plan) await recomputeInvoice(tx, a.tenantId, al.invoiceId);
  const allocated = plan.reduce((sum, al) => sum + al.amountPaisa, 0n);
  await audit(tx, a, 'payment.record', 'ClientPayment', payment.id, {
    number,
    amountPaisa: input.amountPaisa.toString(),
    method: input.method,
    whtPaisa: wht.toString(),
    allocatedPaisa: allocated.toString(),
    creditPaisa: (settles - allocated).toString(),
  });
  return paymentDto(await load(tx, payment.id));
}

export async function recordPayment(projectId: string, input: PaymentInput) {
  const a = actor();
  const dto = await withTenant(a.tenantId, (tx) => recordPaymentTx(tx, a, projectId, input));
  await withinOrBackground(
    () => withTenant(a.tenantId, (tx) => makeReceiptPdf(tx, a, dto.id)),
    (err) => logger.warn({ err, paymentId: dto.id }, 'receipt PDF not made — it is made on first download'),
  );
  return withTenant(a.tenantId, async (tx) => paymentDto(await load(tx, dto.id)));
}

export async function chequeStatusTx(tx: Tx, a: BillingActor, id: string, input: ChequeStatusInput, opts: { at?: Date; sms?: boolean } = {}) {
  assertOwner(a, 'Only the owner marks cheques');
  const p = await find(tx, a, id);
  if (p.method !== 'CHEQUE') throw new BadRequest('NOT_A_CHEQUE', 'Only a cheque has a clearing status');
  if (p.status !== 'PENDING') throw new Conflict('CHEQUE_ALREADY_SETTLED', `This cheque is already ${p.status.toLowerCase()}`, { status: p.status });
  const at = opts.at ?? new Date();
  await tx.clientPayment.update({
    where: { id: p.id },
    data: input.status === 'CLEARED' ? { status: 'CLEARED', clearedAt: at } : { status: 'BOUNCED', bouncedAt: at, bounceReason: input.reason! },
  });
  for (const invoiceId of new Set(p.allocations.map((al) => al.invoiceId))) await recomputeInvoice(tx, a.tenantId, invoiceId);
  if (input.status === 'BOUNCED') {
    await recordEvent(tx, {
      tenantId: a.tenantId,
      projectId: p.projectId,
      type: 'CHEQUE_BOUNCED',
      refType: 'PAYMENT',
      refId: p.id,
      details: { number: p.number, chequeNo: p.chequeNo, bankName: p.bankName, amountPaisa: p.amountPaisa.toString(), reason: input.reason! },
      occurredAt: at,
    });
    if (opts.sms !== false) {
      const owners = await tx.user.findMany({ where: { tenantId: a.tenantId, role: 'THEKEDAR', status: 'ACTIVE' }, select: { phone: true } });
      const text = `${[p.bankName, 'cheque', p.chequeNo].filter(Boolean).join(' ')} (${rs(p.amountPaisa)}) ${p.project.name} bounce ho gaya.`;
      for (const o of owners) await smsProvider().send({ to: o.phone, body: text }).catch((err: unknown) => logger.warn({ err }, 'bounce sms failed'));
    }
  }
  await audit(tx, a, input.status === 'CLEARED' ? 'payment.cheque_cleared' : 'payment.cheque_bounced', 'ClientPayment', p.id, { number: p.number, chequeNo: p.chequeNo, ...(input.reason ? { reason: input.reason } : {}) });
  return paymentDto(await load(tx, p.id));
}

export async function chequeStatus(id: string, input: ChequeStatusInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => chequeStatusTx(tx, a, id, input));
}

export async function listPayments(projectId: string, query: PaymentsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await billingProject(tx, a, projectId);
    const where: P.ClientPaymentWhereInput = { tenantId: a.tenantId, projectId, ...(query.status ? { status: query.status } : {}), ...(query.method ? { method: query.method } : {}) };
    const rows = await tx.clientPayment.findMany({ where, include, orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.limit, take: query.limit });
    const total = await tx.clientPayment.count({ where });
    const sum = async (status: 'CLEARED' | 'PENDING' | 'BOUNCED') =>
      ((await tx.clientPayment.aggregate({ where: { tenantId: a.tenantId, projectId, status }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0n).toString();
    return { data: rows.map(paymentDto), meta: { ...pageMeta(query, total), clearedPaisa: await sum('CLEARED'), pendingPaisa: await sum('PENDING'), bouncedPaisa: await sum('BOUNCED') } };
  });
}

export async function getPayment(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => paymentDto(await find(tx, a, id)));
}

// ─── Receipt PDF ────────────────────────────────────────────────────────────

export async function makeReceiptPdf(tx: Tx, a: BillingActor, id: string) {
  const p = await load(tx, id);
  const dto = paymentDto(p);
  const receivedBy = p.receivedById ? (await tx.user.findUnique({ where: { id: p.receivedById }, select: { name: true } }))?.name ?? null : null;
  const html = receiptHtml({
    company: await letterhead(tx, a.tenantId),
    number: p.number,
    receivedOn: ymd(p.receivedOn)!,
    client: p.client,
    project: p.project,
    amountPaisa: p.amountPaisa,
    whtPaisa: p.whtDeductedPaisa,
    method: [METHOD_LABEL[p.method], p.bankName].filter(Boolean).join(' · '),
    reference: [p.chequeNo ? `Cheque ${p.chequeNo}` : null, p.reference].filter(Boolean).join(' · ') || null,
    status: p.status,
    allocations: p.allocations.map((al) => ({ invoiceNumber: al.invoice.number ?? '—', amountPaisa: al.amountPaisa })),
    creditPaisa: BigInt(dto.creditPaisa),
    receivedBy,
  });
  const attachmentId = await storePdf(tx, a.tenantId, a.userId, 'RECEIPT_PDF', `${p.number}.pdf`, html, `${p.number} · ${p.project.name}`);
  await tx.clientPayment.update({ where: { id }, data: { receiptAttachmentId: attachmentId } });
  return attachmentId;
}

const receiptWhatsapp = (p: Row) => (url: string) =>
  `${salutation(p.client?.name)}, ${p.project.name} ki adaigi ${rs(p.amountPaisa)} (${METHOD_LABEL[p.method]}${p.chequeNo ? ` ${p.chequeNo}` : ''}) ki receipt ${p.number}. Shukriya! Link: ${url}`;

export async function receiptPdf(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const p = await find(tx, a, id);
    let share = p.receiptAttachmentId ? await shareOf(tx, a.tenantId, p.receiptAttachmentId, receiptWhatsapp(p)) : null;
    if (!share) share = await shareOf(tx, a.tenantId, await makeReceiptPdf(tx, a, p.id), receiptWhatsapp(p));
    return { ...share!, clientPhone: p.client?.phone ?? null };
  });
}
