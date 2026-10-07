import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { DailyLogInput, DailyLogsQuery, UpdateDailyLogInput } from './dailylogs.schema.js';
import * as service from './dailylogs.service.js';

const param = (req: Request, name: string) => String(req.params[name]);

export const upsert = async (req: Request, res: Response) => {
  const r = await service.upsert(param(req, 'id'), req.body as DailyLogInput);
  return r.created ? created(res, r.data) : ok(res, r.data);
};
export const list = async (req: Request, res: Response) => {
  const r = await service.list(param(req, 'id'), req.query as unknown as DailyLogsQuery);
  return ok(res, r.data, r.meta);
};
export const get = async (req: Request, res: Response) => ok(res, await service.get(param(req, 'id')));
export const update = async (req: Request, res: Response) => ok(res, await service.update(param(req, 'id'), req.body as UpdateDailyLogInput));
