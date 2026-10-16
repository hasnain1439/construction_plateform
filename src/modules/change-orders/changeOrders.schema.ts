/** Step 15 · Change orders — request schemas (change orders, billing link, site instructions). */
import { z } from 'zod';
import { Prisma } from '../../core/db/prisma.js';
import { langSchema } from '../../core/i18n/lang.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { quantitySchema, uuid } from '../inventory/inventory.schema.js';
import { offline } from '../labor/labor.schema.js';

export const CHANGE_ORDER_TYPES = ['ADDITION', 'DEDUCTION'] as const;
export const CHANGE_ORDER_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'BILLED'] as const;
export const PROOF_TYPES = ['WHATSAPP_SCREENSHOT', 'SIGNED_SLIP', 'VERBAL'] as const;
export const LINE_KINDS = ['MATERIAL', 'LABOUR', 'OTHER'] as const;
export const BILLING_MODES = ['NEXT_STAGE', 'VARIATION'] as const;
export const SITE_INSTRUCTION_STATUSES = ['NEW', 'CONVERTED', 'DISMISSED'] as const;

export const changeOrderTypeSchema = z.enum(CHANGE_ORDER_TYPES, { error: `type must be one of ${CHANGE_ORDER_TYPES.join(', ')}` });
export const changeOrderStatusSchema = z.enum(CHANGE_ORDER_STATUSES);
export const proofTypeSchema = z.enum(PROOF_TYPES, { error: `proofType must be one of ${PROOF_TYPES.join(', ')}` });
export const billingModeSchema = z.enum(BILLING_MODES, { error: `mode must be one of ${BILLING_MODES.join(', ')}` });
export const siteInstructionStatusSchema = z.enum(SITE_INSTRUCTION_STATUSES);

export const idParams = z.object({ id: uuid('id') });

