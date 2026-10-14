/**
 * The events other modules raise, each with its recipients, severity, text and link (frontend
 * routes). Callers pass what they already have; nothing here re-reads business data.
 * Texts are catalogue keys + params (core/i18n, notifications/texts.ts): each recipient gets
 * them in their own language.
 */
import type { Tx } from '../../core/db/withTenant.js';
import type { MaterialLine } from '../../core/i18n/index.js';
import { rs } from '../../core/pdf/templates.js';
import { notify, type Recipient } from './notifications.service.js';

const team = (projectId: string, ...roles: Array<'PM' | 'MUNSHI'>): Recipient => ({ projectRoles: roles, projectId });
type Base = { tenantId: string; at?: Date };

// ─── Procurement / dispatch ─────────────────────────────────────────────────

export const dispatchCreated = (tx: Tx, e: Base & { projectId: string; projectName: string; dispatchId: string; number: string; lines: MaterialLine[] }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: [team(e.projectId, 'PM', 'MUNSHI')],
    type: 'DISPATCH_CREATED',
    severity: 'INFO',
    text: { key: 'dispatchCreated', params: { number: e.number, project: e.projectName, lines: e.lines } },
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
    text: { key: 'shortageCreated', params: { number: e.number, where: e.where, count: e.count } },
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
    text: { key: 'lowStock', params: { material: e.material, store: e.store, left: e.left, unit: e.unit, min: e.min } },
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
    text: { key: 'purchasePendingRate', params: { number: e.number, supplier: e.supplier, where: e.where } },
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
    text: { key: 'settlementSubmitted', params: { project: e.projectName, week: e.week, amount: rs(e.netPaisa) } },
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
    text: { key: 'settlementReturned', params: { project: e.projectName, week: e.week, comment: e.comment } },
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
    text: { key: 'expensePending', params: { amount: rs(e.amountPaisa), holder: e.holder, description: e.description } },
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
    text: { key: 'topupRequested', params: { amount: rs(e.amountPaisa), holder: e.holder } },
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
    text: e.method ? { key: 'floatSentBy', params: { amount: rs(e.amountPaisa), method: e.method } } : { key: 'floatSent', params: { amount: rs(e.amountPaisa) } },
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
    text: { key: 'measurementRecorded', params: { project: e.projectName, subcontractor: e.subcontractor, quantity: e.quantity, unit: e.unit } },
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
    text: { key: 'subcontractorOverpaid', params: { subcontractor: e.subcontractor, amount: rs(e.overpaidPaisa) } },
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
    text: { key: 'invoiceOverdue', params: { number: e.number, project: e.projectName, amount: rs(e.balancePaisa), count: e.overdueDays } },
    projectId: e.projectId,
    ref: { type: 'INVOICE', id: e.invoiceId },
    actionUrl: `/projects/${e.projectId}/billing/invoices/${e.invoiceId}`,
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

/** `sms`: true = the SMS text in each recipient's language; a string = exactly that; false = none. */
export const chequeBounced = (tx: Tx, e: Base & { projectId: string; projectName: string; paymentId: string; cheque: string; amountPaisa: bigint; reason: string; sms: boolean | string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: billingTeam(e.projectId),
    type: 'CHEQUE_BOUNCED',
    severity: 'CRITICAL',
    text: { key: 'chequeBounced', params: { project: e.projectName, cheque: e.cheque, amount: rs(e.amountPaisa), reason: e.reason } },
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
    text: { key: 'stageReadyUnbilled', params: { project: e.projectName, label: e.label, amount: rs(e.amountPaisa), count: e.days } },
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
    text: { key: 'previousStageUnpaid', params: { project: e.projectName, label: e.label, count: e.unpaid } },
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
    text: { key: 'subscriptionRenewal', params: { plan: e.plan, endsOn: e.endsOn, count: e.days } },
    ref: { type: 'SUBSCRIPTION', id: e.subscriptionId },
    actionUrl: '/settings/subscription',
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });

export const subscriptionPayment = (
  tx: Tx,
  e: Base & { paymentId: string } & ({ approved: true; plan: string; until: string; receipt: string } | { approved: false; transactionId: string; reason: string }),
) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: e.approved ? 'SUBSCRIPTION_PAYMENT_APPROVED' : 'SUBSCRIPTION_PAYMENT_REJECTED',
    severity: e.approved ? 'INFO' : 'WARNING',
    text: e.approved
      ? { key: 'subscriptionPaymentApproved', params: { plan: e.plan, until: e.until, receipt: e.receipt } }
      : { key: 'subscriptionPaymentRejected', params: { transactionId: e.transactionId, reason: e.reason } },
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
    text: { key: 'inviteAccepted', params: { name: e.name, role: e.role } },
    ref: { type: 'USER', id: e.userId },
    actionUrl: '/team/members',
    actorId: e.userId,
    ...(e.at ? { at: e.at } : {}),
  });

// ─── Platform support ───────────────────────────────────────────────────────

/** A platform super admin opened the company (act-as session) — every owner is told why. */
export const platformSupportAccess = (tx: Tx, e: Base & { sessionId: string; adminName: string; reason: string }) =>
  notify(tx, {
    tenantId: e.tenantId,
    recipients: ['THEKEDAR'],
    type: 'PLATFORM_SUPPORT_ACCESS',
    severity: 'WARNING',
    text: { key: 'platformSupportAccess', params: { reason: e.reason, admin: e.adminName } },
    ref: { type: 'ACT_AS_SESSION', id: e.sessionId },
    actionUrl: '/settings/audit-log',
    actorId: null,
    ...(e.at ? { at: e.at } : {}),
  });
