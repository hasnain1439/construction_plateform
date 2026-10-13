import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './cashbook.controller.js';
import {
  accountsQuery,
  approveTopupBody,
  cashbookQuery,
  countBody,
  countsQuery,
  decisionBody,
  entriesQuery,
  entryParams,
  expenseBody,
  expensesQuery,
  floatBody,
  handoverBody,
  idParams,
  rejectBody,
  topupBody,
  topupsQuery,
} from './cashbook.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler. Which accounts
 * a caller sees (THEKEDAR all, PM own + their munshis', MUNSHI own) is in the service.
 */

/** Mounted at /api/v1/cash-accounts */
export const cashAccountsRouter = Router();
cashAccountsRouter.use(...company);
cashAccountsRouter.get('/', requirePerm('cashbook.account.view'), validate({ query: accountsQuery }), h(c.listAccounts));
cashAccountsRouter.get('/:id', requirePerm('cashbook.account.view'), validate({ params: idParams }), h(c.getAccount));
cashAccountsRouter.get('/:id/entries', requirePerm('cashbook.account.view'), validate({ params: idParams, query: entriesQuery }), h(c.listEntries));

/** Mounted at /api/v1/cash-floats */
export const cashFloatsRouter = Router();
cashFloatsRouter.use(...company);
cashFloatsRouter.post('/', requirePerm('cashbook.float.manage'), validate({ body: floatBody }), h(c.sendFloat));
cashFloatsRouter.post('/:entryId/acknowledge', requirePerm('cashbook.account.view'), validate({ params: entryParams }), h(c.acknowledge));

/** Mounted at /api/v1/cash-expenses */
export const cashExpensesRouter = Router();
cashExpensesRouter.use(...company);
cashExpensesRouter.get('/', requirePerm('cashbook.expense.view'), validate({ query: expensesQuery }), h(c.listExpenses));
cashExpensesRouter.post('/', requirePerm('cashbook.expense.create'), validate({ body: expenseBody }), h(c.createExpense));
cashExpensesRouter.post('/:id/approve', requirePerm('cashbook.expense.approve'), validate({ params: idParams, body: decisionBody }), h(c.approveExpense));
cashExpensesRouter.post('/:id/reject', requirePerm('cashbook.expense.approve'), validate({ params: idParams, body: rejectBody }), h(c.rejectExpense));

/** Mounted at /api/v1/topup-requests */
export const topupsRouter = Router();
topupsRouter.use(...company);
topupsRouter.get('/', requirePerm('cashbook.topup.view'), validate({ query: topupsQuery }), h(c.listTopups));
topupsRouter.post('/', requirePerm('cashbook.topup.create'), validate({ body: topupBody }), h(c.requestTopup));
topupsRouter.post('/:id/approve', requirePerm('cashbook.topup.approve'), validate({ params: idParams, body: approveTopupBody }), h(c.approveTopup));
topupsRouter.post('/:id/reject', requirePerm('cashbook.topup.approve'), validate({ params: idParams, body: rejectBody }), h(c.rejectTopup));

/** Mounted at /api/v1/cash-counts */
export const cashCountsRouter = Router();
cashCountsRouter.use(...company);
cashCountsRouter.get('/', requirePerm('cashbook.account.view'), validate({ query: countsQuery }), h(c.listCounts));
cashCountsRouter.post('/', requirePerm('cashbook.count.create'), validate({ body: countBody }), h(c.createCount));

/** Mounted at /api/v1/cash-handovers */
export const cashHandoversRouter = Router();
cashHandoversRouter.use(...company);
cashHandoversRouter.post('/', requirePerm('cashbook.handover.create'), validate({ body: handoverBody }), h(c.handover));

/** /api/v1/projects/:id/cashbook — mounted before the projects router (middleware per route). */
export const projectCashbookRouter = Router();
projectCashbookRouter.get('/:id/cashbook', ...company, requirePerm('cashbook.account.view'), validate({ params: idParams, query: cashbookQuery }), h(c.projectCashbook));
