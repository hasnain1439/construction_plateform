import { z } from 'zod';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';

export const REPORT_NAMES = ['project-summary', 'material-audit', 'labor-peshgi', 'cash-book', 'supplier-ageing', 'receivables-ageing', 'stock-valuation'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export const REPORT_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const reportQuery = z
  .object({
    format: z.enum(REPORT_FORMATS).default('json').meta({ description: 'json for the screen; csv / xlsx / pdf return a signed download link' }),
    projectId: uuid('projectId').optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] });

export type ReportQuery = z.infer<typeof reportQuery>;
