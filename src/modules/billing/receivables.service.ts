/**
 * B4 — receivables. Per project:
 *   invoiced     Σ total of live invoices (issued / part paid / paid)
 *   received     Σ cleared payments incl. WHT (money actually in hand)
 *   outstanding  Σ live invoice balances (total − cleared allocations); pending cheques are
 *                part of it and also shown on their own
 *   overdue      outstanding of invoices past their due date
 *   own money    spent to date − received (negative = the owner has paid ahead)
 *   ageing       outstanding by days since the invoice was issued (0–15 / 16–30 / 31–60 / 60+)
 *   contract     revised = original (stages / contract value) + approved change orders (Step 15)
 */
import { assertPerm } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Invoice, Project, ProjectBillingStage } from '../../generated/prisma/client.js';
import { projectScope } from '../projects/access.js';
import type { ReceivablesQuery } from './billing.schema.js';
import { actor, billingProject, daysBetween, today, ymd } from './billing.shared.js';
import { overdueOf } from './invoices.service.js';
import { LIVE } from './ledger.js';
import { costDto, projectCost } from './projectCost.service.js';
import { ageing, ageingDto, addAgeing } from '../finance/ageing.js';
import { stageDto } from './stages.service.js';
import { approvedChangesMany, type ApprovedChanges } from '../change-orders/totals.js'; // Step 15

export type Money = Awaited<ReturnType<typeof moneyOf>>;

export async function moneyOf(tx: Tx, tenantId: string, project: Project) {
  return (await moneyOfMany(tx, tenantId, [project])).get(project.id)!;
}

/**
 * Step 18 · receivables of several projects in a fixed number of set-based queries (stages,
 * invoices, payments, approved change orders, retention, recoverables, credit) instead of ~9
 * per project. Same numbers as one `moneyOf` per project; every project gets an entry.
 * `pre.changes` reuses approved change-order totals the caller already loaded.
 */
export async function moneyOfMany(tx: Tx, tenantId: string, projects: Project[], pre: { changes?: Map<string, ApprovedChanges> } = {}) {
  const ids = projects.map((p) => p.id);
  const out = new Map<string, ReturnType<typeof moneyRow>>();
  if (!ids.length) return out;
  // One id → plain equality (same plan as before); several → IN.
  const projectId = ids.length === 1 ? ids[0]! : { in: ids };
  const byProject = <T extends { projectId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>(ids.map((id) => [id, []]));
    for (const r of rows) m.get(r.projectId)?.push(r);
    return m;
  };
  const stagesBy = byProject(await tx.projectBillingStage.findMany({ where: { tenantId, projectId }, orderBy: { sortOrder: 'asc' } }));
  const invoicesBy = byProject(await tx.invoice.findMany({ where: { tenantId, projectId, status: { in: LIVE } }, orderBy: { issueDate: 'asc' } }));
  const payments = await tx.clientPayment.groupBy({ by: ['projectId', 'status'], where: { tenantId, projectId }, _sum: { amountPaisa: true, whtDeductedPaisa: true } });
  const changes = pre.changes ?? (await approvedChangesMany(tx, tenantId, ids));
  // Retention held on running bills (retention stage not invoiced yet): Σ RETENTION lines (negative).
  const runningRetention: string[] = [];
  for (const p of projects) {
    if (p.billingModel !== 'RUNNING_BILLS') continue;
    const s = stagesBy.get(p.id)!.find((x) => x.isRetention);
    if (s && !invoicesBy.get(p.id)!.some((i) => i.billingStageId === s.id)) runningRetention.push(s.id);
  }
  const heldBy = new Map<string, bigint | null>();
  if (runningRetention.length) {
    const held = await tx.invoiceLine.groupBy({
      by: ['sourceId'],
      where: { tenantId, sourceType: 'RETENTION', sourceId: { in: runningRetention }, invoice: { status: { in: LIVE } } },
      _sum: { amountPaisa: true },
    });
    for (const h of held) if (h.sourceId) heldBy.set(h.sourceId, h._sum.amountPaisa);
  }
  const recoverableBy = new Map(
    (
      await tx.cashEntry.groupBy({
        by: ['projectId'],
        where: { tenantId, projectId, type: 'EXPENSE', costBucket: 'RECOVERABLE_FROM_OWNER', status: { not: 'REJECTED' }, billedInvoiceId: null },
        _sum: { amountPaisa: true },
      })
    ).map((g) => [g.projectId, g._sum.amountPaisa]),
  );
  const stageInvoicesBy = byProject(await tx.invoice.findMany({ where: { tenantId, projectId, status: { not: 'CANCELLED' }, billingStageId: { not: null } }, orderBy: { createdAt: 'asc' } }));
  // Credit (ledger `projectCredit`): unallocated money per non-bounced payment, only positive ones count.
  const creditBy = new Map<string, bigint>();
  const credits = await tx.clientPayment.findMany({
    where: { tenantId, projectId, status: { not: 'BOUNCED' } },
    select: { projectId: true, amountPaisa: true, whtDeductedPaisa: true, allocations: { select: { amountPaisa: true } } },
  });
  for (const pay of credits) {
    const free = pay.amountPaisa + pay.whtDeductedPaisa - pay.allocations.reduce((s, a) => s + a.amountPaisa, 0n);
    if (free > 0n) creditBy.set(pay.projectId, (creditBy.get(pay.projectId) ?? 0n) + free);
  }
  for (const project of projects) {
    const pay = (st: string) => payments.find((p) => p.projectId === project.id && p.status === st);
    out.set(
      project.id,
      moneyRow(project, {
        stages: stagesBy.get(project.id)!,
        invoices: invoicesBy.get(project.id)!,
        received: (pay('CLEARED')?._sum.amountPaisa ?? 0n) + (pay('CLEARED')?._sum.whtDeductedPaisa ?? 0n),
        pendingCheques: pay('PENDING')?._sum.amountPaisa ?? 0n,
        changes: changes.get(project.id)?.totalPaisa ?? 0n,
        heldBy,
        recoverable: recoverableBy.get(project.id) ?? null,
        stageInvoices: stageInvoicesBy.get(project.id)!,
        credit: creditBy.get(project.id) ?? 0n,
      }),
    );
  }
  return out;
}

