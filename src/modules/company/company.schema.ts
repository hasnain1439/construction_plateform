import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
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

export const weekDaySchema = z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);

/** Money in paisa: a digit string (preferred, lossless) or a safe integer. */
export const paisaSchema = z
  .union([
    z.string().trim().regex(/^\d{1,15}$/, 'Amount must be a whole number of paisa, e.g. "2500000"'),
    z.number().int('Amount must be whole paisa').nonnegative('Amount must be ≥ 0').max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value))
  .meta({ example: '2500000', description: 'Paisa as a string (2500000 = Rs 25,000)' });

/** Step 14 · control alert thresholds — also `PUT /control/settings` (control.manage). */
const intIn = (min: number, max: number) => z.number().int(`Must be a whole number between ${min} and ${max}`).min(min, `Must be between ${min} and ${max}`).max(max, `Must be between ${min} and ${max}`);
export const controlThresholdFields = {
  behindPlanAlertPoints: intIn(5, 50).optional(),
  lateFinishGraceDays: intIn(0, 30).optional(),
  quotaAlertPercent: intIn(50, 150).optional(),
  spendAheadAlertPoints: intIn(1, 50).optional(),
  controlAlertsEnabled: z.boolean().optional(),
};

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
    settlementWeekStart: weekDaySchema.optional(),
    workingDays: z
      .array(weekDaySchema)
      .min(1, 'Pick at least one working day')
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'A day is listed twice')
      .optional(),
    hoursPerDay: z.number().min(1, 'Must be between 1 and 16').max(16, 'Must be between 1 and 16').multipleOf(0.25).optional(),
    overtimeMultiplier: z.number().min(1, 'Must be between 1 and 3').max(3, 'Must be between 1 and 3').multipleOf(0.05).nullable().optional(),
    subcontractPaymentsByPm: z.boolean().optional(),
    paymentTermsDays: z.number().int().min(0, 'Must be between 0 and 90').max(90, 'Must be between 0 and 90').optional(),
    taxRatePercent: z.number().min(0, 'Must be between 0 and 30').max(30, 'Must be between 0 and 30').multipleOf(0.01).optional(),
    taxLabel: z.string().trim().max(20).nullable().optional(),
    pmCanRecordPayments: z.boolean().optional(),
    defaultMarginPercent: z.number().min(0, 'Must be between 0 and 100').max(100, 'Must be between 0 and 100').multipleOf(0.01).optional(),
    defaultFinishingAllowancePercent: z.number().min(0, 'Must be between 0 and 200').max(200, 'Must be between 0 and 200').multipleOf(0.01).optional(),
    defaultLanguage: languageSchema.optional(),
    // Step 13 · schedule calendar
    ramadanDayFactor: z.number().min(0.25, 'Must be between 0.25 and 1').max(1, 'Must be between 0.25 and 1').multipleOf(0.05).optional(),
    ramadanPeriods: z
      .array(z.object({ start: isoDateSchema, end: isoDateSchema }).refine((p) => p.end >= p.start && p.end <= dateOnlyPlus(p.start, 35), 'end must be within 35 days after start'))
      .max(20)
      .nullable()
      .optional(),
    // Step 16 · equipment alerts + shuttering planner
    equipmentIdleDays: z.number().int().min(1, 'Must be between 1 and 60').max(60, 'Must be between 1 and 60').optional(),
    shutteringPropsPerPlate: z.number().min(0, 'Must be between 0 and 5').max(5, 'Must be between 0 and 5').multipleOf(0.05).optional(),
    shutteringSparePercent: z.number().int().min(0, 'Must be between 0 and 30').max(30, 'Must be between 0 and 30').optional(),
    // Step 14 · control alert thresholds ("Alerts & Limits")
    ...controlThresholdFields,
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Nothing to update' });

