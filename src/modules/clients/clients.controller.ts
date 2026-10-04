import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from './clients.schema.js';
import * as clients from './clients.service.js';

const id = (req: Request) => String(req.params['id']);

export async function listClients(req: Request, res: Response) {
  const { data, meta } = await clients.listClients(req.query as unknown as ListClientsQuery);
  return ok(res, data, meta);
}
export const getClient = async (req: Request, res: Response) => ok(res, await clients.getClient(id(req)));
export const createClient = async (req: Request, res: Response) => created(res, await clients.createClient(req.body as CreateClientInput));
export const updateClient = async (req: Request, res: Response) => ok(res, await clients.updateClient(id(req), req.body as UpdateClientInput));
