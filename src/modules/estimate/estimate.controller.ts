import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import * as estimate from './estimate.service.js';
import type { FromEstimateInput } from './estimate.service.js';
import type { EstimateSettingsInput } from './settings.js';

const id = (req: Request) => String(req.params['id']);

export const getEstimate = async (req: Request, res: Response) => ok(res, await estimate.getEstimate(id(req)));
export const updateSettings = async (req: Request, res: Response) => ok(res, await estimate.updateSettings(id(req), req.body as EstimateSettingsInput));
export const contractFromEstimate = async (req: Request, res: Response) => ok(res, await estimate.contractFromEstimate(id(req), req.body as FromEstimateInput));
