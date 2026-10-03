import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestHandler } from 'express';
import { runWithCtx, type RequestContext } from '../context/requestContext.js';

const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Accepts a sane incoming `x-request-id` (for tracing through a proxy) or creates
 * one, and echoes it back. Used as pino-http's `genReqId`, so logs and context agree.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

/**
 * Opens the AsyncLocalStorage request context. Mounted after the body/cookie parsers
 * so the context is not lost across their stream callbacks.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const requestId = typeof req.id === 'string' ? req.id : resolveRequestId(req, res);
  const ctx: RequestContext = {
    requestId,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 512),
    actorType: 'ANONYMOUS',
    permissions: [],
  };
  runWithCtx(ctx, () => next());
};
