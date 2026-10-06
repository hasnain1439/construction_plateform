import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './dashboard.controller.js';
import { overviewQuery, projectParams } from './dashboard.schema.js';

/**
 * Mounted at /api/v1/dashboard. Overview: THEKEDAR / PM (money keys only with billing.view).
 * Site: anyone with access to the project (a MUNSHI's landing page); outside → 404.
 */
export const dashboardRouter = Router();
dashboardRouter.get('/overview', ...company, requireRole('THEKEDAR', 'PM'), validate({ query: overviewQuery }), h(c.overview));
dashboardRouter.get('/site/:projectId', ...company, validate({ params: projectParams }), h(c.siteDashboard));
