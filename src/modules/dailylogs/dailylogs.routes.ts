import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './dailylogs.controller.js';
import { dailyLogBody, dailyLogsQuery, idParams, updateDailyLogBody } from './dailylogs.schema.js';

/**
 * THEKEDAR, PM, MUNSHI with access to the project (outside → 404). Writes need an ACTIVE /
 * CLOSEOUT project; only the author changes a log, and only the same day.
 */
export const projectDailyLogsRouter = Router();
projectDailyLogsRouter.post('/:id/daily-logs', ...company, validate({ params: idParams, body: dailyLogBody }), h(c.upsert));
projectDailyLogsRouter.get('/:id/daily-logs', ...company, validate({ params: idParams, query: dailyLogsQuery }), h(c.list));

/** Mounted at /api/v1/daily-logs */
export const dailyLogsRouter = Router();
dailyLogsRouter.get('/:id', ...company, validate({ params: idParams }), h(c.get));
dailyLogsRouter.patch('/:id', ...company, validate({ params: idParams, body: updateDailyLogBody }), h(c.update));
