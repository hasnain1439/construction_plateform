import { z } from 'zod';
import { uuid } from '../inventory/inventory.schema.js';

export const APPROVAL_TYPES = [
  'SETTLEMENT_SUBMITTED',
  'EXPENSE_PENDING_APPROVAL',
  'TOPUP_PENDING',
  'MEASUREMENT_TO_VERIFY',
  'SHORTAGE_OPEN',
  'PURCHASE_PENDING_RATE',
  'STAGE_READY_UNBILLED',
  'INVOICE_DRAFT',
  'CHEQUE_PENDING',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const approvalTypeSchema = z.enum(APPROVAL_TYPES);

export const APPROVAL_ACTIONS = ['approve', 'reject', 'return', 'verify', 'issue', 'clear', 'bounce'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const bulkBody = z.object({
  items: z
    .array(
      z.object({
        type: approvalTypeSchema,
        id: uuid('id'),
        action: z.enum(APPROVAL_ACTIONS),
        note: z.string().trim().max(500).optional().meta({ description: 'Required for reject / return / bounce' }),
        method: z.enum(['CASH', 'BANK', 'JAZZCASH', 'EASYPAISA']).optional().meta({ description: 'Top-up approve: how the cash is sent' }),
      }),
    )
    .min(1, 'Choose at least one item')
    .max(50, 'At most 50 items at once'),
});

export type BulkInput = z.infer<typeof bulkBody>;
