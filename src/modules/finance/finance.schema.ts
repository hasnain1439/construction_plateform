import { z } from 'zod';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';

export const cashFlowQuery = z.object({
  months: z.coerce.number().int().min(1).max(12).default(6).meta({ description: 'Months to look ahead, including this one (1–12)' }),
});

export const pnlQuery = z
  .object({
    projectId: uuid('projectId').optional(),
    from: isoDateSchema.optional().meta({ description: 'Count billing and cost from this day (default: project start)' }),
    to: isoDateSchema.optional().meta({ description: 'Up to this day (default: today)' }),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] });

export type CashFlowQuery = z.infer<typeof cashFlowQuery>;
export type PnlQuery = z.infer<typeof pnlQuery>;
