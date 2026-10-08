import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, success } from '../../core/openapi/registry.js';
import {
  createInvitationBody,
  deviceDto,
  invitationDto,
  invitationSentDto,
  setUserPasswordBody,
  setUserProjectsBody,
  teamUserDto,
  updateUserBody,
  usageDto,
  userDetailDto,
} from './team.schema.js';

const tags = ['Team'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const OWNER = { ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'] };
const ex = (summary: string, value: unknown, description?: string) => ({ summary, value, ...(description ? { description } : {}) });
const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });
const pageMeta = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const page = { page: z.number().int().optional().meta({ example: 1 }), limit: z.number().int().optional().meta({ example: 25 }) };

const sampleUser = {
  id: '0199a8c0-0000-7000-8000-000000000002',
  name: 'Bilal Ahmed',
  phone: '+923331112233',
  email: null,
  role: 'PM',
  status: 'ACTIVE',
  canSeeFinancials: false,
  allProjects: false,
  projects: [
    { id: '0199a8c0-0000-7000-8000-000000000101', name: 'Bahria Town — Commercial Plaza' },
    { id: '0199a8c0-0000-7000-8000-000000000102', name: 'DHA Phase 6 — 1 Kanal Villa' },
  ],
  lastActiveAt: '2026-10-03T08:30:00.000Z',
};

