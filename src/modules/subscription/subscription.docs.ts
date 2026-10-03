import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, success } from '../../core/openapi/registry.js';
import {
  changePlanBody,
  changePlanResultDto,
  paymentDto,
  planListItemDto,
  submitPaymentBody,
  subscriptionDetailDto,
} from './subscription.schema.js';

const tags = ['Subscription'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const OWNER = { ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] };
const ex = (summary: string, value: unknown, description?: string) => ({ summary, value, ...(description ? { description } : {}) });
const today = new Date().toISOString().slice(0, 10);
const PLAN_ID = '0199a8c0-0000-7000-8000-0000000000b2';

const professional = {
  id: PLAN_ID,
  code: 'PROFESSIONAL',
  name: 'Professional',
  pricePaisa: '950000',
  maxActiveProjects: 5,
  maxOfficeUsers: 10,
  features: ['5 active projects', '10 office users', 'Unlimited munshis', 'Profit & billing reports'],
};

export function registerSubscriptionDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/subscription',
    tags,
    summary: 'Current plan, status, days left and usage',
    description:
      'THEKEDAR only.\n\n| status | company |\n|---|---|\n| TRIAL, ACTIVE, GRACE | ACTIVE (full access) |\n| LAPSED | READ_ONLY — only sign-out and subscription/payment routes accept writes |\n\n' +
      '`usage.officeUsers` counts active THEKEDAR + PM **plus pending PM invitations**; Munshis never count.',
    security: companySecurity,
    responses: {
      200: {
        description: 'Subscription',
        content: {
          'application/json': {
            schema: success(subscriptionDetailDto),
            example: {
              success: true,
              data: {
                plan: professional,
                status: 'ACTIVE',
                trialEndsAt: null,
                currentPeriodStart: '2026-09-16T00:00:00.000Z',
                currentPeriodEnd: '2026-10-16T00:00:00.000Z',
                graceEndsAt: null,
                daysLeft: 12,
                usage: { activeProjects: { used: 2, limit: 5 }, officeUsers: { used: 3, limit: 10 } },
                pendingChange: null,
                readOnly: false,
              },
            },
          },
        },
      },
      ...errors({ ...OWNER, 404: ['SUBSCRIPTION_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/subscription/plans',
    tags,
    summary: 'Plans you can buy',
    description: 'THEKEDAR only. Excludes TRIAL. `current` marks your plan.',
    security: companySecurity,
    responses: {
      200: {
        description: 'Plans, cheapest first',
        content: {
          'application/json': {
            schema: success(z.array(planListItemDto)),
            example: { success: true, data: [{ ...professional, current: true }] },
          },
        },
      },
      ...errors(OWNER),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/subscription/payments',
    tags,
    summary: 'Submit a payment slip for review',
    description:
      '1. Pay by JazzCash / Easypaisa / Raast / bank transfer.\n' +
      '2. Upload the slip: `POST /attachments` with `kind: PAYMENT_SLIP` (allowed even when the company is read-only).\n' +
      '3. Submit it here. A platform admin reviews it; approval extends the period (and applies a pending upgrade).\n\n' +
      'Rules: amount = plan price · `paidOn` not in the future and ≤ 30 days old · one payment in review at a time · ' +
      'a transaction ID can be used once across the whole platform. **Works while READ_ONLY.**',
    security: companySecurity,
    request: {
      body: jsonBody(submitPaymentBody, {
        easypaisa: ex(
          'Easypaisa, Professional (Rs 9,500)',
          { method: 'EASYPAISA', transactionId: 'ep2610030117', amountPaisa: '950000', paidOn: today, attachmentId: '0199a8c0-0000-7000-8000-00000000a0a1' },
          'Paste the id of your uploaded PAYMENT_SLIP. The transaction id is upper-cased.',
        ),
        upgrade: ex(
          'Pay for a chosen plan',
          { planId: PLAN_ID, method: 'RAAST', transactionId: 'RAAST2610030921', amountPaisa: '950000', paidOn: today, attachmentId: '0199a8c0-0000-7000-8000-00000000a0a1' },
          'Use a planId from GET /subscription/plans.',
        ),
        wrongAmount: ex('❌ Wrong amount → 400 AMOUNT_MISMATCH', {
          method: 'JAZZCASH',
          transactionId: 'JC2610030001',
          amountPaisa: '500000',
          paidOn: today,
          attachmentId: '0199a8c0-0000-7000-8000-00000000a0a1',
        }),
      }),
    },
    responses: {
      201: { description: 'Submitted (PENDING_REVIEW)', content: { 'application/json': { schema: success(paymentDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'AMOUNT_MISMATCH', 'INVALID_PLAN', 'PLAN_REQUIRED', 'PAID_ON_IN_FUTURE', 'PAID_ON_TOO_OLD'],
        ...OWNER,
        404: ['ATTACHMENT_NOT_FOUND', 'SUBSCRIPTION_NOT_FOUND'],
        409: ['PAYMENT_PENDING', 'DUPLICATE_TRANSACTION'],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/subscription/payments',
    tags,
    summary: 'Payment history',
    description: 'THEKEDAR only. Newest first. `receiptNo` and the period appear once a payment is approved.',
    security: companySecurity,
    request: { query: z.object({ page: z.number().int().optional().meta({ example: 1 }), limit: z.number().int().optional().meta({ example: 25 }) }) },
    responses: {
      200: {
        description: 'Payments',
        content: {
          'application/json': {
            schema: z.object({
              success: z.literal(true),
              data: z.array(paymentDto),
              meta: z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() }),
            }),
          },
        },
      },
      ...errors({ 400: ['VALIDATION_ERROR'], ...OWNER }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/subscription/change-plan',
    tags,
    summary: 'Upgrade or downgrade',
    description:
      '- **Upgrade** (or any change while no paid period is running): saved as pending; it starts when its payment is approved. The response has `amountDuePaisa`.\n' +
      '- **Downgrade** during a paid period: starts at `currentPeriodEnd`. Your office users must already fit the new plan; ' +
      'if you have more active projects than it allows, send `keepActiveProjectIds` — the rest become READ_ONLY when it starts.\n\n' +
      'A new request replaces an earlier pending change.',
    security: companySecurity,
    request: {
      body: jsonBody(changePlanBody, {
        upgrade: ex('Upgrade', { planId: PLAN_ID }, 'Use a planId from GET /subscription/plans.'),
        downgrade: ex(
          'Downgrade keeping two projects active',
          { planId: PLAN_ID, keepActiveProjectIds: ['0199a8c0-0000-7000-8000-000000000101', '0199a8c0-0000-7000-8000-000000000102'] },
          'Only needed when you have more active projects than the new plan allows.',
        ),
      }),
    },
    responses: {
      200: { description: 'Pending change', content: { 'application/json': { schema: success(changePlanResultDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'INVALID_PLAN', 'SAME_PLAN', 'DOWNGRADE_USERS_OVER_LIMIT', 'KEEP_PROJECTS_REQUIRED', 'TOO_MANY_PROJECTS', 'INVALID_PROJECT'],
        ...OWNER,
      }),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/subscription/change-plan',
    tags,
    summary: 'Cancel the pending plan change',
    security: companySecurity,
    responses: {
      200: { description: 'Cancelled', content: { 'application/json': { schema: success(z.object({ cancelled: z.literal(true) })) } } },
      ...errors({ ...OWNER, 404: ['NO_PENDING_CHANGE'] }),
    },
  });
}
