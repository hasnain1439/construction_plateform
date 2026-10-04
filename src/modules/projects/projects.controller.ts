import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import { SUPPLY_PRESETS } from './presets.js';
import type {
  ChangeStatusInput,
  CopyFloorInput,
  CreateProjectInput,
  CreateRoomInput,
  ListProjectsQuery,
  OpeningInput,
  SetTeamInput,
  UpdateBasicInput,
  UpdateContractInput,
  UpdateCoverageInput,
  UpdateOpeningInput,
  UpdatePlotStructureInput,
  UpdateRoomInput,
} from './projects.schema.js';
import * as projects from './projects.service.js';
import * as review from './review.service.js';
import * as rooms from './rooms.service.js';
import * as wizard from './wizard.service.js';

const id = (req: Request) => String(req.params['id']);

export async function listProjects(req: Request, res: Response) {
  const { data, meta } = await projects.listProjects(req.query as unknown as ListProjectsQuery);
  return ok(res, data, meta);
}
export const getProject = async (req: Request, res: Response) => ok(res, await projects.getProject(id(req)));
export const createProject = async (req: Request, res: Response) => created(res, await projects.createProject(req.body as CreateProjectInput));
export const deleteProject = async (req: Request, res: Response) => ok(res, await projects.deleteProject(id(req)));
export const updateBasic = async (req: Request, res: Response) => ok(res, await projects.updateBasic(id(req), req.body as UpdateBasicInput));
export const setTeam = async (req: Request, res: Response) => ok(res, await projects.setTeam(id(req), req.body as SetTeamInput));
export const updateContract = async (req: Request, res: Response) => ok(res, await wizard.updateContract(id(req), req.body as UpdateContractInput));
export const updatePlotStructure = async (req: Request, res: Response) =>
  ok(res, await wizard.updatePlotStructure(id(req), req.body as UpdatePlotStructureInput));
export const updateCoverage = async (req: Request, res: Response) => ok(res, await wizard.updateCoverage(id(req), req.body as UpdateCoverageInput));
export const supplyPresets = async (_req: Request, res: Response) => ok(res, SUPPLY_PRESETS);

// ─── Floors, rooms, openings ────────────────────────────────────────────────

export const listFloors = async (req: Request, res: Response) => ok(res, await rooms.listFloors(id(req)));
export const copyFloor = async (req: Request, res: Response) => ok(res, await rooms.copyFloor(id(req), req.body as CopyFloorInput));
export const createRoom = async (req: Request, res: Response) => created(res, await rooms.createRoom(id(req), req.body as CreateRoomInput));
export const updateRoom = async (req: Request, res: Response) => ok(res, await rooms.updateRoom(id(req), req.body as UpdateRoomInput));
export const deleteRoom = async (req: Request, res: Response) => ok(res, await rooms.deleteRoom(id(req)));
export const createOpening = async (req: Request, res: Response) => created(res, await rooms.createOpening(id(req), req.body as OpeningInput));
export const updateOpening = async (req: Request, res: Response) => ok(res, await rooms.updateOpening(id(req), req.body as UpdateOpeningInput));
export const deleteOpening = async (req: Request, res: Response) => ok(res, await rooms.deleteOpening(id(req)));

// ─── Review, activation, status ─────────────────────────────────────────────

export const getReview = async (req: Request, res: Response) => ok(res, await review.getReview(id(req)));
export const activate = async (req: Request, res: Response) => ok(res, await review.activate(id(req)));
export const changeStatus = async (req: Request, res: Response) => ok(res, await review.changeStatus(id(req), req.body as ChangeStatusInput));
