import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { CreateRoleInput, DuplicateRoleInput, SetOverridesInput, SetRolePermissionsInput, SetUserRolesInput, UpdateRoleInput } from './permissions.schema.js';
import * as svc from './permissions.service.js';

const id = (req: Request) => String(req.params['id']);

export async function getCatalog(_req: Request, res: Response) {
  return ok(res, svc.catalog());
}

export async function listRoles(_req: Request, res: Response) {
  return ok(res, await svc.listRoles());
}

export async function getRole(req: Request, res: Response) {
  return ok(res, await svc.getRole(id(req)));
}

export async function createRole(req: Request, res: Response) {
  return created(res, await svc.createRole(req.body as CreateRoleInput));
}

export async function duplicateRole(req: Request, res: Response) {
  return created(res, await svc.duplicateRole(id(req), req.body as DuplicateRoleInput));
}

export async function updateRole(req: Request, res: Response) {
  return ok(res, await svc.updateRole(id(req), req.body as UpdateRoleInput));
}

export async function setRolePermissions(req: Request, res: Response) {
  return ok(res, await svc.setRolePermissions(id(req), req.body as SetRolePermissionsInput));
}

export async function getUserPermissions(req: Request, res: Response) {
  return ok(res, await svc.getUserPermissions(id(req)));
}

export async function setOverrides(req: Request, res: Response) {
  return ok(res, await svc.setOverrides(id(req), req.body as SetOverridesInput));
}

export async function setUserRoles(req: Request, res: Response) {
  return ok(res, await svc.setUserRoles(id(req), req.body as SetUserRolesInput));
}

export async function setUserRole(req: Request, res: Response) {
  return ok(res, await svc.setUserRole(id(req), (req.body as { roleId: string }).roleId));
}