function dateOnlyPlus(date: string, days: number): string {
  return new Date(dateOnly(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export const settingsDto = z
  .object({
    kharchaApprovalLimitPaisa: z.string().meta({ example: '2500000' }),
    overuseAlertPercent: z.number(),
    missingLogAlertTime: z.string().meta({ example: '18:00' }),
    quoteValidityDays: z.number(),
    taxEnabled: z.boolean(),
    pmCanSeeFinancials: z.boolean(),
    blindCountEnabled: z.boolean().meta({ description: 'Site receiving hides sent / challan quantities until counted' }),
    settlementWeekStart: weekDaySchema.meta({ description: 'Weekly wage settlements start on this day' }),
    workingDays: z.array(weekDaySchema),
    hoursPerDay: z.number().meta({ example: 8 }),
    overtimeMultiplier: z.number().nullable().meta({ description: 'null = the DAILY labour rate multiplier (×1.5 by default)' }),
    subcontractPaymentsByPm: z.boolean().meta({ description: 'A PM may pay sub-contractors (THEKEDAR always can)' }),
    paymentTermsDays: z.number().meta({ description: 'Invoice due date = issue date + this many days', example: 7 }),
    taxRatePercent: z.number().meta({ description: 'Sales tax on invoices (only when taxEnabled)', example: 16 }),
    taxLabel: z.string().nullable().meta({ example: 'PRA' }),
    pmCanRecordPayments: z.boolean().meta({ description: 'A PM with billing.view may record owner payments' }),
    defaultMarginPercent: z.number().meta({ description: 'Profit margin % added to the estimated cost when a contract value is set from the estimate (0–100)', example: 20 }),
    defaultFinishingAllowancePercent: z
      .number()
      .meta({ description: 'Finishing allowance % added for FULL contracts (the estimate is grey structure only), 0–200', example: 0 }),
    defaultLanguage: languageSchema,
    ramadanDayFactor: z.number().meta({ description: 'Share of a normal day of work during Ramadan (schedule), 0.25–1', example: 0.75 }),
    ramadanPeriods: z
      .array(z.object({ start: z.string(), end: z.string() }))
      .meta({ description: 'Ramadan periods the schedule uses (the company own, else built-in approximate Pakistan dates)' }),
    ramadanPeriodsCustom: z.boolean().meta({ description: 'false = the built-in approximate dates' }),
    equipmentIdleDays: z.number().meta({ description: 'Rented equipment with no milestone activity at its site for this many days → EQUIPMENT_IDLE alert (1–60)', example: 5 }),
    shutteringPropsPerPlate: z.number().meta({ description: 'Shuttering planner: props needed per plate (0–5, engineer review)', example: 0.75 }),
    shutteringSparePercent: z.number().meta({ description: 'Shuttering planner: extra plates % for cut pieces / damage (0–30)', example: 5 }),
    behindPlanAlertPoints: z.number().meta({ description: 'Step 14: a milestone is behind plan when planned − actual progress ≥ this many points (5–50)', example: 15 }),
    lateFinishGraceDays: z.number().meta({ description: 'Step 14: a milestone is late when not finished this many days after its planned end (0–30)', example: 3 }),
    quotaAlertPercent: z.number().meta({ description: 'Step 14: quota exhausted when used ≥ this % of the milestone quota (50–150)', example: 100 }),
    spendAheadAlertPoints: z.number().meta({ description: 'Step 14: spend ahead of progress when cost % of contract − progress % > this many points (1–50)', example: 10 }),
    controlAlertsEnabled: z.boolean().meta({ description: 'Step 14: false = the control alert engine stores / sends nothing' }),
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

// ─── Audit log ──────────────────────────────────────────────────────────────

export const companyAuditQuery = paginationQuery.extend({
  actorType: z.enum(['USER', 'PLATFORM_ADMIN', 'SYSTEM']).optional().meta({ description: 'PLATFORM_ADMIN = platform support (changes a super admin made inside the company, and admin actions)' }),
  action: z.string().trim().min(1).max(60).optional().meta({ description: 'Prefix, e.g. "supplier." or "admin."' }),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const companyAuditEntryDto = z
  .object({
    id: z.uuid(),
    action: z.string().meta({ example: 'supplier.update' }),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    actor: z.object({
      type: z.enum(['USER', 'PLATFORM_ADMIN', 'SYSTEM']),
      id: z.string().nullable(),
      name: z.string().meta({ example: 'Platform support · Platform Admin' }),
    }),
    platformSupport: z
      .object({
        sessionId: z.string().nullable(),
        adminName: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .nullable()
      .meta({ description: 'Set for everything platform support did: the support person (adminName). sessionId / reason are only filled on older entries from the former support-session flow' }),
    details: z.unknown(),
    createdAt: z.string(),
  })
  .meta({ id: 'CompanyAuditEntry' });

export type CompanyAuditQuery = z.infer<typeof companyAuditQuery>;
export type CompanyAuditEntryDto = z.infer<typeof companyAuditEntryDto>;
