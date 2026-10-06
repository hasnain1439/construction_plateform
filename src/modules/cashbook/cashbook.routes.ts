import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
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
 * authenticate → tenantContext → readOnlyGuard → role → validate → handler. Which accounts
 * a caller sees (THEKEDAR all, PM own + their munshis', MUNSHI own) is in the service.
 */
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');

/** Mounted at /api/v1/cash-accounts */
export const cashAccountsRouter = Router();
cashAccountsRouter.use(...company);
cashAccountsRouter.get('/', validate({ query: accountsQuery }), h(c.listAccounts));
cashAccountsRouter.get('/:id', validate({ params: idParams }), h(c.getAccount));
cashAccountsRouter.get('/:id/entries', validate({ params: idParams, query: entriesQuery }), h(c.listEntries));

/** Mounted at /api/v1/cash-floats */
export const cashFloatsRouter = Router();
cashFloatsRouter.use(...company);
cashFloatsRouter.post('/', owner, validate({ body: floatBody }), h(c.sendFloat));
cashFloatsRouter.post('/:entryId/acknowledge', validate({ params: entryParams }), h(c.acknowledge));

/** Mounted at /api/v1/cash-expenses */
export const cashExpensesRouter = Router();
cashExpensesRouter.use(...company);
cashExpensesRouter.get('/', validate({ query: expensesQuery }), h(c.listExpenses));
cashExpensesRouter.post('/', validate({ body: expenseBody }), h(c.createExpense));
cashExpensesRouter.post('/:id/approve', office, validate({ params: idParams, body: decisionBody }), h(c.approveExpense));
cashExpensesRouter.post('/:id/reject', office, validate({ params: idParams, body: rejectBody }), h(c.rejectExpense));

/** Mounted at /api/v1/topup-requests */
export const topupsRouter = Router();
topupsRouter.use(...company);
topupsRouter.get('/', validate({ query: topupsQuery }), h(c.listTopups));
topupsRouter.post('/', validate({ body: topupBody }), h(c.requestTopup));
topupsRouter.post('/:id/approve', owner, validate({ params: idParams, body: approveTopupBody }), h(c.approveTopup));
topupsRouter.post('/:id/reject', owner, validate({ params: idParams, body: rejectBody }), h(c.rejectTopup));

/** Mounted at /api/v1/cash-counts */
export const cashCountsRouter = Router();
cashCountsRouter.use(...company);
cashCountsRouter.get('/', validate({ query: countsQuery }), h(c.listCounts));
cashCountsRouter.post('/', validate({ body: countBody }), h(c.createCount));

/** Mounted at /api/v1/cash-handovers */
export const cashHandoversRouter = Router();
cashHandoversRouter.use(...company);
cashHandoversRouter.post('/', validate({ body: handoverBody }), h(c.handover));

/** /api/v1/projects/:id/cashbook — mounted before the projects router (middleware per route). */
export const projectCashbookRouter = Router();
projectCashbookRouter.get('/:id/cashbook', ...company, validate({ params: idParams, query: cashbookQuery }), h(c.projectCashbook));
