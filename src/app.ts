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
import { companyRouter } from './modules/company/company.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
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
  api.use('/auth', authRouter);
  api.use('/invitations', invitationRouter); // public: POST /:token/accept
  api.use('/invitations', teamInvitationsRouter); // THEKEDAR: list / create / resend / cancel
  api.use('/admin/auth', adminAuthRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/company', companyRouter);
  api.use('/users', usersRouter);
  api.use('/devices', devicesRouter);
  api.use('/subscription', subscriptionRouter);
  api.use('/admin', platformAdminRouter); // after /admin/auth (public login)
  options.extraRoutes?.(api);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
