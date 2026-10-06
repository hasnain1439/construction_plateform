import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins, docsEnabled, env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './core/middleware/errorHandler.js';
import { generalRateLimit } from './core/middleware/rateLimit.js';
import { requestContext, resolveRequestId } from './core/middleware/requestId.js';
import { docsRouter } from './core/openapi/docs.js';
import { jsonReplacer } from './core/utils/json.js';
import { attachmentsRouter } from './modules/attachments/attachments.routes.js';
import { adminAuthRouter, authRouter, invitationRouter } from './modules/auth/auth.routes.js';
import {
  cashAccountsRouter,
  cashCountsRouter,
  cashExpensesRouter,
  cashFloatsRouter,
  cashHandoversRouter,
  projectCashbookRouter,
  topupsRouter,
} from './modules/cashbook/cashbook.routes.js';
import {
  billingEventsRouter,
  billingProgressRouter,
  billingStagesRouter,
  clientPaymentsRouter,
  invoicesRouter,
  projectBillingRouter,
  receivablesRouter,
} from './modules/billing/billing.routes.js';
import { clientsRouter } from './modules/clients/clients.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { approvalsRouter } from './modules/approvals/approvals.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { invalidateOnWrite } from './modules/dashboard/dashboard.cache.js';
import { financeRouter } from './modules/finance/finance.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { companyRouter } from './modules/company/company.routes.js';
import { floorsRouter, openingsRouter, projectsRouter, roomsRouter, supplyPresetsRouter } from './modules/projects/projects.routes.js';
import { dispatchesRouter, projectDispatchRouter, shortagesRouter } from './modules/dispatch/dispatch.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import {
  projectLaborRouter,
  laborOverviewRouter,
  projectWorkersRouter,
  settlementsRouter,
  subcontractAssignmentsRouter,
  workforceLaborRouter,
  workMeasurementsRouter,
} from './modules/labor/labor.routes.js';
import { projectStockRouter, stockCountsRouter, stockLocationsRouter, stockRouter, storesRouter } from './modules/inventory/inventory.routes.js';
import {
  purchaseOrdersRouter,
  purchaseReturnsRouter,
  purchasesRouter,
  supplierLedgerRouter,
  supplierPaymentsRouter,
} from './modules/procurement/procurement.routes.js';
import {
  laborRatesRouter,
  materialGroupsRouter,
  materialsRouter,
  paymentTemplatesRouter,
  priceListRouter,
  qualityCategoriesRouter,
  subcontractorsRouter,
  suppliersRouter,
  workersRouter,
} from './modules/master-data/master-data.routes.js';
import { platformAdminRouter } from './modules/platform-admin/platformAdmin.routes.js';
import { subscriptionRouter } from './modules/subscription/subscription.routes.js';
import { devicesRouter, teamInvitationsRouter, usersRouter } from './modules/team/team.routes.js';
import { safeUrl } from './core/utils/safeUrl.js';

export interface CreateAppOptions {
  /** Extra routers mounted under /api/v1 before the 404 handler (used by tests). */
  extraRoutes?: (api: Router) => void;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('json replacer', jsonReplacer);

  app.use(
    pinoHttp({
      logger,
      genReqId: resolveRequestId,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'info' : 'info'),
      // Log only what we need — never bodies, cookies or auth headers.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: safeUrl(req.url) }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext);

  app.use(healthRouter);
  if (docsEnabled) app.use('/api', docsRouter());

  const api = express.Router();
  api.use(generalRateLimit);
  api.use(invalidateOnWrite); // clears cached dashboard / finance numbers after any write
  api.use('/auth', authRouter);
  api.use('/invitations', invitationRouter); // public: POST /:token/accept
  api.use('/invitations', teamInvitationsRouter); // THEKEDAR: list / create / resend / cancel
  api.use('/admin/auth', adminAuthRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/company', companyRouter);
  api.use('/users', usersRouter);
  api.use('/devices', devicesRouter);
  api.use('/subscription', subscriptionRouter);
  api.use('/material-groups', materialGroupsRouter);
  api.use('/materials', materialsRouter);
  api.use('/quality-categories', qualityCategoriesRouter);
  api.use('/price-list', priceListRouter);
  api.use('/labor-rates', laborRatesRouter);
  api.use('/payment-templates', paymentTemplatesRouter);
  api.use('/suppliers', supplierLedgerRouter); // /suppliers/:id/ledger (per-route auth)
  api.use('/suppliers', suppliersRouter);
  api.use('/supplier-payments', supplierPaymentsRouter);
  api.use('/purchase-orders', purchaseOrdersRouter);
  api.use('/purchases', purchasesRouter);
  api.use('/purchase-returns', purchaseReturnsRouter);
  api.use('/', workforceLaborRouter); // /workers/:id/labor-summary, /subcontractors/:id/labor-summary (per-route auth)
  api.use('/workers', workersRouter);
  api.use('/subcontractors', subcontractorsRouter);
  api.use('/clients', clientsRouter);
  api.use('/stock-locations', stockLocationsRouter);
  api.use('/stores', storesRouter);
  api.use('/stock', stockRouter);
  api.use('/stock-counts', stockCountsRouter);
  api.use('/dispatches', dispatchesRouter);
  api.use('/shortages', shortagesRouter);
  api.use('/projects', projectStockRouter); // /projects/:id/stock, /material-usage (per-route auth)
  api.use('/projects', projectDispatchRouter); // /projects/:id/incoming, /owner-deliveries (per-route auth)
  api.use('/projects', projectLaborRouter); // /projects/:id/labor/*, /attendance, /advances, /settlements, ... (per-route auth)
  api.use('/projects', projectCashbookRouter); // /projects/:id/cashbook (per-route auth)
  api.use('/projects', projectBillingRouter); // /projects/:id/billing-stages, /invoices, /payments, /receivables, ... (per-route auth)
  api.use('/projects', projectsRouter);
  api.use('/billing-stages', billingStagesRouter);
  api.use('/billing-progress', billingProgressRouter);
  api.use('/invoices', invoicesRouter);
  api.use('/payments', clientPaymentsRouter);
  api.use('/receivables', receivablesRouter);
  api.use('/billing-events', billingEventsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/approvals', approvalsRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/finance', financeRouter);
  api.use('/reports', reportsRouter);
  api.use('/project-workers', projectWorkersRouter);
  api.use('/subcontract-assignments', subcontractAssignmentsRouter);
  api.use('/work-measurements', workMeasurementsRouter);
  api.use('/settlements', settlementsRouter);
  api.use('/labor', laborOverviewRouter);
  api.use('/cash-accounts', cashAccountsRouter);
  api.use('/cash-floats', cashFloatsRouter);
  api.use('/cash-expenses', cashExpensesRouter);
  api.use('/topup-requests', topupsRouter);
  api.use('/cash-counts', cashCountsRouter);
  api.use('/cash-handovers', cashHandoversRouter);
  api.use('/supply-presets', supplyPresetsRouter);
  api.use('/floors', floorsRouter);
  api.use('/rooms', roomsRouter);
  api.use('/openings', openingsRouter);
  api.use('/admin', platformAdminRouter); // after /admin/auth (public login)
  options.extraRoutes?.(api);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
