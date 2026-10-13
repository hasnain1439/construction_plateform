import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './permissions.controller.js';
import {
  createRoleBody,
  duplicateRoleBody,
  roleIdParams,
  setOverridesBody,
  setRolePermissionsBody,
  setUserRoleBody,
  updateRoleBody,
  userIdParams,
} from './permissions.schema.js';

/**
 * Roles & permissions. authenticate → tenantContext → readOnlyGuard → requirePerm → validate.
 * Management needs `team.member.manage` (THEKEDAR always has it); the catalogue is readable by
 * every company user (labels for "you can't do this" messages).
 */
const manage = requirePerm('team.member.manage');

/** Mounted at /api/v1/permissions */
export const permissionsRouter = Router();
permissionsRouter.get('/catalog', ...company, h(c.getCatalog));

/** Mounted at /api/v1/roles */
export const rolesRouter = Router();
rolesRouter.use(...company, manage);
rolesRouter.get('/', h(c.listRoles));
rolesRouter.post('/', validate({ body: createRoleBody }), h(c.createRole));
rolesRouter.get('/:id', validate({ params: roleIdParams }), h(c.getRole));
rolesRouter.patch('/:id', validate({ params: roleIdParams, body: updateRoleBody }), h(c.updateRole));
rolesRouter.post('/:id/duplicate', validate({ params: roleIdParams, body: duplicateRoleBody }), h(c.duplicateRole));
rolesRouter.put('/:id/permissions', validate({ params: roleIdParams, body: setRolePermissionsBody }), h(c.setRolePermissions));

/** Mounted at /api/v1/users before the team users router (per-route middleware). */
export const userPermissionsRouter = Router();
userPermissionsRouter.get('/:id/permissions', ...company, manage, validate({ params: userIdParams }), h(c.getUserPermissions));
userPermissionsRouter.put('/:id/permission-overrides', ...company, manage, validate({ params: userIdParams, body: setOverridesBody }), h(c.setOverrides));
userPermissionsRouter.patch('/:id/role', ...company, manage, validate({ params: userIdParams, body: setUserRoleBody }), h(c.setUserRole));
