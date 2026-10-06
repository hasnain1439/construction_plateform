import { z } from 'zod';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';

/** Period filter shared by the dashboard and finance reads (Karachi dates, inclusive). */
export const periodQuery = z
  .object({
    from: isoDateSchema.optional().meta({ description: 'Default: 29 days before `to`' }),
    to: isoDateSchema.optional().meta({ description: 'Default: today' }),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] });

export const overviewQuery = z
  .object({
    from: isoDateSchema.optional().meta({ description: 'Default: 29 days before `to`' }),
    to: isoDateSchema.optional().meta({ description: 'Default: today' }),
    projectId: uuid('projectId').optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] });

export const projectParams = z.object({ projectId: uuid('projectId') });

export type OverviewQuery = z.infer<typeof overviewQuery>;
export type PeriodQuery = z.infer<typeof periodQuery>;
