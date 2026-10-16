import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { companyPhoneSchema } from '../company/company.schema.js';

export const clientIdParams = z.object({ id: z.uuid({ error: 'Invalid client id' }) });

export const listClientsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name, phone or email contains' }),
});

const fields = {
  name: z.string().trim().min(2, 'Name is too short').max(80).meta({ example: 'Ahmed Raza' }),
  phone: companyPhoneSchema.meta({ example: '0333-1234567', description: 'Mobile or landline; normalised to +92…' }),
  email: z.email('Invalid email').trim().toLowerCase().max(120),
  address: z.string().trim().max(300),
  notes: z.string().trim().max(1000),
  /** Step 18: NTN (1234567-8) or CNIC — printed on taxed invoices, tax-wise invoice register. */
  ntn: z.string().trim().regex(/^[0-9A-Za-z-]{5,20}$/, 'Enter the NTN / CNIC (digits and dashes)').meta({ example: '1234567-8' }),
};

export const createClientBody = z.object({
  name: fields.name,
  phone: fields.phone,
  email: fields.email.optional(),
  address: fields.address.optional(),
  notes: fields.notes.optional(),
  ntn: fields.ntn.optional(),
});

export const updateClientBody = z
  .object({
    name: fields.name.optional(),
    phone: fields.phone.optional(),
    email: fields.email.nullable().optional(),
    address: fields.address.nullable().optional(),
    notes: fields.notes.nullable().optional(),
    ntn: fields.ntn.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export type ListClientsQuery = z.infer<typeof listClientsQuery>;
export type CreateClientInput = z.infer<typeof createClientBody>;
export type UpdateClientInput = z.infer<typeof updateClientBody>;
