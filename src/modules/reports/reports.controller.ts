import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import type { ReportName, ReportQuery } from './reports.schema.js';
import * as service from './reports.service.js';

export const runReport = (name: ReportName) => async (req: Request, res: Response) => ok(res, await service.runReport(name, req.query as unknown as ReportQuery));
