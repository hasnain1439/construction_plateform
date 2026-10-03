import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';

export const paymentMethodSchema = z
  .enum(['JAZZCASH', 'EASYPAISA', 'RAAST', 'IBFT'], { error: 'method must be JAZZCASH, EASYPAISA, RAAST or IBFT' })
  .meta({ example: 'EASYPAISA' });

export const subscriptionStatusSchema = z.enum(['TRIAL', 'ACTIVE', 'GRACE', 'LAPSED', 'CANCELLED']);
export const paymentStatusSchema = z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REFUNDED']);

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });

// ─── Requests ───────────────────────────────────────────────────────────────

export const submitPaymentBody = z.object({
  planId: uuid('planId').optional().meta({ description: 'Defaults to the pending plan change, else the current plan' }),
  method: paymentMethodSchema,
  transactionId: z
    .string({ error: 'transactionId is required' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{3,39}$/, 'Enter the transaction ID from your payment receipt (4–40 letters/digits)')
    .meta({ example: 'EP2610030117', description: 'Trimmed and upper-cased; must be unique' }),
  amountPaisa: paisaSchema.meta({ example: '950000', description: 'Must equal the plan price (paisa as a string)' }),
  paidOn: isoDateSchema.meta({ description: 'Date of payment: not in the future, at most 30 days ago' }),
  attachmentId: uuid('attachmentId').meta({ description: 'Slip uploaded with POST /attachments, kind PAYMENT_SLIP' }),
});

export const listPaymentsQuery = paginationQuery;

export const changePlanBody = z.object({
  planId: uuid('planId'),
  keepActiveProjectIds: z
    .array(uuid('project id'))
    .max(500)
    .transform((ids) => [...new Set(ids)])
    .optional()
    .meta({ description: 'Required when downgrading below your number of active projects' }),
});

// ─── Responses ──────────────────────────────────────────────────────────────

export const planDto = z
  .object({
    id: z.uuid(),
    code: z.string().meta({ example: 'PROFESSIONAL' }),
    name: z.string(),
    pricePaisa: z.string().meta({ example: '950000', description: 'Monthly price in paisa' }),
    maxActiveProjects: z.number().int().nullable().meta({ description: 'null = unlimited' }),
    maxOfficeUsers: z.number().int().nullable().meta({ description: 'null = unlimited' }),
    features: z.array(z.string()),
  })
  .meta({ id: 'Plan' });

const usageItem = z.object({ used: z.number().int(), limit: z.number().int().nullable() });

export const subscriptionDetailDto = z
  .object({
    plan: planDto,
    status: subscriptionStatusSchema,
    trialEndsAt: z.iso.datetime().nullable(),
    currentPeriodStart: z.iso.datetime().nullable(),
    currentPeriodEnd: z.iso.datetime().nullable(),
    graceEndsAt: z.iso.datetime().nullable(),
    daysLeft: z.number().int().meta({ description: 'Days until the trial / period / grace ends; 0 when lapsed' }),
    usage: z.object({ activeProjects: usageItem, officeUsers: usageItem }),
    pendingChange: z
      .object({
        plan: planDto,
        effectiveOn: z.iso.datetime().nullable().meta({ description: 'null = when the payment is approved' }),
        keepActiveProjectIds: z.array(z.uuid()),
      })
      .nullable(),
    readOnly: z.boolean(),
  })
  .meta({ id: 'SubscriptionDetail' });

export const planListItemDto = planDto.extend({ current: z.boolean() }).meta({ id: 'PlanOption' });

export const paymentDto = z
  .object({
    id: z.uuid(),
    plan: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
    amountPaisa: z.string().meta({ example: '950000' }),
    method: paymentMethodSchema,
    transactionId: z.string(),
    paidOn: z.string().meta({ example: '2026-10-03' }),
    status: paymentStatusSchema,
    rejectReason: z.string().nullable(),
    periodStart: z.iso.datetime().nullable(),
    periodEnd: z.iso.datetime().nullable(),
    receiptNo: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SubscriptionPayment' });

export const changePlanResultDto = z
  .object({
    type: z.enum(['UPGRADE', 'DOWNGRADE']),
    pendingChange: z.object({
      plan: planDto,
      effectiveOn: z.iso.datetime().nullable(),
      keepActiveProjectIds: z.array(z.uuid()),
    }),
    amountDuePaisa: z.string().nullable().meta({ description: 'Pay this to activate the new plan (null for scheduled downgrades)' }),
  })
  .meta({ id: 'PlanChange' });

export type SubmitPaymentInput = z.infer<typeof submitPaymentBody>;
export type ChangePlanInput = z.infer<typeof changePlanBody>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;
export type PlanDto = z.infer<typeof planDto>;
export type SubscriptionDetailDto = z.infer<typeof subscriptionDetailDto>;
export type PlanListItemDto = z.infer<typeof planListItemDto>;
export type PaymentDto = z.infer<typeof paymentDto>;
export type ChangePlanResultDto = z.infer<typeof changePlanResultDto>;
