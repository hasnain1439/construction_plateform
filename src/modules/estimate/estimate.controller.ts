import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { Lang } from '../../core/i18n/lang.js';
import * as estimate from './estimate.service.js';
import type { FromEstimateInput } from './estimate.service.js';
import type { LineOverrideBody, ShoppingListQuery } from './estimate.schema.js';
import * as revisions from './revisions.service.js';
import type { EstimateSettingsInput } from './settings.js';

const param = (req: Request, name: string) => String(req.params[name]);
const id = (req: Request) => param(req, 'id');
const query = <T>(req: Request) => req.query as unknown as T;

export const getEstimate = async (req: Request, res: Response) => ok(res, await estimate.getEstimate(id(req)));
export const updateSettings = async (req: Request, res: Response) => ok(res, await estimate.updateSettings(id(req), req.body as EstimateSettingsInput));
export const contractFromEstimate = async (req: Request, res: Response) => ok(res, await estimate.contractFromEstimate(id(req), req.body as FromEstimateInput));

// Saved estimates (revisions)
export const generate = async (req: Request, res: Response) => created(res, await revisions.generate(id(req), req.body as { note?: string | null }));
export const listRevisions = async (req: Request, res: Response) => ok(res, await revisions.listForProject(id(req)));
export const getRevision = async (req: Request, res: Response) => ok(res, await revisions.getOne(id(req)));
export const regenerate = async (req: Request, res: Response) => ok(res, await revisions.regenerate(id(req)));
export const overrideLine = async (req: Request, res: Response) => ok(res, await revisions.overrideLine(id(req), param(req, 'lineId'), req.body as LineOverrideBody));
export const approve = async (req: Request, res: Response) => ok(res, await revisions.approve(id(req), req.body as { confirmOutdatedRates?: boolean }));
export const compare = async (req: Request, res: Response) => ok(res, await revisions.compare(param(req, 'a'), param(req, 'b')));
export const revisionPdf = async (req: Request, res: Response) => ok(res, await revisions.estimatePdf(id(req), query<{ lang?: Lang }>(req).lang));
export const ownerShoppingList = async (req: Request, res: Response) => ok(res, await revisions.ownerShoppingList(id(req), query<ShoppingListQuery>(req).estimateId));
export const ownerShoppingListPdf = async (req: Request, res: Response) => ok(res, await revisions.ownerShoppingListPdf(id(req), query<ShoppingListQuery>(req)));
