import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { boolQuery, countSchema, note, quantitySchema, uniqueMaterials, uuid } from '../inventory/inventory.schema.js';

export { idParams } from '../inventory/inventory.schema.js';

export const deliverToSchema = z.enum(['STORE', 'SITE']);
export const paymentModeSchema = z.enum(['UDHAAR', 'CASH', 'PARTIAL']);
export const paidFromSchema = z.enum(['OFFICE_CASH', 'BANK', 'CHEQUE', 'JAZZCASH', 'EASYPAISA', 'SITE_CASH']);
export const purchaseStatusSchema = z.enum(['SAVED', 'PENDING_RATE', 'PENDING_RECEIPT', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE']);
export const poStatusSchema = z.enum(['OPEN', 'PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED']);
export const paymentMethodSchema = z.enum(['CASH', 'BANK', 'CHEQUE', 'JAZZCASH', 'EASYPAISA']);
export const paymentStatusSchema = z.enum(['CLEARED', 'PENDING', 'BOUNCED']);

const ref = (label: string, max = 40) => z.string().trim().min(1, `Enter the ${label}`).max(max);

/** SITE deliveries need the project. */
function siteNeedsProject(v: { deliverTo?: string; projectId?: string | null }, ctx: z.RefinementCtx) {
  if (v.deliverTo === 'SITE' && !v.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Choose the project site' });
}

// ─── Purchase orders ────────────────────────────────────────────────────────

const poItems = z
  .array(z.object({ materialId: uuid('materialId'), orderedQty: quantitySchema, ratePaisa: paisaSchema }))
  .min(1, 'Add at least one material')
  .max(100)
  .superRefine(uniqueMaterials);

export const createPurchaseOrderBody = z
  .object({
    supplierId: uuid('supplierId'),
    deliverTo: deliverToSchema,
    projectId: uuid('projectId').optional(),
    expectedDate: isoDateSchema.optional(),
    note: note.optional(),
    items: poItems,
  })
  .superRefine(siteNeedsProject);

export const updatePurchaseOrderBody = z
  .object({
    expectedDate: isoDateSchema.nullable().optional(),
    note: note.nullable().optional(),
    items: poItems.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const listPurchaseOrdersQuery = paginationQuery.extend({
  supplierId: uuid('supplierId').optional(),
  projectId: uuid('projectId').optional(),
  status: poStatusSchema.optional(),
});

// ─── Purchases ──────────────────────────────────────────────────────────────

export const createPurchaseBody = z
  .object({
    supplierId: uuid('supplierId'),
    deliverTo: deliverToSchema,
    projectId: uuid('projectId').optional().meta({ description: 'Required for SITE; optional tag for STORE' }),
    purchaseOrderId: uuid('purchaseOrderId').optional(),
    challanNo: ref('challan number').meta({ example: 'CH-2231' }),
    vehicleNo: z.string().trim().max(20).optional().meta({ example: 'LES-4521' }),
    purchaseDate: isoDateSchema,
    paymentMode: paymentModeSchema.default('UDHAAR'),
    paidNowPaisa: paisaSchema.optional().meta({ description: 'PARTIAL only (CASH pays the whole bill)' }),
    paidFrom: paidFromSchema.optional().meta({ description: 'Required for CASH / PARTIAL' }),
    challanAttachmentId: uuid('challanAttachmentId').meta({ description: 'Photo of the challan (upload with kind CHALLAN)' }),
    billAttachmentId: uuid('billAttachmentId').optional(),
    note: note.optional(),
    items: z
      .array(
        z.object({
          materialId: uuid('materialId'),
          challanQty: quantitySchema,
          countedQty: countSchema.optional().meta({ description: 'STORE (and MUNSHI site entries): counted on arrival, defaults to challanQty. SITE office entries are counted on receipt.' }),
          damagedQty: countSchema.optional(),
          ratePaisa: paisaSchema.optional().meta({ description: 'Defaults from the PO, then the supplier’s agreed rate. MUNSHI must not send rates.' }),
          note: note.optional().meta({ description: 'Required when the good quantity is less than the challan' }),
        }),
      )
      .min(1, 'Add at least one material')
      .max(100)
      .superRefine(uniqueMaterials),
  })
  .superRefine(siteNeedsProject)
  .superRefine((v, ctx) => {
    if (v.paymentMode !== 'UDHAAR' && !v.paidFrom) ctx.addIssue({ code: 'custom', path: ['paidFrom'], message: 'Choose where the money was paid from' });
    if (v.paymentMode === 'PARTIAL' && v.paidNowPaisa === undefined) ctx.addIssue({ code: 'custom', path: ['paidNowPaisa'], message: 'Enter the amount paid now' });
  });

export const listPurchasesQuery = paginationQuery.extend({
  supplierId: uuid('supplierId').optional(),
  locationId: uuid('locationId').optional(),
  projectId: uuid('projectId').optional(),
  paymentMode: paymentModeSchema.optional(),
  status: purchaseStatusSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  search: z.string().trim().min(1).max(60).optional().meta({ description: 'Purchase or challan number' }),
});

export const setRatesBody = z
  .object({
    items: z
      .array(z.object({ materialId: uuid('materialId'), ratePaisa: paisaSchema }))
      .min(1)
      .max(100)
      .superRefine(uniqueMaterials),
    paymentMode: paymentModeSchema.default('UDHAAR'),
    paidNowPaisa: paisaSchema.optional(),
    paidFrom: paidFromSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.paymentMode !== 'UDHAAR' && !v.paidFrom) ctx.addIssue({ code: 'custom', path: ['paidFrom'], message: 'Choose where the money was paid from' });
    if (v.paymentMode === 'PARTIAL' && v.paidNowPaisa === undefined) ctx.addIssue({ code: 'custom', path: ['paidNowPaisa'], message: 'Enter the amount paid now' });
  });

export const correctionBody = z.object({
  reason: z.string().trim().min(3, 'Explain the correction').max(500),
  items: z
    .array(
      z
        .object({
          purchaseItemId: uuid('purchaseItemId'),
          qty: countSchema.optional().meta({ description: 'Correct quantity (replaces the good quantity and the billed quantity)' }),
          ratePaisa: paisaSchema.optional().meta({ description: 'Correct rate' }),
        })
        .refine((i) => i.qty !== undefined || i.ratePaisa !== undefined, { message: 'Give the correct quantity or rate' }),
    )
    .min(1)
    .max(100),
});

export const purchaseReturnBody = z.object({
  reason: z.string().trim().min(3, 'Give the reason').max(300),
  items: z
    .array(z.object({ materialId: uuid('materialId'), qty: quantitySchema }))
    .min(1, 'Add at least one material')
    .max(100)
    .superRefine(uniqueMaterials),
  attachmentId: uuid('attachmentId').optional(),
  note: note.optional(),
});

export const listReturnsQuery = paginationQuery.extend({
  supplierId: uuid('supplierId').optional(),
  purchaseId: uuid('purchaseId').optional(),
});

export const receivePurchaseBody = z.object({
  items: z
    .array(
      z.object({
        materialId: uuid('materialId'),
        countedQty: countSchema,
        damagedQty: countSchema.optional(),
        note: note.optional().meta({ description: 'Required when the good quantity is less than the challan' }),
      }),
    )
    .min(1)
    .max(100)
    .superRefine(uniqueMaterials),
  note: note.optional(),
});

// ─── Supplier ledger + payments ─────────────────────────────────────────────

export const ledgerQuery = paginationQuery.extend({
  projectId: uuid('projectId').optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const createPaymentBody = z
  .object({
    supplierId: uuid('supplierId'),
    amountPaisa: paisaSchema.refine((v) => v > 0n, 'Amount must be greater than 0'),
    method: paymentMethodSchema,
    reference: z.string().trim().max(60).optional(),
    chequeNo: z.string().trim().max(30).optional(),
    chequeDate: isoDateSchema.optional(),
    paidOn: isoDateSchema,
    projectId: uuid('projectId').optional(),
    note: note.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'CHEQUE' && !v.chequeNo) ctx.addIssue({ code: 'custom', path: ['chequeNo'], message: 'Enter the cheque number' });
  });

export const chequeStatusBody = z.object({
  status: z.enum(['CLEARED', 'BOUNCED']),
  note: note.optional(),
});

export const listPaymentsQuery = paginationQuery.extend({
  supplierId: uuid('supplierId').optional(),
  method: paymentMethodSchema.optional(),
  status: paymentStatusSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const supplierBalanceQuery = z.object({ withBalance: boolQuery });

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderBody>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderBody>;
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuery>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseBody>;
export type ListPurchasesQuery = z.infer<typeof listPurchasesQuery>;
export type SetRatesInput = z.infer<typeof setRatesBody>;
export type CorrectionInput = z.infer<typeof correctionBody>;
export type PurchaseReturnInput = z.infer<typeof purchaseReturnBody>;
export type ListReturnsQuery = z.infer<typeof listReturnsQuery>;
export type ReceivePurchaseInput = z.infer<typeof receivePurchaseBody>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
export type CreatePaymentInput = z.infer<typeof createPaymentBody>;
export type ChequeStatusInput = z.infer<typeof chequeStatusBody>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;
