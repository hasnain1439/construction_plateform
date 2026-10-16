import { z } from 'zod';
import { Prisma } from '../../core/db/prisma.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { boolQuery, countSchema, note, quantitySchema, uuid } from '../inventory/inventory.schema.js';

export { idParams } from '../inventory/inventory.schema.js';

export const equipmentKindSchema = z.enum(['MACHINE', 'BULK']);
export const equipmentCategorySchema = z.enum(['SHUTTERING_PLATE', 'PROP', 'SCAFFOLDING', 'MIXER', 'VIBRATOR', 'GENERATOR', 'PUMP', 'TOOL', 'OTHER']);
export const movementTypeSchema = z.enum(['OPENING_IN', 'PURCHASE_IN', 'TRANSFER_OUT', 'TRANSIT_IN', 'TRANSIT_OUT', 'RECEIPT_IN', 'RENTAL_IN', 'RENTAL_RETURN_OUT', 'LOSS_OUT', 'ADJUSTMENT']);
export const transferKindSchema = z.enum(['DISPATCH', 'TRANSFER', 'RETURN']);
export const transferStatusSchema = z.enum(['ON_THE_WAY', 'RECEIVED', 'RECEIVED_WITH_GAP', 'CANCELLED']);
export const rentalStatusSchema = z.enum(['ACTIVE', 'RETURNED', 'CLOSED']);
export const lossKindSchema = z.enum(['MISSING', 'DAMAGED']);
export const lossStatusSchema = z.enum(['REPORTED', 'CHARGED']);
export const chargeToSchema = z.enum(['PROJECT', 'SUBCONTRACTOR', 'WRITE_OFF']);
export const chargeKindSchema = z.enum(['INTERNAL_HIRE', 'RENTAL']);

const name = z.string().trim().min(2, 'Name is too short').max(80);
const coverage = z
  .union([z.number(), z.string().trim().regex(/^\d{1,6}(\.\d{1,3})?$/)])
  .transform((v) => new Prisma.Decimal(v))
  .refine((d) => d.gt(0), 'Must be greater than 0')
  .meta({ example: 6, description: 'Shuttering plate face area per unit (sq ft)' });

/** Signed, non-zero quantity with at most 3 dp. */
const signedQty = z
  .union([z.number(), z.string().trim().regex(/^-?\d{1,10}(\.\d{1,3})?$/, 'Quantity must be a number with at most 3 decimals')])
  .transform((v, ctx) => {
    const d = new Prisma.Decimal(v);
    if (!d.isFinite() || d.decimalPlaces() > 3 || d.eq(0) || d.abs().gt(1_000_000_000)) {
      ctx.addIssue({ code: 'custom', message: 'Quantity must be non-zero with at most 3 decimals' });
      return z.NEVER;
    }
    return d;
  })
  .meta({ example: -4, description: '+ found / more counted, − disposed / short' });

function uniqueBy<T>(key: (t: T) => string, message: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const k = key(item);
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [i], message });
      seen.add(k);
    });
  };
}

// ─── Register ───────────────────────────────────────────────────────────────

export const createEquipmentBody = z.object({
  name,
  code: z.string().trim().min(1).max(20).optional().meta({ example: 'MX-01' }),
  kind: equipmentKindSchema,
  category: equipmentCategorySchema,
  unit: z.string().trim().min(1).max(20).optional().meta({ example: 'nos' }),
  serialNo: z.string().trim().min(1).max(60).optional(),
  hireRatePaisaPerDay: paisaSchema.optional().meta({ example: '150000', description: 'Internal hire per unit per day (paisa)' }),
  replacementValuePaisa: paisaSchema.optional().meta({ example: '850000', description: 'Value of one unit when lost (paisa)' }),
  coverageSqftPerUnit: coverage.optional(),
  notes: note.optional(),
});

