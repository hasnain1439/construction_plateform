import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { Created } from '../labor/labor.shared.js';
import type {
  ApproveTopupInput,
  CashbookQuery,
  CountInput,
  CountsQuery,
  EntriesQuery,
  ExpenseInput,
  ExpensesQuery,
  FloatInput,
  HandoverInput,
  TopupInput,
  TopupsQuery,
} from './cashbook.schema.js';
import * as cash from './cashbook.service.js';

const param = (req: Request, name: string) => String(req.params[name]);
const query = <T>(req: Request) => req.query as unknown as T;
const replayable = <T>(res: Response, r: Created<T>) => (r.created ? created(res, r.data) : ok(res, r.data));
const paged = (res: Response, r: { data: unknown; meta: Record<string, unknown> }) => ok(res, r.data, r.meta);

export const listAccounts = async (req: Request, res: Response) => ok(res, await cash.listAccounts(query<{ includeInactive?: boolean }>(req)));
export const getAccount = async (req: Request, res: Response) => ok(res, await cash.getAccount(param(req, 'id')));
export const listEntries = async (req: Request, res: Response) => paged(res, await cash.listEntries(param(req, 'id'), query<EntriesQuery>(req)));

export const sendFloat = async (req: Request, res: Response) => created(res, await cash.sendFloat(req.body as FloatInput));
export const acknowledge = async (req: Request, res: Response) => ok(res, await cash.acknowledge(param(req, 'entryId')));

export const createExpense = async (req: Request, res: Response) => replayable(res, await cash.createExpense(req.body as ExpenseInput));
export const listExpenses = async (req: Request, res: Response) => paged(res, await cash.listExpenses(query<ExpensesQuery>(req)));
export const approveExpense = async (req: Request, res: Response) => ok(res, await cash.approveExpense(param(req, 'id'), (req.body as { note?: string } | undefined)?.note));
export const rejectExpense = async (req: Request, res: Response) => ok(res, await cash.rejectExpense(param(req, 'id'), (req.body as { note: string }).note));

export const requestTopup = async (req: Request, res: Response) => replayable(res, await cash.requestTopup(req.body as TopupInput));
export const listTopups = async (req: Request, res: Response) => paged(res, await cash.listTopups(query<TopupsQuery>(req)));
export const approveTopup = async (req: Request, res: Response) => ok(res, await cash.approveTopup(param(req, 'id'), req.body as ApproveTopupInput));
export const rejectTopup = async (req: Request, res: Response) => ok(res, await cash.rejectTopup(param(req, 'id'), (req.body as { note: string }).note));

export const createCount = async (req: Request, res: Response) => created(res, await cash.createCount(req.body as CountInput));
export const listCounts = async (req: Request, res: Response) => paged(res, await cash.listCounts(query<CountsQuery>(req)));
export const handover = async (req: Request, res: Response) => created(res, await cash.handover(req.body as HandoverInput));

export async function projectCashbook(req: Request, res: Response) {
  const { meta, ...data } = await cash.projectCashbook(param(req, 'id'), query<CashbookQuery>(req));
  return ok(res, data, meta);
}
