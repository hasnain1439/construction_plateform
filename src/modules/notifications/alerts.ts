/**
 * The events other modules raise, each with its recipients, severity, text and link (frontend
 * routes). Callers pass what they already have; nothing here re-reads business data.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { rs } from '../../core/pdf/templates.js';
import { notify, type Recipient } from './notifications.service.js';

const team = (projectId: string, ...roles: Array<'PM' | 'MUNSHI'>): Recipient => ({ projectRoles: roles, projectId });
type Base = { tenantId: string; at?: Date };

// ─── Procurement / dispatch ─────────────────────────────────────────────────

export const dispatchCreated = (tx: Tx, e: Base & { projectId: string; projectName: string; dispatchId: string; number: string; lines: string[] }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: [team(e.projectId, 'PM', 'MUNSHI')],
    type: 'DISPATCH_CREATED',
    severity: 'INFO',
    title: `${e.number} on the way to ${e.projectName}`,
    body: e.lines.join(', '),
    projectId: e.projectId,
    ref: { type: 'DISPATCH', id: e.dispatchId },
    actionUrl: `/projects/${e.projectId}/site/incoming`,
    ...(e.at ? { at: e.at } : {}),
  });

export const shortageCreated = (tx: Tx, e: Base & { projectId: string | null; refType: 'DISPATCH' | 'PURCHASE'; refId: string; number: string; where: string; count: number }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'SHORTAGE_CREATED',
    severity: 'WARNING',
    title: `Shortage on ${e.number}`,
    body: `${e.count} ${e.count === 1 ? 'item was' : 'items were'} short or damaged at ${e.where}. Decide what to do with ${e.count === 1 ? 'it' : 'them'}.`,
    projectId: e.projectId,
    ref: { type: e.refType, id: e.refId },
    actionUrl: '/suppliers-stock/shortages',
    ...(e.at ? { at: e.at } : {}),
  });

export const lowStock = (tx: Tx, e: Base & { materialId: string; material: string; unit: string; left: string; min: string; store: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'LOW_STOCK',
    severity: 'WARNING',
    title: `Low stock: ${e.material}`,
    body: `${e.store} has ${e.left} ${e.unit} left (minimum ${e.min}).`,
    ref: { type: 'MATERIAL', id: e.materialId },
    actionUrl: '/suppliers-stock/store-stock',
    ...(e.at ? { at: e.at } : {}),
  });

export const purchasePendingRate = (tx: Tx, e: Base & { projectId: string | null; purchaseId: string; number: string; supplier: string; where: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR', ...(e.projectId ? [team(e.projectId, 'PM')] : [])],
    type: 'PURCHASE_PENDING_RATE',
    severity: 'INFO',
    title: `Add rates: ${e.number}`,
    body: `${e.supplier} delivered at ${e.where}; the site entered it without rates.`,
    projectId: e.projectId,
    ref: { type: 'PURCHASE', id: e.purchaseId },
    actionUrl: `/suppliers-stock/purchases/${e.purchaseId}`,
    ...(e.at ? { at: e.at } : {}),
  });

// ─── Labour / cash ──────────────────────────────────────────────────────────

export const settlementSubmitted = (tx: Tx, e: Base & { projectId: string; projectName: string; settlementId: string; week: string; netPaisa: bigint }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR', team(e.projectId, 'PM')],
    type: 'SETTLEMENT_SUBMITTED',
    severity: 'INFO',
    title: `Wages to approve — ${e.projectName}`,
    body: `Week ${e.week}: net ${rs(e.netPaisa)} submitted for approval.`,
    projectId: e.projectId,
    ref: { type: 'SETTLEMENT', id: e.settlementId },
    actionUrl: `/projects/${e.projectId}/labor/settlements/${e.settlementId}`,
    ...(e.at ? { at: e.at } : {}),
  });

export const settlementReturned = (tx: Tx, e: Base & { projectId: string; projectName: string; settlementId: string; week: string; comment: string; submittedById: string | null }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: [{ userIds: e.submittedById ? [e.submittedById] : [] }],
    type: 'SETTLEMENT_RETURNED',
    severity: 'WARNING',
    title: `Wages returned — ${e.projectName}`,
    body: `Week ${e.week} was sent back: ${e.comment}`,
    projectId: e.projectId,
    ref: { type: 'SETTLEMENT', id: e.settlementId },
    actionUrl: `/projects/${e.projectId}/labor/settlements/${e.settlementId}`,
    ...(e.at ? { at: e.at } : {}),
  });

export const expensePending = (tx: Tx, e: Base & { projectId: string | null; entryId: string; holder: string; amountPaisa: bigint; description: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR', ...(e.projectId ? [team(e.projectId, 'PM')] : [])],
    type: 'EXPENSE_PENDING_APPROVAL',
    severity: 'WARNING',
    title: `Kharcha to approve: ${rs(e.amountPaisa)}`,
    body: `${e.holder} spent ${rs(e.amountPaisa)} on ${e.description} — above the approval limit.`,
    projectId: e.projectId,
    ref: { type: 'CASH_ENTRY', id: e.entryId },
    actionUrl: e.projectId ? `/projects/${e.projectId}/cash-book/kharcha` : '/dashboard/approvals',
    ...(e.at ? { at: e.at } : {}),
  });

export const topupRequested = (tx: Tx, e: Base & { topupId: string; holder: string; amountPaisa: bigint; projectId?: string | null }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'TOPUP_REQUESTED',
    severity: 'INFO',
    title: `Top-up request: ${rs(e.amountPaisa)}`,
    body: `${e.holder} asked for ${rs(e.amountPaisa)} more site cash.`,
    projectId: e.projectId ?? null,
    ref: { type: 'TOPUP', id: e.topupId },
    actionUrl: '/finance/cash-floats',
    ...(e.at ? { at: e.at } : {}),
  });

export const floatSent = (tx: Tx, e: Base & { holderUserId: string; entryId: string; amountPaisa: bigint; projectId: string | null; method: string | null }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: [{ userIds: [e.holderUserId] }],
    type: 'FLOAT_SENT',
    severity: 'INFO',
    title: `Cash sent to you: ${rs(e.amountPaisa)}`,
    body: `${rs(e.amountPaisa)}${e.method ? ` by ${e.method.replace('_', ' ').toLowerCase()}` : ''} — confirm when you receive it.`,
    projectId: e.projectId,
    ref: { type: 'CASH_ENTRY', id: e.entryId },
    actionUrl: e.projectId ? `/projects/${e.projectId}/cash-book/floats` : '/dashboard',
    ...(e.at ? { at: e.at } : {}),
  });

export const measurementRecorded = (tx: Tx, e: Base & { projectId: string; projectName: string; measurementId: string; subcontractor: string; quantity: string; unit: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: [team(e.projectId, 'PM')],
    type: 'MEASUREMENT_RECORDED',
    severity: 'INFO',
    title: `Measurement to verify — ${e.projectName}`,
    body: `${e.subcontractor}: ${e.quantity} ${e.unit} recorded.`,
    projectId: e.projectId,
    ref: { type: 'MEASUREMENT', id: e.measurementId },
    actionUrl: `/projects/${e.projectId}/labor/measurements`,
    ...(e.at ? { at: e.at } : {}),
  });

export const subcontractorOverpaid = (tx: Tx, e: Base & { projectId: string; assignmentId: string; subcontractor: string; overpaidPaisa: bigint }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'SUBCONTRACTOR_OVERPAID',
    severity: 'WARNING',
    title: `${e.subcontractor} is overpaid`,
    body: `Paid ${rs(e.overpaidPaisa)} more than the verified work.`,
    projectId: e.projectId,
    ref: { type: 'SUBCONTRACT_ASSIGNMENT', id: e.assignmentId },
    actionUrl: `/projects/${e.projectId}/labor/subcontractor-accounts`,
    ...(e.at ? { at: e.at } : {}),
  });

// ─── Billing ────────────────────────────────────────────────────────────────

const billingTeam = (projectId: string): Recipient[] => ['THEKEDAR', team(projectId, 'PM')];

export const invoiceOverdue = (tx: Tx, e: Base & { projectId: string; projectName: string; invoiceId: string; number: string; balancePaisa: bigint; overdueDays: number }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: billingTeam(e.projectId),
    type: 'INVOICE_OVERDUE',
    severity: 'WARNING',
    title: `${e.number} overdue — ${e.projectName}`,
    body: `${rs(e.balancePaisa)} is ${e.overdueDays} ${e.overdueDays === 1 ? 'day' : 'days'} past due.`,
    projectId: e.projectId,
    ref: { type: 'INVOICE', id: e.invoiceId },
    actionUrl: `/projects/${e.projectId}/billing/invoices/${e.invoiceId}`,
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

export const chequeBounced = (tx: Tx, e: Base & { projectId: string; projectName: string; paymentId: string; cheque: string; amountPaisa: bigint; reason: string; sms: string | false }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: billingTeam(e.projectId),
    type: 'CHEQUE_BOUNCED',
    severity: 'CRITICAL',
    title: `Cheque bounced — ${e.projectName}`,
    body: `${e.cheque} (${rs(e.amountPaisa)}) bounced: ${e.reason}.`,
    projectId: e.projectId,
    ref: { type: 'PAYMENT', id: e.paymentId },
    actionUrl: `/projects/${e.projectId}/billing/payments`,
    sms: e.sms,
    ...(e.at ? { at: e.at } : {}),
  });

export const stageReadyUnbilled = (tx: Tx, e: Base & { projectId: string; projectName: string; stageId: string; label: string; days: number; amountPaisa: bigint }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: billingTeam(e.projectId),
    type: 'STAGE_READY_UNBILLED',
    severity: 'WARNING',
    title: `Bill the owner — ${e.projectName}`,
    body: `"${e.label}" (${rs(e.amountPaisa)}) has been ready for ${e.days} days without an invoice.`,
    projectId: e.projectId,
    ref: { type: 'STAGE', id: e.stageId },
    actionUrl: `/projects/${e.projectId}/billing/schedule`,
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

export const previousStageUnpaid = (tx: Tx, e: Base & { projectId: string; projectName: string; stageId: string; label: string; unpaid: number }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: billingTeam(e.projectId),
    type: 'PREVIOUS_STAGE_UNPAID',
    severity: 'WARNING',
    title: `Earlier stage unpaid — ${e.projectName}`,
    body: `"${e.label}" is ready but ${e.unpaid === 1 ? 'an earlier stage is' : `${e.unpaid} earlier stages are`} still unpaid past the due date.`,
    projectId: e.projectId,
    ref: { type: 'STAGE', id: e.stageId },
    actionUrl: `/projects/${e.projectId}/billing/schedule`,
    ...(e.at ? { at: e.at } : {}),
  });

// ─── Subscription / team ────────────────────────────────────────────────────

export const subscriptionRenewal = (tx: Tx, e: Base & { subscriptionId: string; plan: string; endsOn: string; days: number }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'SUBSCRIPTION_RENEWAL',
    severity: e.days <= 1 ? 'CRITICAL' : 'WARNING',
    title: `${e.plan} plan ends in ${e.days} ${e.days === 1 ? 'day' : 'days'}`,
    body: `Your plan ends on ${e.endsOn}. Upload the payment slip to keep the account active.`,
    ref: { type: 'SUBSCRIPTION', id: e.subscriptionId },
    actionUrl: '/settings/subscription',
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

export const subscriptionPayment = (tx: Tx, e: Base & { paymentId: string; approved: boolean; detail: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: e.approved ? 'SUBSCRIPTION_PAYMENT_APPROVED' : 'SUBSCRIPTION_PAYMENT_REJECTED',
    severity: e.approved ? 'INFO' : 'WARNING',
    title: e.approved ? 'Subscription payment approved' : 'Subscription payment rejected',
    body: e.detail,
    ref: { type: 'SUBSCRIPTION_PAYMENT', id: e.paymentId },
    actionUrl: '/settings/subscription',
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

export const inviteAccepted = (tx: Tx, e: Base & { userId: string; name: string; role: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'INVITE_ACCEPTED',
    severity: 'INFO',
    title: `${e.name} joined the team`,
    body: `${e.name} accepted the invitation and joined as ${e.role === 'PM' ? 'project manager' : e.role.toLowerCase()}.`,
    ref: { type: 'USER', id: e.userId },
    actionUrl: '/team/members',
    actorId: e.userId,
    ...(e.at ? { at: e.at } : {}),
  });