function moneyRow(
  project: Project,
  d: {
    stages: ProjectBillingStage[];
    invoices: Invoice[];
    received: bigint;
    pendingCheques: bigint;
    changes: bigint;
    heldBy: Map<string, bigint | null>;
    recoverable: bigint | null;
    stageInvoices: Invoice[];
    credit: bigint;
  },
) {
  const { stages, invoices } = d;
  const originalContract = stages.reduce((s, x) => s + x.amountPaisa, 0n) || (project.contractValuePaisa ?? 0n);
  // Step 15: revised contract = original + approved change orders (signed; deductions lower it).
  const contract = originalContract + d.changes;
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
      const held = d.heldBy.get(retentionStage.id) ?? null;
      retentionHeld = held ? -held : retentionStage.amountPaisa;
    } else retentionHeld = retentionStage.amountPaisa;
  }
  const unbilledRecoverable = -(d.recoverable ?? 0n);
  const invoiceOfStage = new Map(d.stageInvoices.map((i) => [i.billingStageId!, i]));
  const next = stages.find((s) => s.status === 'READY') ?? stages.find((s) => s.status === 'UPCOMING' && !s.isRetention) ?? null;
  return {
    stages,
    invoiceOfStage,
    originalContract,
    approvedChanges: d.changes,
    contract,
    invoiced,
    received: d.received,
    pendingCheques: d.pendingCheques,
    outstanding,
    overdue,
    oldestOverdueDays,
    retentionHeld,
    unbilledRecoverable,
    credit: d.credit,
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
      originalContractPaisa: m.originalContract.toString(),
      approvedChangesPaisa: m.approvedChanges.toString(),
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
  assertPerm('finance.receivables.view', a);
  return withTenant(a.tenantId, async (tx) => {
    const projects = await tx.project.findMany({
      where: { tenantId: a.tenantId, ...projectScope(a), status: query.status ? query.status : { notIn: ['DRAFT'] } },
      include: { client: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const money = await moneyOfMany(tx, a.tenantId, projects);
    const rows = [];
    for (const p of projects) {
      const m = money.get(p.id)!;
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