export const updateEquipmentBody = z
  .object({
    name: name.optional(),
    code: z.string().trim().min(1).max(20).nullable().optional(),
    kind: equipmentKindSchema.optional(),
    category: equipmentCategorySchema.optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    serialNo: z.string().trim().min(1).max(60).nullable().optional(),
    hireRatePaisaPerDay: paisaSchema.optional(),
    replacementValuePaisa: paisaSchema.optional(),
    coverageSqftPerUnit: coverage.nullable().optional(),
    notes: note.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const listEquipmentQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(60).optional(),
  category: equipmentCategorySchema.optional(),
  kind: equipmentKindSchema.optional(),
  active: boolQuery,
});

export const stockInBody = z
  .object({
    locationId: uuid('locationId').optional().meta({ description: 'Default: the yard (Central Store)' }),
    projectId: uuid('projectId').optional().meta({ description: 'Shortcut for the project’s site' }),
    qty: quantitySchema,
    type: z.enum(['OPENING', 'PURCHASE']),
    date: isoDateSchema.optional().meta({ description: 'Defaults to today' }),
    note: note.optional(),
  })
  .refine((v) => !(v.locationId && v.projectId), { message: 'Give locationId or projectId, not both', path: ['locationId'] });

export const adjustBody = z.object({
  locationId: uuid('locationId'),
  qty: signedQty,
  rentalId: uuid('rentalId').optional(),
  reason: z.string().trim().min(3, 'Write the reason').max(500),
  date: isoDateSchema.optional(),
});

export const balancesQuery = z.object({
  projectId: uuid('projectId').optional(),
  locationId: uuid('locationId').optional(),
  equipmentId: uuid('equipmentId').optional(),
  category: equipmentCategorySchema.optional(),
});

