import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './approvals.controller.js';
import { bulkBody } from './approvals.schema.js';

/** Mounted at /api/v1/approvals — THEKEDAR and PM (a PM sees their projects only). */
export const approvalsRouter = Router();
const office = requireRole('THEKEDAR', 'PM');
approvalsRouter.get('/', ...company, office, h(c.listApprovals));
approvalsRouter.post('/bulk', ...company, office, validate({ body: bulkBody }), h(c.bulk));
