import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import type { ReceivablesQuery } from '../billing/billing.schema.js';
import type { CashFlowQuery, PnlQuery } from './finance.schema.js';
import * as service from './finance.service.js';

const query = <T>(req: Request) => req.query as unknown as T;

export const receivables = async (req: Request, res: Response) => ok(res, await service.receivables(query<ReceivablesQuery>(req)));
export const cashFlow = async (req: Request, res: Response) => ok(res, await service.cashFlow(query<CashFlowQuery>(req)));
export const pnl = async (req: Request, res: Response) => ok(res, await service.pnl(query<PnlQuery>(req)));
export const cashFloats = async (_req: Request, res: Response) => ok(res, await service.cashFloats());
