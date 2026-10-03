import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './team.controller.js';
import {
  createInvitationBody,
  deviceIdParams,
  invitationIdParams,
  listDevicesQuery,
  listInvitationsQuery,
  listUsersQuery,
  setUserProjectsBody,
  updateUserBody,
  userIdParams,
} from './team.schema.js';

// Chains are attached per route (not router.use) because /invitations is shared with the
// public auth route POST /invitations/:token/accept.
const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];
const thekedar: RequestHandler[] = [...company, requireRole('THEKEDAR')];

/** Mounted at /api/v1/users */
export const usersRouter = Router();

usersRouter.get('/', ...company, requireRole('THEKEDAR', 'PM'), validate({ query: listUsersQuery }), h(c.listUsers));
usersRouter.get('/:id', ...thekedar, validate({ params: userIdParams }), h(c.getUser));
usersRouter.patch('/:id', ...thekedar, validate({ params: userIdParams, body: updateUserBody }), h(c.updateUser));
usersRouter.delete('/:id', ...thekedar, validate({ params: userIdParams }), h(c.deactivateUser));
usersRouter.post('/:id/reactivate', ...thekedar, validate({ params: userIdParams }), h(c.reactivateUser));
usersRouter.put('/:id/projects', ...thekedar, validate({ params: userIdParams, body: setUserProjectsBody }), h(c.setUserProjects));

/** Mounted at /api/v1/invitations (after the auth router's public accept route) */
export const teamInvitationsRouter = Router();

teamInvitationsRouter.get('/', ...thekedar, validate({ query: listInvitationsQuery }), h(c.listInvitations));
teamInvitationsRouter.post('/', ...thekedar, validate({ body: createInvitationBody }), h(c.createInvitation));
teamInvitationsRouter.post('/:id/resend', ...thekedar, validate({ params: invitationIdParams }), h(c.resendInvitation));
teamInvitationsRouter.delete('/:id', ...thekedar, validate({ params: invitationIdParams }), h(c.cancelInvitation));

/** Mounted at /api/v1/devices */
export const devicesRouter = Router();

devicesRouter.get('/', ...thekedar, validate({ query: listDevicesQuery }), h(c.listDevices));
devicesRouter.delete('/:id', ...thekedar, validate({ params: deviceIdParams }), h(c.revokeDevice));
