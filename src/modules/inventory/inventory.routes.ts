import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
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
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * Location and project scoping (PM / MUNSHI only their sites, outside → 404) is in the
 * services. Values and rates are omitted for callers without fields.rates.
 */
export const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];

/** Mounted at /api/v1/stock-locations */
export const stockLocationsRouter = Router();
stockLocationsRouter.use(...company);
stockLocationsRouter.get('/', requirePerm('inventory.stock.view'), h(c.listLocations));

/** Mounted at /api/v1/stores */
export const storesRouter = Router();
storesRouter.use(...company);
storesRouter.get('/:locationId/stock', requirePerm('inventory.store.view'), validate({ params: locationParams, query: storeStockQuery }), h(c.storeStock));
storesRouter.put('/:locationId/low-stock-levels', requirePerm('inventory.store.manage'), validate({ params: locationParams, body: lowStockLevelsBody }), h(c.setLowStockLevels));

/** Mounted at /api/v1/stock */
export const stockRouter = Router();
stockRouter.use(...company);
stockRouter.get('/movements', requirePerm('inventory.store.view'), validate({ query: movementsQuery }), h(c.listMovements));

/** Mounted at /api/v1/stock-counts — sites: THEKEDAR / PM / MUNSHI with access; the store: THEKEDAR only. */
export const stockCountsRouter = Router();
stockCountsRouter.use(...company);
stockCountsRouter.get('/', requirePerm('inventory.count.view'), validate({ query: stockCountsQuery }), h(c.listCounts));
stockCountsRouter.post('/', requirePerm('inventory.count.create'), validate({ body: stockCountBody }), h(c.createCount));

/**
 * Project-scoped stock routes, mounted at /api/v1/projects before the projects router.
 * Middleware is per route so other /projects paths fall through untouched.
 */
export const projectStockRouter = Router();
projectStockRouter.get('/:id/stock', ...company, requirePerm('inventory.stock.view'), validate({ params: idParams }), h(c.projectStock));
projectStockRouter.get('/:id/material-usage', ...company, requirePerm('inventory.stock.view'), validate({ params: idParams, query: usageListQuery }), h(c.listUsage));
projectStockRouter.post('/:id/material-usage', ...company, requirePerm('inventory.usage.create'), validate({ params: idParams, body: usageBody }), h(c.recordUsage));
