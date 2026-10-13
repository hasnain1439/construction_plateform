import { pino, type DestinationStream, type Logger } from 'pino';
import { env, isProduction, isTest } from './env.js';
import { tryGetCtx } from '../core/context/requestContext.js';

/**
 * Paths that must never reach the logs. pino replaces them with "[REDACTED]".
 * Covers request bodies/headers as serialised by pino-http and any object we log.
 */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'code',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'codeHash',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.code',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.tokenHash',
  '*.codeHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

/**
 * In tests every log line is also written to this in-memory sink so the suite can
 * assert that secrets never appear in the output.
 */
export const testLogSink: string[] = [];

function destination(): DestinationStream | undefined {
  if (isTest) {
    return { write: (line: string) => void testLogSink.push(line) };
  }
  return undefined;
}

/**
 * Adds the current request's tenantId / userId (and the platform admin behind a support
 * session) to every log line written while handling it. Ids only — never names or phones.
 */
export function contextFields(): Record<string, string> {
  const ctx = tryGetCtx();
  if (!ctx) return {};
  const fields: Record<string, string> = {};
  if (ctx.tenantId) fields['tenantId'] = ctx.tenantId;
  if (ctx.userId) fields['userId'] = ctx.userId;
  if (ctx.platformAdminId) fields['platformAdminId'] = ctx.platformAdminId;
  return fields;
}

function createLogger(): Logger {
  const options = {
    mixin: contextFields,
    level: env.LOG_LEVEL ?? (isTest ? 'debug' : isProduction ? 'info' : 'debug'),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'construction-api' },
  };
  const dest = destination();
  if (dest) return pino(options, dest);
  if (!isProduction) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' } },
    });
  }
  return pino(options);
}

export const logger = createLogger();
