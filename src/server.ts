import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { disconnectDatabases } from './core/db/prisma.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on http://localhost:${env.PORT}`);
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    disconnectDatabases()
      .catch((err: unknown) => logger.error({ err }, 'error closing database connections'))
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
