import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as counts from './counts.service.js';
import type {
  LowStockLevelsInput,
  MovementsQuery,
  StockCountInput,
  StockCountsQuery,
  StoreStockQuery,
  UsageInput,
  UsageListQuery,
} from './inventory.schema.js';
import * as inventory from './inventory.service.js';
import * as usage from './usage.service.js';

const param = (req: Request, name: string) => String(req.params[name]);
const query = <T>(req: Request) => req.query as unknown as T;

export const listLocations = async (_req: Request, res: Response) => ok(res, await inventory.listLocations());
export const storeStock = async (req: Request, res: Response) => ok(res, await inventory.storeStock(param(req, 'locationId'), query<StoreStockQuery>(req)));
export const setLowStockLevels = async (req: Request, res: Response) =>
  ok(res, await inventory.setLowStockLevels(param(req, 'locationId'), req.body as LowStockLevelsInput));

export async function listMovements(req: Request, res: Response) {
  const { data, meta } = await inventory.listMovements(query<MovementsQuery>(req));
  return ok(res, data, meta);
}

export const projectStock = async (req: Request, res: Response) => ok(res, await inventory.projectStock(param(req, 'id')));

export const recordUsage = async (req: Request, res: Response) => created(res, await usage.recordUsage(param(req, 'id'), req.body as UsageInput));
export async function listUsage(req: Request, res: Response) {
  const { data, meta } = await usage.listUsage(param(req, 'id'), query<UsageListQuery>(req));
  return ok(res, data, meta);
}

export const createCount = async (req: Request, res: Response) => created(res, await counts.createCount(req.body as StockCountInput));
export async function listCounts(req: Request, res: Response) {
  const { data, meta } = await counts.listCounts(query<StockCountsQuery>(req));
  return ok(res, data, meta);
}
