import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';
import { boolQuery, note, quantitySchema, uuid } from '../inventory/inventory.schema.js';

/** Paisa > 0 */
export const amountSchema = paisaSchema.refine((v) => v > 0n, 'Amount must be more than 0');
export const percentSchema = z.number().min(0, 'Must be between 0 and 100').max(100, 'Must be between 0 and 100').multipleOf(0.01);
export const requiredNote = z.string().trim().min(3, 'Write a short reason (at least 3 characters)').max(500);

/** Offline-safe create: the phone's UUID v7 and when it saved the record. */
export const offline = {
  clientId: z.uuid({ error: 'Invalid clientId' }).optional().meta({ description: 'UUID v7 made on the phone. Sending it again returns the saved record (200).' }),
  deviceCreatedAt: z.iso.datetime({ offset: true, error: 'Invalid deviceCreatedAt' }).optional().meta({ example: '2026-10-06T08:15:00+05:00' }),
};

export const idParams = z.object({ id: uuid('id') });
export const lineParams = z.object({ id: uuid('id'), lineId: uuid('lineId') });

export const attendanceStatusSchema = z.enum(['FULL', 'HALF', 'ABSENT']);
export const rateTypeSchema = z.enum(['PER_SQFT', 'PER_TON', 'PER_BRICK', 'PER_RFT', 'PER_CFT', 'LUMPSUM']);
export const laborPaidFromSchema = z.enum(['SITE_CASH', 'OFFICE_CASH', 'BANK', 'JAZZCASH', 'EASYPAISA']);
export const payeeTypeSchema = z.enum(['WORKER', 'SUBCONTRACTOR']);
export const settlementStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED']);
export const measurementStatusSchema = z.enum(['RECORDED', 'VERIFIED', 'REJECTED']);
const reference = z.string().trim().min(1).max(60);

// ─── B1: who works on the project ───────────────────────────────────────────

export const projectWorkersQuery = z.object({ active: boolQuery });

export const assignWorkerBody = z.object({
  workerId: uuid('workerId'),
  dailyRatePaisa: amountSchema.optional().meta({ description: "Defaults to the worker's own daily rate. MUNSHI may not change it." }),
  startDate: isoDateSchema.optional().meta({ description: 'Defaults to today' }),
});

export const updateProjectWorkerBody = z
  .object({
    dailyRatePaisa: amountSchema.optional(),
    endDate: isoDateSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const subcontractsQuery = z.object({ active: boolQuery });

export const assignSubcontractBody = z
  .object({
    subcontractorId: uuid('subcontractorId'),
    scope: z.string().trim().min(2, 'Describe the work').max(200).meta({ example: 'Shuttering — ground + first floor slabs' }),
    rateType: rateTypeSchema,
    ratePaisa: amountSchema.optional().meta({ description: "Unit rate. Defaults to the company's SUBCONTRACT labour rate for the trade." }),
    contractValuePaisa: amountSchema.optional().meta({ description: "LUMPSUM only. Defaults to the trade's LUMPSUM labour rate." }),
    retentionPercent: percentSchema.max(20, 'Retention can be at most 20%').optional().meta({ description: 'Default 5' }),
    startDate: isoDateSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.rateType !== 'LUMPSUM' && v.contractValuePaisa !== undefined) ctx.addIssue({ code: 'custom', path: ['contractValuePaisa'], message: 'Only a lump-sum contract has a value' });
  });

export const updateSubcontractBody = z
  .object({
    scope: z.string().trim().min(2).max(200).optional(),
    ratePaisa: amountSchema.optional().meta({ description: 'Applies to measurements verified from now on' }),
    contractValuePaisa: amountSchema.optional(),
    retentionPercent: percentSchema.max(20, 'Retention can be at most 20%').optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── B2: hazri ──────────────────────────────────────────────────────────────

const overtime = z.number().min(0, 'Overtime cannot be negative').max(12, 'At most 12 overtime hours').multipleOf(0.5, 'Overtime in half hours');

export const attendanceBody = z.object({
  date: isoDateSchema,
  entries: z
    .array(
      z.object({
        workerId: uuid('workerId'),
        status: attendanceStatusSchema,
        overtimeHours: overtime.optional(),
        note: note.optional(),
      }),
    )
    .min(1, 'Mark at least one worker')
    .max(300)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.workerId)) ctx.addIssue({ code: 'custom', path: [i, 'workerId'], message: 'This worker is listed twice' });
        seen.add(item.workerId);
      });
    }),
  ...offline,
});

export const attendanceQuery = z
  .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be on or before `to`', path: ['to'] });

// ─── B3: measurements and peshgi ────────────────────────────────────────────

