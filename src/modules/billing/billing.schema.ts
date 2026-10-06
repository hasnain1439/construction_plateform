import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { note, quantitySchema, uuid } from '../inventory/inventory.schema.js';
import { amountSchema, requiredNote } from '../labor/labor.schema.js';

export const idParams = z.object({ id: uuid('id') });
const attachmentIds = z.array(uuid('attachmentId')).max(10);

export const invoiceTypeSchema = z.enum(['STAGE', 'RUNNING_BILL', 'RECOVERABLE', 'RETENTION', 'OTHER']);
export const invoiceStatusSchema = z.enum(['DRAFT', 'ISSUED', 'PARTLY_PAID', 'PAID', 'CANCELLED']);
export const paymentMethodSchema = z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'JAZZCASH', 'EASYPAISA', 'RAAST']);

// ─── B1: stages and running-bill progress ───────────────────────────────────

export const markReadyBody = z.object({
  proofAttachmentIds: attachmentIds.min(1, 'Add at least one photo of the finished work'),
  note: note.optional(),
});

export const updateStageBody = z.object({ expectedDate: isoDateSchema.nullable() });

export const progressBody = z.object({
  date: isoDateSchema,
  quantity: quantitySchema.meta({ description: 'Sq ft done', example: 1200 }),
  description: z.string().trim().min(2, 'Describe the work').max(300).meta({ example: 'Ground-floor brickwork + plaster' }),
  attachmentIds: attachmentIds.optional(),
});
export const updateProgressBody = progressBody.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export const progressQuery = z.object({ billed: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

// ─── B2: invoices ───────────────────────────────────────────────────────────

const manualLine = z.object({
  description: z.string().trim().min(2, 'Describe the line').max(300),
  quantity: quantitySchema.optional(),
  unit: z.string().trim().max(20).optional(),
  ratePaisa: paisaSchema.optional(),
  amountPaisa: paisaSchema.optional().meta({ description: 'Defaults to quantity × rate' }),
});

export const createInvoiceBody = z
  .object({
    type: invoiceTypeSchema,
    billingStageId: uuid('billingStageId').optional().meta({ description: 'STAGE' }),
    force: z.boolean().optional().meta({ description: 'STAGE: invoice a stage that is not marked ready yet (note required)' }),
    forceNote: note.optional(),
    from: isoDateSchema.optional().meta({ description: 'RUNNING_BILL period' }),
    to: isoDateSchema.optional(),
    cashEntryIds: z.array(uuid('cashEntryId')).max(100).optional().meta({ description: 'RECOVERABLE: owner-recoverable kharcha entries' }),
    extraCashEntryIds: z.array(uuid('cashEntryId')).max(100).optional().meta({ description: 'STAGE: also bill these owner-recoverable entries' }),
    lines: z.array(manualLine).min(1).max(50).optional().meta({ description: 'OTHER: manual lines (THEKEDAR)' }),
    notes: note.optional(),
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, path: string, message: string) => (!ok ? ctx.addIssue({ code: 'custom', path: [path], message }) : undefined);
    if (v.type === 'STAGE') need(!!v.billingStageId, 'billingStageId', 'Choose the stage');
    if (v.type === 'STAGE' && v.force) need(!!v.forceNote && v.forceNote.length >= 3, 'forceNote', 'Say why the stage is billed before it is ready');
    if (v.type === 'RUNNING_BILL') {
      need(!!v.from && !!v.to, 'from', 'Choose the period');
      if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must be on or after `from`' });
    }
    if (v.type === 'RECOVERABLE') need(!!v.cashEntryIds?.length, 'cashEntryIds', 'Choose the items to recover');
    if (v.type === 'OTHER') need(!!v.lines?.length, 'lines', 'Add at least one line');
  });

export const updateInvoiceBody = z
  .object({
    notes: note.nullable().optional(),
    dueDate: isoDateSchema.optional(),
    lines: z.array(manualLine).min(1).max(50).optional().meta({ description: 'OTHER drafts only: replaces the manual lines' }),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const issueBody = z.object({ issueDate: isoDateSchema.optional().meta({ description: 'Defaults to today' }) }).default({});
export const cancelBody = z.object({ reason: requiredNote });
export const invoicesQuery = paginationQuery.extend({
  status: invoiceStatusSchema.optional(),
  type: invoiceTypeSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ─── B3: payments ───────────────────────────────────────────────────────────

export const paymentBody = z
  .object({
    receivedOn: isoDateSchema,
    amountPaisa: amountSchema,
    method: paymentMethodSchema,
    bankName: z.string().trim().max(60).optional(),
    reference: z.string().trim().max(60).optional(),
    chequeNo: z.string().trim().max(30).optional(),
    chequeDate: isoDateSchema.optional(),
    whtDeductedPaisa: paisaSchema.optional().meta({ description: 'Tax withheld by the owner (only when tax is on)' }),
    attachmentId: uuid('attachmentId').optional(),
    note: note.optional(),
    allocations: z
      .array(z.object({ invoiceId: uuid('invoiceId'), amountPaisa: amountSchema }))
      .max(50)
      .optional()
      .meta({ description: 'Omit to settle the oldest due invoices first; any remainder is kept as project credit' }),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'CHEQUE' && !v.chequeNo) ctx.addIssue({ code: 'custom', path: ['chequeNo'], message: 'Enter the cheque number' });
    const seen = new Set<string>();
    v.allocations?.forEach((a, i) => {
      if (seen.has(a.invoiceId)) ctx.addIssue({ code: 'custom', path: ['allocations', i, 'invoiceId'], message: 'This invoice is listed twice' });
      seen.add(a.invoiceId);
    });
  });

export const chequeStatusBody = z
  .object({ status: z.enum(['CLEARED', 'BOUNCED']), reason: note.optional(), date: isoDateSchema.optional() })
  .superRefine((v, ctx) => {
    if (v.status === 'BOUNCED' && (!v.reason || v.reason.length < 3)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why the cheque bounced' });
  });

export const paymentsQuery = paginationQuery.extend({
  status: z.enum(['CLEARED', 'PENDING', 'BOUNCED']).optional(),
  method: paymentMethodSchema.optional(),
});

// ─── B4–B6 ──────────────────────────────────────────────────────────────────

export const receivablesQuery = z.object({
  status: z.enum(['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED']).optional(),
  overdueOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export const statementQuery = z
  .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['to'] });
export const eventsQuery = z.object({ openOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

export type MarkReadyInput = z.infer<typeof markReadyBody>;
export type UpdateStageInput = z.infer<typeof updateStageBody>;
export type ProgressInput = z.infer<typeof progressBody>;
export type UpdateProgressInput = z.infer<typeof updateProgressBody>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceBody>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceBody>;
export type InvoicesQuery = z.infer<typeof invoicesQuery>;
export type PaymentInput = z.infer<typeof paymentBody>;
export type ChequeStatusInput = z.infer<typeof chequeStatusBody>;
export type PaymentsQuery = z.infer<typeof paymentsQuery>;
export type ReceivablesQuery = z.infer<typeof receivablesQuery>;
export type StatementQuery = z.infer<typeof statementQuery>;
export type ManualLine = z.infer<typeof manualLine>;
