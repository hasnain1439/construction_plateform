import { z } from 'zod';
import { paisaSchema as paisa } from '../company/company.schema.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });

export const scopeSchema = z.enum(['ASSIGNED_PROJECTS', 'ALL_PROJECTS']);
export const baseRoleSchema = z.enum(['PM', 'MUNSHI', 'OTHER']).meta({ description: 'PM = office accounts, MUNSHI = site (mobile) accounts, OTHER = either' });
export const effectSchema = z.enum(['ALLOW', 'DENY']);

export const roleIdParams = z.object({ id: uuid('role id') });
export const userIdParams = z.object({ id: uuid('user id') });

export const grantSchema = z.object({
  key: z.string().min(3).max(80).meta({ example: 'cashbook.expense.approve' }),
  scope: scopeSchema.optional().meta({ description: 'Scoped keys only; default ASSIGNED_PROJECTS' }),
  maxAmountPaisa: paisa.nullable().optional().meta({ description: 'Approval limit (limit keys only); null / omitted = no limit' }),
});

const names = {
  name: z.string().trim().min(2, 'Name is too short').max(60),
  nameRoman: z.string().trim().min(1).max(60).nullable().optional(),
  nameUrdu: z.string().trim().min(1).max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
};

export const createRoleBody = z
  .object({
    ...names,
    baseRole: baseRoleSchema.optional().meta({ description: 'Default: the source role’s, else OTHER' }),
    fromRoleId: uuid('fromRoleId').optional().meta({ description: 'Copy the permissions of this role (e.g. a system template)' }),
    permissions: z.array(grantSchema).max(200).optional().meta({ description: 'Overrides the copied permissions when given' }),
  })
  .meta({ example: { name: 'Senior PM', nameRoman: 'Senior PM', fromRoleId: '0199a8c0-0000-7000-8000-000000000301' } });

export const duplicateRoleBody = z.object({
  name: names.name.optional().meta({ description: 'Default: "<name> (copy)"' }),
  nameRoman: names.nameRoman,
  nameUrdu: names.nameUrdu,
  description: names.description,
});

export const updateRoleBody = z
  .object({
    name: names.name.optional(),
    nameRoman: names.nameRoman,
    nameUrdu: names.nameUrdu,
    description: names.description,
    baseRole: baseRoleSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const setRolePermissionsBody = z.object({ permissions: z.array(grantSchema).max(200) });

export const overrideSchema = z.object({
  key: z.string().min(3).max(80).meta({ example: 'fields.amounts' }),
  effect: effectSchema,
  scope: scopeSchema.optional().meta({ description: 'ALLOW + scoped keys only; default: the role’s scope' }),
  maxAmountPaisa: paisa.nullable().optional().meta({ description: 'ALLOW + limit keys only' }),
  note: z.string().trim().max(200).optional(),
});

export const setOverridesBody = z.object({ overrides: z.array(overrideSchema).max(200) });

export const setUserRoleBody = z.object({ roleId: uuid('roleId') });

// ─── Response shapes ────────────────────────────────────────────────────────

const label = z.object({ en: z.string(), roman: z.string(), urdu: z.string() });

export const catalogDto = z
  .object({
    modules: z.array(z.object({ key: z.string(), label })),
    permissions: z.array(
      z.object({
        key: z.string(),
        module: z.string(),
        resource: z.string(),
        action: z.string(),
        label,
        description: z.string(),
        ownerOnly: z.boolean(),
        scoped: z.boolean(),
        limit: z.boolean(),
        field: z.boolean(),
      }),
    ),
    templates: z.array(z.object({ key: z.string(), name: label, baseRole: baseRoleSchema, description: z.string(), permissions: z.array(z.string()) })),
    financialBundle: z.array(z.string()).meta({ description: 'What the old canSeeFinancials flag means (PATCH /users/:id { canSeeFinancials })' }),
  })
  .meta({ id: 'PermissionCatalog' });

export const roleGrantDto = z.object({ key: z.string(), scope: scopeSchema.nullable(), maxAmountPaisa: z.string().nullable() });

export const roleDto = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    nameRoman: z.string().nullable(),
    nameUrdu: z.string().nullable(),
    description: z.string().nullable(),
    isSystem: z.boolean(),
    baseRole: baseRoleSchema,
    userCount: z.number().int(),
    permissions: z.array(roleGrantDto),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Role' });

export const fieldAccessDto = z.object({ rates: z.boolean(), amounts: z.boolean(), profit: z.boolean(), contract: z.boolean() }).meta({ id: 'FieldAccess' });

export const userPermissionsDto = z
  .object({
    user: z.object({ id: z.uuid(), name: z.string(), role: z.enum(['THEKEDAR', 'PM', 'MUNSHI']) }),
    owner: z.boolean(),
    role: z.object({ id: z.uuid().nullable(), key: z.string().nullable(), name: z.string().nullable() }).nullable(),
    effective: z.array(
      z.object({
        key: z.string(),
        source: z.enum(['owner', 'role', 'override']),
        scope: scopeSchema.nullable(),
        maxAmountPaisa: z.string().nullable(),
      }),
    ),
    overrides: z.array(
      z.object({ key: z.string(), effect: effectSchema, scope: scopeSchema.nullable(), maxAmountPaisa: z.string().nullable(), note: z.string().nullable() }),
    ),
    denied: z.array(z.string()).meta({ description: 'Keys of the role removed by a DENY override' }),
    permissions: z.array(z.string()),
    fieldAccess: fieldAccessDto,
    scopes: z.record(z.string(), scopeSchema),
    approvalLimits: z.record(z.string(), z.string().nullable()),
  })
  .meta({ id: 'UserPermissions' });

export type GrantInput = z.infer<typeof grantSchema>;
export type CreateRoleInput = z.infer<typeof createRoleBody>;
export type DuplicateRoleInput = z.infer<typeof duplicateRoleBody>;
export type UpdateRoleInput = z.infer<typeof updateRoleBody>;
export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsBody>;
export type OverrideInput = z.infer<typeof overrideSchema>;
export type SetOverridesInput = z.infer<typeof setOverridesBody>;
export type RoleDto = z.infer<typeof roleDto>;
export type UserPermissionsDto = z.infer<typeof userPermissionsDto>;
