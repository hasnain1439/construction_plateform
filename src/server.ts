import './instrument.js'; // first: Sentry must load before Express (no-op without SENTRY_DSN)
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { disconnectDatabases } from './core/db/prisma.js';
import { shutdownAnalytics } from './core/observability/analytics.js';
import { flushSentry } from './core/observability/sentry.js';
import { startScheduledJobs, stopScheduledJobs } from './jobs/scheduler.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on http://localhost:${env.PORT}`);
  startScheduledJobs();
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopScheduledJobs();
  server.close(() => {
    // Independent services, not database queries: flushing both at once is fine.
    Promise.all([flushSentry(), shutdownAnalytics()])
      .then(() => disconnectDatabases())
      .catch((err: unknown) => logger.error({ err }, 'error closing database connections'))
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