export const measurementBody = z.object({
  assignmentId: uuid('assignmentId'),
  date: isoDateSchema,
  description: z.string().trim().min(2, 'Describe the work measured').max(300).meta({ example: 'First-floor slab shuttering' }),
  quantity: quantitySchema,
  attachmentIds: z.array(uuid('attachmentId')).max(10).optional(),
  ...offline,
});

export const measurementsQuery = paginationQuery.extend({
  assignmentId: uuid('assignmentId').optional(),
  status: measurementStatusSchema.optional(),
});

export const rejectBody = z.object({ note: requiredNote });
export const approveBody = z.object({ note: note.optional() }).default({});

export const advanceBody = z
  .object({
    payeeType: payeeTypeSchema,
    workerId: uuid('workerId').optional(),
    assignmentId: uuid('assignmentId').optional(),
    amountPaisa: amountSchema,
    date: isoDateSchema,
    paidFrom: laborPaidFromSchema,
    cashAccountId: uuid('cashAccountId').optional().meta({ description: "SITE_CASH: whose cash. Defaults to the caller's own." }),
    reference: reference.optional(),
    note: note.optional(),
    ...offline,
  })
  .superRefine((v, ctx) => {
    if (v.payeeType === 'WORKER' && !v.workerId) ctx.addIssue({ code: 'custom', path: ['workerId'], message: 'Choose the worker' });
    if (v.payeeType === 'SUBCONTRACTOR' && !v.assignmentId) ctx.addIssue({ code: 'custom', path: ['assignmentId'], message: 'Choose the sub-contract' });
  });

export const advancesQuery = paginationQuery.extend({
  payeeType: payeeTypeSchema.optional(),
  workerId: uuid('workerId').optional(),
  assignmentId: uuid('assignmentId').optional(),
  status: z.enum(['OUTSTANDING', 'PARTLY_ADJUSTED', 'ADJUSTED']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ─── B4: weekly settlements ─────────────────────────────────────────────────

export const settlementsQuery = paginationQuery.extend({ status: settlementStatusSchema.optional() });
export const generateBody = z.object({ weekStart: isoDateSchema.meta({ example: '2026-09-21' }) });
export const lineBody = z.object({
  advanceAdjustedPaisa: paisaSchema.meta({ description: 'Peshgi to cut from this week (0 = none)' }),
  note: requiredNote,
});
export const returnBody = z.object({ comment: requiredNote });
export const payBody = z.object({
  lineIds: z.array(uuid('lineId')).min(1, 'Choose who is being paid').max(300),
  paidFrom: laborPaidFromSchema,
  cashAccountId: uuid('cashAccountId').optional(),
  reference: reference.optional(),
});

// ─── B5: sub-contractor accounts ────────────────────────────────────────────

export const progressBody = z.object({
  percent: z.number().gt(0, 'Must be more than 0').max(100, 'At most 100').multipleOf(0.01).meta({ description: 'Cumulative % complete', example: 40 }),
  date: isoDateSchema.optional(),
  note: note.optional(),
});

export const subcontractPaymentBody = z.object({
  type: z.enum(['RUNNING', 'FINAL', 'RETENTION_RELEASE']),
  amountPaisa: amountSchema,
  paidFrom: laborPaidFromSchema,
  cashAccountId: uuid('cashAccountId').optional(),
  reference: reference.optional(),
  date: isoDateSchema.optional(),
  note: note.optional(),
  allowAdvance: z.boolean().optional().meta({ description: 'Pay more than the balance due (the extra becomes an advance)' }),
});

export const deductionBody = z.object({
  amountPaisa: amountSchema,
  reason: requiredNote,
  date: isoDateSchema.optional(),
});

export const ledgerQuery = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });

export type AssignWorkerInput = z.infer<typeof assignWorkerBody>;
export type UpdateProjectWorkerInput = z.infer<typeof updateProjectWorkerBody>;
export type AssignSubcontractInput = z.infer<typeof assignSubcontractBody>;
export type UpdateSubcontractInput = z.infer<typeof updateSubcontractBody>;
export type AttendanceInput = z.infer<typeof attendanceBody>;
export type AttendanceQuery = z.infer<typeof attendanceQuery>;
export type MeasurementInput = z.infer<typeof measurementBody>;
export type MeasurementsQuery = z.infer<typeof measurementsQuery>;
export type AdvanceInput = z.infer<typeof advanceBody>;
export type AdvancesQuery = z.infer<typeof advancesQuery>;
export type SettlementsQuery = z.infer<typeof settlementsQuery>;
export type LineInput = z.infer<typeof lineBody>;
export type PayInput = z.infer<typeof payBody>;
export type ProgressInput = z.infer<typeof progressBody>;
export type SubcontractPaymentInput = z.infer<typeof subcontractPaymentBody>;
export type DeductionInput = z.infer<typeof deductionBody>;
export type LaborPaidFrom = z.infer<typeof laborPaidFromSchema>;
