import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './projects.controller.js';
import {
  changeStatusBody,
  copyFloorBody,
  createProjectBody,
  createRoomBody,
  idParams,
  listProjectsQuery,
  openingInputSchema,
  setTeamBody,
  updateBasicBody,
  updateContractBody,
  updateCoverageBody,
  updateOpeningBody,
  updatePlotStructureBody,
  updateRoomBody,
} from './projects.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → role → validate → handler.
 * Project scoping (PM / MUNSHI only see assigned projects, others → 404) happens in the
 * services via access.ts, so a role check here is only the coarse gate.
 */
const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');

/** Mounted at /api/v1/projects */
export const projectsRouter = Router();
projectsRouter.use(...company);
projectsRouter.get('/', validate({ query: listProjectsQuery }), h(c.listProjects));
projectsRouter.post('/', office, validate({ body: createProjectBody }), h(c.createProject));
projectsRouter.get('/:id', validate({ params: idParams }), h(c.getProject));
projectsRouter.delete('/:id', owner, validate({ params: idParams }), h(c.deleteProject));
projectsRouter.patch('/:id/basic', office, validate({ params: idParams, body: updateBasicBody }), h(c.updateBasic));
projectsRouter.put('/:id/team', owner, validate({ params: idParams, body: setTeamBody }), h(c.setTeam));
projectsRouter.patch('/:id/contract', office, validate({ params: idParams, body: updateContractBody }), h(c.updateContract));
projectsRouter.patch('/:id/plot-structure', office, validate({ params: idParams, body: updatePlotStructureBody }), h(c.updatePlotStructure));
projectsRouter.get('/:id/review', office, validate({ params: idParams }), h(c.getReview));
projectsRouter.post('/:id/activate', office, validate({ params: idParams }), h(c.activate));
projectsRouter.patch('/:id/status', owner, validate({ params: idParams, body: changeStatusBody }), h(c.changeStatus));
projectsRouter.get('/:id/floors', validate({ params: idParams }), h(c.listFloors));
projectsRouter.patch('/:id/coverage', office, validate({ params: idParams, body: updateCoverageBody }), h(c.updateCoverage));

/** Mounted at /api/v1/supply-presets — static, every role. */
export const supplyPresetsRouter = Router();
supplyPresetsRouter.use(...company);
supplyPresetsRouter.get('/', h(c.supplyPresets));

/** Mounted at /api/v1/floors */
export const floorsRouter = Router();
floorsRouter.use(...company, office);
floorsRouter.post('/:id/rooms', validate({ params: idParams, body: createRoomBody }), h(c.createRoom));
floorsRouter.post('/:id/copy', validate({ params: idParams, body: copyFloorBody }), h(c.copyFloor));

/** Mounted at /api/v1/rooms */
export const roomsRouter = Router();
roomsRouter.use(...company, office);
roomsRouter.patch('/:id', validate({ params: idParams, body: updateRoomBody }), h(c.updateRoom));
roomsRouter.delete('/:id', validate({ params: idParams }), h(c.deleteRoom));
roomsRouter.post('/:id/openings', validate({ params: idParams, body: openingInputSchema }), h(c.createOpening));

/** Mounted at /api/v1/openings */
export const openingsRouter = Router();
openingsRouter.use(...company, office);
openingsRouter.patch('/:id', validate({ params: idParams, body: updateOpeningBody }), h(c.updateOpening));
openingsRouter.delete('/:id', validate({ params: idParams }), h(c.deleteOpening));
