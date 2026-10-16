import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { created, ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { bill } from './billing.js';
import * as S from './changeOrders.schema.js';
import * as co from './changeOrders.service.js';
import * as si from './siteInstructions.service.js';
import { slipPdf } from './slip.js';

/**
 * Step 15 · Change orders + site instructions. Project routes are mounted at /api/v1/projects
 * (per-route auth, before the projects router); a project outside the caller's scope → 404.
 */
const id = (req: Request) => String(req.params['id']);
const body = <T>(req: Request) => req.body as T;
const query = <T>(req: Request) => req.query as unknown as T;
const params = S.idParams;
const READ_SI = requirePerm(['changeorder.instruction.view', 'changeorder.instruction.create'], { any: true });

export const projectChangeOrdersRouter = Router();
const p = projectChangeOrdersRouter;
p.get('/:id/change-orders', ...company, requirePerm('changeorder.view'), validate({ params, query: S.changeOrdersQuery }), h(async (req: Request, res: Response) => ok(res, await co.list(id(req), query(req)))));
p.post('/:id/change-orders', ...company, requirePerm('changeorder.create'), validate({ params, body: S.createChangeOrderBody }), h(async (req: Request, res: Response) => created(res, await co.create(id(req), body(req)))));
p.get('/:id/change-orders/rates', ...company, requirePerm('changeorder.create'), validate({ params }), h(async (req: Request, res: Response) => ok(res, await co.rateOptions(id(req)))));
p.get('/:id/site-instructions', ...company, READ_SI, validate({ params, query: S.siteInstructionsQuery }), h(async (req: Request, res: Response) => ok(res, await si.list(id(req), query(req)))));
p.post(
  '/:id/site-instructions',
  ...company,
  requirePerm('changeorder.instruction.create'),
  validate({ params, body: S.createSiteInstructionBody }),
  h(async (req: Request, res: Response) => {
    const r = await si.create(id(req), body(req));
    return r.created ? created(res, r.data) : ok(res, r.data);
  }),
);

/** Mounted at /api/v1/change-orders */
export const changeOrdersRouter = Router();
const c = changeOrdersRouter;
c.get('/:id', ...company, requirePerm('changeorder.view'), validate({ params }), h(async (req: Request, res: Response) => ok(res, await co.get(id(req)))));
c.patch('/:id', ...company, requirePerm('changeorder.edit'), validate({ params, body: S.updateChangeOrderBody }), h(async (req: Request, res: Response) => ok(res, await co.update(id(req), body(req)))));
c.delete('/:id', ...company, requirePerm('changeorder.edit'), validate({ params }), h(async (req: Request, res: Response) => ok(res, await co.remove(id(req)))));
c.post('/:id/send', ...company, requirePerm('changeorder.edit'), validate({ params, body: S.emptyBody }), h(async (req: Request, res: Response) => ok(res, await co.send(id(req)))));
c.post('/:id/approve', ...company, requirePerm('changeorder.approve'), validate({ params, body: S.approveBody }), h(async (req: Request, res: Response) => ok(res, await co.approve(id(req), body(req)))));
c.post('/:id/reject', ...company, requirePerm('changeorder.approve'), validate({ params, body: S.rejectBody }), h(async (req: Request, res: Response) => ok(res, await co.reject(id(req), body(req)))));
c.post('/:id/reopen', ...company, requirePerm('changeorder.edit'), validate({ params, body: S.emptyBody }), h(async (req: Request, res: Response) => ok(res, await co.reopen(id(req)))));
c.post('/:id/start', ...company, requirePerm('changeorder.edit'), validate({ params, body: S.emptyBody }), h(async (req: Request, res: Response) => ok(res, await co.start(id(req)))));
c.post('/:id/complete', ...company, requirePerm('changeorder.edit'), validate({ params, body: S.emptyBody }), h(async (req: Request, res: Response) => ok(res, await co.complete(id(req)))));
c.post('/:id/bill', ...company, requirePerm(['changeorder.manage', 'billing.invoice.create']), validate({ params, body: S.billBody }), h(async (req: Request, res: Response) => ok(res, await bill(id(req), body(req)))));
c.get('/:id/pdf', ...company, requirePerm('changeorder.view'), validate({ params, query: S.pdfQuery }), h(async (req: Request, res: Response) => ok(res, await slipPdf(id(req), query(req)))));

/** Mounted at /api/v1/site-instructions */
export const siteInstructionsRouter = Router();
siteInstructionsRouter.get('/:id', ...company, READ_SI, validate({ params }), h(async (req: Request, res: Response) => ok(res, await si.get(id(req)))));
siteInstructionsRouter.post('/:id/convert', ...company, requirePerm('changeorder.create'), validate({ params, body: S.convertBody }), h(async (req: Request, res: Response) => created(res, await si.convert(id(req), body(req)))));
siteInstructionsRouter.post('/:id/dismiss', ...company, requirePerm('changeorder.create'), validate({ params, body: S.dismissBody }), h(async (req: Request, res: Response) => ok(res, await si.dismiss(id(req), body(req)))));

/** Mounted at /api/v1/snags (beside the closeout snag routes): POST /snags/:id/change-order */
export const snagChangeOrderRouter = Router();
snagChangeOrderRouter.post('/:id/change-order', ...company, requirePerm('changeorder.create'), validate({ params, body: S.convertBody }), h(async (req: Request, res: Response) => created(res, await si.fromSnag(id(req), body(req)))));
