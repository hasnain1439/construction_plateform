/** Step 13 · schedule routes (per-route auth: company chain + permission + validation). */
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { created, ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import { idParams } from '../projects/projects.schema.js';
import * as insights from './insights.service.js';
import * as progress from './progress.service.js';
import * as schedule from './schedule.service.js';
import {
  approveStoppageBody,
  generateScheduleBody,
  milestoneEditBody,
  milestoneIdParams,
  progressBody,
  rejectStoppageBody,
  replanBody,
  stoppageBody,
  stoppageIdParams,
  stoppagesQuery,
  todayQuery,
  type ApproveStoppageInput,
  type GenerateInput,
  type MilestoneEditInput,
  type ProgressInput,
  type ReplanInput,
  type StoppageInput,
} from './schedule.schema.js';
import * as stoppages from './stoppages.service.js';

const id = (req: Request) => String(req.params['id']);
const VIEW = requirePerm('schedule.plan.view');
const MANAGE = requirePerm('schedule.plan.manage');

/** Mounted at /api/v1/projects (before the projects router). */
export const projectScheduleRouter = Router();
projectScheduleRouter.get('/:id/schedule', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await schedule.getSchedule(id(req)))));
projectScheduleRouter.post(
  '/:id/schedule/generate',
  ...company,
  MANAGE,
  validate({ params: idParams, body: generateScheduleBody }),
  h(async (req: Request, res: Response) => created(res, await schedule.generate(id(req), req.body as GenerateInput))),
);
projectScheduleRouter.post(
  '/:id/schedule/replan',
  ...company,
  MANAGE,
  validate({ params: idParams, body: replanBody }),
  h(async (req: Request, res: Response) => ok(res, await schedule.replan(id(req), req.body as ReplanInput))),
);
projectScheduleRouter.get('/:id/schedule/baseline', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await schedule.baseline(id(req)))));
projectScheduleRouter.get('/:id/schedule/versions', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await schedule.versions(id(req)))));
projectScheduleRouter.get('/:id/schedule/delays', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await insights.delays(id(req)))));
projectScheduleRouter.get('/:id/schedule/quotas', ...company, VIEW, validate({ params: idParams }), h(async (req: Request, res: Response) => ok(res, await insights.quotas(id(req)))));
projectScheduleRouter.get(
  '/:id/schedule/today',
  ...company,
  VIEW,
  validate({ params: idParams, query: todayQuery }),
  h(async (req: Request, res: Response) => ok(res, await insights.todayView(id(req), req.query as { date?: string }))),
);
projectScheduleRouter.get(
  '/:id/stoppages',
  ...company,
  VIEW,
  validate({ params: idParams, query: stoppagesQuery }),
  h(async (req: Request, res: Response) => ok(res, await stoppages.listStoppages(id(req), req.query as { status?: 'PENDING' | 'APPROVED' | 'REJECTED' }))),
);
projectScheduleRouter.post(
  '/:id/stoppages',
  ...company,
  requirePerm('schedule.stoppage.create'),
  validate({ params: idParams, body: stoppageBody }),
  h(async (req: Request, res: Response) => {
    const r = await stoppages.createStoppage(id(req), req.body as StoppageInput);
    return r.created ? created(res, r.stoppage) : ok(res, r.stoppage);
  }),
);

/** Mounted at /api/v1/milestones. The milestone's project must be in scope (else 404 MILESTONE_NOT_FOUND). */
export const milestonesRouter = Router();
milestonesRouter.get('/:id', ...company, VIEW, validate({ params: milestoneIdParams }), h(async (req: Request, res: Response) => ok(res, await schedule.getMilestone(id(req)))));
milestonesRouter.patch(
  '/:id',
  ...company,
  MANAGE,
  validate({ params: milestoneIdParams, body: milestoneEditBody }),
  h(async (req: Request, res: Response) => ok(res, await schedule.editMilestone(id(req), req.body as MilestoneEditInput))),
);
milestonesRouter.post(
  '/:id/progress',
  ...company,
  requirePerm('schedule.progress.edit'),
  validate({ params: milestoneIdParams, body: progressBody }),
  h(async (req: Request, res: Response) => ok(res, await progress.updateProgress(id(req), req.body as ProgressInput))),
);

/** Mounted at /api/v1/stoppages. */
export const stoppagesRouter = Router();
stoppagesRouter.get('/:id', ...company, VIEW, validate({ params: stoppageIdParams }), h(async (req: Request, res: Response) => ok(res, await stoppages.getStoppage(id(req)))));
stoppagesRouter.post(
  '/:id/approve',
  ...company,
  requirePerm('schedule.stoppage.approve'),
  validate({ params: stoppageIdParams, body: approveStoppageBody }),
  h(async (req: Request, res: Response) => ok(res, await stoppages.approveStoppage(id(req), req.body as ApproveStoppageInput))),
);
stoppagesRouter.post(
  '/:id/reject',
  ...company,
  requirePerm('schedule.stoppage.approve'),
  validate({ params: stoppageIdParams, body: rejectStoppageBody }),
  h(async (req: Request, res: Response) => ok(res, await stoppages.rejectStoppage(id(req), req.body as { note: string }))),
);
