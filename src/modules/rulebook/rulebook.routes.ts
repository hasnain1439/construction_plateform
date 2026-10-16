import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as service from './rulebook.service.js';
import { keyParams, setOverridesBody, type SetOverridesInput } from './rulebook.schema.js';

/** Mounted at /api/v1/rulebook — the company's resolved estimation rulebook and its own overrides. */
export const rulebookRouter = Router();
rulebookRouter.get('/', ...company, requirePerm('rulebook.override.view'), h(async (_req: Request, res: Response) => ok(res, await service.getRulebook())));
rulebookRouter.get('/overrides', ...company, requirePerm('rulebook.override.view'), h(async (_req: Request, res: Response) => ok(res, await service.listOverrides())));
rulebookRouter.put(
  '/overrides',
  ...company,
  requirePerm('rulebook.override.manage'),
  validate({ body: setOverridesBody }),
  h(async (req: Request, res: Response) => ok(res, await service.setOverrides(req.body as SetOverridesInput))),
);
rulebookRouter.delete(
  '/overrides/:key',
  ...company,
  requirePerm('rulebook.override.manage'),
  validate({ params: keyParams }),
  h(async (req: Request, res: Response) => ok(res, await service.deleteOverride(String(req.params['key'])))),
);
