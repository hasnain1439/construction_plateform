/** Zod schemas of the saved estimates (revisions) and the owner shopping list. */
import { z } from 'zod';
import { langSchema } from '../../core/i18n/lang.js';

const uuid = (what: string) => z.uuid({ error: `${what} must be a UUID` });

export const estimateIdParams = z.object({ id: uuid('Estimate id').meta({ description: 'Estimate id' }) });
export const lineParams = z.object({ id: uuid('Estimate id').meta({ description: 'Estimate id' }), lineId: uuid('Line id').meta({ description: 'Estimate line id' }) });
export const compareParams = z.object({ a: uuid('Estimate a').meta({ description: 'Older revision (a)' }), b: uuid('Estimate b').meta({ description: 'Newer revision (b)' }) });

export const generateEstimateBody = z
  .object({ note: z.string().trim().max(500, 'Note is too long (500 max)').nullish().meta({ description: 'Why this revision was made', example: 'After the owner added a store on the first floor' }) })
  .strict()
  .meta({ id: 'GenerateEstimateInput' });

export const lineOverrideBody = z
  .object({
    quantity: z.number().min(0, 'Quantity cannot be negative').max(100_000_000, 'Quantity is too large').nullable().optional().meta({ description: 'Quantity to use instead of the computed one (with wastage); null clears it', example: 300 }),
    ratePaisa: z.string().regex(/^\d{1,12}$/, 'Paisa as a whole number string').nullable().optional().meta({ description: 'Rate (paisa per rate unit) instead of the price-list rate; null clears it. Needs fields.rates', example: '150000' }),
    note: z.string().trim().min(1, 'Note is required').max(300, 'Note is too long (300 max)').optional().meta({ description: 'Why — required when setting a value', example: 'Site measured: 300 bags' }),
  })
  .strict()
  .refine((v) => v.quantity !== undefined || v.ratePaisa !== undefined, { message: 'Send quantity and / or ratePaisa', path: ['quantity'] })
  .meta({ id: 'EstimateLineOverrideInput' });
export type LineOverrideBody = z.infer<typeof lineOverrideBody>;

export const approveEstimateBody = z
  .object({ confirmOutdatedRates: z.boolean().optional().meta({ description: 'Approve even though the price list changed after the estimate was made' }) })
  .strict()
  .meta({ id: 'ApproveEstimateInput' });

export const shoppingListQuery = z.object({
  estimateId: z.uuid({ error: 'estimateId must be a UUID' }).optional().meta({ description: 'A specific revision (default: APPROVED, else the DRAFT, else the live preview)' }),
  lang: langSchema.optional(),
});
export type ShoppingListQuery = z.infer<typeof shoppingListQuery>;