export function registerTeamDocs(): void {
  // ─── Users ───────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/users',
    tags,
    summary: 'List team members',
    description:
      'THEKEDAR and PM. `meta.usage` shows office seats used (THEKEDAR + PM, Munshis are free) against the plan. ' +
      '`canSeeFinancials` is omitted when a PM is asking.',
    security: companySecurity,
    request: {
      query: z.object({
        search: z.string().optional().meta({ example: 'Bilal' }),
        role: z.enum(['THEKEDAR', 'PM', 'MUNSHI']).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        projectId: z.uuid().optional(),
        ...page,
      }),
    },
    responses: {
      200: {
        description: 'Team members',
        content: {
          'application/json': {
            schema: z.object({ success: z.literal(true), data: z.array(teamUserDto), meta: pageMeta.extend({ usage: usageDto }) }),
            example: { success: true, data: [sampleUser], meta: { page: 1, limit: 25, total: 3, totalPages: 1, usage: { officeUsers: 2, maxOfficeUsers: 10 } } },
          },
        },
      },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/users/{id}',
    tags,
    summary: 'Team member details',
    description: 'THEKEDAR only. Includes assigned projects and active device count.',
    security: companySecurity,
    request: { params: idParam('User') },
    responses: {
      200: { description: 'User', content: { 'application/json': { schema: success(userDetailDto) } } },
      ...errors({ ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'], 404: ['USER_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/{id}',
    tags,
    summary: 'Edit a team member',
    description:
      'THEKEDAR only. Role can be PM or MUNSHI; owners keep their role and nobody can change their own. ' +
      'MUNSHI → PM needs a free office seat. New permissions apply at the user’s next token refresh (≤ 15 min).',
    security: companySecurity,
    request: {
      params: idParam('User'),
      body: jsonBody(updateUserBody, {
        financials: ex('Let a PM see financials', { canSeeFinancials: true }),
        promote: ex('Promote Munshi to PM', { role: 'PM' }),
        demote: ex('Make PM a Munshi', { role: 'MUNSHI' }),
        rename: ex('Fix name and phone', { name: 'Bilal Ahmed Khan', phone: '0333-1112233' }),
      }),
    },
    responses: {
      200: { description: 'Updated user', content: { 'application/json': { schema: success(userDetailDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'FINANCIALS_PM_ONLY'],
        ...AUTH,
        402: ['PLAN_LIMIT_REACHED'],
        403: ['FORBIDDEN', 'CANNOT_CHANGE_OWN_ROLE', 'CANNOT_CHANGE_OWNER_ROLE', 'ACCOUNT_READ_ONLY'],
        404: ['USER_NOT_FOUND'],
        409: ['PHONE_TAKEN'],
      }),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/users/{id}',
    tags,
    summary: 'Deactivate a team member',
    description: 'THEKEDAR only. Soft delete: signs out every session and device. History stays. Use reactivate to undo.',
    security: companySecurity,
    request: { params: idParam('User') },
    responses: {
      200: { description: 'Deactivated user', content: { 'application/json': { schema: success(userDetailDto) } } },
      ...errors({
        ...AUTH,
        403: ['FORBIDDEN', 'CANNOT_DEACTIVATE_SELF', 'LAST_THEKEDAR', 'ACCOUNT_READ_ONLY'],
        404: ['USER_NOT_FOUND'],
        409: ['CASH_BALANCE_OPEN'],
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/users/{id}/reactivate',
    tags,
    summary: 'Reactivate a team member',
    description: 'THEKEDAR only. A PM needs a free office seat.',
    security: companySecurity,
    request: { params: idParam('User') },
    responses: {
      200: { description: 'Active again', content: { 'application/json': { schema: success(userDetailDto) } } },
      ...errors({ ...OWNER, 402: ['PLAN_LIMIT_REACHED'], 404: ['USER_NOT_FOUND'], 409: ['USER_ALREADY_ACTIVE'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/users/{id}/login-code',
    tags,
    summary: "A munshi's sign-in code (when SMS doesn't arrive)",
    description:
      'THEKEDAR only, for an active MUNSHI. Issues the same one-time LOGIN code the munshi app asks for (10 minutes, one use) and returns it, so the owner can pass it on by voice or WhatsApp. The code is never stored or logged. Same resend wait / hourly limit as SMS codes.',
    security: companySecurity,
    request: { params: idParam('User') },
    responses: {
      200: {
        description: 'Code issued',
        content: {
          'application/json': {
            schema: success(z.object({ phone: z.string(), code: z.string().meta({ example: '482913' }), expiresIn: z.number().meta({ example: 600 }) })),
          },
        },
      },
      ...errors({ ...OWNER, 400: ['LOGIN_CODE_MUNSHI_ONLY'], 404: ['USER_NOT_FOUND'], 409: ['USER_INACTIVE'], 429: ['OTP_RESEND_WAIT', 'OTP_LIMIT_REACHED'] }),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/users/{id}/password',
    tags,
    summary: "Set a munshi's password",
    description: 'THEKEDAR only, for a MUNSHI. The munshi can then sign in with phone + password (no code needed). Clears a lockout.',
    security: companySecurity,
    request: { params: idParam('User'), body: jsonBody(setUserPasswordBody, { munshi: ex('Set a password', { password: 'Naveed#2026' }) }) },
    responses: {
      200: { description: 'Password set', content: { 'application/json': { schema: success(z.object({ passwordSet: z.literal(true) })) } } },
      ...errors({ ...OWNER, 400: ['VALIDATION_ERROR', 'PASSWORD_MUNSHI_ONLY'], 404: ['USER_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/users/{id}/projects',
    tags,
    summary: 'Set which projects a PM / Munshi works on',
    description: 'THEKEDAR only. Replaces the whole list. A THEKEDAR always has every project.',
    security: companySecurity,
    request: {
      params: idParam('User'),
      body: jsonBody(setUserProjectsBody, {
        two: ex('Assign two projects', { projectIds: ['0199a8c0-0000-7000-8000-000000000101', '0199a8c0-0000-7000-8000-000000000102'] }, 'Use project ids from your company.'),
        none: ex('Remove all projects', { projectIds: [] }),
      }),
    },
    responses: {
      200: {
        description: 'New assignment',
        content: { 'application/json': { schema: success(z.object({ userId: z.uuid(), projects: z.array(z.object({ id: z.uuid(), name: z.string() })) })) } },
      },
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_PROJECT', 'THEKEDAR_HAS_ALL_PROJECTS'], ...OWNER, 404: ['USER_NOT_FOUND'] }),
    },
  });

  // ─── Invitations ─────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/invitations',
    tags,
    summary: 'List invitations',
    description: 'THEKEDAR only. Defaults to PENDING. Overdue pending invitations are marked EXPIRED automatically.',
    security: companySecurity,
    request: { query: z.object({ status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED']).optional(), ...page }) },
    responses: {
      200: { description: 'Invitations', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.array(invitationDto), meta: pageMeta }) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/invitations',
    tags,
    summary: 'Invite a PM or Munshi',
    description:
      'THEKEDAR only. Sends an SMS (Roman Urdu) with a one-time link valid 7 days. ' +
      'A PM invite reserves an office seat (active THEKEDAR + PM + pending PM invites ≤ plan limit). ' +
      'In development the response includes `devInviteUrl`.',
    security: companySecurity,
    request: {
      body: jsonBody(createInvitationBody, {
        pm: ex('Invite a PM', { name: 'Usman Ghani', phone: '0345-1112233', role: 'PM', canSeeFinancials: false }),
        munshi: ex('Invite a Munshi', { name: 'Naveed Iqbal', phone: '0312-7654321', role: 'MUNSHI' }, 'Add projectIds from your company to assign sites.'),
        member: ex('❌ Already a member → 409', { name: 'Bilal Ahmed', phone: '03331112233', role: 'PM' }),
      }),
    },
    responses: {
      201: {
        description: 'Invitation sent',
        content: {
          'application/json': {
            schema: success(invitationSentDto),
            example: { success: true, data: { id: '0199…', status: 'PENDING', expiresAt: '2026-10-10T12:00:00.000Z', devInviteUrl: 'http://localhost:3000/invite/…' } },
          },
        },
      },
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_PROJECT'], ...OWNER, 402: ['PLAN_LIMIT_REACHED'], 409: ['ALREADY_MEMBER', 'INVITE_PENDING'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/invitations/{id}/resend',
    tags,
    summary: 'Resend an invitation with a new link',
    description: 'THEKEDAR only. PENDING or EXPIRED invitations; the old link stops working. Once per 60 s.',
    security: companySecurity,
    request: { params: idParam('Invitation') },
    responses: {
      200: { description: 'Sent again', content: { 'application/json': { schema: success(invitationSentDto) } } },
      ...errors({
        ...OWNER,
        402: ['PLAN_LIMIT_REACHED'],
        404: ['INVITE_NOT_FOUND'],
        409: ['INVITE_ALREADY_ACCEPTED', 'INVITE_CANCELLED', 'ALREADY_MEMBER'],
        429: ['INVITE_RESEND_WAIT'],
      }),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/invitations/{id}',
    tags,
    summary: 'Cancel an invitation',
    description: 'THEKEDAR only. The link stops working (accepting it answers 410 INVITE_CANCELLED).',
    security: companySecurity,
    request: { params: idParam('Invitation') },
    responses: {
      200: { description: 'Cancelled', content: { 'application/json': { schema: success(z.object({ id: z.uuid(), status: z.literal('CANCELLED') })) } } },
      ...errors({ ...OWNER, 404: ['INVITE_NOT_FOUND'], 409: ['INVITE_ALREADY_ACCEPTED', 'INVITE_CANCELLED'] }),
    },
  });

  // ─── Devices ─────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/devices',
    tags,
    summary: 'Devices signed in to the company',
    description: 'THEKEDAR only. Shows sync status for the mobile app; `current` marks the device making the request.',
    security: companySecurity,
    request: { query: z.object({ userId: z.uuid().optional(), platform: z.enum(['ANDROID', 'IOS', 'WEB']).optional(), ...page }) },
    responses: {
      200: { description: 'Devices', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.array(deviceDto), meta: pageMeta }) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/devices/{id}',
    tags,
    summary: 'Revoke a device (lost / stolen phone)',
    description: 'THEKEDAR only. Signs the device out: its refresh fails with 401 DEVICE_REVOKED until the user logs in again.',
    security: companySecurity,
    request: { params: idParam('Device') },
    responses: {
      200: { description: 'Revoked', content: { 'application/json': { schema: success(z.object({ id: z.uuid(), revokedAt: z.iso.datetime() })) } } },
      ...errors({ 400: ['CANNOT_REVOKE_CURRENT_DEVICE'], ...OWNER, 404: ['DEVICE_NOT_FOUND'] }),
    },
  });
}
