import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { langQuery } from '../../core/i18n/lang.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { idParams } from '../projects/projects.schema.js';
import * as c from './estimate.controller.js';
import { contractFromEstimateBody } from './contractValue.js';
import { approveEstimateBody, compareParams, estimateIdParams, generateEstimateBody, lineOverrideBody, lineParams, shoppingListQuery } from './estimate.schema.js';
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
// Step 11 · saved estimates (revisions) + owner shopping list
projectEstimateRouter.post('/:id/estimates', ...company, requirePerm('projects.estimate.manage'), validate({ params: idParams, body: generateEstimateBody }), h(c.generate));
projectEstimateRouter.get('/:id/estimates', ...company, requirePerm('projects.estimate.view'), validate({ params: idParams }), h(c.listRevisions));
projectEstimateRouter.get('/:id/owner-shopping-list', ...company, requirePerm('projects.estimate.view'), validate({ params: idParams, query: shoppingListQuery }), h(c.ownerShoppingList));
projectEstimateRouter.get('/:id/owner-shopping-list/pdf', ...company, requirePerm('projects.estimate.view'), validate({ params: idParams, query: shoppingListQuery }), h(c.ownerShoppingListPdf));

/** Mounted at /api/v1/estimates. The estimate's project must be in the caller's scope (else 404 ESTIMATE_NOT_FOUND). */
export const estimatesRouter = Router();
estimatesRouter.get('/:a/compare/:b', ...company, requirePerm('projects.estimate.view'), validate({ params: compareParams }), h(c.compare));
estimatesRouter.get('/:id', ...company, requirePerm('projects.estimate.view'), validate({ params: estimateIdParams }), h(c.getRevision));
estimatesRouter.get('/:id/pdf', ...company, requirePerm('projects.estimate.view'), validate({ params: estimateIdParams, query: langQuery }), h(c.revisionPdf));
estimatesRouter.post('/:id/regenerate', ...company, requirePerm('projects.estimate.manage'), validate({ params: estimateIdParams }), h(c.regenerate));
estimatesRouter.patch('/:id/lines/:lineId', ...company, requirePerm('projects.estimate.manage'), validate({ params: lineParams, body: lineOverrideBody }), h(c.overrideLine));
estimatesRouter.post('/:id/approve', ...company, requirePerm('estimate.revision.approve'), validate({ params: estimateIdParams, body: approveEstimateBody }), h(c.approve));
