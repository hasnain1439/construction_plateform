import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import type { BulkInput } from './approvals.schema.js';
import * as service from './approvals.service.js';

export const listApprovals = async (_req: Request, res: Response) => ok(res, await service.listApprovals());
export const bulk = async (req: Request, res: Response) => ok(res, await service.bulk(req.body as BulkInput));
