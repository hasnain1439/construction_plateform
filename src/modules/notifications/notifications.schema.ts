import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { uuid } from '../inventory/inventory.schema.js';

export const NOTIFICATION_TYPES = [
  'DISPATCH_CREATED',
  'SHORTAGE_CREATED',
  'LOW_STOCK',
  'PURCHASE_PENDING_RATE',
  'SETTLEMENT_SUBMITTED',
  'SETTLEMENT_RETURNED',
  'EXPENSE_PENDING_APPROVAL',
  'TOPUP_REQUESTED',
  'FLOAT_SENT',
  'MEASUREMENT_RECORDED',
  'SUBCONTRACTOR_OVERPAID',
  'INVOICE_OVERDUE',
  'CHEQUE_BOUNCED',
  'STAGE_READY_UNBILLED',
  'PREVIOUS_STAGE_UNPAID',
  'SUBSCRIPTION_RENEWAL',
  'SUBSCRIPTION_PAYMENT_APPROVED',
  'SUBSCRIPTION_PAYMENT_REJECTED',
  'INVITE_ACCEPTED',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const severitySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);

export const idParams = z.object({ id: uuid('id') });

export const notificationsQuery = paginationQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .meta({ description: 'Only unread' }),
  type: notificationTypeSchema.optional(),
  severity: severitySchema.optional(),
  projectId: uuid('projectId').optional(),
});

export type NotificationsQuery = z.infer<typeof notificationsQuery>;
