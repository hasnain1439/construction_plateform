import { z } from 'zod';
import { langSchema } from '../../core/i18n/lang.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';
import { REPORT_FORMATS } from '../reports/reports.schema.js';
import { TAX_AUTHORITIES } from './tax.rules.js';

export const taxAuthoritySchema = z.enum(TAX_AUTHORITIES).meta({ description: 'PRA (Punjab) / SRB (Sindh) / KPRA (Khyber Pakhtunkhwa) / ICT (Islamabad)' });
export const projectTaxModeSchema = z.enum(['INHERIT', 'ON', 'OFF']);
const rate = z.number().min(0, 'Must be between 0 and 30').max(30, 'Must be between 0 and 30').multipleOf(0.01);
const regNo = z.string().trim().regex(/^[0-9A-Za-z-]{5,20}$/, 'Digits, letters and dashes only (5–20)');

export const taxSettingsBody = z
  .object({
    enabled: z.boolean().optional().meta({ description: 'Sales tax on invoices (off by default)' }),
    authority: taxAuthoritySchema.nullable().optional(),
    ratePercent: rate.optional().meta({ description: 'Sales tax % on the taxable base (verify with your tax adviser)', example: 16 }),
    label: z.string().trim().min(2).max(30).nullable().optional().meta({ description: 'Tax line label on invoices (null = the authority default)', example: 'PRA Sales Tax' }),
    ntn: regNo.nullable().optional().meta({ description: 'Company NTN (same field as the company profile)', example: '1234567-8' }),
    strn: regNo.nullable().optional().meta({ description: 'Sales tax registration number printed on invoices', example: '3277876123456' }),
    whtDefaultRatePercent: rate.optional().meta({ description: 'WHT % pre-filled on the payment form', example: 8 }),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const projectTaxBody = z
  .object({
    mode: projectTaxModeSchema.optional().meta({ description: 'INHERIT = company setting; ON / OFF = this project only' }),
    authority: taxAuthoritySchema.nullable().optional().meta({ description: 'Project in another province (null = the company authority)' }),
    ratePercent: rate.nullable().optional().meta({ description: 'null = the company rate' }),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const TAX_REPORT_NAMES = ['wht-summary', 'tax-invoice-register'] as const;
export type TaxReportName = (typeof TAX_REPORT_NAMES)[number];

export const taxReportQuery = z
  .object({
    format: z.enum(REPORT_FORMATS).default('json').meta({ description: 'json for the screen; csv / xlsx / pdf return a signed download link' }),
    projectId: uuid('projectId').optional(),
    from: isoDateSchema.optional().meta({ description: 'Default: 1 July of the current tax year' }),
    to: isoDateSchema.optional().meta({ description: 'Default: 30 June of the current tax year' }),
    lang: langSchema.optional().meta({ description: 'Language of csv / xlsx / pdf titles, headers and labels (default: your language)' }),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] });

export type TaxSettingsInput = z.infer<typeof taxSettingsBody>;
export type ProjectTaxInput = z.infer<typeof projectTaxBody>;
export type TaxReportQuery = z.infer<typeof taxReportQuery>;
