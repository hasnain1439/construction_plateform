import { z } from 'zod';

export const pullQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d+$/, 'cursor is the number the last pull returned')
    .optional()
    .meta({ description: 'Omit for a full snapshot; otherwise the `cursor` of the previous pull', example: '1842' }),
  limit: z.coerce.number().int().min(1).max(1000).default(500).meta({ description: 'Change rows per page (incremental pulls)' }),
});

export type PullQuery = z.infer<typeof pullQuery>;

export const SYNC_MUTATION_TYPES = [
  'WORKER_CREATE',
  'PROJECT_WORKER_ASSIGN',
  'ATTENDANCE_UPSERT',
  'ADVANCE_CREATE',
  'WORK_MEASUREMENT_CREATE',
  'SETTLEMENT_GENERATE',
  'SETTLEMENT_SUBMIT',
  'SETTLEMENT_PAY',
  'DISPATCH_RECEIVE',
  'PURCHASE_RECEIVE',
  'OWNER_DELIVERY_CREATE',
  'MATERIAL_USAGE_CREATE',
  'STOCK_COUNT_CREATE',
  'CASH_EXPENSE_CREATE',
  'FLOAT_ACKNOWLEDGE',
  'TOPUP_REQUEST_CREATE',
  'DAILY_LOG_UPSERT',
  'SITE_PURCHASE_CREATE',
] as const;

export const pushBody = z.object({
  deviceId: z.string().trim().min(8).max(128).optional().meta({ description: 'The app’s device id (must match the signed-in device)' }),
  mutations: z
    .array(
      z.object({
        clientId: z.uuid({ error: 'clientId must be a UUID (v7)' }),
        type: z.enum(SYNC_MUTATION_TYPES),
        payload: z.record(z.string(), z.unknown()).meta({ description: 'The REST body of that action plus its path ids (projectId, settlementId, dispatchId, purchaseId, entryId). Ids may be clientIds of earlier mutations or attachments.' }),
        deviceCreatedAt: z.iso.datetime({ offset: true }).optional(),
        dependsOn: z.array(z.uuid()).max(20).optional(),
      }),
    )
    .min(1, 'Send at least one mutation')
    .max(100, 'At most 100 mutations per call'),
});

export type PushInput = z.infer<typeof pushBody>;
