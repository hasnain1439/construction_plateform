import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { HandoverItemKey } from '../../generated/prisma/client.js';
import type * as S from './closeout.schema.js';
import * as drawings from './drawings.service.js';
import * as handover from './handover.service.js';
import * as retention from './retention.service.js';
import * as snags from './snags.service.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;

// Drawings
export const listDrawings = async (req: Request, res: Response) => ok(res, await drawings.list(id(req), query<S.DrawingsQuery>(req)));
export const createDrawing = async (req: Request, res: Response) => created(res, await drawings.create(id(req), req.body as S.CreateDrawingInput));
export const getDrawing = async (req: Request, res: Response) => ok(res, await drawings.get(id(req)));
export const updateDrawing = async (req: Request, res: Response) => ok(res, await drawings.update(id(req), req.body as S.UpdateDrawingInput));
export const deleteDrawing = async (req: Request, res: Response) => ok(res, await drawings.remove(id(req)));
export const addRevision = async (req: Request, res: Response) => created(res, await drawings.addRevision(id(req), req.body as S.AddRevisionInput));
export const updateRevision = async (req: Request, res: Response) => ok(res, await drawings.updateRevision(id(req), req.body as S.UpdateRevisionInput));

// Snags
export const listSnags = async (req: Request, res: Response) => {
  const r = await snags.list(id(req), query<S.SnagsQuery>(req));
  return ok(res, r.data, r.meta);
};
export const createSnag = async (req: Request, res: Response) => {
  const r = await snags.create(id(req), req.body as S.CreateSnagInput);
  return r.created ? created(res, r.data) : ok(res, r.data);
};
export const getSnag = async (req: Request, res: Response) => ok(res, await snags.get(id(req)));
export const updateSnag = async (req: Request, res: Response) => ok(res, await snags.update(id(req), req.body as S.UpdateSnagInput));
export const deleteSnag = async (req: Request, res: Response) => ok(res, await snags.remove(id(req)));
export const fixSnag = async (req: Request, res: Response) => ok(res, await snags.fix(id(req), req.body as S.FixSnagInput));
export const verifySnag = async (req: Request, res: Response) => ok(res, await snags.verify(id(req), req.body as S.VerifySnagInput));
export const reopenSnag = async (req: Request, res: Response) => ok(res, await snags.reopen(id(req), req.body as S.ReopenSnagInput));
export const snagCost = async (req: Request, res: Response) => ok(res, await snags.setCost(id(req), req.body as S.SnagCostInput));

// Handover
export const getHandover = async (req: Request, res: Response) => ok(res, await handover.get(id(req)));
export const setHandoverItem = async (req: Request, res: Response) => ok(res, await handover.setItem(id(req), String(req.params['key']) as HandoverItemKey, req.body as S.HandoverItemInput));
export const signOff = async (req: Request, res: Response) => ok(res, await handover.signOff(id(req), req.body as S.SignOffInput));
export const completeHandover = async (req: Request, res: Response) => ok(res, await handover.complete(id(req), req.body as S.CompleteHandoverInput));
export const certificate = async (req: Request, res: Response) => ok(res, await handover.certificate(id(req), query<S.CertificateQuery>(req)));

// Retention
export const getRetention = async (req: Request, res: Response) => ok(res, await retention.get(id(req)));
export const updateRetention = async (req: Request, res: Response) => ok(res, await retention.updateSettings(id(req), req.body as S.RetentionSettingsInput));
