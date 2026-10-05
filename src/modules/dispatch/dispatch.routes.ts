import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
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
 * authenticate → tenantContext → readOnlyGuard → role → validate → handler.
 * Who may dispatch from / receive at which location is checked in the services
 * (THEKEDAR any; PM from their sites; receivers need access to the destination site).
 */
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');

/** Mounted at /api/v1/dispatches */
export const dispatchesRouter = Router();
dispatchesRouter.use(...company);
dispatchesRouter.get('/', validate({ query: listDispatchesQuery }), h(c.listDispatches));
dispatchesRouter.post('/', office, validate({ body: createDispatchBody }), h(c.createDispatch));
dispatchesRouter.get('/:id', validate({ params: idParams }), h(c.getDispatch));
dispatchesRouter.post('/:id/cancel', office, validate({ params: idParams }), h(c.cancelDispatch));
dispatchesRouter.post('/:id/receive', validate({ params: idParams, body: receiveDispatchBody }), h(c.receiveDispatch));

/** Mounted at /api/v1/shortages — THEKEDAR decides; a PM can read their projects' shortages. */
export const shortagesRouter = Router();
shortagesRouter.use(...company);
shortagesRouter.get('/', office, validate({ query: listShortagesQuery }), h(c.listShortages));
shortagesRouter.post('/:id/resolve', owner, validate({ params: idParams, body: resolveShortageBody }), h(c.resolveShortage));

/** Mounted at /api/v1/projects before the projects router (per-route middleware). */
export const projectDispatchRouter = Router();
projectDispatchRouter.get('/:id/incoming', ...company, validate({ params: idParams }), h(c.incoming));
projectDispatchRouter.get('/:id/owner-deliveries', ...company, validate({ params: idParams, query: ownerDeliveriesQuery }), h(c.listOwnerDeliveries));
projectDispatchRouter.post('/:id/owner-deliveries', ...company, validate({ params: idParams, body: ownerDeliveryBody }), h(c.createOwnerDelivery));
