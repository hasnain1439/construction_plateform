/**
 * B5 — owner statement for a period: opening balance, invoices (debit) and payments
 * (credit, cleared only — pending and bounced cheques are listed with their status but do
 * not reduce the balance), closing balance due; plus unbilled recoverables and credit.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { rs, statementHtml } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { StatementQuery } from './billing.schema.js';
import { actor, billingProject, today, ymd, type BillingActor } from './billing.shared.js';
import { day } from '../../core/pdf/templates.js';
import { letterhead, salutation, shareOf, storePdf } from './documents.js';
import { LIVE, projectCredit } from './ledger.js';
import { METHOD_LABEL } from './payments.service.js';

async function build(tx: Tx, a: BillingActor, projectId: string, query: StatementQuery) {
  const project = await billingProject(tx, a, projectId);
  const client = project.clientId ? await tx.client.findUnique({ where: { id: project.clientId }, select: { id: true, name: true, phone: true } }) : null;
  const invoices = await tx.invoice.findMany({ where: { tenantId: a.tenantId, projectId: project.id, status: { in: LIVE } }, orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }] });
  const payments = await tx.clientPayment.findMany({ where: { tenantId: a.tenantId, projectId: project.id }, orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }] });
  const first = [ymd(invoices[0]?.issueDate), ymd(payments[0]?.receivedOn), ymd(project.startDate)].filter((d): d is string => !!d).sort()[0] ?? today();
  const from = query.from ?? first;
  const to = query.to ?? today();

  const credited = (p: (typeof payments)[number]) => (p.status === 'CLEARED' ? p.amountPaisa + p.whtDeductedPaisa : 0n);
  const opening =
    invoices.filter((i) => ymd(i.issueDate)! < from).reduce((s, i) => s + i.totalPaisa, 0n) - payments.filter((p) => ymd(p.receivedOn)! < from).reduce((s, p) => s + credited(p), 0n);

  type Row = { date: string; kind: 'INVOICE' | 'PAYMENT'; id: string; reference: string; description: string; debitPaisa: bigint; creditPaisa: bigint; status: string | null };
  const rows: Row[] = [
    ...invoices
      .filter((i) => ymd(i.issueDate)! >= from && ymd(i.issueDate)! <= to)
      .map((i) => ({ date: ymd(i.issueDate)!, kind: 'INVOICE' as const, id: i.id, reference: i.number ?? '', description: `Invoice due ${day(ymd(i.dueDate))}`, debitPaisa: i.totalPaisa, creditPaisa: 0n, status: null })),
    ...payments
      .filter((p) => ymd(p.receivedOn)! >= from && ymd(p.receivedOn)! <= to)
      .map((p) => ({
        date: ymd(p.receivedOn)!,
        kind: 'PAYMENT' as const,
        id: p.id,
        reference: p.number,
        description: [METHOD_LABEL[p.method], p.bankName, p.chequeNo ? `cheque ${p.chequeNo}` : null, p.whtDeductedPaisa > 0n ? `incl. WHT ${rs(p.whtDeductedPaisa)}` : null].filter(Boolean).join(' · '),
        debitPaisa: 0n,
        creditPaisa: credited(p),
        status: p.method === 'CHEQUE' || p.status !== 'CLEARED' ? p.status : null,
      })),
  ].sort((x, y) => (x.date === y.date ? (x.kind === 'INVOICE' ? -1 : 1) : x.date < y.date ? -1 : 1));
  let running = opening;
  const withBalance = rows.map((r) => {
    running += r.debitPaisa - r.creditPaisa;
    return { ...r, balancePaisa: running };
  });
  const recoverables = await tx.cashEntry.findMany({
    where: { tenantId: a.tenantId, projectId: project.id, type: 'EXPENSE', costBucket: 'RECOVERABLE_FROM_OWNER', status: { not: 'REJECTED' }, billedInvoiceId: null, occurredAt: { lte: dateOnly(to) } },
    orderBy: { occurredAt: 'asc' },
  });
  return {
    project,
    client,
    from,
    to,
    opening,
    rows: withBalance,
    closing: running,
    credit: await projectCredit(tx, a.tenantId, project.id),
    pendingCheques: payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amountPaisa, 0n),
    recoverables,
  };
}

export async function ownerStatement(projectId: string, query: StatementQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const s = await build(tx, a, projectId, query);
    return {
      project: { id: s.project.id, code: s.project.code, name: s.project.name },
      client: s.client,
      from: s.from,
      to: s.to,
      openingPaisa: s.opening.toString(),
      rows: s.rows.map((r) => ({ ...r, debitPaisa: r.debitPaisa.toString(), creditPaisa: r.creditPaisa.toString(), balancePaisa: r.balancePaisa.toString() })),
      totals: {
        invoicedPaisa: s.rows.reduce((x, r) => x + r.debitPaisa, 0n).toString(),
        receivedPaisa: s.rows.reduce((x, r) => x + r.creditPaisa, 0n).toString(),
      },
      closingPaisa: s.closing.toString(),
      creditPaisa: s.credit.toString(),
      pendingChequesPaisa: s.pendingCheques.toString(),
      unbilledRecoverables: s.recoverables.map((e) => ({ id: e.id, date: ymd(e.occurredAt), description: e.description, amountPaisa: (-e.amountPaisa).toString() })),
    };
  });
}

export async function ownerStatementPdf(projectId: string, query: StatementQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const s = await build(tx, a, projectId, query);
    const html = statementHtml({
      company: await letterhead(tx, a.tenantId),
      client: s.client,
      project: s.project,
      from: s.from,
      to: s.to,
      openingPaisa: s.opening,
      rows: s.rows,
      closingPaisa: s.closing,
      creditPaisa: s.credit,
    });
    const id = await storePdf(tx, a.tenantId, a.userId, 'STATEMENT_PDF', `Statement ${s.project.code} ${s.to}.pdf`, html, `Statement · ${s.project.name}`);
    const share = await shareOf(
      tx,
      a.tenantId,
      id,
      (url) => `${salutation(s.client?.name)}, ${s.project.name} ka hisaab (${day(s.from)} – ${day(s.to)}): baqaya ${rs(s.closing > 0n ? s.closing : 0n)}. Link: ${url}`,
    );
    return { ...share!, clientPhone: s.client?.phone ?? null };
  });
}
