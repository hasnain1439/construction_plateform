import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './dashboard.controller.js';
import { overviewQuery, projectParams } from './dashboard.schema.js';

/**
 * Mounted at /api/v1/dashboard. Overview: THEKEDAR / PM (money keys only with billing.view).
 * Site: anyone with access to the project (a MUNSHI's landing page); outside → 404.
 */
export const dashboardRouter = Router();
dashboardRouter.get('/overview', ...company, requirePerm('dashboard.overview.view'), validate({ query: overviewQuery }), h(c.overview));
dashboardRouter.get('/site/:projectId', ...company, requirePerm('dashboard.site.view'), validate({ params: projectParams }), h(c.siteDashboard));
