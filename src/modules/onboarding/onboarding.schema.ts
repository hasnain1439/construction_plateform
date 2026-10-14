import { z } from 'zod';
import { isoDateSchema } from '../../core/utils/dates.js';
import { paisaSchema } from '../company/company.schema.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
const positivePaisa = paisaSchema.refine((v) => v > 0n, 'Amount must be more than zero');
const base = {
  date: isoDateSchema.meta({ description: 'The day the balance stood (not in the future)', example: '2026-10-01' }),
  note: z.string().trim().max(300).optional(),
};

// ─── Checklist ──────────────────────────────────────────────────────────────

export const dismissBody = z.object({
  dismissed: z.boolean().default(true).meta({ description: 'false shows the checklist again' }),
});

// ─── Imports ────────────────────────────────────────────────────────────────

export const commitQuery = z.object({
  skipInvalid: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .meta({ description: 'true = import only the valid rows (default: all-or-nothing)' }),
});

// ─── Opening balances ───────────────────────────────────────────────────────

export const openingKindSchema = z.enum(['SUPPLIER_UDHAAR', 'CASH_IN_HAND', 'STORE_STOCK', 'WORKER_PESHGI']);

export const openingBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SUPPLIER_UDHAAR'), supplierId: uuid('supplierId'), amountPaisa: positivePaisa.meta({ description: 'What you owe the supplier (paisa)' }), ...base }),
  z.object({ kind: z.literal('CASH_IN_HAND'), holderUserId: uuid('holderUserId').meta({ description: 'A munshi or project manager' }), amountPaisa: positivePaisa, ...base }),
  z.object({
    kind: z.literal('STORE_STOCK'),
    materialId: uuid('materialId'),
    quantity: z.number().positive('Quantity must be more than zero').max(1e9),
    ratePaisa: paisaSchema.meta({ description: 'Rate per unit (paisa) — the stock value is quantity × rate' }),
    ...base,
  }),
  z.object({
    kind: z.literal('WORKER_PESHGI'),
    workerId: uuid('workerId'),
    projectId: uuid('projectId').meta({ description: 'The project the worker is on — the peshgi is cut from their wages there' }),
    amountPaisa: positivePaisa,
    ...base,
  }),
]);

export const openingListQuery = z.object({ kind: openingKindSchema.optional() });

export type OpeningInput = z.infer<typeof openingBody>;
export type OpeningKind = z.infer<typeof openingKindSchema>;
