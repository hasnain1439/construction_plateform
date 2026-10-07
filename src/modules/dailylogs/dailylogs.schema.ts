import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';
import { offline } from '../labor/labor.schema.js';

export const SITE_CONDITIONS = ['NORMAL', 'RAIN', 'POWER_CUT', 'WATER_SHORTAGE', 'CURING', 'LABOUR_SHORT', 'MATERIAL_SHORT', 'OTHER'] as const;
export const siteConditionSchema = z.enum(SITE_CONDITIONS);

export const idParams = z.object({ id: uuid('id') });

const fields = {
  note: z.string().trim().max(2000, 'Keep the note under 2000 characters').optional(),
  conditions: z.array(siteConditionSchema).max(8).optional().meta({ example: ['CURING', 'POWER_CUT'] }),
  workDone: z.string().trim().max(2000).optional().meta({ example: 'First-floor column curing (day 10), water given twice' }),
  photoAttachmentIds: z.array(uuid('photoAttachmentId')).max(10).optional().meta({ description: 'SITE_PHOTO attachments' }),
  voiceAttachmentIds: z.array(uuid('voiceAttachmentId')).max(3).optional().meta({ description: 'VOICE_NOTE attachments (15–30 s)' }),
};

export const dailyLogBody = z.object({
  logDate: isoDateSchema.optional().meta({ description: 'Default today (Asia/Karachi); up to 7 days back' }),
  ...fields,
  ...offline,
});

export const updateDailyLogBody = z.object(fields).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const dailyLogsQuery = paginationQuery.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  author: uuid('author').optional().meta({ description: 'Only this user’s logs' }),
});

export type DailyLogInput = z.infer<typeof dailyLogBody>;
export type UpdateDailyLogInput = z.infer<typeof updateDailyLogBody>;
export type DailyLogsQuery = z.infer<typeof dailyLogsQuery>;
