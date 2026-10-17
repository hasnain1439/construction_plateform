/** Platform admin · estimation rulebook versions (Step 11). */
import { z } from 'zod';
import { regionSchema } from '../auth/auth.schema.js';

export const rulebooksQuery = z.object({ region: regionSchema.optional() });
export type RulebooksQuery = z.infer<typeof rulebooksQuery>;

export const createRulebookBody = z
  .object({
    region: regionSchema,
    notes: z.string().trim().max(1000).nullish().meta({ description: 'What changes in this version', example: 'Engineer review: steel % per element' }),
    copyFromId: z.uuid({ error: 'copyFromId must be a UUID' }).optional().meta({ description: 'Version to copy the values from (same region). Default: the latest version of the region' }),
  })
  .strict()
  .meta({ id: 'CreateRulebookInput' });
export type CreateRulebookInput = z.infer<typeof createRulebookBody>;

export const updateRulebookBody = z
  .object({ notes: z.string().trim().max(1000).nullable().meta({ description: 'Notes of the version', example: 'v2 draft — pending engineer sign-off' }) })
  .strict()
  .meta({ id: 'UpdateRulebookInput' });
export type UpdateRulebookInput = z.infer<typeof updateRulebookBody>;

export const rulebookParamParams = z.object({ id: z.uuid({ error: 'id must be a UUID' }), key: z.string().trim().min(1).max(80) });

export const updateParameterBody = z
  .object({
    value: z.number().finite().optional().meta({ description: 'New value (DRAFT versions only); must be inside the safe range', example: 5 }),
    safeMin: z.number().finite().optional().meta({ description: 'Lowest value a company / project may use (DRAFT only)', example: 4 }),
    safeMax: z.number().finite().optional().meta({ description: 'Highest value a company / project may use (DRAFT only)', example: 6 }),
    reviewStatus: z.enum(['PENDING_ENGINEER_REVIEW', 'REVIEWED']).optional().meta({ description: 'Civil-engineer review (any version)' }),
    label: z
      .object({ en: z.string().trim().min(1).max(120).optional(), roman: z.string().trim().min(1).max(120).optional(), ur: z.string().trim().min(1).max(120).optional() })
      .strict()
      .optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })
  .meta({ id: 'UpdateRulebookParameterInput' });
export type UpdateParameterInput = z.infer<typeof updateParameterBody>;
