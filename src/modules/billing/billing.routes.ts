import { Router } from 'express';
import { langQuery } from '../../core/i18n/lang.js';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './billing.controller.js';
import {
  cancelBody,
  chequeStatusBody,
  createInvoiceBody,
  eventsQuery,
  idParams,
  invoicesQuery,
  issueBody,
  markReadyBody,
  paymentBody,
  paymentsQuery,
  progressBody,
  progressQuery,
  receivablesQuery,
  statementQuery,
  updateInvoiceBody,
  updateProgressBody,
  updateStageBody,
  whtCertificateBody,
} from './billing.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm(billing.*) → validate.
 * Without the permission → 403 PERMISSION_DENIED; a project outside the caller's scope is 404.
 * Finer rules (manual invoices, other people's drafts, the pmCanRecordPayments setting) are in the services.
 */
const perm = (key: string) => [...company, requirePerm(key)];
const view = perm('billing.invoice.view');
const prepare = perm('billing.invoice.create');

/** Project-scoped billing routes, mounted at /api/v1/projects before the projects router. */
export const projectBillingRouter = Router();
const p = projectBillingRouter;
p.get('/:id/billing-stages', ...view, validate({ params: idParams }), h(c.listStages));
p.get('/:id/billing-progress', ...view, validate({ params: idParams, query: progressQuery }), h(c.listProgress));
p.post('/:id/billing-progress', ...prepare, validate({ params: idParams, body: progressBody }), h(c.addProgress));
p.get('/:id/invoices', ...view, validate({ params: idParams, query: invoicesQuery }), h(c.listInvoices));
p.post('/:id/invoices', ...prepare, validate({ params: idParams, body: createInvoiceBody }), h(c.createInvoice));
p.get('/:id/payments', ...perm('billing.payment.view'), validate({ params: idParams, query: paymentsQuery }), h(c.listPayments));
p.post('/:id/payments', ...perm('billing.payment.create'), validate({ params: idParams, body: paymentBody }), h(c.recordPayment));
p.get('/:id/receivables', ...view, validate({ params: idParams }), h(c.projectReceivables));
p.get('/:id/owner-statement', ...view, validate({ params: idParams, query: statementQuery }), h(c.ownerStatement));
p.get('/:id/owner-statement/pdf', ...view, validate({ params: idParams, query: statementQuery }), h(c.ownerStatementPdf));

/** Mounted at /api/v1/billing-stages */
export const billingStagesRouter = Router();
billingStagesRouter.post('/:id/mark-ready', ...prepare, validate({ params: idParams, body: markReadyBody }), h(c.markReady));
billingStagesRouter.patch('/:id', ...perm('billing.stage.manage'), validate({ params: idParams, body: updateStageBody }), h(c.updateStage));

/** Mounted at /api/v1/billing-progress */
export const billingProgressRouter = Router();
billingProgressRouter.patch('/:id', ...prepare, validate({ params: idParams, body: updateProgressBody }), h(c.updateProgress));
billingProgressRouter.delete('/:id', ...prepare, validate({ params: idParams }), h(c.deleteProgress));

/** Mounted at /api/v1/invoices */
export const invoicesRouter = Router();
invoicesRouter.get('/:id', ...view, validate({ params: idParams }), h(c.getInvoice));
invoicesRouter.patch('/:id', ...prepare, validate({ params: idParams, body: updateInvoiceBody }), h(c.updateInvoice));
invoicesRouter.delete('/:id', ...prepare, validate({ params: idParams }), h(c.deleteInvoice));
invoicesRouter.post('/:id/issue', ...perm('billing.invoice.approve'), validate({ params: idParams, body: issueBody }), h(c.issueInvoice));
invoicesRouter.post('/:id/cancel', ...perm('billing.invoice.approve'), validate({ params: idParams, body: cancelBody }), h(c.cancelInvoice));
invoicesRouter.get('/:id/pdf', ...view, validate({ params: idParams, query: langQuery }), h(c.invoicePdf));

/** Mounted at /api/v1/payments (owner payments; supplier payments are /supplier-payments) */
export const clientPaymentsRouter = Router();
clientPaymentsRouter.get('/:id', ...perm('billing.payment.view'), validate({ params: idParams }), h(c.getPayment));
clientPaymentsRouter.patch('/:id/cheque-status', ...perm('billing.payment.manage'), validate({ params: idParams, body: chequeStatusBody }), h(c.chequeStatus));
clientPaymentsRouter.patch('/:id/wht-certificate', ...perm('billing.payment.create'), validate({ params: idParams, body: whtCertificateBody }), h(c.whtCertificate)); // Step 18
clientPaymentsRouter.get('/:id/receipt-pdf', ...perm('billing.payment.view'), validate({ params: idParams, query: langQuery }), h(c.receiptPdf));

/** Mounted at /api/v1/receivables (THEKEDAR) */
export const receivablesRouter = Router();
receivablesRouter.get('/', ...perm('finance.receivables.view'), validate({ query: receivablesQuery }), h(c.companyReceivables));

/** Mounted at /api/v1/billing-events (THEKEDAR) */
export const billingEventsRouter = Router();
billingEventsRouter.get('/', ...perm('finance.receivables.view'), validate({ query: eventsQuery }), h(c.listEvents));
