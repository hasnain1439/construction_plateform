/** Step 12 · Quotes: request schemas (zod → validation + OpenAPI). */
import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { langSchema } from '../../core/i18n/lang.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { companyPhoneSchema, paisaSchema } from '../company/company.schema.js';
import { SUPPLY_CATEGORY_KEYS } from '../projects/presets.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });

export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'NEGOTIATION', 'WON', 'LOST', 'EXPIRED'] as const;
export const LOST_REASONS = ['COMPETITOR_CHEAPER', 'CLIENT_POSTPONED', 'SELF_BUILD', 'OTHER'] as const;
export const quoteStatusSchema = z.enum(QUOTE_STATUSES);
export const lostReasonSchema = z.enum(LOST_REASONS, { error: 'Choose a reason: COMPETITOR_CHEAPER, CLIENT_POSTPONED, SELF_BUILD or OTHER' });

export const quoteIdParams = z.object({ id: uuid('quote id') });

/** What the client tells: plot, covered area, storeys, structure, contract — plus price settings. */
export const quoteInputsSchema = z
  .object({
    plot: z.object({
      unit: z.enum(['MARLA', 'KANAL', 'SQFT']),
      size: z.number().positive('Plot size must be > 0').max(100_000),
      frontFt: z.number().positive().max(1000).nullable().optional(),
      depthFt: z.number().positive().max(1000).nullable().optional(),
      marlaStandard: z.union([z.literal(225), z.literal(272.25)]).optional().meta({ description: 'Sq ft per marla; default = the company setting' }),
    }),
    coveredAreaSqft: z.number().positive('Covered area must be > 0').max(200_000).meta({ description: 'Total covered area of all floors (basement and mumty included)', example: 3950 }),
    floors: z.number().int().min(1, 'At least the ground floor').max(4, 'Up to 4 storeys (ground + 3)').meta({ description: 'Storeys above ground: 1 = ground only, 2 = ground + first …', example: 2 }),
    mumty: z.boolean().default(true),
    basement: z.boolean().default(false),
    basementHeightFt: z.number().positive().max(20).default(10),
    structureType: z.enum(['FRAMED', 'LOAD_BEARING']),
    contractType: z.enum(['FULL', 'GREY_OWNER_FINISHING', 'LABOR_ONLY']),
    qualityCategoryId: uuid('qualityCategoryId').nullable().optional().meta({ description: 'Quality category of contractor-supplied material; null / omitted = the company default category' }),
    supplyRules: z
      .array(z.object({ categoryKey: z.enum(SUPPLY_CATEGORY_KEYS), suppliedBy: z.enum(['CONTRACTOR', 'OWNER']) }))
      .max(20)
      .refine((rows) => new Set(rows.map((r) => r.categoryKey)).size === rows.length, 'Each category may appear only once')
      .optional()
      .meta({ description: 'Who supplies what, on top of the contract-type preset' }),
    marginPercent: z.number().min(0).max(100).multipleOf(0.01).optional().meta({ description: 'Profit margin % on cost; default = the company default' }),
    finishingAllowancePercent: z.number().min(0).max(200).multipleOf(0.01).optional().meta({ description: 'FULL only; default = the company default' }),
    paymentTemplateId: uuid('paymentTemplateId').optional().meta({ description: 'Payment schedule template; default = the company default template' }),
    finalPricePaisa: paisaSchema.nullable().optional().meta({ description: 'Negotiated final price (paisa); null / omitted = the computed price', example: '1850000000' }),
  })
  .meta({ id: 'QuoteInputs' });

export type QuoteInputsInput = z.infer<typeof quoteInputsSchema>;

const header = {
  title: z.string().trim().min(3, 'Title is too short').max(120).meta({ example: 'DHA Phase 6 · 10 Marla' }),
  siteAddress: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(60),
  validUntil: isoDateSchema,
  notes: z.string().trim().max(1000),
};

export const newClientSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  phone: companyPhoneSchema,
  email: z.email('Invalid email').trim().toLowerCase().max(120).optional(),
});

export const createQuoteBody = z
  .object({
    clientId: uuid('clientId').optional(),
    newClient: newClientSchema.optional(),
    title: header.title,
    siteAddress: header.siteAddress.optional(),
    city: header.city.optional(),
    validUntil: header.validUntil.optional().meta({ description: 'Default: today + company quoteValidityDays' }),
    notes: header.notes.optional(),
    inputs: quoteInputsSchema,
    note: z.string().trim().max(300).optional().meta({ description: 'Note on revision 1' }),
  })
  .refine((v) => Boolean(v.clientId) !== Boolean(v.newClient), { message: 'Send either clientId or newClient', path: ['clientId'] })
  .meta({ id: 'CreateQuoteInput' });

export const updateQuoteBody = z
  .object({
    clientId: uuid('clientId').optional(),
    title: header.title.optional(),
    siteAddress: header.siteAddress.nullable().optional(),
    city: header.city.nullable().optional(),
    validUntil: header.validUntil.optional(),
    notes: header.notes.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })
  .meta({ id: 'UpdateQuoteInput' });

export const previewBody = z.object({ inputs: quoteInputsSchema }).meta({ id: 'QuotePreviewInput' });

export const addRevisionBody = z.object({ inputs: quoteInputsSchema, note: z.string().trim().max(300).optional() }).meta({ id: 'AddQuoteRevisionInput' });

export const sendQuoteBody = z
  .object({
    validUntil: isoDateSchema.optional().meta({ description: 'Default: today + company quoteValidityDays' }),
    lang: langSchema.optional().meta({ description: 'Customer PDF / WhatsApp language (default: the signed-in user)' }),
  })
  .meta({ id: 'SendQuoteInput' });

export const negotiationBody = z.object({ note: z.string().trim().min(1, 'Write what the client said').max(500) }).meta({ id: 'QuoteNegotiationInput' });

export const lostBody = z
  .object({
    reason: lostReasonSchema,
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'QuoteLostInput' });

export const wonBody = z
  .object({
    startDate: isoDateSchema.optional().meta({ description: 'Project start (default today)' }),
    endDate: isoDateSchema.optional().meta({ description: 'Project end (default start + 12 months)' }),
    name: z.string().trim().min(3).max(120).optional().meta({ description: 'Project name (default: the quote title)' }),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, 'Code: 2–30 letters, digits or dashes')
      .optional()
      .meta({ description: 'Project code (default: next MSB-2026-NNN)' }),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] })
  .meta({ id: 'QuoteWonInput' });

export const listQuotesQuery = paginationQuery.extend({
  status: quoteStatusSchema.optional(),
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Number, title, client name or phone contains' }),
  clientId: uuid('clientId').optional(),
  followUp: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .meta({ description: 'true = SENT quotes with no activity for more than 5 days' }),
});

export const pdfQuery = z.object({
  variant: z.enum(['customer', 'internal']).default('customer'),
  lang: langSchema.optional(),
});

export const insightsQuery = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12).meta({ description: 'Months back from this month (default 12)' }),
});

export type CreateQuoteInput = z.infer<typeof createQuoteBody>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteBody>;
export type AddRevisionInput = z.infer<typeof addRevisionBody>;
export type SendQuoteInput = z.infer<typeof sendQuoteBody>;
export type LostInput = z.infer<typeof lostBody>;
export type WonInput = z.infer<typeof wonBody>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuery>;
export type PdfQuery = z.infer<typeof pdfQuery>;
