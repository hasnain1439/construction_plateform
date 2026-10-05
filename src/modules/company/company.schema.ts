import { z } from 'zod';
import { dateOnly, isoDateSchema } from '../../core/utils/dates.js';
import { normalizePkAnyPhone } from '../../core/utils/phone.js';
import { emailSchema, languageSchema, regionSchema } from '../auth/auth.schema.js';

export const ntnSchema = z
  .string()
  .trim()
  .regex(/^\d{7}-\d$/, 'NTN must look like 1234567-8')
  .meta({ example: '1234567-8' });

/** Office phone: mobile or landline. */
export const companyPhoneSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const phone = normalizePkAnyPhone(value);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid Pakistani phone, e.g. 042-35761234 or 03001234567' });
      return z.NEVER;
    }
    return phone;
  })
  .meta({ example: '042-35761234' });

const marlaStandardSchema = z
  .union([z.literal(225), z.literal(272.25)], { error: 'marlaStandard must be 225 or 272.25' })
  .meta({ example: 225 });

// ─── Company profile ────────────────────────────────────────────────────────

export const updateCompanyBody = z
  .object({
    name: z.string().trim().min(3, 'Name must be at least 3 characters').max(100, 'Name must be at most 100 characters').optional(),
    ntn: ntnSchema.nullable().optional(),
    logoAttachmentId: z.uuid({ error: 'logoAttachmentId must be a UUID' }).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    phone: companyPhoneSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    region: regionSchema.optional(),
    marlaStandard: marlaStandardSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Nothing to update' });

export const companyDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    ntn: z.string().nullable(),
    logoAttachmentId: z.uuid().nullable(),
    logoUrl: z.string().nullable().meta({ description: 'Signed, short-lived' }),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    region: regionSchema,
    marlaStandard: z.number(),
    status: z.enum(['ACTIVE', 'READ_ONLY', 'SUSPENDED', 'CLOSED']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Company' });

// ─── Settings ───────────────────────────────────────────────────────────────

/** Money in paisa: a digit string (preferred, lossless) or a safe integer. */
export const paisaSchema = z
  .union([
    z.string().trim().regex(/^\d{1,15}$/, 'Amount must be a whole number of paisa, e.g. "2500000"'),
    z.number().int('Amount must be whole paisa').nonnegative('Amount must be ≥ 0').max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value))
  .meta({ example: '2500000', description: 'Paisa as a string (2500000 = Rs 25,000)' });

export const updateSettingsBody = z
  .object({
    kharchaApprovalLimitPaisa: paisaSchema.optional(),
    overuseAlertPercent: z.number().int().min(1, 'Must be between 1 and 20').max(20, 'Must be between 1 and 20').optional(),
    missingLogAlertTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 18:00')
      .optional(),
    quoteValidityDays: z.number().int().min(1, 'Must be between 1 and 90').max(90, 'Must be between 1 and 90').optional(),
    taxEnabled: z.boolean().optional(),
    pmCanSeeFinancials: z.boolean().optional(),
    blindCountEnabled: z.boolean().optional(),
    defaultLanguage: languageSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Nothing to update' });

export const settingsDto = z
  .object({
    kharchaApprovalLimitPaisa: z.string().meta({ example: '2500000' }),
    overuseAlertPercent: z.number(),
    missingLogAlertTime: z.string().meta({ example: '18:00' }),
    quoteValidityDays: z.number(),
    taxEnabled: z.boolean(),
    pmCanSeeFinancials: z.boolean(),
    blindCountEnabled: z.boolean().meta({ description: 'Site receiving hides sent / challan quantities until counted' }),
    defaultLanguage: languageSchema,
  })
  .meta({ id: 'CompanySettings' });

// ─── Holidays ───────────────────────────────────────────────────────────────

export const holidayTypeSchema = z.enum(['NON_WORKING', 'PARTIAL']);

export const holidaysQuery = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  })
  .superRefine((q, ctx) => {
    if (Boolean(q.from) !== Boolean(q.to)) {
      ctx.addIssue({ code: 'custom', path: [q.from ? 'to' : 'from'], message: 'Send both from and to' });
    }
    if (q.from && q.to && dateOnly(q.to) < dateOnly(q.from)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be on or after from' });
    }
    if (q.from && q.year) ctx.addIssue({ code: 'custom', path: ['year'], message: 'Use either year or from/to' });
  });

export const createHolidayBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(100),
    startDate: isoDateSchema,
    endDate: isoDateSchema.optional(),
    type: holidayTypeSchema.default('NON_WORKING'),
  })
  .superRefine((value, ctx) => {
    if (value.endDate && dateOnly(value.endDate) < dateOnly(value.startDate)) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must be on or after startDate' });
    }
  });

export const holidayIdParams = z.object({ id: z.uuid({ error: 'Invalid holiday id' }) });

export const holidayDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    startDate: z.string().meta({ example: '2026-08-14' }),
    endDate: z.string().meta({ example: '2026-08-14' }),
    type: holidayTypeSchema,
    source: z.enum(['platform', 'company']),
    editable: z.boolean(),
  })
  .meta({ id: 'Holiday' });

export type UpdateCompanyInput = z.infer<typeof updateCompanyBody>;
export type CompanyDto = z.infer<typeof companyDto>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsBody>;
export type SettingsDto = z.infer<typeof settingsDto>;
export type HolidaysQuery = z.infer<typeof holidaysQuery>;
export type CreateHolidayInput = z.infer<typeof createHolidayBody>;
export type HolidayDto = z.infer<typeof holidayDto>;
