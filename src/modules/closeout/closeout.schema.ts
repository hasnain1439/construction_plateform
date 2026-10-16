/** Step 17 · Closeout — request schemas (drawings, snags, handover, retention). */
import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { langSchema } from '../../core/i18n/lang.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { boolQuery, uuid } from '../inventory/inventory.schema.js';
import { offline } from '../labor/labor.schema.js';

export const DRAWING_FOLDERS = ['ARCHITECTURAL', 'STRUCTURAL', 'MEP', 'SOCIETY_APPROVED', 'OTHER'] as const;
export const SNAG_STATUSES = ['OPEN', 'FIXED', 'VERIFIED'] as const;
export const COST_ATTRIBUTIONS = ['NONE', 'REWORK', 'SUBCONTRACTOR_DEDUCTION', 'CHANGE_ORDER'] as const;
export const HANDOVER_ITEM_KEYS = ['KEYS', 'ELECTRICITY_CONNECTION', 'GAS_CONNECTION', 'WATER_CONNECTION', 'WARRANTY_CARDS', 'FINAL_DRAWINGS', 'FINAL_PHOTOS'] as const;

export const drawingFolderSchema = z.enum(DRAWING_FOLDERS, { error: `folder must be one of ${DRAWING_FOLDERS.join(', ')}` });
export const snagStatusSchema = z.enum(SNAG_STATUSES);
export const costAttributionSchema = z.enum(COST_ATTRIBUTIONS, { error: `attribution must be one of ${COST_ATTRIBUTIONS.join(', ')}` });
export const handoverItemKeySchema = z.enum(HANDOVER_ITEM_KEYS, { error: `Unknown checklist item — one of ${HANDOVER_ITEM_KEYS.join(', ')}` });

export const idParams = z.object({ id: uuid('id') });
export const itemParams = z.object({ id: uuid('id'), key: handoverItemKeySchema });

const note = z.string().trim().max(1000, 'Keep the note under 1000 characters');
const photoIds = (label: string) => z.array(uuid(label)).max(10, 'At most 10 photos');

// ─── Drawings ───────────────────────────────────────────────────────────────

const revisionFields = {
  attachmentId: uuid('attachmentId').meta({ description: 'DOCUMENT attachment (PDF or image) uploaded with POST /attachments' }),
  approvedAt: isoDateSchema.optional().meta({ description: 'Date the revision was approved (society / client / engineer)' }),
  notes: note.optional(),
};

