import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { phoneSchema } from '../auth/auth.schema.js';
import { paisaSchema } from '../company/company.schema.js';
import { countSchema, note, quantitySchema, uniqueMaterials, uuid } from '../inventory/inventory.schema.js';

export { idParams } from '../inventory/inventory.schema.js';

export const dispatchStatusSchema = z.enum(['ON_THE_WAY', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE', 'RECEIVED_WITH_EXCESS', 'CANCELLED']);
export const shortageKindSchema = z.enum(['DISPATCH_SHORT', 'DAMAGED', 'EXCESS', 'SUPPLIER_SHORT']);
export const resolutionSchema = z.enum(['SEND_REMAINING', 'RETURN_TO_STORE', 'ACCEPT_LOSS', 'RECOVER_FROM_DRIVER', 'SUPPLIER_CREDIT']);

const vehicle = {
  vehicleNo: z.string().trim().min(2).max(20).optional().meta({ example: 'LES-4521' }),
  driverName: z.string().trim().min(2).max(60).optional().meta({ example: 'Nadeem' }),
  driverPhone: phoneSchema.optional().meta({ example: '0300-1112233' }),
};

// ─── Dispatches ─────────────────────────────────────────────────────────────

export const createDispatchBody = z
  .object({
    fromLocationId: uuid('fromLocationId').meta({ description: 'Central Store, or a site (transfer)' }),
    toLocationId: uuid('toLocationId').optional(),
    toProjectId: uuid('toProjectId').optional().meta({ description: 'Shortcut for the project’s site location' }),
    ...vehicle,
    dispatchedAt: z.iso.datetime({ offset: true }).optional().meta({ description: 'Defaults to now' }),
    loadPhotoAttachmentId: uuid('loadPhotoAttachmentId').optional(),
    note: note.optional(),
    items: z
      .array(z.object({ materialId: uuid('materialId'), qty: quantitySchema }))
      .min(1, 'Add at least one material')
      .max(100)
      .superRefine(uniqueMaterials),
  })
  .refine((v) => Boolean(v.toLocationId) !== Boolean(v.toProjectId), { message: 'Give either toLocationId or toProjectId', path: ['toLocationId'] });

export const listDispatchesQuery = paginationQuery.extend({
  status: dispatchStatusSchema.optional(),
  fromLocationId: uuid('fromLocationId').optional(),
  toLocationId: uuid('toLocationId').optional(),
  projectId: uuid('projectId').optional().meta({ description: 'Dispatches to or from this project’s site' }),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  search: z.string().trim().min(1).max(40).optional().meta({ description: 'GP number or vehicle' }),
});

export const receiveDispatchBody = z.object({
  items: z
    .array(
      z.object({
        materialId: uuid('materialId'),
        receivedQty: countSchema.meta({ description: 'Everything that arrived, damaged included' }),
        damagedQty: countSchema.optional(),
        note: note.optional().meta({ description: 'Required when the good quantity is less than sent' }),
        photoAttachmentId: uuid('photoAttachmentId').optional(),
      }),
    )
    .min(1)
    .max(100)
    .superRefine(uniqueMaterials),
  note: note.optional(),
});

// ─── Shortages ──────────────────────────────────────────────────────────────

export const listShortagesQuery = paginationQuery.extend({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  kind: shortageKindSchema.optional(),
  source: z.enum(['DISPATCH', 'PURCHASE']).optional(),
  projectId: uuid('projectId').optional(),
});

export const resolveShortageBody = z
  .object({
    resolution: resolutionSchema,
    note: z.string().trim().min(3, 'Write what was decided').max(500),
    recoveredAmountPaisa: paisaSchema.optional().meta({ description: 'RECOVER_FROM_DRIVER only' }),
    chargeToAssignmentId: uuid('chargeToAssignmentId')
      .optional()
      .meta({ description: 'ACCEPT_LOSS only (THEKEDAR): charge the loss to this sub-contract as a deduction' }),
    ...vehicle,
  })
  .superRefine((v, ctx) => {
    if (v.resolution === 'RECOVER_FROM_DRIVER' && (v.recoveredAmountPaisa === undefined || v.recoveredAmountPaisa <= 0n)) {
      ctx.addIssue({ code: 'custom', path: ['recoveredAmountPaisa'], message: 'Enter the amount recovered from the driver' });
    }
    if (v.chargeToAssignmentId && v.resolution !== 'ACCEPT_LOSS') {
      ctx.addIssue({ code: 'custom', path: ['chargeToAssignmentId'], message: 'Only a loss can be charged to a sub-contractor' });
    }
  });

// ─── Owner deliveries ───────────────────────────────────────────────────────

export const ownerDeliveryBody = z.object({
  deliveryDate: isoDateSchema,
  items: z
    .array(z.object({ materialId: uuid('materialId'), qty: quantitySchema }))
    .min(1, 'Add at least one material')
    .max(100)
    .superRefine(uniqueMaterials),
  note: note.optional(),
  photoAttachmentIds: z.array(uuid('photoAttachmentId')).max(10).default([]),
});

export const ownerDeliveriesQuery = paginationQuery;

export type CreateDispatchInput = z.infer<typeof createDispatchBody>;
export type ListDispatchesQuery = z.infer<typeof listDispatchesQuery>;
export type ReceiveDispatchInput = z.infer<typeof receiveDispatchBody>;
export type ListShortagesQuery = z.infer<typeof listShortagesQuery>;
export type ResolveShortageInput = z.infer<typeof resolveShortageBody>;
export type OwnerDeliveryInput = z.infer<typeof ownerDeliveryBody>;
export type OwnerDeliveriesQuery = z.infer<typeof ownerDeliveriesQuery>;
