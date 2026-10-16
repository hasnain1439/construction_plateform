import { z } from 'zod';

export const setOverridesBody = z
  .object({
    overrides: z
      .array(
        z
          .object({
            key: z.string().trim().min(1, 'key is required').max(80).meta({ description: 'Rulebook parameter key (GET /rulebook)', example: 'contingencyPercent' }),
            value: z.number({ error: 'value must be a number' }).finite().meta({ description: 'Company value — must be within the parameter safe range', example: 7 }),
            note: z.string().trim().max(300, 'Note is too long (300 max)').nullish().meta({ description: 'Why the company uses its own value', example: 'Our sites need more allowance' }),
          })
          .strict(),
      )
      .min(1, 'Send at least one override')
      .max(100, 'At most 100 overrides at once'),
  })
  .strict()
  .meta({ id: 'SetRulebookOverridesInput' });
export type SetOverridesInput = z.infer<typeof setOverridesBody>;

export const keyParams = z.object({ key: z.string().trim().min(1).max(80).meta({ description: 'Rulebook parameter key', example: 'contingencyPercent' }) });
