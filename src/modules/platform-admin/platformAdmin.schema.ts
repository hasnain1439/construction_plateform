import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { emailSchema, phoneSchema, regionSchema } from '../auth/auth.schema.js';
import { companyPhoneSchema, ntnSchema, paisaSchema } from '../company/company.schema.js';
import { paymentMethodSchema, subscriptionStatusSchema } from '../subscription/subscription.schema.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
export const idParams = z.object({ id: uuid('id') });
export const tenantStatusSchema = z.enum(['ACTIVE', 'READ_ONLY', 'SUSPENDED', 'CLOSED']);
const transactionIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{3,39}$/, 'Enter the transaction ID from the payment receipt (4–40 letters/digits)');
const holidayType = z.enum(['NON_WORKING', 'PARTIAL']);

// ─── Companies ──────────────────────────────────────────────────────────────

export const tenantsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name, slug or owner phone' }),
  tenantStatus: tenantStatusSchema.optional(),
  subscriptionStatus: subscriptionStatusSchema.optional(),
  plan: z.string().trim().toUpperCase().max(30).optional().meta({ description: 'Plan code' }),
  renewsBefore: isoDateSchema.optional().meta({ description: 'Period/trial ends on or before this date' }),
});

export const createTenantBody = z
  .object({
    company: z.object({
      name: z.string().trim().min(3, 'Name must be at least 3 characters').max(100),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes')
        .min(3)
        .max(48)
        .optional(),
      phone: companyPhoneSchema,
      email: emailSchema.optional(),
      ntn: ntnSchema.optional(),
      address: z.string().trim().max(300).optional(),
      region: regionSchema,
      marlaStandard: z.union([z.literal(225), z.literal(272.25)], { error: 'marlaStandard must be 225 or 272.25' }).optional(),
    }),
    owner: z.object({
      name: z.string().trim().min(2).max(80),
      phone: phoneSchema,
      email: emailSchema.optional(),
    }),
    subscription: z.object({
      mode: z.enum(['TRIAL', 'PAID']),
      planCode: z.string().trim().toUpperCase().min(2).max(30),
      trialDays: z.number().int().min(1, 'trialDays must be 1–60').max(60, 'trialDays must be 1–60').default(14),
      payment: z
        .object({
          method: paymentMethodSchema,
          transactionId: transactionIdSchema,
          amountPaisa: paisaSchema,
          paidOn: isoDateSchema,
        })
        .optional(),
    }),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.subscription.mode === 'PAID' && !v.subscription.payment) {
      ctx.addIssue({ code: 'custom', path: ['subscription', 'payment'], message: 'payment is required for PAID' });
    }
  });

export const tenantStatusBody = z
  .object({
    action: z.enum(['EXTEND_TRIAL', 'SET_READ_ONLY', 'REACTIVATE', 'SUSPEND', 'CLOSE']),
    days: z.number().int().min(1, 'days must be 1–30').max(30, 'days must be 1–30').optional(),
    note: z.string().trim().min(3, 'Note is too short').max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'EXTEND_TRIAL' && !v.days) ctx.addIssue({ code: 'custom', path: ['days'], message: 'days is required for EXTEND_TRIAL' });
    if ((v.action === 'SUSPEND' || v.action === 'CLOSE') && !v.note) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: `note is required for ${v.action}` });
    }
  });

export const tenantPlanBody = z.object({
  planId: uuid('planId'),
  effective: z.enum(['IMMEDIATE', 'NEXT_RENEWAL']),
  keepActiveProjectIds: z.array(uuid('project id')).max(500).optional().meta({ description: 'Needed when the company has more active projects than the plan allows' }),
  note: z.string().trim().max(500).optional(),
});

// ─── Payments ───────────────────────────────────────────────────────────────

export const paymentsQuery = paginationQuery.extend({
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REFUNDED']).default('PENDING_REVIEW'),
  method: paymentMethodSchema.optional(),
  tenantId: uuid('tenantId').optional(),
  from: isoDateSchema.optional().meta({ description: 'Submitted on or after (date)' }),
  to: isoDateSchema.optional().meta({ description: 'Submitted on or before (date)' }),
});

export const approvePaymentBody = z.object({ note: z.string().trim().max(500).optional() });
export const rejectPaymentBody = z.object({
  reason: z.string({ error: 'reason is required' }).trim().min(5, 'reason must be 5–300 characters').max(300, 'reason must be 5–300 characters'),
});

// ─── Plans ──────────────────────────────────────────────────────────────────

const limitSchema = z.number().int().min(1, 'Must be at least 1').nullable().meta({ description: 'null = unlimited' });

