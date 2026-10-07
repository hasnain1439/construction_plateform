import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import { pull as pullChanges } from './sync.pull.js';
import { push as pushMutations, status as syncStatus } from './sync.push.js';
import type { PullQuery, PushInput } from './sync.schema.js';

export const pull = async (req: Request, res: Response) => ok(res, await pullChanges(req.query as unknown as PullQuery));

export const push = async (req: Request, res: Response) => ok(res, await pushMutations(req.body as PushInput, req.get('x-pending-mutations')));
export const status = async (_req: Request, res: Response) => ok(res, await syncStatus());
