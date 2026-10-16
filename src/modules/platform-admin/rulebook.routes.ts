import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { created, ok } from '../../core/http/response.js';
import { validate } from '../../core/middleware/validate.js';
import { idParams } from './platformAdmin.schema.js';
import { createRulebookBody, rulebookParamParams, rulebooksQuery, updateParameterBody, updateRulebookBody, type CreateRulebookInput, type RulebooksQuery, type UpdateParameterInput, type UpdateRulebookInput } from './rulebook.schema.js';
import * as rulebooks from './rulebook.service.js';

/** Mounted at /api/v1/admin/rulebooks inside the platform-admin router (platform token + live admin session). */
export const adminRulebookRouter = Router();
const id = (req: Request) => String(req.params['id']);

adminRulebookRouter.get('/', validate({ query: rulebooksQuery }), h(async (req: Request, res: Response) => ok(res, await rulebooks.listRulebooks(req.query as unknown as RulebooksQuery))));
adminRulebookRouter.post('/', validate({ body: createRulebookBody }), h(async (req: Request, res: Response) => created(res, await rulebooks.createRulebook(req.body as CreateRulebookInput))));
adminRulebookRouter.get('/:id', validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await rulebooks.getRulebook(id(req)))));
adminRulebookRouter.patch('/:id', validate({ params: idParams, body: updateRulebookBody }), h(async (req: Request, res: Response) => ok(res, await rulebooks.updateRulebook(id(req), req.body as UpdateRulebookInput))));
adminRulebookRouter.delete('/:id', validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await rulebooks.deleteRulebook(id(req)))));
adminRulebookRouter.post('/:id/publish', validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await rulebooks.publishRulebook(id(req)))));
adminRulebookRouter.patch(
  '/:id/parameters/:key',
  validate({ params: rulebookParamParams, body: updateParameterBody }),
  h(async (req: Request, res: Response) => ok(res, await rulebooks.updateParameter(id(req), String(req.params['key']), req.body as UpdateParameterInput))),
);
