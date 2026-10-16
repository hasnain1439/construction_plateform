/** Zod schemas of the schedule (Step 13): generate, re-plan, milestone edit / progress, stoppage days. */
import { z } from 'zod';
import { isoDateSchema } from '../../core/utils/dates.js';

const uuid = (what: string) => z.uuid({ error: `${what} must be a UUID` });
const note = (max = 500) => z.string().trim().min(1).max(max, `Note is too long (${max} max)`);

export const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'CURING', 'DONE', 'BLOCKED'] as const;
export const STOPPAGE_REASONS = ['RAIN', 'SMOG_BAN', 'HOLIDAY', 'OWNER_HOLD', 'MATERIAL_SHORT', 'LABOUR_SHORT', 'OTHER'] as const;
export const DELAY_CATEGORIES = ['OWNER', 'EXCUSABLE', 'CONTRACTOR'] as const;
export const STOPPAGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export const milestoneIdParams = z.object({ id: uuid('Milestone id').meta({ description: 'Milestone id' }) });
export const stoppageIdParams = z.object({ id: uuid('Stoppage id').meta({ description: 'Stoppage id' }) });

export const generateScheduleBody = z
  .object({
    startDate: isoDateSchema.optional().meta({ description: 'First day of work (default: the project start date)', example: '2026-03-16' }),
    teams: z.number().int().min(1, 'At least 1 team').max(6, 'At most 6 teams').optional().meta({ description: 'Parallel teams per activity (effort ÷ teams), default 1', example: 1 }),
    note: z.string().trim().max(500, 'Note is too long (500 max)').nullish().meta({ example: 'Plan shared with the owner' }),
  })
  .strict()
  .meta({ id: 'GenerateScheduleInput' });
export type GenerateInput = z.infer<typeof generateScheduleBody>;

export const replanBody = z
  .object({
    note: z.string().trim().min(3, 'Say why (3 characters at least)').max(500, 'Note is too long (500 max)').meta({ example: 'Rain week + owner asked to add a store room' }),
    fromToday: z.boolean().optional().meta({ description: 'Default true: nothing not started is planned before today; in-progress work = remaining effort from today' }),
    refreshQuantities: z.boolean().optional().meta({ description: 'Re-read the current APPROVED estimate (efforts, quotas, new milestones)' }),
    teams: z.number().int().min(1).max(6).optional().meta({ description: 'Change the teams (efforts are recomputed)' }),
  })
  .strict()
  .meta({ id: 'ReplanScheduleInput' });
export type ReplanInput = z.infer<typeof replanBody>;

export const dependencySchema = z.object({
  milestoneId: uuid('milestoneId'),
  type: z.enum(['FS', 'SS']).default('FS'),
  lagDays: z.number().int().min(0, 'Lag cannot be negative').max(90, 'Lag is too long (90 days max)').default(0).meta({ description: 'Calendar days (curing)' }),
});

export const milestoneEditBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    workDays: z.number().min(0.5, 'At least half a day').max(1000).multipleOf(0.5).optional().meta({ description: 'Effort in team-days' }),
    curingDays: z.number().int().min(0).max(60).optional(),
    startNoEarlierThan: isoDateSchema.nullable().optional().meta({ description: 'Gantt drag: start on or after this date (null clears)' }),
    dependsOn: z.array(dependencySchema).max(10).optional(),
    billingStageId: uuid('billingStageId').nullable().optional().meta({ description: 'Payment stage this milestone starts (stage-lock warning)' }),
    dryRun: z.boolean().optional().meta({ description: 'Preview the shifts without saving' }),
  })
  .strict()
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'dryRun' && x !== undefined), { message: 'Nothing to change' })
  .meta({ id: 'MilestoneEditInput' });
export type MilestoneEditInput = z.infer<typeof milestoneEditBody>;

export const progressBody = z
  .object({
    clientId: uuid('clientId').optional().meta({ description: 'Phone-generated id — a retry returns the first update' }),
    progressPercent: z.number().int().min(0).max(100).optional().meta({ example: 60 }),
    status: z.enum(MILESTONE_STATUSES).optional(),
    note: note().optional().meta({ example: 'Shuttering complete, steel binding started' }),
    date: isoDateSchema.optional().meta({ description: 'Actual start / end date (≤ today, default today)' }),
    photoAttachmentIds: z.array(uuid('photoAttachmentIds')).max(10).optional().meta({ description: 'SITE_PHOTO attachments' }),
    deviceCreatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => v.progressPercent !== undefined || v.status !== undefined, { message: 'Send progressPercent and / or status', path: ['progressPercent'] })
  .meta({ id: 'MilestoneProgressInput' });
export type ProgressInput = z.infer<typeof progressBody>;

export const stoppageBody = z
  .object({
    clientId: uuid('clientId').optional(),
    dates: z.array(isoDateSchema).min(1).max(31).optional().meta({ description: 'The days (or from + to)' }),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    reason: z.enum(STOPPAGE_REASONS),
    note: note().optional().meta({ example: 'Heavy rain since morning, site flooded' }),
    photoAttachmentIds: z.array(uuid('photoAttachmentIds')).max(10).optional().meta({ description: 'SITE_PHOTO attachments — at least one unless HOLIDAY' }),
    deviceCreatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => Boolean(v.dates?.length) !== Boolean(v.from), { message: 'Send dates, or from (+ to)', path: ['dates'] })
  .refine((v) => !v.to || (v.from !== undefined && v.to >= v.from), { message: 'to must be on or after from', path: ['to'] })
  .meta({ id: 'StoppageInput' });
export type StoppageInput = z.infer<typeof stoppageBody>;

export const approveStoppageBody = z
  .object({ category: z.enum(DELAY_CATEGORIES).optional().meta({ description: 'Who the days are charged to (default from the reason)' }), note: note().optional() })
  .strict()
  .meta({ id: 'ApproveStoppageInput' });
export type ApproveStoppageInput = z.infer<typeof approveStoppageBody>;

export const rejectStoppageBody = z
  .object({ note: z.string().trim().min(3, 'Say why (3 characters at least)').max(500) })
  .strict()
  .meta({ id: 'RejectStoppageInput' });

export const stoppagesQuery = z.object({ status: z.enum(STOPPAGE_STATUSES).optional() });
export const todayQuery = z.object({ date: isoDateSchema.optional() });
