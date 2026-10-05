import { z } from 'zod';
import { Prisma } from '../../core/db/prisma.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';

export const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
export const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const MAX_QTY = 1_000_000_000;

function quantity(min: 'positive' | 'nonnegative') {
  return z
    .union([z.number(), z.string().trim().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Quantity must be a number with at most 3 decimals')])
    .transform((v, ctx) => {
      const d = new Prisma.Decimal(v);
      if (!d.isFinite() || d.decimalPlaces() > 3) {
        ctx.addIssue({ code: 'custom', message: 'Quantity can have at most 3 decimals' });
        return z.NEVER;
      }
      if (min === 'positive' ? d.lte(0) : d.lt(0)) {
        ctx.addIssue({ code: 'custom', message: min === 'positive' ? 'Quantity must be greater than 0' : 'Quantity cannot be negative' });
        return z.NEVER;
      }
      if (d.gt(MAX_QTY)) {
        ctx.addIssue({ code: 'custom', message: 'Quantity is too large' });
        return z.NEVER;
      }
      return d;
    })
    .meta({ example: 200, description: 'Number (or numeric string) with at most 3 decimals' });
}

/** > 0, at most 3 dp → Prisma.Decimal */
export const quantitySchema = quantity('positive');
/** ≥ 0, at most 3 dp → Prisma.Decimal */
export const countSchema = quantity('nonnegative');

/** Rejects a document listing the same material twice. */
export function uniqueMaterials<T extends { materialId: string }>(items: T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.materialId)) ctx.addIssue({ code: 'custom', path: [i, 'materialId'], message: 'This material is listed twice' });
    seen.add(item.materialId);
  });
}

export const note = z.string().trim().max(500);

export const idParams = z.object({ id: uuid('id') });
export const locationParams = z.object({ locationId: uuid('locationId') });

// ─── Store stock / movements ────────────────────────────────────────────────

export const storeStockQuery = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  lowStockOnly: boolQuery,
});

export const lowStockLevelsBody = z
  .array(z.object({ materialId: uuid('materialId'), minQty: countSchema.meta({ example: 200, description: '0 removes the level' }) }))
  .min(1, 'Send at least one level')
  .max(200)
  .superRefine(uniqueMaterials);

export const movementTypeSchema = z.enum([
  'PURCHASE_IN',
  'PURCHASE_RETURN_OUT',
  'DISPATCH_OUT',
  'TRANSIT_IN',
  'TRANSIT_OUT',
  'RECEIPT_IN',
  'OWNER_DELIVERY_IN',
  'USAGE_OUT',
  'COUNT_ADJUSTMENT',
  'CORRECTION',
]);

export const movementsQuery = paginationQuery.extend({
  locationId: uuid('locationId').optional(),
  projectId: uuid('projectId').optional(),
  materialId: uuid('materialId').optional(),
  type: movementTypeSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ─── Material usage ─────────────────────────────────────────────────────────

export const usageBody = z.object({
  usageDate: isoDateSchema,
  items: z
    .array(
      z.object({
        materialId: uuid('materialId'),
        qty: quantitySchema,
        ownerSupplied: z.boolean().optional().meta({ description: 'Defaults from the project supply rules' }),
      }),
    )
    .min(1, 'Add at least one material')
    .max(100)
    .superRefine(uniqueMaterials),
  note: note.optional(),
  milestoneId: uuid('milestoneId').nullable().optional(),
  deviceCreatedAt: z.iso.datetime({ offset: true }).optional().meta({ description: 'When the entry was made on the phone (offline sync)' }),
});

export const usageListQuery = paginationQuery.extend({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });

// ─── Stock counts ───────────────────────────────────────────────────────────

export const countReasonSchema = z.enum(['HARDENED_IN_RAIN', 'BREAKAGE', 'THEFT_SUSPECTED', 'MEASUREMENT', 'OTHER']);

export const stockCountBody = z.object({
  locationId: uuid('locationId'),
  countedAt: z.iso.datetime({ offset: true }).optional().meta({ description: 'Defaults to now' }),
  items: z
    .array(
      z.object({
        materialId: uuid('materialId'),
        countedQty: countSchema,
        reason: countReasonSchema.optional().meta({ description: 'Required when the count differs from the system' }),
        note: note.optional(),
        ownerSupplied: z.boolean().optional(),
      }),
    )
    .min(1, 'Count at least one material')
    .max(200)
    .superRefine(uniqueMaterials),
  note: note.optional(),
});

export const stockCountsQuery = paginationQuery.extend({
  locationId: uuid('locationId').optional(),
  projectId: uuid('projectId').optional(),
});

export type StoreStockQuery = z.infer<typeof storeStockQuery>;
export type LowStockLevelsInput = z.infer<typeof lowStockLevelsBody>;
export type MovementsQuery = z.infer<typeof movementsQuery>;
export type UsageInput = z.infer<typeof usageBody>;
export type UsageListQuery = z.infer<typeof usageListQuery>;
export type StockCountInput = z.infer<typeof stockCountBody>;
export type StockCountsQuery = z.infer<typeof stockCountsQuery>;
