import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import { createClientBody, listClientsQuery, updateClientBody } from './clients.schema.js';

const tags = ['Clients'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const idParam = z.object({ id: z.uuid().meta({ description: 'Client id' }) });
const resp = (status: 200 | 201, description: string, example: unknown, meta?: unknown) => ({
  [status]: { description, content: { 'application/json': { schema: data, example: { success: true, data: example, ...(meta ? { meta } : {}) } } } },
});

const client = {
  id: '0199a8c0-0000-7000-8000-0000000001c1',
  name: 'Ahmed Raza',
  phone: '+923331234567',
  email: null,
  address: null,
  notes: null,
  createdAt: '2026-03-01T09:00:00.000Z',
};

export function registerClientsDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/clients',
    tags,
    summary: 'List clients',
    description: 'THEKEDAR, PM. Search matches name, phone or email. `projectsCount` counts only projects the caller can see.',
    security: companySecurity,
    request: { query: listClientsQuery },
    responses: {
      ...resp(200, 'Clients', [{ ...client, projectsCount: 1 }], { page: 1, limit: 25, total: 6, totalPages: 1 }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/clients',
    tags,
    summary: 'Add a client',
    description: 'THEKEDAR, PM. Clients are project owners and never log in. Phone (mobile or landline) is unique within the company.',
    security: companySecurity,
    request: {
      body: jsonBody(createClientBody, {
        full: ex('Owner with email and address', { name: 'Naveed Akhtar', phone: '0300-7654321', email: 'naveed@example.pk', address: 'House 12, Block B, Gulberg III, Lahore' }),
        minimal: ex('Name + phone', { name: 'Shahzad Butt', phone: '042-35881122' }),
      }),
    },
    responses: { ...resp(201, 'Created', client), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'], 409: ['CLIENT_PHONE_TAKEN'] }) },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/clients/{id}',
    tags,
    summary: 'Client details',
    description: 'THEKEDAR, PM. With the client’s projects (only the ones the caller can see).',
    security: companySecurity,
    request: { params: idParam },
    responses: {
      ...resp(200, 'Client', {
        ...client,
        projects: [{ id: '0199a8c0-0000-7000-8000-000000000101', code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE', city: 'Lahore', startDate: '2026-03-15', endDate: '2027-02-15' }],
      }),
      ...errors({ ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'], 404: ['CLIENT_NOT_FOUND'] }),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/clients/{id}',
    tags,
    summary: 'Edit a client',
    description: 'THEKEDAR, PM. `null` clears email, address or notes.',
    security: companySecurity,
    request: { params: idParam, body: jsonBody(updateClientBody, { address: ex('Add the address', { address: 'Model Town, Lahore', email: null }) }) },
    responses: {
      ...resp(200, 'Updated', client),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'], 404: ['CLIENT_NOT_FOUND'], 409: ['CLIENT_PHONE_TAKEN'] }),
    },
  });
}