/** 0–100 with at most 2 decimals → Prisma.Decimal */
const percentSchema = z
  .union([z.number(), z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Markup must be a number with at most 2 decimals')])
  .transform((v, ctx) => {
    const d = new Prisma.Decimal(v);
    if (!d.isFinite() || d.lt(0) || d.gt(100) || d.decimalPlaces() > 2) {
      ctx.addIssue({ code: 'custom', message: 'Markup must be between 0 and 100 % (2 decimals)' });
      return z.NEVER;
    }
    return d;
  })
  .meta({ example: 10, description: 'Markup % on the cost (0–100, 2 decimals)' });

export const lineSchema = z.object({
  kind: z.enum(LINE_KINDS, { error: `kind must be one of ${LINE_KINDS.join(', ')}` }),
  materialId: uuid('materialId').optional().meta({ description: 'MATERIAL lines: company material' }),
  laborRateId: uuid('laborRateId').optional().meta({ description: 'LABOUR lines: company labour rate (or give description + unit + ratePaisa)' }),
  description: z.string().trim().min(1, 'Describe the line').max(300).optional().meta({ description: 'Default: the material / labour rate name' }),
  unit: z.string().trim().min(1).max(20).optional().meta({ description: "Default: the material / labour rate's unit", example: 'sqft' }),
  quantity: quantitySchema,
  ratePaisa: paisaSchema.optional().meta({ description: 'Cost rate per unit (needs fields.rates). Default: approved estimate → price list → labour rate.' }),
});

const lines = z.array(lineSchema).max(100, 'At most 100 lines');
const proofIds = z.array(uuid('proofAttachmentId')).max(10, 'At most 10 proof files');
const milestoneIds = z.array(uuid('affectedMilestoneId')).max(50);
const note = (max: number) => z.string().trim().max(max);

const coFields = {
  title: z.string().trim().min(3, 'Title is required (at least 3 characters)').max(200),
  description: note(2000).optional(),
  type: changeOrderTypeSchema,
  markupPercent: percentSchema.optional(),
  daysImpact: z.number().int('Whole days').min(0).max(365, 'At most 365 days').optional().meta({ description: 'Working days the change adds to the contract end date' }),
  affectedMilestoneIds: milestoneIds.optional().meta({ description: 'Schedule milestones of the project the change touches' }),
  lines: lines.optional(),
  proofType: proofTypeSchema.optional(),
  proofNote: note(1000).optional().meta({ description: 'Required for VERBAL proof (who agreed, when, where)' }),
  proofAttachmentIds: proofIds.optional().meta({ description: 'SITE_PHOTO / DOCUMENT attachments: WhatsApp screenshot, signed slip' }),
};

export const createChangeOrderBody = z.object(coFields);

export const updateChangeOrderBody = z
  .object({
    title: coFields.title.optional(),
    description: note(2000).nullable().optional(),
    type: changeOrderTypeSchema.optional(),
    markupPercent: percentSchema.optional(),
    daysImpact: coFields.daysImpact,
    affectedMilestoneIds: milestoneIds.optional(),
    lines: lines.optional(),
    proofType: proofTypeSchema.nullable().optional(),
    proofNote: note(1000).nullable().optional(),
    proofAttachmentIds: proofIds.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

/** Convert a site instruction / snag: every field optional (defaults from the source). */
export const convertBody = z.object({
  title: coFields.title.optional(),
  description: note(2000).optional(),
  type: changeOrderTypeSchema.optional(),
  markupPercent: percentSchema.optional(),
  daysImpact: coFields.daysImpact,
  affectedMilestoneIds: milestoneIds.optional(),
  lines: lines.optional(),
  proofType: proofTypeSchema.optional(),
  proofNote: note(1000).optional(),
  proofAttachmentIds: proofIds.optional(),
});

export const changeOrdersQuery = z.object({ status: changeOrderStatusSchema.optional() });

export const approveBody = z.object({
  approvedOn: isoDateSchema.optional().meta({ description: 'Date the owner agreed (default today, not in the future)' }),
  proofType: proofTypeSchema.optional(),
  proofNote: note(1000).optional(),
  proofAttachmentIds: proofIds.optional(),
  billingMode: billingModeSchema.optional().meta({ description: 'How it will be billed (can also be chosen when billing)' }),
});

export const rejectBody = z.object({ reason: z.string().trim().min(3, 'Write a short reason (at least 3 characters)').max(500) });
export const emptyBody = z.object({});

export const billBody = z.object({
  mode: billingModeSchema,
  notes: note(500).optional(),
});

export const pdfQuery = z.object({ lang: langSchema.optional() });

// ─── Site instructions ──────────────────────────────────────────────────────

export const siteInstructionsQuery = z.object({ status: siteInstructionStatusSchema.optional() });

export const createSiteInstructionBody = z.object({
  note: z.string().trim().min(3, 'Write what the owner asked for (at least 3 characters)').max(1000),
  photoIds: z.array(uuid('photoId')).max(10, 'At most 10 photos').optional().meta({ description: 'SITE_PHOTO attachments' }),
  ...offline,
});

export const dismissBody = z.object({ reason: z.string().trim().min(3, 'Write a short reason (at least 3 characters)').max(500) });

export type LineInput = z.infer<typeof lineSchema>;
export type CreateChangeOrderInput = z.infer<typeof createChangeOrderBody>;
export type UpdateChangeOrderInput = z.infer<typeof updateChangeOrderBody>;
export type ConvertInput = z.infer<typeof convertBody>;
export type ChangeOrdersQuery = z.infer<typeof changeOrdersQuery>;
export type ApproveInput = z.infer<typeof approveBody>;
export type RejectInput = z.infer<typeof rejectBody>;
export type BillInput = z.infer<typeof billBody>;
export type PdfQuery = z.infer<typeof pdfQuery>;
export type SiteInstructionsQuery = z.infer<typeof siteInstructionsQuery>;
export type CreateSiteInstructionInput = z.infer<typeof createSiteInstructionBody>;
export type DismissInput = z.infer<typeof dismissBody>;
