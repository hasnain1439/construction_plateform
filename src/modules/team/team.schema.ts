import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { emailSchema, languageSchema, passwordSchema, phoneSchema, roleSchema } from '../auth/auth.schema.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
/** Roles a THEKEDAR can give through the team screens (owners are created at signup). */
export const staffRoleSchema = z.enum(['PM', 'MUNSHI'], { error: 'role must be PM or MUNSHI' });
export const userStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
const projectIdsSchema = z
  .array(uuid('project id'))
  .max(500)
  .transform((ids) => [...new Set(ids)])
  .meta({ example: ['0199a8c0-0000-7000-8000-000000000101'] });

// ─── Users ──────────────────────────────────────────────────────────────────

export const listUsersQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name, phone or email contains' }),
  role: roleSchema.optional(),
  status: userStatusSchema.optional(),
  projectId: uuid('projectId').optional().meta({ description: 'Users who can work on this project (THEKEDARs always can)' }),
});

export const userIdParams = z.object({ id: uuid('user id') });

export const updateUserBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    phone: phoneSchema.optional(),
    role: staffRoleSchema.optional(),
    canSeeFinancials: z.boolean().optional().meta({ description: 'PM only' }),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const setUserProjectsBody = z.object({ projectIds: projectIdsSchema });

const projectRef = z.object({ id: z.uuid(), name: z.string() });

export const teamUserDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    role: roleSchema,
    status: userStatusSchema,
    canSeeFinancials: z.boolean().optional().meta({ description: 'Hidden when a PM is asking' }),
    allProjects: z.boolean().meta({ description: 'THEKEDAR works on every project' }),
    projects: z.array(projectRef),
    lastActiveAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'TeamUser' });

export const userDetailDto = teamUserDto
  .extend({
    canSeeFinancials: z.boolean(),
    language: languageSchema,
    activeDeviceCount: z.number().int(),
    lastLoginAt: z.iso.datetime().nullable(),
    deactivatedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TeamUserDetail' });

export const usageDto = z.object({
  officeUsers: z.number().int().meta({ description: 'Active THEKEDAR + PM (MUNSHI not counted)' }),
  maxOfficeUsers: z.number().int().nullable().meta({ description: 'null = unlimited' }),
});

// ─── Invitations ────────────────────────────────────────────────────────────

export const invitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED']);

export const listInvitationsQuery = paginationQuery.extend({
  status: invitationStatusSchema.default('PENDING'),
});

export const invitationIdParams = z.object({ id: uuid('invitation id') });

export const createInvitationBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    phone: phoneSchema,
    email: emailSchema.optional(),
    role: staffRoleSchema,
    projectIds: projectIdsSchema.optional(),
    canSeeFinancials: z.boolean().optional().meta({ description: 'PM only. Defaults to the company setting pmCanSeeFinancials.' }),
  })
  .superRefine((v, ctx) => {
    if (v.role !== 'PM' && v.canSeeFinancials) {
      ctx.addIssue({ code: 'custom', path: ['canSeeFinancials'], message: 'Only a PM can see financials' });
    }
  });

export const invitationDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    role: staffRoleSchema,
    canSeeFinancials: z.boolean(),
    projects: z.array(projectRef),
    status: invitationStatusSchema,
    expiresAt: z.iso.datetime(),
    lastResentAt: z.iso.datetime().nullable(),
    invitedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Invitation' });

export const invitationSentDto = z
  .object({
    id: z.uuid(),
    status: invitationStatusSchema,
    expiresAt: z.iso.datetime(),
    devInviteUrl: z.string().optional().meta({ description: 'Development only — never returned in production' }),
  })
  .meta({ id: 'InvitationSent' });

// ─── Devices ────────────────────────────────────────────────────────────────

export const listDevicesQuery = paginationQuery.extend({
  userId: uuid('userId').optional(),
  platform: z.enum(['ANDROID', 'IOS', 'WEB']).optional(),
});

export const deviceIdParams = z.object({ id: uuid('device id') });

export const deviceDto = z
  .object({
    id: z.uuid(),
    user: z.object({ id: z.uuid(), name: z.string(), role: roleSchema }),
    platform: z.enum(['ANDROID', 'IOS', 'WEB']),
    model: z.string().nullable(),
    appVersion: z.string().nullable(),
    lastActiveAt: z.iso.datetime(),
    lastSyncAt: z.iso.datetime().nullable(),
    pendingUploads: z.number().int(),
    revokedAt: z.iso.datetime().nullable(),
    current: z.boolean().meta({ description: 'The device making this request' }),
  })
  .meta({ id: 'Device' });

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type UpdateUserInput = z.infer<typeof updateUserBody>;
export type SetUserProjectsInput = z.infer<typeof setUserProjectsBody>;
export type TeamUserDto = z.infer<typeof teamUserDto>;
export type UserDetailDto = z.infer<typeof userDetailDto>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuery>;
export type CreateInvitationInput = z.infer<typeof createInvitationBody>;
export type InvitationDto = z.infer<typeof invitationDto>;
export type InvitationSentDto = z.infer<typeof invitationSentDto>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuery>;
export type DeviceDto = z.infer<typeof deviceDto>;

/** The owner sets a munshi's password (so the munshi can sign in without a code). */
export const setUserPasswordBody = z.object({ password: passwordSchema }).meta({ example: { password: 'Naveed#2026' } });
export type SetUserPasswordInput = z.infer<typeof setUserPasswordBody>;
