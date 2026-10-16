import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { idParams } from '../projects/projects.schema.js';
import * as c from './estimate.controller.js';
import { contractFromEstimateBody } from './contractValue.js';
import { estimateSettingsBody } from './settings.js';

/**
 * Mounted at /api/v1/projects (per-route auth, before the projects router).
 * Project scope: THEKEDAR every project; others need the permission in scope (outside → 404).
 */
export const projectEstimateRouter = Router();
projectEstimateRouter.get('/:id/estimate', ...company, requirePerm('projects.estimate.view'), validate({ params: idParams }), h(c.getEstimate));
projectEstimateRouter.put(
  '/:id/estimate/settings',
  ...company,
  requirePerm('projects.estimate.manage'),
  validate({ params: idParams, body: estimateSettingsBody }),
  h(c.updateSettings),
);
/** Contract value (labour-only: rate) from the estimate — needs the cost (fields.rates) and the contract value (fields.contract). */
projectEstimateRouter.post(
  '/:id/contract/from-estimate',
  ...company,
  requirePerm(['projects.project.edit', 'fields.contract', 'fields.rates']),
  validate({ params: idParams, body: contractFromEstimateBody }),
  h(c.contractFromEstimate),
);
