import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './approvals.controller.js';
import { bulkBody } from './approvals.schema.js';

/** Mounted at /api/v1/approvals — approvals.inbox.view; each item / action needs its own approve permission. */
export const approvalsRouter = Router();
const office = requirePerm('approvals.inbox.view');
approvalsRouter.get('/', ...company, office, h(c.listApprovals));
approvalsRouter.post('/bulk', ...company, office, validate({ body: bulkBody }), h(c.bulk));
