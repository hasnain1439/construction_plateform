import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
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
import { autoWallsBody, setWallsBody } from './walls.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * Project scoping (PM / MUNSHI only see assigned projects, others → 404) happens in the
 * services via access.ts, so the permission here is only the coarse gate.
 */
const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];
const edit = requirePerm('projects.project.edit');

/** Mounted at /api/v1/projects */
export const projectsRouter = Router();
projectsRouter.use(...company);
projectsRouter.get('/', requirePerm('projects.project.view'), validate({ query: listProjectsQuery }), h(c.listProjects));
projectsRouter.post('/', requirePerm('projects.project.create'), validate({ body: createProjectBody }), h(c.createProject));
projectsRouter.get('/:id', requirePerm('projects.project.view'), validate({ params: idParams }), h(c.getProject));
projectsRouter.delete('/:id', requirePerm('projects.project.manage'), validate({ params: idParams }), h(c.deleteProject));
projectsRouter.patch('/:id/basic', requirePerm('projects.project.edit'), validate({ params: idParams, body: updateBasicBody }), h(c.updateBasic));
projectsRouter.put('/:id/team', requirePerm('projects.team.manage'), validate({ params: idParams, body: setTeamBody }), h(c.setTeam));
projectsRouter.patch('/:id/contract', requirePerm('projects.project.edit'), validate({ params: idParams, body: updateContractBody }), h(c.updateContract));
projectsRouter.patch('/:id/plot-structure', requirePerm('projects.project.edit'), validate({ params: idParams, body: updatePlotStructureBody }), h(c.updatePlotStructure));
projectsRouter.get('/:id/review', requirePerm('projects.project.edit'), validate({ params: idParams }), h(c.getReview));
projectsRouter.post('/:id/activate', requirePerm('projects.project.approve'), validate({ params: idParams }), h(c.activate));
projectsRouter.patch('/:id/status', requirePerm('projects.project.manage'), validate({ params: idParams, body: changeStatusBody }), h(c.changeStatus));
projectsRouter.get('/:id/floors', requirePerm('projects.project.view'), validate({ params: idParams }), h(c.listFloors));
projectsRouter.patch('/:id/coverage', requirePerm('projects.project.edit'), validate({ params: idParams, body: updateCoverageBody }), h(c.updateCoverage));

/** Mounted at /api/v1/supply-presets — static, every role. */
export const supplyPresetsRouter = Router();
supplyPresetsRouter.use(...company);
supplyPresetsRouter.get('/', h(c.supplyPresets));

/** Mounted at /api/v1/floors */
export const floorsRouter = Router();
floorsRouter.use(...company, edit);
floorsRouter.post('/:id/rooms', validate({ params: idParams, body: createRoomBody }), h(c.createRoom));
floorsRouter.post('/:id/copy', validate({ params: idParams, body: copyFloorBody }), h(c.copyFloor));
floorsRouter.post('/:id/walls/auto', validate({ params: idParams, body: autoWallsBody }), h(c.autoFloorWalls));

/** Mounted at /api/v1/rooms */
export const roomsRouter = Router();
roomsRouter.use(...company, edit);
roomsRouter.patch('/:id', validate({ params: idParams, body: updateRoomBody }), h(c.updateRoom));
roomsRouter.delete('/:id', validate({ params: idParams }), h(c.deleteRoom));
roomsRouter.post('/:id/openings', validate({ params: idParams, body: openingInputSchema }), h(c.createOpening));
roomsRouter.put('/:id/walls', validate({ params: idParams, body: setWallsBody }), h(c.setRoomWalls));

/** Mounted at /api/v1/openings */
export const openingsRouter = Router();
openingsRouter.use(...company, edit);
openingsRouter.patch('/:id', validate({ params: idParams, body: updateOpeningBody }), h(c.updateOpening));
openingsRouter.delete('/:id', validate({ params: idParams }), h(c.deleteOpening));
