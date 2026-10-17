import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestHandler } from 'express';
import { runWithCtx, type RequestContext } from '../context/requestContext.js';
import { isLang } from '../i18n/lang.js';
import { tagSentryScope } from '../observability/sentryScope.js';

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
  // QA-B-20: UI language of the web app (X-Lang); anything else is ignored.
  const uiLang = req.get('x-lang')?.trim().toLowerCase();
  if (isLang(uiLang)) ctx.uiLang = uiLang;
  // Kept on res.locals too: the request log line is written after the context has ended.
  res.locals['ctx'] = ctx;
  tagSentryScope(ctx);
  runWithCtx(ctx, () => next());
};

/** tenantId / userId for pino-http's request line (ids only). */
export function requestLogFields(res: ServerResponse): Record<string, string> {
  const ctx = (res as ServerResponse & { locals?: { ctx?: RequestContext } }).locals?.ctx;
  if (!ctx) return {};
  const fields: Record<string, string> = {};
  if (ctx.tenantId) fields['tenantId'] = ctx.tenantId;
  if (ctx.userId) fields['userId'] = ctx.userId;
  if (ctx.platformAdminId) fields['platformAdminId'] = ctx.platformAdminId;
  return fields;
}