export const movementsQuery = paginationQuery.extend({
  equipmentId: uuid('equipmentId').optional(),
  locationId: uuid('locationId').optional(),
  projectId: uuid('projectId').optional(),
  type: movementTypeSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ─── Transfers ──────────────────────────────────────────────────────────────

export const createTransferBody = z
  .object({
    fromLocationId: uuid('fromLocationId').meta({ description: 'The yard (Central Store) or a site' }),
    toLocationId: uuid('toLocationId').optional(),
    toProjectId: uuid('toProjectId').optional().meta({ description: 'Shortcut for the project’s site' }),
    date: isoDateSchema.optional().meta({ description: 'Defaults to now' }),
    vehicleNo: z.string().trim().min(2).max(20).optional().meta({ example: 'LES-4521' }),
    driverName: z.string().trim().min(2).max(60).optional(),
    note: note.optional(),
    items: z
      .array(z.object({ equipmentId: uuid('equipmentId'), rentalId: uuid('rentalId').optional(), qty: quantitySchema }))
      .min(1, 'Add at least one item')
      .max(100)
      .superRefine(uniqueBy((i) => `${i.equipmentId}:${i.rentalId ?? ''}`, 'This item is listed twice')),
  })
  .refine((v) => Boolean(v.toLocationId) !== Boolean(v.toProjectId), { message: 'Give either toLocationId or toProjectId', path: ['toLocationId'] });

export const listTransfersQuery = paginationQuery.extend({
  status: transferStatusSchema.optional(),
  kind: transferKindSchema.optional(),
  projectId: uuid('projectId').optional(),
  locationId: uuid('locationId').optional(),
});

export const receiveTransferBody = z.object({
  date: isoDateSchema.optional().meta({ description: 'Defaults to now' }),
  note: note.optional(),
  items: z
    .array(
      z.object({
        itemId: uuid('itemId'),
        receivedQty: countSchema.meta({ description: 'Everything that arrived, damaged included' }),
        damagedQty: countSchema.optional(),
        note: note.optional().meta({ description: 'Required when short or damaged' }),
        photoAttachmentId: uuid('photoAttachmentId').optional(),
      }),
    )
    .min(1)
    .max(100)
    .superRefine(uniqueBy((i) => i.itemId, 'This item is listed twice')),
});

// ─── Rentals ────────────────────────────────────────────────────────────────

export const createRentalBody = z
  .object({
    supplierId: uuid('supplierId'),
    projectId: uuid('projectId').optional().meta({ description: 'Delivered to this project’s site; rent is charged to it' }),
    locationId: uuid('locationId').optional().meta({ description: 'Or delivered to the yard (no project)' }),
    startDate: isoDateSchema,
    expectedEndDate: isoDateSchema.optional(),
    depositPaisa: paisaSchema.optional(),
    reference: z.string().trim().min(1).max(40).optional().meta({ example: 'PSY-2231' }),
    note: note.optional(),
    items: z
      .array(z.object({ equipmentId: uuid('equipmentId'), qty: quantitySchema, ratePaisaPerDay: paisaSchema }))
      .min(1, 'Add at least one item')
      .max(50)
      .superRefine(uniqueBy((i) => i.equipmentId, 'This item is listed twice')),
  })
  .refine((v) => Boolean(v.projectId) !== Boolean(v.locationId), { message: 'Give either projectId or locationId', path: ['projectId'] })
  .refine((v) => !v.expectedEndDate || v.expectedEndDate >= v.startDate, { message: 'The end date is before the start', path: ['expectedEndDate'] });

export const listRentalsQuery = paginationQuery.extend({
  status: rentalStatusSchema.optional(),
  supplierId: uuid('supplierId').optional(),
  projectId: uuid('projectId').optional(),
  overdue: boolQuery,
});

export const extendRentalBody = z.object({ expectedEndDate: isoDateSchema, note: note.optional() });

export const returnRentalBody = z
  .object({
    returnDate: isoDateSchema,
    fromLocationId: uuid('fromLocationId').optional().meta({ description: 'Default: where the rental was delivered' }),
    items: z
      .array(
        z.object({
          rentalItemId: uuid('rentalItemId'),
          qty: countSchema.meta({ description: 'Handed back to the yard' }),
          damagedQty: countSchema.optional().meta({ description: 'Of the handed-back qty, damaged' }),
          missingQty: countSchema.optional().meta({ description: 'Not handed back (must be reported as a MISSING loss first)' }),
        }),
      )
      .min(1)
      .max(50)
      .superRefine(uniqueBy((i) => i.rentalItemId, 'This item is listed twice')),
    damageChargesPaisa: paisaSchema.optional().meta({ example: '450000' }),
    note: note.optional(),
  })
  .superRefine((v, ctx) => {
    v.items.forEach((i, n) => {
      if (i.damagedQty && i.damagedQty.gt(i.qty)) ctx.addIssue({ code: 'custom', path: ['items', n, 'damagedQty'], message: 'Damaged can’t be more than returned' });
      if (i.qty.add(i.missingQty ?? 0).lte(0)) ctx.addIssue({ code: 'custom', path: ['items', n, 'qty'], message: 'Return or mark missing at least one' });
    });
  });

export const closeRentalBody = z.object({
  depositRefundPaisa: paisaSchema.optional().meta({ description: 'Cash the yard paid back; the rest of the deposit is adjusted against the charges' }),
  note: note.optional(),
});

// ─── Losses ─────────────────────────────────────────────────────────────────

export const reportLossBody = z
  .object({
    projectId: uuid('projectId').optional().meta({ description: 'The project’s site (Munshi)' }),
    locationId: uuid('locationId').optional(),
    equipmentId: uuid('equipmentId'),
    rentalId: uuid('rentalId').optional().meta({ description: 'Rented units of this rental' }),
    kind: lossKindSchema,
    qty: quantitySchema,
    photoAttachmentId: uuid('photoAttachmentId').optional(),
    note: z.string().trim().min(3, 'Write what happened').max(500),
    date: isoDateSchema.optional(),
  })
  .refine((v) => Boolean(v.projectId) !== Boolean(v.locationId), { message: 'Give either projectId or locationId', path: ['projectId'] });

export const listLossesQuery = paginationQuery.extend({
  status: lossStatusSchema.optional(),
  kind: lossKindSchema.optional(),
  projectId: uuid('projectId').optional(),
  equipmentId: uuid('equipmentId').optional(),
});

export const chargeLossBody = z
  .object({
    chargedTo: chargeToSchema,
    valuePaisa: paisaSchema.optional().meta({ description: 'Default: qty × replacement value' }),
    subcontractAssignmentId: uuid('subcontractAssignmentId').optional(),
    note: z.string().trim().min(3, 'Write what was decided').max(500),
  })
  .superRefine((v, ctx) => {
    if (v.chargedTo === 'SUBCONTRACTOR' && !v.subcontractAssignmentId) ctx.addIssue({ code: 'custom', path: ['subcontractAssignmentId'], message: 'Choose the sub-contract to charge' });
    if (v.chargedTo !== 'SUBCONTRACTOR' && v.subcontractAssignmentId) ctx.addIssue({ code: 'custom', path: ['subcontractAssignmentId'], message: 'Only for SUBCONTRACTOR' });
  });

// ─── Charges / accrual ──────────────────────────────────────────────────────

export const listChargesQuery = paginationQuery.extend({
  projectId: uuid('projectId').optional(),
  kind: chargeKindSchema.optional(),
  equipmentId: uuid('equipmentId').optional(),
  rentalId: uuid('rentalId').optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const accrualBody = z.object({ through: isoDateSchema.optional().meta({ description: 'Last day to post (≤ yesterday); default yesterday' }) });

export type CreateEquipmentInput = z.infer<typeof createEquipmentBody>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentBody>;
export type ListEquipmentQuery = z.infer<typeof listEquipmentQuery>;
export type StockInInput = z.infer<typeof stockInBody>;
export type AdjustInput = z.infer<typeof adjustBody>;
export type BalancesQuery = z.infer<typeof balancesQuery>;
export type MovementsQuery = z.infer<typeof movementsQuery>;
export type CreateTransferInput = z.infer<typeof createTransferBody>;
export type ListTransfersQuery = z.infer<typeof listTransfersQuery>;
export type ReceiveTransferInput = z.infer<typeof receiveTransferBody>;
export type CreateRentalInput = z.infer<typeof createRentalBody>;
export type ListRentalsQuery = z.infer<typeof listRentalsQuery>;
export type ExtendRentalInput = z.infer<typeof extendRentalBody>;
export type ReturnRentalInput = z.infer<typeof returnRentalBody>;
export type CloseRentalInput = z.infer<typeof closeRentalBody>;
export type ReportLossInput = z.infer<typeof reportLossBody>;
export type ListLossesQuery = z.infer<typeof listLossesQuery>;
export type ChargeLossInput = z.infer<typeof chargeLossBody>;
export type ListChargesQuery = z.infer<typeof listChargesQuery>;
export type AccrualInput = z.infer<typeof accrualBody>;

// ─── Shuttering demand + idle rent (Step 16 part 2) ─────────────────────────

const weeksQuery = z.coerce.number().int().min(1, 'Between 1 and 26 weeks').max(26, 'Between 1 and 26 weeks').optional().meta({ example: 8, description: 'Weeks to plan (default 8)' });
export const shutteringDemandQuery = z.object({
  projectId: uuid('projectId').optional(),
  from: isoDateSchema.optional().meta({ description: 'First week (snapped back to Monday; default this week)', example: '2026-10-12' }),
  weeks: weeksQuery,
});
export const projectShutteringQuery = shutteringDemandQuery.omit({ projectId: true });
export const idleQuery = z.object({
  projectId: uuid('projectId').optional(),
  all: boolQuery.meta({ description: 'true = also rentals below the idle threshold' }),
});

export type ShutteringDemandQuery = z.infer<typeof shutteringDemandQuery>;
export type IdleQuery = z.infer<typeof idleQuery>;
