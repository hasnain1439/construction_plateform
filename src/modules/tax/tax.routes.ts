/** Step 18 · tax routes (per-route auth: company chain + permission + validation). */
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { idParams } from '../projects/projects.schema.js';
import * as service from './tax.service.js';
import { projectTaxBody, TAX_REPORT_NAMES, taxReportQuery, taxSettingsBody, type ProjectTaxInput, type TaxReportQuery, type TaxSettingsInput } from './tax.schema.js';
import { runTaxReport } from './taxReports.js';

const id = (req: Request) => String(req.params['id']);

/** Mounted at /api/v1/tax */
export const taxRouter = Router();
taxRouter.get('/settings', ...company, requirePerm('tax.view'), h(async (_req: Request, res: Response) => ok(res, await service.getSettings())));
taxRouter.patch('/settings', ...company, requirePerm('tax.settings.manage'), validate({ body: taxSettingsBody }), h(async (req: Request, res: Response) => ok(res, await service.updateSettings(req.body as TaxSettingsInput))));

/** Mounted at /api/v1/projects (before the projects router). */
export const projectTaxRouter = Router();
projectTaxRouter.get('/:id/tax', ...company, requirePerm('billing.invoice.view'), validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await service.getProjectTax(id(req)))));
projectTaxRouter.patch(
  '/:id/tax',
  ...company,
  requirePerm('tax.settings.manage'),
  validate({ params: idParams, body: projectTaxBody }),
  h(async (req: Request, res: Response) => ok(res, await service.updateProjectTax(id(req), req.body as ProjectTaxInput))),
);

/** Mounted at /api/v1/reports — the two tax reports beside the finance reports (same export pipeline). */
export const taxReportsRouter = Router();
for (const name of TAX_REPORT_NAMES) {
  taxReportsRouter.get(`/${name}`, ...company, requirePerm('tax.view'), validate({ query: taxReportQuery }), h(async (req: Request, res: Response) => ok(res, await runTaxReport(name, req.query as unknown as TaxReportQuery))));
}
