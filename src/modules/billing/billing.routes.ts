import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePermission, requireRole } from '../../core/middleware/requireRole.js';
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
} from './billing.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → THEKEDAR / PM + billing.view → validate.
 * MUNSHI and a PM without financials get 403; a project outside a PM's list is 404.
 * Owner-only actions (issue, cancel, cheque status, manual invoices, …) are checked in the services.
 */
const billing = [...company, requireRole('THEKEDAR', 'PM'), requirePermission('billing.view')];
const owner = requireRole('THEKEDAR');

/** Project-scoped billing routes, mounted at /api/v1/projects before the projects router. */
export const projectBillingRouter = Router();
const p = projectBillingRouter;
p.get('/:id/billing-stages', ...billing, validate({ params: idParams }), h(c.listStages));
p.get('/:id/billing-progress', ...billing, validate({ params: idParams, query: progressQuery }), h(c.listProgress));
p.post('/:id/billing-progress', ...billing, validate({ params: idParams, body: progressBody }), h(c.addProgress));
p.get('/:id/invoices', ...billing, validate({ params: idParams, query: invoicesQuery }), h(c.listInvoices));
p.post('/:id/invoices', ...billing, validate({ params: idParams, body: createInvoiceBody }), h(c.createInvoice));
p.get('/:id/payments', ...billing, validate({ params: idParams, query: paymentsQuery }), h(c.listPayments));
p.post('/:id/payments', ...billing, validate({ params: idParams, body: paymentBody }), h(c.recordPayment));
p.get('/:id/receivables', ...billing, validate({ params: idParams }), h(c.projectReceivables));
p.get('/:id/owner-statement', ...billing, validate({ params: idParams, query: statementQuery }), h(c.ownerStatement));
p.get('/:id/owner-statement/pdf', ...billing, validate({ params: idParams, query: statementQuery }), h(c.ownerStatementPdf));

/** Mounted at /api/v1/billing-stages */
export const billingStagesRouter = Router();
billingStagesRouter.post('/:id/mark-ready', ...billing, validate({ params: idParams, body: markReadyBody }), h(c.markReady));
billingStagesRouter.patch('/:id', ...billing, owner, validate({ params: idParams, body: updateStageBody }), h(c.updateStage));

/** Mounted at /api/v1/billing-progress */
export const billingProgressRouter = Router();
billingProgressRouter.patch('/:id', ...billing, validate({ params: idParams, body: updateProgressBody }), h(c.updateProgress));
billingProgressRouter.delete('/:id', ...billing, validate({ params: idParams }), h(c.deleteProgress));

/** Mounted at /api/v1/invoices */
export const invoicesRouter = Router();
invoicesRouter.get('/:id', ...billing, validate({ params: idParams }), h(c.getInvoice));
invoicesRouter.patch('/:id', ...billing, validate({ params: idParams, body: updateInvoiceBody }), h(c.updateInvoice));
invoicesRouter.delete('/:id', ...billing, validate({ params: idParams }), h(c.deleteInvoice));
invoicesRouter.post('/:id/issue', ...billing, owner, validate({ params: idParams, body: issueBody }), h(c.issueInvoice));
invoicesRouter.post('/:id/cancel', ...billing, owner, validate({ params: idParams, body: cancelBody }), h(c.cancelInvoice));
invoicesRouter.get('/:id/pdf', ...billing, validate({ params: idParams }), h(c.invoicePdf));

/** Mounted at /api/v1/payments (owner payments; supplier payments are /supplier-payments) */
export const clientPaymentsRouter = Router();
clientPaymentsRouter.get('/:id', ...billing, validate({ params: idParams }), h(c.getPayment));
clientPaymentsRouter.patch('/:id/cheque-status', ...billing, owner, validate({ params: idParams, body: chequeStatusBody }), h(c.chequeStatus));
clientPaymentsRouter.get('/:id/receipt-pdf', ...billing, validate({ params: idParams }), h(c.receiptPdf));

/** Mounted at /api/v1/receivables (THEKEDAR) */
export const receivablesRouter = Router();
receivablesRouter.get('/', ...billing, owner, validate({ query: receivablesQuery }), h(c.companyReceivables));

/** Mounted at /api/v1/billing-events (THEKEDAR) */
export const billingEventsRouter = Router();
billingEventsRouter.get('/', ...billing, owner, validate({ query: eventsQuery }), h(c.listEvents));
