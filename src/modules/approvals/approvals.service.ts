/**
 * B2 — one inbox for everything waiting on the office. THEKEDAR sees all; a PM only items of
 * assigned projects, and only the actions they may take; money items (stages, invoices,
 * cheques) need billing.view. The bulk endpoint calls the owning module's service for each
 * item, so every rule (limits, own-kharcha, locks) still applies — and failures are per item.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { AppError, Forbidden } from '../../core/errors/AppError.js';
import { dayMonth } from '../../core/pdf/templates.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import * as payments from '../billing/payments.service.js';
import * as invoices from '../billing/invoices.service.js';
import * as cashbook from '../cashbook/cashbook.service.js';
import * as measurements from '../labor/measurements.service.js';
import * as settlements from '../labor/settlements.service.js';
import { times } from '../labor/labor.shared.js';
import { readActor as approvalActor, type ReadActor as ApprovalActor } from '../dashboard/dashboard.shared.js';
import { projectScope } from '../projects/access.js';
import type { ApprovalAction, ApprovalType, BulkInput } from './approvals.schema.js';

export interface QuickAction {
  action: ApprovalAction;
  label: string;
  needsNote: boolean;
  needsMethod: boolean;
}
const qa = (action: ApprovalAction, label: string, needs: { note?: boolean; method?: boolean } = {}): QuickAction => ({
  action,
  label,
  needsNote: needs.note ?? false,
  needsMethod: needs.method ?? false,
});

export interface ApprovalItem {
  type: ApprovalType;
  id: string;
  title: string;
  subtitle: string | null;
  project: { id: string; code: string; name: string } | null;
  amountPaisa: string | null;
  createdAt: string;
  ageDays: number;
  actionUrl: string;
  quickActions: QuickAction[];
}

export const GROUP_LABEL: Record<ApprovalType, string> = {
  SETTLEMENT_SUBMITTED: 'Wage settlements to approve',
  EXPENSE_PENDING_APPROVAL: 'Kharcha above the limit',
  TOPUP_PENDING: 'Cash top-up requests',
  MEASUREMENT_TO_VERIFY: 'Measurements to verify',
  SHORTAGE_OPEN: 'Open shortages',
  PURCHASE_PENDING_RATE: 'Site purchases without rates',
  STAGE_READY_UNBILLED: 'Stages ready to bill',
  INVOICE_DRAFT: 'Draft invoices',
  CHEQUE_PENDING: 'Owner cheques to clear',
};

const projectRef = { select: { id: true, code: true, name: true } } as const;
const DAY_MS = 86_400_000;

/** Project ids the caller may see (null = all, for the owner). */
async function scopeIds(tx: Tx, a: ApprovalActor): Promise<string[] | null> {
  if (a.role === 'THEKEDAR') return null;
  const rows = await tx.project.findMany({ where: { tenantId: a.tenantId, ...projectScope(a) }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function collectApprovals(tx: Tx, a: ApprovalActor, now = new Date()): Promise<ApprovalItem[]> {
  const ids = await scopeIds(tx, a);
  const inScope = ids === null ? {} : { projectId: { in: ids } };
  const owner = a.role === 'THEKEDAR';
  const age = (d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
  const item = (i: Omit<ApprovalItem, 'ageDays' | 'createdAt'> & { at: Date }): ApprovalItem => {
    const { at, ...rest } = i;
    return { ...rest, createdAt: at.toISOString(), ageDays: age(at) };
  };
  const out: ApprovalItem[] = [];

  const settlementRows = await tx.wageSettlement.findMany({ where: { tenantId: a.tenantId, status: 'SUBMITTED', ...inScope }, include: { project: projectRef }, orderBy: { submittedAt: 'asc' } });
  for (const s of settlementRows) {
    out.push(
      item({
        type: 'SETTLEMENT_SUBMITTED',
        id: s.id,
        title: `Wages ${dayMonth(formatDateOnly(s.weekStart))} – ${dayMonth(formatDateOnly(s.weekEnd))}`,
        subtitle: `Gross ${s.grossPaisa / 100n} − peshgi ${s.advancePaisa / 100n}`,
        project: s.project,
        amountPaisa: s.netPaisa.toString(),
        at: s.submittedAt ?? s.updatedAt,
        actionUrl: `/projects/${s.projectId}/labor/settlements/${s.id}`,
        quickActions: [qa('approve', 'Approve'), qa('return', 'Return', { note: true })],
      }),
    );
  }

  const expenses = await tx.cashEntry.findMany({
    where: { tenantId: a.tenantId, type: 'EXPENSE', status: 'PENDING_APPROVAL', ...(ids === null ? {} : { projectId: { in: ids } }) },
    include: { project: projectRef, account: { select: { holderUserId: true, holder: { select: { name: true } } } } },
    orderBy: { occurredAt: 'asc' },
  });
  for (const e of expenses) {
    const own = a.role === 'PM' && e.account.holderUserId === a.userId;
    out.push(
      item({
        type: 'EXPENSE_PENDING_APPROVAL',
        id: e.id,
        title: `${e.account.holder.name}: ${e.description}`,
        subtitle: e.category ? e.category.replaceAll('_', ' ').toLowerCase() : null,
        project: e.project,
        amountPaisa: (-e.amountPaisa).toString(),
        at: e.occurredAt,
        actionUrl: e.projectId ? `/projects/${e.projectId}/cash-book/kharcha` : '/finance/cash-floats',
        quickActions: own ? [] : [qa('approve', 'Approve'), qa('reject', 'Reject', { note: true })],
      }),
    );
  }

  if (owner) {
    const topups = await tx.topupRequest.findMany({ where: { tenantId: a.tenantId, status: 'PENDING' }, include: { account: { select: { holder: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } });
    for (const t of topups) {
      out.push(
        item({
          type: 'TOPUP_PENDING',
          id: t.id,
          title: `${t.account.holder.name} asks for more cash`,
          subtitle: t.note,
          project: null,
          amountPaisa: t.amountPaisa.toString(),
          at: t.createdAt,
          actionUrl: '/finance/cash-floats',
          quickActions: [qa('approve', 'Send', { method: true }), qa('reject', 'Reject', { note: true })],
        }),
      );
    }
  }

  const measured = await tx.workMeasurement.findMany({
    where: { tenantId: a.tenantId, status: 'RECORDED', ...inScope },
    include: { project: projectRef, assignment: { select: { ratePaisa: true, subcontractor: { select: { name: true } } } } },
    orderBy: { date: 'asc' },
  });
  for (const m of measured) {
    out.push(
      item({
        type: 'MEASUREMENT_TO_VERIFY',
        id: m.id,
        title: `${m.assignment.subcontractor.name}: ${Number(m.quantity.toFixed(3))} ${m.unit}`,
        subtitle: m.description,
        project: m.project,
        amountPaisa: m.assignment.ratePaisa === null ? null : times(m.quantity, m.assignment.ratePaisa).toString(),
        at: m.createdAt,
        actionUrl: `/projects/${m.projectId}/labor/measurements`,
        quickActions: [qa('approve', 'Verify'), qa('reject', 'Reject', { note: true })],
      }),
    );
  }

  const shortages = await tx.shortage.findMany({
    where: { tenantId: a.tenantId, status: 'OPEN', kind: { not: 'EXCESS' }, ...(ids === null ? {} : { projectId: { in: ids } }) },
    include: { material: { select: { name: true, unit: true } }, location: { select: { name: true } }, dispatch: { select: { number: true } }, purchase: { select: { number: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const projectsById = new Map((await tx.project.findMany({ where: { tenantId: a.tenantId, id: { in: shortages.map((s) => s.projectId).filter((x): x is string => !!x) } }, ...projectRef })).map((p) => [p.id, p]));
  for (const s of shortages) {
    out.push(
      item({
        type: 'SHORTAGE_OPEN',
        id: s.id,
        title: `${s.material.name} ${Number(s.qty.toFixed(3))} ${s.material.unit} ${s.kind === 'DAMAGED' ? 'damaged' : 'short'}`,
        subtitle: [s.dispatch?.number ?? s.purchase?.number, s.location.name].filter(Boolean).join(' · '),
        project: s.projectId ? (projectsById.get(s.projectId) ?? null) : null,
        amountPaisa: a.seesRates ? s.valuePaisa.toString() : null,
        at: s.createdAt,
        actionUrl: '/suppliers-stock/shortages',
        quickActions: [],
      }),
    );
  }

  const pendingRate = await tx.purchase.findMany({ where: { tenantId: a.tenantId, status: 'PENDING_RATE', ...inScope }, include: { project: projectRef, supplier: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
  for (const p of pendingRate) {
    out.push(
      item({
        type: 'PURCHASE_PENDING_RATE',
        id: p.id,
        title: `${p.number} — ${p.supplier.name}`,
        subtitle: `Challan ${p.challanNo}`,
        project: p.project,
        amountPaisa: null,
        at: p.createdAt,
        actionUrl: `/suppliers-stock/purchases/${p.id}`,
        quickActions: [],
      }),
    );
  }

  if (a.seesFinancials) {
    const stages = await tx.projectBillingStage.findMany({ where: { tenantId: a.tenantId, status: 'READY', ...inScope }, include: { project: projectRef }, orderBy: { readyAt: 'asc' } });
    for (const s of stages) {
      out.push(
        item({
          type: 'STAGE_READY_UNBILLED',
          id: s.id,
          title: `Bill: ${s.label}`,
          subtitle: `${Number(s.percent)}% of the contract`,
          project: s.project,
          amountPaisa: s.amountPaisa.toString(),
          at: s.readyAt ?? s.updatedAt,
          actionUrl: `/projects/${s.projectId}/billing/schedule`,
          quickActions: [],
        }),
      );
    }
    const drafts = await tx.invoice.findMany({ where: { tenantId: a.tenantId, status: 'DRAFT', ...inScope }, include: { project: projectRef }, orderBy: { createdAt: 'asc' } });
    for (const d of drafts) {
      out.push(
        item({
          type: 'INVOICE_DRAFT',
          id: d.id,
          title: `Draft ${d.type.replace('_', ' ').toLowerCase()} invoice`,
          subtitle: d.notes,
          project: d.project,
          amountPaisa: d.totalPaisa.toString(),
          at: d.createdAt,
          actionUrl: `/projects/${d.projectId}/billing/invoices/${d.id}`,
          quickActions: owner ? [qa('issue', 'Issue')] : [],
        }),
      );
    }
    const cheques = await tx.clientPayment.findMany({ where: { tenantId: a.tenantId, method: 'CHEQUE', status: 'PENDING', ...inScope }, include: { project: projectRef }, orderBy: { receivedOn: 'asc' } });
    for (const c of cheques) {
      out.push(
        item({
          type: 'CHEQUE_PENDING',
          id: c.id,
          title: [c.bankName, 'cheque', c.chequeNo].filter(Boolean).join(' '),
          subtitle: c.number,
          project: c.project,
          amountPaisa: c.amountPaisa.toString(),
          at: c.createdAt,
          actionUrl: `/projects/${c.projectId}/billing/payments`,
          quickActions: owner ? [qa('clear', 'Mark cleared'), qa('bounce', 'Bounced', { note: true })] : [],
        }),
      );
    }
  }
  return out;
}

export function groupApprovals(items: ApprovalItem[]) {
  const groups = (Object.keys(GROUP_LABEL) as ApprovalType[])
    .map((type) => {
      const list = items.filter((i) => i.type === type);
      const amount = list.reduce((s, i) => s + BigInt(i.amountPaisa ?? '0'), 0n);
      return { type, label: GROUP_LABEL[type], count: list.length, totalPaisa: list.some((i) => i.amountPaisa !== null) ? amount.toString() : null, items: list };
    })
    .filter((g) => g.count > 0);
  return { total: items.length, groups };
}

export async function listApprovals() {
  const a = approvalActor();
  return withTenant(a.tenantId, async (tx) => groupApprovals(await collectApprovals(tx, a)));
}

/** Pending count for the dashboard KPI. */
export async function approvalsCount(tx: Tx, a: ApprovalActor) {
  return (await collectApprovals(tx, a)).length;
}

// ─── Bulk ───────────────────────────────────────────────────────────────────

type BulkItem = BulkInput['items'][number];

const needNote = (i: BulkItem) => {
  if (!i.note || i.note.length < 3) throw new AppError(400, 'NOTE_REQUIRED', 'Add a short note (why)');
  return i.note;
};
const ownerOnly = (a: ApprovalActor, what: string) => {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', `Only the owner can ${what}`);
};
const unsupported = (i: BulkItem) => new AppError(400, 'UNSUPPORTED_ACTION', `${i.action} is not a quick action for ${i.type.replaceAll('_', ' ').toLowerCase()} — open it instead`);

async function run(a: ApprovalActor, i: BulkItem): Promise<unknown> {
  switch (i.type) {
    case 'SETTLEMENT_SUBMITTED':
      if (i.action === 'approve') return settlements.approve(i.id);
      if (i.action === 'return') return settlements.returnSettlement(i.id, needNote(i));
      throw unsupported(i);
    case 'EXPENSE_PENDING_APPROVAL':
      if (i.action === 'approve') return cashbook.approveExpense(i.id, i.note);
      if (i.action === 'reject') return cashbook.rejectExpense(i.id, needNote(i));
      throw unsupported(i);
    case 'TOPUP_PENDING':
      if (i.action === 'approve') {
        if (!i.method) throw new AppError(400, 'METHOD_REQUIRED', 'Choose how the cash is sent');
        return cashbook.approveTopup(i.id, { method: i.method });
      }
      if (i.action === 'reject') return cashbook.rejectTopup(i.id, needNote(i));
      throw unsupported(i);
    case 'MEASUREMENT_TO_VERIFY':
      if (i.action === 'verify' || i.action === 'approve') return measurements.verifyMeasurement(i.id);
      if (i.action === 'reject') return measurements.rejectMeasurement(i.id, needNote(i));
      throw unsupported(i);
    case 'INVOICE_DRAFT':
      if (i.action !== 'issue') throw unsupported(i);
      if (!a.seesFinancials) throw new Forbidden('FORBIDDEN', 'You cannot see billing');
      ownerOnly(a, 'issue invoices');
      return invoices.issue(i.id, {});
    case 'CHEQUE_PENDING':
      if (i.action !== 'clear' && i.action !== 'bounce') throw unsupported(i);
      if (!a.seesFinancials) throw new Forbidden('FORBIDDEN', 'You cannot see billing');
      ownerOnly(a, 'mark cheques');
      return payments.chequeStatus(i.id, i.action === 'clear' ? { status: 'CLEARED' } : { status: 'BOUNCED', reason: needNote(i) });
    default:
      throw unsupported(i);
  }
}

export async function bulk(input: BulkInput) {
  const a = approvalActor();
  const results = [];
  for (const i of input.items) {
    try {
      await run(a, i);
      results.push({ type: i.type, id: i.id, action: i.action, ok: true as const, error: null });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      results.push({ type: i.type, id: i.id, action: i.action, ok: false as const, error: { code: err.code, message: err.message } });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { succeeded, failed: results.length - succeeded, results };
}
