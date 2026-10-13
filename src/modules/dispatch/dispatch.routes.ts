import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './dispatch.controller.js';
import {
  createDispatchBody,
  idParams,
  listDispatchesQuery,
  listShortagesQuery,
  ownerDeliveriesQuery,
  ownerDeliveryBody,
  receiveDispatchBody,
  resolveShortageBody,
} from './dispatch.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * Who may dispatch from / receive at which location is checked in the services
 * (THEKEDAR any; PM from their sites; receivers need access to the destination site).
 */

/** Mounted at /api/v1/dispatches */
export const dispatchesRouter = Router();
dispatchesRouter.use(...company);
dispatchesRouter.get('/', requirePerm('procurement.dispatch.view'), validate({ query: listDispatchesQuery }), h(c.listDispatches));
dispatchesRouter.post('/', requirePerm('procurement.dispatch.create'), validate({ body: createDispatchBody }), h(c.createDispatch));
dispatchesRouter.get('/:id', requirePerm('procurement.dispatch.view'), validate({ params: idParams }), h(c.getDispatch));
dispatchesRouter.post('/:id/cancel', requirePerm('procurement.dispatch.create'), validate({ params: idParams }), h(c.cancelDispatch));
dispatchesRouter.post('/:id/receive', requirePerm('procurement.receiving.create'), validate({ params: idParams, body: receiveDispatchBody }), h(c.receiveDispatch));

/** Mounted at /api/v1/shortages — THEKEDAR decides; a PM can read their projects' shortages. */
export const shortagesRouter = Router();
shortagesRouter.use(...company);
shortagesRouter.get('/', requirePerm('procurement.shortage.view'), validate({ query: listShortagesQuery }), h(c.listShortages));
shortagesRouter.post('/:id/resolve', requirePerm('procurement.shortage.approve'), validate({ params: idParams, body: resolveShortageBody }), h(c.resolveShortage));

/** Mounted at /api/v1/projects before the projects router (per-route middleware). */
export const projectDispatchRouter = Router();
projectDispatchRouter.get('/:id/incoming', ...company, requirePerm('procurement.dispatch.view'), validate({ params: idParams }), h(c.incoming));
projectDispatchRouter.get('/:id/owner-deliveries', ...company, requirePerm('inventory.ownerdelivery.view'), validate({ params: idParams, query: ownerDeliveriesQuery }), h(c.listOwnerDeliveries));
projectDispatchRouter.post('/:id/owner-deliveries', ...company, requirePerm('inventory.ownerdelivery.create'), validate({ params: idParams, body: ownerDeliveryBody }), h(c.createOwnerDelivery));
