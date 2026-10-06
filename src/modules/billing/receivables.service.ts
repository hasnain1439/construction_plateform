/**
 * B4 — receivables. Per project:
 *   invoiced     Σ total of live invoices (issued / part paid / paid)
 *   received     Σ cleared payments incl. WHT (money actually in hand)
 *   outstanding  Σ live invoice balances (total − cleared allocations); pending cheques are
 *                part of it and also shown on their own
 *   overdue      outstanding of invoices past their due date
 *   own money    spent to date − received (negative = the owner has paid ahead)
 *   ageing       outstanding by days since the invoice was issued (0–15 / 16–30 / 31–60 / 60+)
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import { projectScope } from '../projects/access.js';
import type { ReceivablesQuery } from './billing.schema.js';
import { actor, assertOwner, billingProject, daysBetween, today, ymd } from './billing.shared.js';
import { overdueOf } from './invoices.service.js';
import { LIVE, projectCredit } from './ledger.js';
import { costDto, projectCost } from './projectCost.service.js';
import { ageing, ageingDto, addAgeing } from '../finance/ageing.js';
import { stageDto } from './stages.service.js';

export async function moneyOf(tx: Tx, tenantId: string, project: Project) {
  const stages = await tx.projectBillingStage.findMany({ where: { tenantId, projectId: project.id }, orderBy: { sortOrder: 'asc' } });
  const invoices = await tx.invoice.findMany({ where: { tenantId, projectId: project.id, status: { in: LIVE } }, orderBy: { issueDate: 'asc' } });
  const payments = await tx.clientPayment.groupBy({ by: ['status'], where: { tenantId, projectId: project.id }, _sum: { amountPaisa: true, whtDeductedPaisa: true } });
  const pay = (s: string) => payments.find((p) => p.status === s);
  const received = (pay('CLEARED')?._sum.amountPaisa ?? 0n) + (pay('CLEARED')?._sum.whtDeductedPaisa ?? 0n);
  const pendingCheques = pay('PENDING')?._sum.amountPaisa ?? 0n;

  const contract = stages.reduce((s, x) => s + x.amountPaisa, 0n) || (project.contractValuePaisa ?? 0n);
  const invoiced = invoices.reduce((s, i) => s + i.totalPaisa, 0n);
  const outstanding = invoices.reduce((s, i) => s + i.balancePaisa, 0n);
  let overdue = 0n;
  let oldestOverdueDays = 0;
  for (const i of invoices) {
    const o = overdueOf(i);
    if (o.overdue) {
      overdue += i.balancePaisa;
      oldestOverdueDays = Math.max(oldestOverdueDays, o.overdueDays);
    }
  }
  // Retention: the retention stage until it is billed and paid (running bills: what was held back).
  const retentionStage = stages.find((s) => s.isRetention) ?? null;
  let retentionHeld = 0n;
  if (retentionStage) {
    const retInv = invoices.find((i) => i.billingStageId === retentionStage.id);
    if (retInv) retentionHeld = retInv.balancePaisa;
    else if (project.billingModel === 'RUNNING_BILLS') {
      const held = await tx.invoiceLine.aggregate({ where: { tenantId, sourceType: 'RETENTION', sourceId: retentionStage.id, invoice: { status: { in: LIVE } } }, _sum: { amountPaisa: true } });
      retentionHeld = held._sum.amountPaisa ? -held._sum.amountPaisa : retentionStage.amountPaisa;
    } else retentionHeld = retentionStage.amountPaisa;
  }
  const unbilledRecoverable = -(
    (
      await tx.cashEntry.aggregate({
        where: { tenantId, projectId: project.id, type: 'EXPENSE', costBucket: 'RECOVERABLE_FROM_OWNER', status: { not: 'REJECTED' }, billedInvoiceId: null },
        _sum: { amountPaisa: true },
      })
    )._sum.amountPaisa ?? 0n
  );
  const invoiceOfStage = new Map(
    (await tx.invoice.findMany({ where: { tenantId, projectId: project.id, status: { not: 'CANCELLED' }, billingStageId: { not: null } }, orderBy: { createdAt: 'asc' } })).map((i) => [i.billingStageId!, i]),
  );
  const next = stages.find((s) => s.status === 'READY') ?? stages.find((s) => s.status === 'UPCOMING' && !s.isRetention) ?? null;
  return {
    stages,
    invoiceOfStage,
    contract,
    invoiced,
    received,
    pendingCheques,
    outstanding,
    overdue,
    oldestOverdueDays,
    retentionHeld,
    unbilledRecoverable,
    credit: await projectCredit(tx, tenantId, project.id),
    readyStagesCount: stages.filter((s) => s.status === 'READY').length,
    next,
    ageing: ageing(invoices.filter((i) => i.balancePaisa > 0n).map((i) => ({ days: daysBetween(ymd(i.issueDate) ?? today(), today()), amountPaisa: i.balancePaisa }))),
  };
}

export async function projectReceivables(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await billingProject(tx, a, projectId);
    const m = await moneyOf(tx, a.tenantId, project);
    const cost = await projectCost(tx, a.tenantId, project.id);
    return {
      project: { id: project.id, code: project.code, name: project.name, status: project.status, billingModel: project.billingModel },
      originalContractPaisa: m.contract.toString(),
      approvedChangesPaisa: '0',
      revisedContractPaisa: m.contract.toString(),
      invoicedPaisa: m.invoiced.toString(),
      receivedPaisa: m.received.toString(),
      pendingChequesPaisa: m.pendingCheques.toString(),
      outstandingPaisa: m.outstanding.toString(),
      overduePaisa: m.overdue.toString(),
      oldestOverdueDays: m.oldestOverdueDays,
      creditPaisa: m.credit.toString(),
      retentionHeldPaisa: m.retentionHeld.toString(),
      unbilledRecoverablePaisa: m.unbilledRecoverable.toString(),
      readyStagesCount: m.readyStagesCount,
      collectedPercent: m.invoiced > 0n ? Number((m.received * 1000n) / m.invoiced) / 10 : 0,
      spentToDatePaisa: cost.totalPaisa.toString(),
      spent: costDto(cost),
      ownMoneyInvestedPaisa: (cost.totalPaisa - m.received).toString(),
      nextBillableStage: m.next ? stageDto(m.next, null) : null,
      stages: m.stages.map((s) => {
        const inv = m.invoiceOfStage.get(s.id) ?? null;
        return {
          id: s.id,
          label: s.label,
          percent: Number(s.percent),
          amountPaisa: s.amountPaisa.toString(),
          status: s.status,
          isRetention: s.isRetention,
          expectedDate: ymd(s.expectedDate),
          invoiceId: inv?.id ?? null,
          invoiceNumber: inv?.number ?? null,
          dueDate: ymd(inv?.dueDate),
        };
      }),
    };
  });
}

/** Company view (THEKEDAR): one row per non-draft project, plus totals. */
export async function companyReceivables(query: ReceivablesQuery) {
  const a = actor();
  assertOwner(a, 'Only the owner sees company receivables');
  return withTenant(a.tenantId, async (tx) => {
    const projects = await tx.project.findMany({
      where: { tenantId: a.tenantId, ...projectScope(a), status: query.status ? query.status : { notIn: ['DRAFT'] } },
      include: { client: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const rows = [];
    for (const p of projects) {
      const m = await moneyOf(tx, a.tenantId, p);
      if (m.invoiced === 0n && m.contract === 0n) continue;
      rows.push({
        project: { id: p.id, code: p.code, name: p.name, status: p.status },
        client: p.client,
        revisedContractPaisa: m.contract.toString(),
        invoicedPaisa: m.invoiced.toString(),
        receivedPaisa: m.received.toString(),
        pendingChequesPaisa: m.pendingCheques.toString(),
        outstandingPaisa: m.outstanding.toString(),
        overduePaisa: m.overdue.toString(),
        oldestOverdueDays: m.oldestOverdueDays,
        creditPaisa: m.credit.toString(),
        retentionHeldPaisa: m.retentionHeld.toString(),
        ageing: m.ageing,
        nextBillableStage: m.next ? { id: m.next.id, label: m.next.label, status: m.next.status, amountPaisa: m.next.amountPaisa.toString() } : null,
      });
    }
    const filtered = query.overdueOnly ? rows.filter((r) => r.overduePaisa !== '0') : rows;
    const totalAgeing = filtered.reduce((s, r) => addAgeing(s, r.ageing), ageing([]));
    const items = filtered.map((r) => ({ ...r, ageing: ageingDto(r.ageing) }));
    const total = (k: 'revisedContractPaisa' | 'invoicedPaisa' | 'receivedPaisa' | 'pendingChequesPaisa' | 'outstandingPaisa' | 'overduePaisa' | 'retentionHeldPaisa') =>
      items.reduce((s, r) => s + BigInt(r[k]), 0n).toString();
    return {
      asOf: today(),
      items,
      totals: {
        revisedContractPaisa: total('revisedContractPaisa'),
        invoicedPaisa: total('invoicedPaisa'),
        receivedPaisa: total('receivedPaisa'),
        pendingChequesPaisa: total('pendingChequesPaisa'),
        outstandingPaisa: total('outstandingPaisa'),
        overduePaisa: total('overduePaisa'),
        retentionHeldPaisa: total('retentionHeldPaisa'),
        overdueProjects: items.filter((r) => r.overduePaisa !== '0').length,
        ageing: ageingDto(totalAgeing),
      },
    };
  });
}

