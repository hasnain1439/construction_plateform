/** Step 14 · control request schemas (Zod; also the OpenAPI request bodies). */
import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { controlThresholdFields } from '../company/company.schema.js';

export const materialVarianceQuery = z.object({
  milestoneId: z.uuid({ error: 'milestoneId must be a UUID' }).optional().meta({ description: 'Only this milestone: its quotas × its progress vs usage linked to it' }),
});
export type MaterialVarianceQuery = z.infer<typeof materialVarianceQuery>;

export const ALERT_STATUSES = ['OPEN', 'RESOLVED', 'ALL'] as const;

export const projectAlertsQuery = z.object({
  status: z.enum(ALERT_STATUSES).default('OPEN'),
});
export type ProjectAlertsQuery = z.infer<typeof projectAlertsQuery>;

export const alertsQuery = paginationQuery.extend({
  projectId: z.uuid({ error: 'projectId must be a UUID' }).optional(),
  rule: z.string().trim().min(1).max(60).optional().meta({ example: 'MATERIAL_OVERUSE' }),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  status: z.enum(ALERT_STATUSES).default('OPEN'),
});
export type AlertsQuery = z.infer<typeof alertsQuery>;

export const runAlertsBody = z
  .object({
    projectId: z.uuid({ error: 'projectId must be a UUID' }).optional().meta({ description: 'Only this project (default: every ACTIVE / CLOSEOUT project)' }),
    rules: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional().meta({ description: 'Only these rules (default: every rule the engine evaluates)', example: ['MATERIAL_OVERUSE'] }),
  })
  .strict();
export type RunAlertsInput = z.infer<typeof runAlertsBody>;

export const controlSettingsBody = z
  .object({
    overuseAlertPercent: z.number().int('Must be a whole number between 1 and 20').min(1, 'Must be between 1 and 20').max(20, 'Must be between 1 and 20').optional(),
    ...controlThresholdFields,
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type ControlSettingsInput = z.infer<typeof controlSettingsBody>;
