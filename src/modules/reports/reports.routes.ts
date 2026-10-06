import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './reports.controller.js';
import { REPORT_NAMES, reportQuery } from './reports.schema.js';

/**
 * Mounted at /api/v1/reports — one GET per report, THEKEDAR / PM (owner-only reports and
 * money / rate rules are checked in the service). `format=csv|xlsx|pdf` returns a signed link.
 */
export const reportsRouter = Router();
for (const name of REPORT_NAMES) {
  reportsRouter.get(`/${name}`, ...company, requireRole('THEKEDAR', 'PM'), validate({ query: reportQuery }), h(c.runReport(name)));
}
