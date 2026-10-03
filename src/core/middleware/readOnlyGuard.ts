import type { RequestHandler } from 'express';
import { getCtx } from '../context/requestContext.js';
import { Forbidden } from '../errors/AppError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes that stay allowed on a READ_ONLY company (so users can sign out and pay). */
const ALLOWED_PREFIXES = ['/api/v1/auth/logout', '/api/v1/subscription/payments', '/api/v1/billing/payments'];

/**
 * Blocks POST/PUT/PATCH/DELETE for READ_ONLY companies with 403 ACCOUNT_READ_ONLY.
 * Must run after `tenantContext`.
 */
export const readOnlyGuard: RequestHandler = (req, _res, next) => {
  if (!getCtx().readOnly || SAFE_METHODS.has(req.method)) return next();
  const path = req.originalUrl.split('?')[0] ?? '';
  if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();
  throw new Forbidden(
    'ACCOUNT_READ_ONLY',
    'This company account is read-only. Renew the subscription to make changes.',
  );
};
