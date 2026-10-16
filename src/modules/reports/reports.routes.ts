import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './reports.controller.js';
import { BOOK_NAMES, bookParams, bookQuery, PHASE1_REPORT_NAMES, reportQuery, STEP18_REPORT_NAMES, STEP18_REPORT_PERM, step18Query } from './reports.schema.js';

/**
 * Mounted at /api/v1/reports — one GET per report, THEKEDAR / PM (owner-only reports and
 * money / rate rules are checked in the service). `format=csv|xlsx|pdf` returns a signed link.
 * Step 18 reports also need the source module's view key (its scope picks the projects);
 * delay analysis, variance and snags have a per-project book at /<name>/:projectId.
 */
export const reportsRouter = Router();
for (const name of PHASE1_REPORT_NAMES) {
  reportsRouter.get(`/${name}`, ...company, requirePerm('finance.reports.view'), validate({ query: reportQuery }), h(c.runReport(name)));
}
for (const name of STEP18_REPORT_NAMES) {
  reportsRouter.get(`/${name}`, ...company, requirePerm(['finance.reports.view', STEP18_REPORT_PERM[name]]), validate({ query: step18Query }), h(c.runReport(name)));
}
for (const name of BOOK_NAMES) {
  reportsRouter.get(`/${name}/:projectId`, ...company, requirePerm(['finance.reports.view', STEP18_REPORT_PERM[name]]), validate({ params: bookParams, query: bookQuery }), h(c.runBook(name)));
}
