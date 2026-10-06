import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type {
  ChequeStatusInput,
  CreateInvoiceInput,
  InvoicesQuery,
  MarkReadyInput,
  PaymentInput,
  PaymentsQuery,
  ProgressInput,
  ReceivablesQuery,
  StatementQuery,
  UpdateInvoiceInput,
  UpdateProgressInput,
  UpdateStageInput,
} from './billing.schema.js';
import * as events from './events.service.js';
import * as invoices from './invoices.service.js';
import * as payments from './payments.service.js';
import * as receivables from './receivables.service.js';
import * as stages from './stages.service.js';
import * as statements from './statements.service.js';

const param = (req: Request, name: string) => String(req.params[name]);
const query = <T>(req: Request) => req.query as unknown as T;
const paged = (res: Response, r: { data: unknown; meta: Record<string, unknown> }) => ok(res, r.data, r.meta);

// B1
export const listStages = async (req: Request, res: Response) => ok(res, await stages.listStages(param(req, 'id')));
export const markReady = async (req: Request, res: Response) => ok(res, await stages.markReady(param(req, 'id'), req.body as MarkReadyInput));
export const updateStage = async (req: Request, res: Response) => ok(res, await stages.updateStage(param(req, 'id'), req.body as UpdateStageInput));
export const listProgress = async (req: Request, res: Response) => ok(res, await stages.listProgress(param(req, 'id'), query<{ billed?: boolean }>(req)));
export const addProgress = async (req: Request, res: Response) => created(res, await stages.addProgress(param(req, 'id'), req.body as ProgressInput));
export const updateProgress = async (req: Request, res: Response) => ok(res, await stages.updateProgress(param(req, 'id'), req.body as UpdateProgressInput));
export const deleteProgress = async (req: Request, res: Response) => ok(res, await stages.deleteProgress(param(req, 'id')));

// B2
export const createInvoice = async (req: Request, res: Response) => created(res, await invoices.createInvoice(param(req, 'id'), req.body as CreateInvoiceInput));
export const listInvoices = async (req: Request, res: Response) => paged(res, await invoices.listInvoices(param(req, 'id'), query<InvoicesQuery>(req)));
export const getInvoice = async (req: Request, res: Response) => ok(res, await invoices.getInvoice(param(req, 'id')));
export const updateInvoice = async (req: Request, res: Response) => ok(res, await invoices.updateInvoice(param(req, 'id'), req.body as UpdateInvoiceInput));
export const deleteInvoice = async (req: Request, res: Response) => ok(res, await invoices.deleteInvoice(param(req, 'id')));
export const issueInvoice = async (req: Request, res: Response) => ok(res, await invoices.issue(param(req, 'id'), (req.body ?? {}) as { issueDate?: string }));
export const cancelInvoice = async (req: Request, res: Response) => ok(res, await invoices.cancel(param(req, 'id'), (req.body as { reason: string }).reason));
export const invoicePdf = async (req: Request, res: Response) => ok(res, await invoices.invoicePdf(param(req, 'id')));

// B3
export const recordPayment = async (req: Request, res: Response) => created(res, await payments.recordPayment(param(req, 'id'), req.body as PaymentInput));
export const listPayments = async (req: Request, res: Response) => paged(res, await payments.listPayments(param(req, 'id'), query<PaymentsQuery>(req)));
export const getPayment = async (req: Request, res: Response) => ok(res, await payments.getPayment(param(req, 'id')));
export const chequeStatus = async (req: Request, res: Response) => ok(res, await payments.chequeStatus(param(req, 'id'), req.body as ChequeStatusInput));
export const receiptPdf = async (req: Request, res: Response) => ok(res, await payments.receiptPdf(param(req, 'id')));

// B4–B6
export const projectReceivables = async (req: Request, res: Response) => ok(res, await receivables.projectReceivables(param(req, 'id')));
export const companyReceivables = async (req: Request, res: Response) => ok(res, await receivables.companyReceivables(query<ReceivablesQuery>(req)));
export const ownerStatement = async (req: Request, res: Response) => ok(res, await statements.ownerStatement(param(req, 'id'), query<StatementQuery>(req)));
export const ownerStatementPdf = async (req: Request, res: Response) => ok(res, await statements.ownerStatementPdf(param(req, 'id'), query<StatementQuery>(req)));
export const listEvents = async (req: Request, res: Response) => ok(res, await events.listEvents(query<{ openOnly?: boolean }>(req)));
