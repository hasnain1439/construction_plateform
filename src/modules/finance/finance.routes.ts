import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { receivablesQuery } from '../billing/billing.schema.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './finance.controller.js';
import { cashFlowQuery, pnlQuery } from './finance.schema.js';

/**
 * Mounted at /api/v1/finance. Receivables and the cash-flow outlook: THEKEDAR. P&L: THEKEDAR,
 * or a PM with profit.view (own projects). Cash floats: THEKEDAR, PM (their munshis).
 */
export const financeRouter = Router();
financeRouter.get('/receivables', ...company, requirePerm('finance.receivables.view'), validate({ query: receivablesQuery }), h(c.receivables));
financeRouter.get('/cash-flow', ...company, requirePerm('finance.cashflow.view'), validate({ query: cashFlowQuery }), h(c.cashFlow));
financeRouter.get('/pnl', ...company, requirePerm('finance.pnl.view'), validate({ query: pnlQuery }), h(c.pnl));
financeRouter.get('/cash-floats', ...company, requirePerm('cashbook.float.view'), h(c.cashFloats));
