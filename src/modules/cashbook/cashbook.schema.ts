import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { note, quantitySchema, uniqueMaterials, uuid } from '../inventory/inventory.schema.js';
import { amountSchema, offline, requiredNote } from '../labor/labor.schema.js';

export const floatMethodSchema = z.enum(['CASH', 'BANK', 'JAZZCASH', 'EASYPAISA']);
export const expenseCategorySchema = z.enum(['TEA_WATER', 'TRANSPORT', 'UNLOADING', 'FUEL', 'SMALL_TOOLS', 'URGENT_MATERIAL', 'OWNER_PURCHASE', 'REPAIRS', 'OTHER']);
export const cashEntryTypeSchema = z.enum([
  'FLOAT_IN',
  'EXPENSE',
  'PESHGI',
  'WAGE_PAYMENT',
  'SUBCONTRACT_PAYMENT',
  'PURCHASE',
  'HANDOVER_OUT',
  'HANDOVER_IN',
  'COUNT_ADJUSTMENT',
  'REFUND_IN',
]);
export const cashEntryStatusSchema = z.enum(['PENDING_ACK', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED']);
const reference = z.string().trim().min(1).max(60);

export const idParams = z.object({ id: uuid('id') });
export const entryParams = z.object({ entryId: uuid('entryId') });

export const floatBody = z.object({
  holderUserId: uuid('holderUserId').meta({ description: 'The munshi / PM receiving the cash' }),
  amountPaisa: amountSchema,
  method: floatMethodSchema,
  reference: reference.optional().meta({ example: 'EP88213' }),
  projectId: uuid('projectId').optional(),
  note: note.optional(),
  date: isoDateSchema.optional(),
});

export const expenseBody = z
  .object({
    projectId: uuid('projectId'),
    category: expenseCategorySchema,
    amountPaisa: amountSchema,
    description: z.string().trim().min(2, 'Write what the money was spent on').max(300).meta({ example: 'Diesel for mixer' }),
    attachmentId: uuid('attachmentId').optional().meta({ description: 'Receipt photo (upload with kind RECEIPT)' }),
    date: isoDateSchema.optional().meta({ description: 'Defaults to today' }),
    supplierId: uuid('supplierId').optional().meta({ description: 'URGENT_MATERIAL: who sold it' }),
    challanNo: z.string().trim().min(1).max(40).optional(),
    items: z
      .array(z.object({ materialId: uuid('materialId'), qty: quantitySchema }))
      .min(1)
      .max(50)
      .superRefine(uniqueMaterials)
      .optional()
      .meta({ description: 'URGENT_MATERIAL with a supplier: the goods go into site stock (rates added by the office)' }),
    ...offline,
  })
  .superRefine((v, ctx) => {
    if ((v.items || v.supplierId) && v.category !== 'URGENT_MATERIAL') {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Only urgent material can list goods' });
    }
    if (v.items && !v.supplierId) ctx.addIssue({ code: 'custom', path: ['supplierId'], message: 'Choose who sold the material' });
    if (v.supplierId && !v.items) ctx.addIssue({ code: 'custom', path: ['items'], message: 'List the material bought' });
    if (v.items && !v.attachmentId) ctx.addIssue({ code: 'custom', path: ['attachmentId'], message: 'Add a photo of the bill / challan' });
  });

export const expensesQuery = paginationQuery.extend({
  status: cashEntryStatusSchema.optional(),
  projectId: uuid('projectId').optional(),
  accountId: uuid('accountId').optional(),
});

export const decisionBody = z.object({ note: note.optional() });
export const rejectBody = z.object({ note: requiredNote });

export const topupBody = z.object({
  amountPaisa: amountSchema,
  note: note.optional(),
  clientId: offline.clientId,
});
export const topupsQuery = paginationQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });
export const approveTopupBody = z.object({
  amountPaisa: amountSchema.optional().meta({ description: 'Defaults to the amount asked for' }),
  method: floatMethodSchema,
  reference: reference.optional(),
});

export const countBody = z
  .object({
    accountId: uuid('accountId').optional().meta({ description: "Defaults to the caller's own" }),
    countedPaisa: paisaSchema,
    note: note.optional().meta({ description: 'Required when the count differs from the book' }),
    ...offline,
  });
export const countsQuery = paginationQuery.extend({ accountId: uuid('accountId').optional() });

export const handoverBody = z.object({
  fromAccountId: uuid('fromAccountId').optional().meta({ description: "Defaults to the caller's own (THEKEDAR may hand over anyone's)" }),
  toUserId: uuid('toUserId'),
  amountPaisa: amountSchema,
  note: note.optional(),
});

export const accountsQuery = z.object({ includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
export const entriesQuery = paginationQuery.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  type: cashEntryTypeSchema.optional(),
});
export const cashbookQuery = paginationQuery.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  category: expenseCategorySchema.optional(),
});

export type FloatInput = z.infer<typeof floatBody>;
export type ExpenseInput = z.infer<typeof expenseBody>;
export type ExpensesQuery = z.infer<typeof expensesQuery>;
export type TopupInput = z.infer<typeof topupBody>;
export type TopupsQuery = z.infer<typeof topupsQuery>;
export type ApproveTopupInput = z.infer<typeof approveTopupBody>;
export type CountInput = z.infer<typeof countBody>;
export type CountsQuery = z.infer<typeof countsQuery>;
export type HandoverInput = z.infer<typeof handoverBody>;
export type EntriesQuery = z.infer<typeof entriesQuery>;
export type CashbookQuery = z.infer<typeof cashbookQuery>;
