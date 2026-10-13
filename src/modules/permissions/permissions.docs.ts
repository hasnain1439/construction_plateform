import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, success } from '../../core/openapi/registry.js';
import {
  catalogDto,
  createRoleBody,
  duplicateRoleBody,
  roleDto,
  setOverridesBody,
  setRolePermissionsBody,
  setUserRoleBody,
  updateRoleBody,
  userPermissionsDto,
} from './permissions.schema.js';

const tags = ['Permissions'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const DENIED = ['PERMISSION_DENIED', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'];
const ex = (summary: string, value: unknown, description?: string) => ({ summary, value, ...(description ? { description } : {}) });
const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });
const MANAGE = 'THEKEDAR, or a user with `team.member.manage`.';

const sampleRole = {
  id: '0199a8c0-0000-7000-8000-000000000301',
  key: 'PROJECT_MANAGER',
  name: 'Project Manager',
  nameRoman: 'Project Manager',
  nameUrdu: 'پراجیکٹ مینیجر',
  description: 'Office user: projects, team on site, purchases, rates and approvals of assigned projects.',
  isSystem: true,
  baseRole: 'PM',
  userCount: 1,
  permissions: [
    { key: 'projects.project.view', scope: 'ASSIGNED_PROJECTS', maxAmountPaisa: null },
    { key: 'cashbook.expense.approve', scope: 'ASSIGNED_PROJECTS', maxAmountPaisa: null },
    { key: 'fields.rates', scope: null, maxAmountPaisa: null },
  ],
  createdAt: '2026-10-19T09:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
};

