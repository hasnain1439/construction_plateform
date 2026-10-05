import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type {
  CreateDispatchInput,
  ListDispatchesQuery,
  ListShortagesQuery,
  OwnerDeliveriesQuery,
  OwnerDeliveryInput,
  ReceiveDispatchInput,
  ResolveShortageInput,
} from './dispatch.schema.js';
import * as dispatches from './dispatches.service.js';
import * as owner from './ownerDeliveries.service.js';
import * as shortages from './shortages.service.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;

export async function listDispatches(req: Request, res: Response) {
  const { data, meta } = await dispatches.listDispatches(query<ListDispatchesQuery>(req));
  return ok(res, data, meta);
}
export const getDispatch = async (req: Request, res: Response) => ok(res, await dispatches.getDispatch(id(req)));
export const createDispatch = async (req: Request, res: Response) => created(res, await dispatches.createDispatch(req.body as CreateDispatchInput));
export const cancelDispatch = async (req: Request, res: Response) => ok(res, await dispatches.cancelDispatch(id(req)));
export const receiveDispatch = async (req: Request, res: Response) => ok(res, await dispatches.receiveDispatch(id(req), req.body as ReceiveDispatchInput));
export const incoming = async (req: Request, res: Response) => ok(res, await dispatches.incoming(id(req)));

export async function listShortages(req: Request, res: Response) {
  const { data, meta } = await shortages.listShortages(query<ListShortagesQuery>(req));
  return ok(res, data, meta);
}
export const resolveShortage = async (req: Request, res: Response) => ok(res, await shortages.resolveShortage(id(req), req.body as ResolveShortageInput));

export const createOwnerDelivery = async (req: Request, res: Response) => created(res, await owner.createOwnerDelivery(id(req), req.body as OwnerDeliveryInput));
export async function listOwnerDeliveries(req: Request, res: Response) {
  const { data, meta } = await owner.listOwnerDeliveries(id(req), query<OwnerDeliveriesQuery>(req));
  return ok(res, data, meta);
}
