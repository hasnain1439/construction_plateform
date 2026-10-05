import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePermission, requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './inventory.controller.js';
import {
  idParams,
  locationParams,
  lowStockLevelsBody,
  movementsQuery,
  stockCountBody,
  stockCountsQuery,
  storeStockQuery,
  usageBody,
  usageListQuery,
} from './inventory.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → role / permission → validate → handler.
 * Location and project scoping (PM / MUNSHI only their sites, outside → 404) is in the
 * services. Values and rates are omitted for callers without rates.view.
 */
export const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');
const rates = requirePermission('rates.view');

/** Mounted at /api/v1/stock-locations */
export const stockLocationsRouter = Router();
stockLocationsRouter.use(...company);
stockLocationsRouter.get('/', h(c.listLocations));

/** Mounted at /api/v1/stores */
export const storesRouter = Router();
storesRouter.use(...company);
storesRouter.get('/:locationId/stock', office, rates, validate({ params: locationParams, query: storeStockQuery }), h(c.storeStock));
storesRouter.put('/:locationId/low-stock-levels', owner, validate({ params: locationParams, body: lowStockLevelsBody }), h(c.setLowStockLevels));

/** Mounted at /api/v1/stock */
export const stockRouter = Router();
stockRouter.use(...company);
stockRouter.get('/movements', office, rates, validate({ query: movementsQuery }), h(c.listMovements));

/** Mounted at /api/v1/stock-counts — sites: THEKEDAR / PM / MUNSHI with access; the store: THEKEDAR only. */
export const stockCountsRouter = Router();
stockCountsRouter.use(...company);
stockCountsRouter.get('/', validate({ query: stockCountsQuery }), h(c.listCounts));
stockCountsRouter.post('/', validate({ body: stockCountBody }), h(c.createCount));

/**
 * Project-scoped stock routes, mounted at /api/v1/projects before the projects router.
 * Middleware is per route so other /projects paths fall through untouched.
 */
export const projectStockRouter = Router();
projectStockRouter.get('/:id/stock', ...company, validate({ params: idParams }), h(c.projectStock));
projectStockRouter.get('/:id/material-usage', ...company, validate({ params: idParams, query: usageListQuery }), h(c.listUsage));
projectStockRouter.post('/:id/material-usage', ...company, validate({ params: idParams, body: usageBody }), h(c.recordUsage));