export const createPlanBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Code: letters, digits, underscore (2–30), starting with a letter'),
  name: z.string().trim().min(2).max(60),
  pricePaisa: paisaSchema,
  maxActiveProjects: limitSchema.optional().default(null),
  maxOfficeUsers: limitSchema.optional().default(null),
  features: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const updatePlanBody = z
  .object({
    code: z
      .unknown()
      .optional()
      .refine((v) => v === undefined, 'code cannot be changed')
      .meta({ description: 'Immutable — sending it is an error' }),
    name: z.string().trim().min(2).max(60).optional(),
    pricePaisa: paisaSchema.optional().meta({ description: 'Applies to future payments only' }),
    maxActiveProjects: limitSchema.optional(),
    maxOfficeUsers: limitSchema.optional(),
    features: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── Holidays ───────────────────────────────────────────────────────────────

export const holidaysQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export const createHolidayBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    startDate: isoDateSchema,
    endDate: isoDateSchema.optional(),
    type: holidayType.default('NON_WORKING'),
    region: regionSchema.nullable().optional().meta({ description: 'null / omitted = nationwide' }),
  })
  .superRefine((v, ctx) => {
    if (v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must be on or after startDate' });
  });

export const updateHolidayBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.nullable().optional(),
    type: holidayType.optional(),
    region: regionSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── Audit log ──────────────────────────────────────────────────────────────

export const auditQuery = paginationQuery.extend({
  tenantId: uuid('tenantId').optional(),
  actorType: z.enum(['USER', 'PLATFORM_ADMIN', 'SYSTEM']).optional(),
  action: z.string().trim().min(1).max(60).optional().meta({ description: 'Prefix, e.g. "auth." or "subscription.payment"' }),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export type TenantsQuery = z.infer<typeof tenantsQuery>;
export type CreateTenantInput = z.infer<typeof createTenantBody>;
export type TenantStatusInput = z.infer<typeof tenantStatusBody>;
export type TenantPlanInput = z.infer<typeof tenantPlanBody>;
export type PaymentsQuery = z.infer<typeof paymentsQuery>;
export type ApprovePaymentInput = z.infer<typeof approvePaymentBody>;
export type RejectPaymentInput = z.infer<typeof rejectPaymentBody>;
export type CreatePlanInput = z.infer<typeof createPlanBody>;
export type UpdatePlanInput = z.infer<typeof updatePlanBody>;
export type HolidaysQuery = z.infer<typeof holidaysQuery>;
export type CreateHolidayInput = z.infer<typeof createHolidayBody>;
export type UpdateHolidayInput = z.infer<typeof updateHolidayBody>;
export type AuditQuery = z.infer<typeof auditQuery>;

// ─── Material catalog ───────────────────────────────────────────────────────

export const supplyCategorySchema = z.enum(['GREY_STRUCTURE', 'FINISHING']);
export const altUnitsSchema = z
  .array(z.object({ unit: z.string().trim().min(1).max(20), factor: z.number().positive() }))
  .max(5)
  .meta({ example: [{ unit: 'kg', factor: 50 }], description: 'How many of `unit` make one base unit' });

export const catalogMaterialsQuery = z.object({
  groupId: uuid('groupId').optional(),
  search: z.string().trim().min(1).max(100).optional(),
  supplyCategory: supplyCategorySchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const createCatalogMaterialBody = z.object({
  groupId: uuid('groupId'),
  name: z.string().trim().min(2).max(80),
  unit: z.string().trim().min(1).max(20),
  unitDetail: z.string().trim().max(80).optional(),
  altUnits: altUnitsSchema.default([]),
  supplyCategory: supplyCategorySchema,
  usedByRulebook: z.boolean().default(false),
  rulebookKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase_snake_case').optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  pushToTenants: z.boolean().default(true).meta({ description: 'Add it to every company now (skips companies that already have the name)' }),
});

export const updateCatalogMaterialBody = z
  .object({
    unit: z
      .unknown()
      .optional()
      .refine((v) => v === undefined, 'unit cannot be changed')
      .meta({ description: 'Immutable — companies have rates in this unit' }),
    name: z.string().trim().min(2).max(80).optional(),
    unitDetail: z.string().trim().max(80).nullable().optional(),
    altUnits: altUnitsSchema.optional(),
    supplyCategory: supplyCategorySchema.optional(),
    usedByRulebook: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export type CatalogMaterialsQuery = z.infer<typeof catalogMaterialsQuery>;
export type CreateCatalogMaterialInput = z.infer<typeof createCatalogMaterialBody>;
export type UpdateCatalogMaterialInput = z.infer<typeof updateCatalogMaterialBody>;
