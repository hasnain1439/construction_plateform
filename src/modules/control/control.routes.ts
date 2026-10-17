/** Step 14 · control routes (per-route auth: company chain + permission + validation). */
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { idParams } from '../projects/projects.schema.js';
import * as alerts from './alerts.service.js';
import { alertsQuery, controlSettingsBody, materialVarianceQuery, projectAlertsQuery, runAlertsBody, type AlertsQuery, type ControlSettingsInput, type MaterialVarianceQuery, type ProjectAlertsQuery, type RunAlertsInput } from './control.schema.js';
import * as cost from './cost.service.js';
import * as delay from './delay.service.js';
import * as summary from './summary.service.js';
import * as variance from './variance.service.js';

const id = (req: Request) => String(req.params['id']);
const VIEW = requirePerm('control.view');
const MANAGE = requirePerm('control.manage');
const q = <T>(req: Request) => req.query as unknown as T;

/** Mounted at /api/v1/projects (before the projects router). */
export const projectControlRouter = Router();
projectControlRouter.get(
  '/:id/control/material-variance',
  ...company,
  VIEW,
  validate({ params: idParams, query: materialVarianceQuery }),
  h(async (req: Request, res: Response) => ok(res, await variance.materialVariance(id(req), q<MaterialVarianceQuery>(req)))),
);
projectControlRouter.get('/:id/control/cost-variance', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await cost.costVariance(id(req)))));
projectControlRouter.get('/:id/control/burn-rate', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await cost.burnRate(id(req)))));
projectControlRouter.get('/:id/control/delay-analysis', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await delay.delayAnalysis(id(req)))));
projectControlRouter.get(
  '/:id/control/alerts',
  ...company,
  VIEW,
  validate({ params: idParams, query: projectAlertsQuery }),
  h(async (req: Request, res: Response) => ok(res, await alerts.projectAlerts(id(req), q<ProjectAlertsQuery>(req)))),
);

/** Mounted at /api/v1/control */
export const controlRouter = Router();
controlRouter.get('/summary', ...company, VIEW, h(async (_req: Request, res: Response) => ok(res, await summary.summary())));
controlRouter.get(
  '/alerts',
  ...company,
  VIEW,
  validate({ query: alertsQuery }),
  h(async (req: Request, res: Response) => {
    const r = await alerts.listAlerts(q<AlertsQuery>(req));
    return ok(res, r.data, r.meta);
  }),
);
controlRouter.get('/alerts/rules', ...company, VIEW, h(async (_req: Request, res: Response) => ok(res, await alerts.listRules())));
controlRouter.post('/alerts/run', ...company, MANAGE, validate({ body: runAlertsBody }), h(async (req: Request, res: Response) => ok(res, await alerts.runAlerts(req.body as RunAlertsInput))));
controlRouter.get('/settings', ...company, VIEW, h(async (_req: Request, res: Response) => ok(res, await alerts.getSettings())));
controlRouter.put('/settings', ...company, MANAGE, validate({ body: controlSettingsBody }), h(async (req: Request, res: Response) => ok(res, await alerts.updateSettings(req.body as ControlSettingsInput))));
