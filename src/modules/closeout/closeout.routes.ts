import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './closeout.controller.js';
import * as S from './closeout.schema.js';

/**
 * Step 17 · Closeout. Project routes are mounted at /api/v1/projects (per-route auth, before the
 * projects router); project scope: THEKEDAR every project, others the permission in scope
 * (outside → 404).
 */
export const projectCloseoutRouter = Router();
const p = projectCloseoutRouter;
const params = S.idParams;
p.get('/:id/drawings', ...company, requirePerm('closeout.drawing.view'), validate({ params, query: S.drawingsQuery }), h(c.listDrawings));
p.post('/:id/drawings', ...company, requirePerm('closeout.drawing.manage'), validate({ params, body: S.createDrawingBody }), h(c.createDrawing));
p.get('/:id/snags', ...company, requirePerm('closeout.snag.view'), validate({ params, query: S.snagsQuery }), h(c.listSnags));
p.post('/:id/snags', ...company, requirePerm('closeout.snag.create'), validate({ params, body: S.createSnagBody }), h(c.createSnag));
p.get('/:id/handover', ...company, requirePerm('closeout.handover.manage'), validate({ params }), h(c.getHandover));
p.put('/:id/handover/items/:key', ...company, requirePerm('closeout.handover.manage'), validate({ params: S.itemParams, body: S.handoverItemBody }), h(c.setHandoverItem));
p.post('/:id/handover/sign-off', ...company, requirePerm('closeout.handover.manage'), validate({ params, body: S.signOffBody }), h(c.signOff));
p.post(
  '/:id/handover/complete',
  ...company,
  requirePerm(['closeout.handover.manage', 'projects.project.manage']),
  validate({ params, body: S.completeHandoverBody }),
  h(c.completeHandover),
);
p.get('/:id/handover/certificate', ...company, requirePerm('closeout.handover.manage'), validate({ params, query: S.certificateQuery }), h(c.certificate));
p.get('/:id/retention', ...company, requirePerm('closeout.retention.view'), validate({ params }), h(c.getRetention));
p.patch('/:id/retention', ...company, requirePerm('closeout.handover.manage'), validate({ params, body: S.retentionSettingsBody }), h(c.updateRetention));

/** Mounted at /api/v1/drawings */
export const drawingsRouter = Router();
drawingsRouter.get('/:id', ...company, requirePerm('closeout.drawing.view'), validate({ params }), h(c.getDrawing));
drawingsRouter.patch('/:id', ...company, requirePerm('closeout.drawing.manage'), validate({ params, body: S.updateDrawingBody }), h(c.updateDrawing));
drawingsRouter.delete('/:id', ...company, requirePerm('closeout.drawing.manage'), validate({ params }), h(c.deleteDrawing));
drawingsRouter.post('/:id/revisions', ...company, requirePerm('closeout.drawing.manage'), validate({ params, body: S.addRevisionBody }), h(c.addRevision));

/** Mounted at /api/v1/drawing-revisions */
export const drawingRevisionsRouter = Router();
drawingRevisionsRouter.patch('/:id', ...company, requirePerm('closeout.drawing.manage'), validate({ params, body: S.updateRevisionBody }), h(c.updateRevision));

/** Mounted at /api/v1/snags */
export const snagsRouter = Router();
snagsRouter.get('/:id', ...company, requirePerm('closeout.snag.view'), validate({ params }), h(c.getSnag));
snagsRouter.patch('/:id', ...company, requirePerm('closeout.snag.manage'), validate({ params, body: S.updateSnagBody }), h(c.updateSnag));
snagsRouter.delete('/:id', ...company, requirePerm('closeout.snag.manage'), validate({ params }), h(c.deleteSnag));
snagsRouter.post('/:id/fix', ...company, requirePerm('closeout.snag.create'), validate({ params, body: S.fixSnagBody }), h(c.fixSnag));
snagsRouter.post('/:id/verify', ...company, requirePerm('closeout.snag.manage'), validate({ params, body: S.verifySnagBody }), h(c.verifySnag));
snagsRouter.post('/:id/reopen', ...company, requirePerm('closeout.snag.manage'), validate({ params, body: S.reopenSnagBody }), h(c.reopenSnag));
/** Who pays: needs the amounts too. */
snagsRouter.put('/:id/cost', ...company, requirePerm(['closeout.snag.manage', 'fields.amounts']), validate({ params, body: S.snagCostBody }), h(c.snagCost));