export function registerPermissionsDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/permissions/catalog',
    tags,
    summary: 'Permission catalogue',
    description:
      'Every permission key (`<module>.<resource>.<action>`, plus the field permissions `fields.rates|amounts|profit|contract`) with labels in English / Roman Urdu / Urdu, ' +
      'the owner-only / scoped / approval-limit flags, the system role templates and the financial bundle (what the old `canSeeFinancials` means). Any company user.',
    security: companySecurity,
    responses: {
      200: { description: 'Catalogue', content: { 'application/json': { schema: success(catalogDto) } } },
      ...errors({ ...AUTH, 403: ['COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/roles',
    tags,
    summary: 'List roles',
    description: `${MANAGE} System templates first (read-only), then custom roles, each with its permissions and user count.`,
    security: companySecurity,
    responses: {
      200: { description: 'Roles', content: { 'application/json': { schema: success(z.array(roleDto)), example: { success: true, data: [sampleRole] } } } },
      ...errors({ ...AUTH, 403: DENIED }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/roles',
    tags,
    summary: 'Create a role',
    description: `${MANAGE} Copies \`fromRoleId\` (e.g. a system template) unless \`permissions\` are given. Owner-only keys can't be granted; a non-owner can only grant what they hold (key, scope, limit). Audited \`role.create\`.`,
    security: companySecurity,
    request: {
      body: jsonBody(createRoleBody, {
        copy: ex('Copy the Project Manager template', { name: 'Senior PM', nameRoman: 'Senior PM', fromRoleId: '0199a8c0-0000-7000-8000-000000000301' }),
        custom: ex('Accountant with a kharcha limit', {
          name: 'Site accountant',
          baseRole: 'OTHER',
          permissions: [
            { key: 'cashbook.expense.view', scope: 'ALL_PROJECTS' },
            { key: 'cashbook.expense.approve', scope: 'ALL_PROJECTS', maxAmountPaisa: '5000000' },
            { key: 'fields.amounts' },
          ],
        }),
      }),
    },
    responses: {
      201: { description: 'Created role', content: { 'application/json': { schema: success(roleDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'UNKNOWN_PERMISSION', 'SCOPE_NOT_SUPPORTED', 'LIMIT_NOT_SUPPORTED', 'DUPLICATE_PERMISSION'],
        ...AUTH,
        403: [...DENIED, 'OWNER_ONLY_PERMISSION', 'GRANT_EXCEEDS_OWN'],
        404: ['ROLE_NOT_FOUND'],
        409: ['ROLE_NAME_TAKEN'],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/roles/{id}',
    tags,
    summary: 'Role detail',
    description: MANAGE,
    security: companySecurity,
    request: { params: idParam('Role') },
    responses: {
      200: { description: 'Role', content: { 'application/json': { schema: success(roleDto) } } },
      ...errors({ ...AUTH, 403: DENIED, 404: ['ROLE_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/roles/{id}',
    tags,
    summary: 'Rename a role',
    description: `${MANAGE} Names, description, base role. System templates → 403 ROLE_IS_SYSTEM. Audited \`role.update\` (before / after).`,
    security: companySecurity,
    request: { params: idParam('Role'), body: jsonBody(updateRoleBody, { rename: ex('Rename', { name: 'Site accountant', nameUrdu: 'سائٹ اکاؤنٹنٹ' }) }) },
    responses: {
      200: { description: 'Updated role', content: { 'application/json': { schema: success(roleDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: [...DENIED, 'ROLE_IS_SYSTEM', 'CANNOT_EDIT_OWN_PERMISSIONS'], 404: ['ROLE_NOT_FOUND'], 409: ['ROLE_NAME_TAKEN', 'ROLE_IN_USE'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/roles/{id}/duplicate',
    tags,
    summary: 'Duplicate a role',
    description: `${MANAGE} The way to edit a system template: copy it, then change the copy. Name defaults to "<name> (copy)".`,
    security: companySecurity,
    request: { params: idParam('Role'), body: jsonBody(duplicateRoleBody, { default: ex('Default name', {}), named: ex('Named copy', { name: 'Munshi (no peshgi)' }) }) },
    responses: {
      201: { description: 'The copy', content: { 'application/json': { schema: success(roleDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: [...DENIED, 'GRANT_EXCEEDS_OWN'], 404: ['ROLE_NOT_FOUND'], 409: ['ROLE_NAME_TAKEN'] }),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/roles/{id}/permissions',
    tags,
    summary: 'Replace a role’s permissions',
    description:
      `${MANAGE} The full list (matrix editor): key, scope (scoped keys) and approval limit (limit keys). Applies to every user of the role on their next request; ` +
      'their phones resync. System templates → 403 ROLE_IS_SYSTEM. Audited `role.permissions_update` (before / after).',
    security: companySecurity,
    request: {
      params: idParam('Role'),
      body: jsonBody(setRolePermissionsBody, {
        matrix: ex('Kharcha up to Rs 50,000 on all projects', {
          permissions: [
            { key: 'projects.project.view', scope: 'ALL_PROJECTS' },
            { key: 'cashbook.expense.view', scope: 'ALL_PROJECTS' },
            { key: 'cashbook.expense.approve', scope: 'ALL_PROJECTS', maxAmountPaisa: '5000000' },
          ],
        }),
      }),
    },
    responses: {
      200: { description: 'Updated role', content: { 'application/json': { schema: success(roleDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'UNKNOWN_PERMISSION', 'SCOPE_NOT_SUPPORTED', 'LIMIT_NOT_SUPPORTED', 'DUPLICATE_PERMISSION'],
        ...AUTH,
        403: [...DENIED, 'ROLE_IS_SYSTEM', 'OWNER_ONLY_PERMISSION', 'GRANT_EXCEEDS_OWN', 'CANNOT_EDIT_OWN_PERMISSIONS'],
        404: ['ROLE_NOT_FOUND'],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/users/{id}/permissions',
    tags,
    summary: 'A user’s effective permissions',
    description: `${MANAGE} Every effective key with its source (\`owner\` / \`role\` / \`override\`), scope and approval limit; the overrides; role keys removed by DENY; field access.`,
    security: companySecurity,
    request: { params: idParam('User') },
    responses: {
      200: { description: 'Effective permissions', content: { 'application/json': { schema: success(userPermissionsDto) } } },
      ...errors({ ...AUTH, 403: DENIED, 404: ['USER_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/users/{id}/permission-overrides',
    tags,
    summary: 'Replace a user’s extra / removed permissions',
    description:
      `${MANAGE} ALLOW adds a key on top of the role (optional scope / limit), DENY removes one the role gives. The full list replaces the old one. ` +
      'Never for a THEKEDAR (403 CANNOT_EDIT_OWNER) or yourself. Audited `user.permissions_update` (before / after).',
    security: companySecurity,
    request: {
      params: idParam('User'),
      body: jsonBody(setOverridesBody, {
        financials: ex('Let this PM see billing and profit', {
          overrides: [
            { key: 'billing.invoice.view', effect: 'ALLOW' },
            { key: 'fields.amounts', effect: 'ALLOW' },
            { key: 'fields.profit', effect: 'ALLOW' },
          ],
        }),
        noPeshgi: ex('Munshi may not give peshgi', { overrides: [{ key: 'labor.advance.create', effect: 'DENY', note: 'Ask the office' }] }),
        clear: ex('Back to the role only', { overrides: [] }),
      }),
    },
    responses: {
      200: { description: 'Effective permissions after the change', content: { 'application/json': { schema: success(userPermissionsDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'UNKNOWN_PERMISSION', 'SCOPE_NOT_SUPPORTED', 'LIMIT_NOT_SUPPORTED', 'DUPLICATE_PERMISSION', 'DENY_HAS_NO_SCOPE'],
        ...AUTH,
        403: [...DENIED, 'CANNOT_EDIT_OWNER', 'CANNOT_EDIT_OWN_PERMISSIONS', 'OWNER_ONLY_PERMISSION', 'GRANT_EXCEEDS_OWN'],
        404: ['USER_NOT_FOUND'],
      }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/{id}/role',
    tags,
    summary: 'Change a user’s role',
    description:
      `${MANAGE} The role must fit the account: \`baseRole\` PM → office (PM) accounts, MUNSHI → site accounts, OTHER → either. ` +
      'Overrides are kept. Audited `user.role_change` (before / after).',
    security: companySecurity,
    request: { params: idParam('User'), body: jsonBody(setUserRoleBody, { role: ex('Give a role', { roleId: '0199a8c0-0000-7000-8000-000000000301' }) }) },
    responses: {
      200: { description: 'Effective permissions after the change', content: { 'application/json': { schema: success(userPermissionsDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR', 'ROLE_NOT_FOR_ACCOUNT'], ...AUTH, 403: [...DENIED, 'CANNOT_EDIT_OWNER', 'CANNOT_EDIT_OWN_PERMISSIONS', 'GRANT_EXCEEDS_OWN'], 404: ['USER_NOT_FOUND', 'ROLE_NOT_FOUND'] }),
    },
  });
}
