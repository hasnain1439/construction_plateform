import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './sync.controller.js';
import { pullQuery, pushBody } from './sync.schema.js';

/**
 * Mounted at /api/v1/sync — the mobile app's offline sync. Company bearer token of a device
 * that is not revoked (tenantContext → 401 DEVICE_REVOKED). Scope and visibility per role are
 * enforced in the loaders / serializers.
 */
export const syncRouter = Router();
syncRouter.get('/pull', ...company, validate({ query: pullQuery }), h(c.pull));
syncRouter.post('/push', ...company, validate({ body: pushBody }), h(c.push));
syncRouter.get('/status', ...company, h(c.status));
