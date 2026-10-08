import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as devices from './devices.service.js';
import * as invitations from './invitations.service.js';
import type {
  CreateInvitationInput,
  ListDevicesQuery,
  ListInvitationsQuery,
  ListUsersQuery,
  SetUserProjectsInput,
  UpdateUserInput,
  SetUserPasswordInput,
} from './team.schema.js';
import * as users from './users.service.js';

const id = (req: Request) => String(req.params['id']);

// ─── Users ──────────────────────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response) {
  const { data, meta } = await users.listUsers(req.query as unknown as ListUsersQuery);
  return ok(res, data, meta);
}

export async function getUser(req: Request, res: Response) {
  return ok(res, await users.getUser(id(req)));
}

export async function updateUser(req: Request, res: Response) {
  return ok(res, await users.updateUser(id(req), req.body as UpdateUserInput));
}

export async function deactivateUser(req: Request, res: Response) {
  return ok(res, await users.deactivateUser(id(req)));
}

export async function reactivateUser(req: Request, res: Response) {
  return ok(res, await users.reactivateUser(id(req)));
}

export async function issueLoginCode(req: Request, res: Response) {
  return ok(res, await users.issueLoginCode(id(req)));
}

export async function setUserPassword(req: Request, res: Response) {
  return ok(res, await users.setUserPassword(id(req), (req.body as SetUserPasswordInput).password));
}

export async function setUserProjects(req: Request, res: Response) {
  return ok(res, await users.setUserProjects(id(req), req.body as SetUserProjectsInput));
}

// ─── Invitations ────────────────────────────────────────────────────────────

export async function listInvitations(req: Request, res: Response) {
  const { data, meta } = await invitations.listInvitations(req.query as unknown as ListInvitationsQuery);
  return ok(res, data, meta);
}

export async function createInvitation(req: Request, res: Response) {
  return created(res, await invitations.createInvitation(req.body as CreateInvitationInput));
}

export async function resendInvitation(req: Request, res: Response) {
  return ok(res, await invitations.resendInvitation(id(req)));
}

export async function cancelInvitation(req: Request, res: Response) {
  return ok(res, await invitations.cancelInvitation(id(req)));
}

// ─── Devices ────────────────────────────────────────────────────────────────

export async function listDevices(req: Request, res: Response) {
  const { data, meta } = await devices.listDevices(req.query as unknown as ListDevicesQuery);
  return ok(res, data, meta);
}

export async function revokeDevice(req: Request, res: Response) {
  return ok(res, await devices.revokeDevice(id(req)));
}