export const drawingsQuery = z.object({
  folder: drawingFolderSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export const createDrawingBody = z.object({
  folder: drawingFolderSchema,
  title: z.string().trim().min(1, 'Title is required').max(200),
  number: z.string().trim().max(40).optional().meta({ example: 'A-101' }),
  milestoneId: uuid('milestoneId').optional().meta({ description: 'Schedule milestone (Step 13)' }),
  notes: note.optional(),
  revision: z.object(revisionFields),
});

export const updateDrawingBody = z
  .object({
    folder: drawingFolderSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    number: z.string().trim().max(40).nullable().optional(),
    milestoneId: uuid('milestoneId').nullable().optional(),
    notes: note.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const addRevisionBody = z.object(revisionFields);

export const updateRevisionBody = z
  .object({ approvedAt: isoDateSchema.nullable().optional(), notes: note.nullable().optional() })
  .refine((v) => v.approvedAt !== undefined || v.notes !== undefined, { message: 'Nothing to update' });

// ─── Snags ──────────────────────────────────────────────────────────────────

export const snagsQuery = paginationQuery.extend({
  status: snagStatusSchema.optional(),
  assigneeType: z.enum(['WORKER', 'SUBCONTRACTOR']).optional(),
  assigneeId: uuid('assigneeId').optional(),
  roomId: uuid('roomId').optional(),
  defectPeriod: boolQuery.optional(),
  overdue: boolQuery.optional(),
  q: z.string().trim().max(100).optional(),
});

const assignee = {
  workerId: uuid('workerId').optional().meta({ description: 'Assign to a worker (or subcontractorId, not both)' }),
  subcontractorId: uuid('subcontractorId').optional(),
};

export const createSnagBody = z
  .object({
    roomId: uuid('roomId').optional(),
    location: z.string().trim().max(200).optional().meta({ example: 'Master bedroom — east wall near window' }),
    description: z.string().trim().min(3, 'Describe the snag (at least 3 characters)').max(1000),
    beforePhotoIds: photoIds('beforePhotoId').optional().meta({ description: 'SITE_PHOTO attachments' }),
    ...assignee,
    targetDate: isoDateSchema.optional(),
    ...offline,
  })
  .refine((v) => !(v.workerId && v.subcontractorId), { message: 'Assign to a worker or a sub-contractor, not both', path: ['subcontractorId'] });

export const updateSnagBody = z
  .object({
    roomId: uuid('roomId').nullable().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().min(3).max(1000).optional(),
    beforePhotoIds: photoIds('beforePhotoId').optional(),
    workerId: uuid('workerId').nullable().optional(),
    subcontractorId: uuid('subcontractorId').nullable().optional(),
    targetDate: isoDateSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })
  .refine((v) => !(v.workerId && v.subcontractorId), { message: 'Assign to a worker or a sub-contractor, not both', path: ['subcontractorId'] });

export const fixSnagBody = z.object({
  afterPhotoIds: photoIds('afterPhotoId').optional().meta({ description: 'SITE_PHOTO attachments after the fix' }),
  note: note.optional(),
});

export const verifySnagBody = z.object({ note: note.optional() });

export const reopenSnagBody = z.object({ reason: z.string().trim().min(3, 'Write a short reason (at least 3 characters)').max(500) });

export const snagCostBody = z.object({
  attribution: costAttributionSchema,
  amountPaisa: paisaSchema.optional().meta({ description: 'Required (> 0) for REWORK and SUBCONTRACTOR_DEDUCTION' }),
  subcontractAssignmentId: uuid('subcontractAssignmentId').optional().meta({ description: "Deduction: the sub-contract account (default: the snag sub-contractor's latest one on the project)" }),
  note: note.optional(),
});

// ─── Handover / retention ───────────────────────────────────────────────────

export const handoverItemBody = z.object({
  done: z.boolean(),
  note: note.optional(),
  attachmentIds: z.array(uuid('attachmentId')).max(10).optional().meta({ description: 'Photos / documents (SITE_PHOTO or DOCUMENT)' }),
});

export const signOffBody = z.object({
  ownerName: z.string().trim().min(2, 'Owner name is required').max(120),
  signedOn: isoDateSchema,
  signatureAttachmentId: uuid('signatureAttachmentId').optional().meta({ description: 'Photo of the signed handover slip (SITE_PHOTO or DOCUMENT)' }),
  note: note.optional(),
});

export const completeHandoverBody = z.object({
  handoverDate: isoDateSchema.optional().meta({ description: 'Default today (Asia/Karachi); not in the future' }),
  acceptOpenSnags: z.boolean().optional().meta({ description: 'Hand over although snags are still open (they stay on the list)' }),
  note: z.string().trim().max(500).optional(),
});

export const certificateQuery = z.object({ lang: langSchema.optional() });

export const retentionSettingsBody = z.object({
  reminderDaysBefore: z.number().int().min(1, 'Between 1 and 90 days').max(90, 'Between 1 and 90 days'),
});

export type DrawingsQuery = z.infer<typeof drawingsQuery>;
export type CreateDrawingInput = z.infer<typeof createDrawingBody>;
export type UpdateDrawingInput = z.infer<typeof updateDrawingBody>;
export type AddRevisionInput = z.infer<typeof addRevisionBody>;
export type UpdateRevisionInput = z.infer<typeof updateRevisionBody>;
export type SnagsQuery = z.infer<typeof snagsQuery>;
export type CreateSnagInput = z.infer<typeof createSnagBody>;
export type UpdateSnagInput = z.infer<typeof updateSnagBody>;
export type FixSnagInput = z.infer<typeof fixSnagBody>;
export type VerifySnagInput = z.infer<typeof verifySnagBody>;
export type ReopenSnagInput = z.infer<typeof reopenSnagBody>;
export type SnagCostInput = z.infer<typeof snagCostBody>;
export type HandoverItemInput = z.infer<typeof handoverItemBody>;
export type SignOffInput = z.infer<typeof signOffBody>;
export type CompleteHandoverInput = z.infer<typeof completeHandoverBody>;
export type CertificateQuery = z.infer<typeof certificateQuery>;
export type RetentionSettingsInput = z.infer<typeof retentionSettingsBody>;
