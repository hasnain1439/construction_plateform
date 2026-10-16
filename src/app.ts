import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins, docsEnabled, env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './core/middleware/errorHandler.js';
import { generalRateLimit } from './core/middleware/rateLimit.js';
import { requestContext, requestLogFields, resolveRequestId } from './core/middleware/requestId.js';
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
import { dailyLogsRouter, projectDailyLogsRouter } from './modules/dailylogs/dailylogs.routes.js';
import { drawingRevisionsRouter, drawingsRouter, projectCloseoutRouter, snagsRouter } from './modules/closeout/closeout.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';
import { companyRouter } from './modules/company/company.routes.js';
import { floorsRouter, openingsRouter, projectsRouter, roomsRouter, supplyPresetsRouter } from './modules/projects/projects.routes.js';
import { estimatesRouter, projectEstimateRouter } from './modules/estimate/estimate.routes.js';
import { rulebookRouter } from './modules/rulebook/rulebook.routes.js';
import { equipmentRouter, projectEquipmentRouter } from './modules/equipment/equipment.routes.js'; // Step 16
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
  workerTypesRouter,
} from './modules/master-data/master-data.routes.js';
import { demoRouter, importsRouter, onboardingRouter, openingBalancesRouter } from './modules/onboarding/onboarding.routes.js';
import { permissionsRouter, rolesRouter, userPermissionsRouter } from './modules/permissions/permissions.routes.js';
import { platformAdminRouter } from './modules/platform-admin/platformAdmin.routes.js';
import { subscriptionRouter } from './modules/subscription/subscription.routes.js';
import { devicesRouter, teamInvitationsRouter, usersRouter } from './modules/team/team.routes.js';
import { safeUrl } from './core/utils/safeUrl.js';
import type { RouteMount } from './core/http/routeList.js';

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
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/health/ready' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'info' : 'info'),
      // The request line carries the caller's tenantId / userId (set after authentication).
      customSuccessObject: (_req, res, val: object) => ({ ...val, ...requestLogFields(res) }),
      customErrorObject: (_req, res, _err, val: object) => ({ ...val, ...requestLogFields(res) }),
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
  // Every router mounted under /api/v1 is recorded so tools and tests can list the routes (listRoutes).
  const mounts: RouteMount[] = [];
  app.locals['routeMounts'] = mounts;
  const mount = (path: string, router: Router) => {
    mounts.push({ path: `/api/v1${path === '/' ? '' : path}`, router });
    api.use(path, router);
  };
  mount('/auth', authRouter);
  mount('/invitations', invitationRouter); // public: POST /:token/accept
  mount('/invitations', teamInvitationsRouter); // THEKEDAR: list / create / resend / cancel
  mount('/admin/auth', adminAuthRouter);
  mount('/attachments', attachmentsRouter);
  mount('/company', companyRouter);
  mount('/users', userPermissionsRouter); // /users/:id/permissions, /permission-overrides, /role (per-route auth)
  mount('/users', usersRouter);
  mount('/permissions', permissionsRouter);
  mount('/roles', rolesRouter);
  mount('/devices', devicesRouter);
  mount('/subscription', subscriptionRouter);
  mount('/material-groups', materialGroupsRouter);
  mount('/materials', materialsRouter);
  mount('/quality-categories', qualityCategoriesRouter);
  mount('/price-list', priceListRouter);
  mount('/labor-rates', laborRatesRouter);
  mount('/worker-types', workerTypesRouter);
  mount('/payment-templates', paymentTemplatesRouter);
  mount('/suppliers', supplierLedgerRouter); // /suppliers/:id/ledger (per-route auth)
  mount('/suppliers', suppliersRouter);
  mount('/supplier-payments', supplierPaymentsRouter);
  mount('/purchase-orders', purchaseOrdersRouter);
  mount('/purchases', purchasesRouter);
  mount('/purchase-returns', purchaseReturnsRouter);
  mount('/', workforceLaborRouter); // /workers/:id/labor-summary, /subcontractors/:id/labor-summary (per-route auth)
  mount('/workers', workersRouter);
  mount('/subcontractors', subcontractorsRouter);
  mount('/clients', clientsRouter);
  mount('/stock-locations', stockLocationsRouter);
  mount('/stores', storesRouter);
  mount('/stock', stockRouter);
  mount('/stock-counts', stockCountsRouter);
  mount('/equipment', equipmentRouter); // Step 16
  mount('/dispatches', dispatchesRouter);
  mount('/shortages', shortagesRouter);
  mount('/projects', projectStockRouter); // /projects/:id/stock, /material-usage (per-route auth)
  mount('/projects', projectDispatchRouter); // /projects/:id/incoming, /owner-deliveries (per-route auth)
  mount('/projects', projectLaborRouter); // /projects/:id/labor/*, /attendance, /advances, /settlements, ... (per-route auth)
  mount('/projects', projectCashbookRouter); // /projects/:id/cashbook (per-route auth)
  mount('/projects', projectBillingRouter);
  mount('/projects', projectDailyLogsRouter); // /projects/:id/daily-logs (per-route auth) // /projects/:id/billing-stages, /invoices, /payments, /receivables, ... (per-route auth)
  mount('/projects', projectEstimateRouter); // /projects/:id/estimate, /estimate/settings (per-route auth)
  mount('/projects', projectEquipmentRouter); // Step 16: /projects/:id/equipment (per-route auth)
  mount('/projects', projectCloseoutRouter); // Step 17: /projects/:id/drawings, /snags, /handover, /retention (per-route auth)
  mount('/projects', projectsRouter);
  mount('/billing-stages', billingStagesRouter);
  mount('/billing-progress', billingProgressRouter);
  mount('/invoices', invoicesRouter);
  mount('/payments', clientPaymentsRouter);
  mount('/receivables', receivablesRouter);
  mount('/billing-events', billingEventsRouter);
  mount('/notifications', notificationsRouter);
  mount('/approvals', approvalsRouter);
  mount('/dashboard', dashboardRouter);
  mount('/finance', financeRouter);
  mount('/reports', reportsRouter);
  mount('/daily-logs', dailyLogsRouter);
  mount('/drawings', drawingsRouter);
  mount('/drawing-revisions', drawingRevisionsRouter);
  mount('/snags', snagsRouter);
  mount('/sync', syncRouter);
  mount('/project-workers', projectWorkersRouter);
  mount('/subcontract-assignments', subcontractAssignmentsRouter);
  mount('/work-measurements', workMeasurementsRouter);
  mount('/settlements', settlementsRouter);
  mount('/labor', laborOverviewRouter);
  mount('/cash-accounts', cashAccountsRouter);
  mount('/cash-floats', cashFloatsRouter);
  mount('/cash-expenses', cashExpensesRouter);
  mount('/topup-requests', topupsRouter);
  mount('/cash-counts', cashCountsRouter);
  mount('/cash-handovers', cashHandoversRouter);
  mount('/supply-presets', supplyPresetsRouter);
  mount('/floors', floorsRouter);
  mount('/rooms', roomsRouter);
  mount('/estimates', estimatesRouter); // Step 11: saved estimate revisions (per-route auth)
  mount('/rulebook', rulebookRouter); // Step 11: company estimation rulebook (per-route auth)
  mount('/openings', openingsRouter);
  mount('/onboarding', onboardingRouter);
  mount('/imports', importsRouter);
  mount('/opening-balances', openingBalancesRouter);
  mount('/demo', demoRouter);
  mount('/admin', platformAdminRouter); // after /admin/auth (public login)
  options.extraRoutes?.(api);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
