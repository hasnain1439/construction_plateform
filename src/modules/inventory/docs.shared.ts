/** Swagger helpers shared by the inventory, procurement and dispatch docs. */
import { z } from 'zod';
import { companySecurity, registry, type NamedExample } from '../../core/openapi/registry.js';

export const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
export const READ_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED'];
export const WRITE_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'];

const data = z.object({ success: z.literal(true), data: z.unknown() });

export const ok = (description: string, example?: unknown, meta?: unknown) => ({
  200: {
    description,
    content: { 'application/json': { schema: data, ...(example ? { example: { success: true, data: example, ...(meta ? { meta } : {}) } } : {}) } },
  },
});

export const createdResp = (description: string, example?: unknown) => ({
  201: { description, content: { 'application/json': { schema: data, ...(example ? { example: { success: true, data: example } } : {}) } } },
});

export const ex = (summary: string, value: unknown, description?: string): NamedExample => ({ summary, value, ...(description ? { description } : {}) });
export const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });
export const page = (total: number, limit = 25) => ({ page: 1, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });

export function path(tag: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) {
  registry.registerPath({ method, path: url, tags: [tag], security: companySecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
}

// Example ids (look the real ones up with the list endpoints on a seeded database)
export const IDS = {
  store: '0199a8c0-0000-7000-8000-000000000501',
  transit: '0199a8c0-0000-7000-8000-000000000502',
  dhaSite: '0199a8c0-0000-7000-8000-000000000503',
  dha: '0199a8c0-0000-7000-8000-000000000301',
  bahria: '0199a8c0-0000-7000-8000-000000000302',
  cement: '0199a8c0-0000-7000-8000-0000000000d1',
  bricks: '0199a8c0-0000-7000-8000-0000000000d2',
  steel: '0199a8c0-0000-7000-8000-0000000000d4',
  sand: '0199a8c0-0000-7000-8000-0000000000d5',
  tiles: '0199a8c0-0000-7000-8000-0000000000d6',
  almadina: '0199a8c0-0000-7000-8000-0000000000f1',
  ittefaq: '0199a8c0-0000-7000-8000-0000000000f2',
  challan: '0199a8c0-0000-7000-8000-000000000601',
  photo: '0199a8c0-0000-7000-8000-000000000602',
  purchase: '0199a8c0-0000-7000-8000-000000000701',
  purchaseOrder: '0199a8c0-0000-7000-8000-000000000702',
  purchaseItem: '0199a8c0-0000-7000-8000-000000000703',
  dispatch: '0199a8c0-0000-7000-8000-000000000801',
  shortage: '0199a8c0-0000-7000-8000-000000000802',
  payment: '0199a8c0-0000-7000-8000-000000000901',
} as const;

export const KHALID = { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' };
export const RAFAQAT = { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Rafaqat Ali' };
export const CEMENT = { id: IDS.cement, name: 'Cement OPC', unit: 'bag' };
export const BRICKS = { id: IDS.bricks, name: 'Clay bricks Class-1', unit: 'nos' };
export const STEEL = { id: IDS.steel, name: 'Steel Grade-60 #4', unit: 'ton' };
export const STORE = { id: IDS.store, type: 'STORE', name: 'Central Store', projectId: null };
export const DHA_SITE = { id: IDS.dhaSite, type: 'SITE', name: 'DHA Phase 6 · 10 Marla', projectId: IDS.dha };
