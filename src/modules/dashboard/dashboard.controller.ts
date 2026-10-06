import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import type { OverviewQuery } from './dashboard.schema.js';
import * as service from './dashboard.service.js';

export const overview = async (req: Request, res: Response) => ok(res, await service.overview(req.query as unknown as OverviewQuery));
export const siteDashboard = async (req: Request, res: Response) => ok(res, await service.siteDashboard(String(req.params['projectId'])));
