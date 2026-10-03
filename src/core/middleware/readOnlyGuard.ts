import type { Request, RequestHandler } from 'express';
import { getCtx } from '../context/requestContext.js';
import { Forbidden } from '../errors/AppError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes that stay allowed on a READ_ONLY company: signing out, and everything under
 * /subscription (submitting a payment and choosing a plan is how a lapsed company pays).
 */
const ALLOWED_PREFIXES = ['/api/v1/auth/logout', '/api/v1/subscription/', '/api/v1/subscription?'];

function blocked(req: Request): boolean {
  if (!getCtx().readOnly || SAFE_METHODS.has(req.method)) return false;
  const path = `${req.originalUrl.split('?')[0] ?? ''}/`;
  return !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const readOnlyError = () =>
  new Forbidden('ACCOUNT_READ_ONLY', 'This company account is read-only. Renew the subscription to make changes.');

/**
 * Blocks POST/PUT/PATCH/DELETE for READ_ONLY companies with 403 ACCOUNT_READ_ONLY.
 * Must run after `tenantContext`.
 */
export const readOnlyGuard: RequestHandler = (req, _res, next) => {
  if (blocked(req)) throw readOnlyError();
  next();
};

/**
 * Same as readOnlyGuard, but lets a write through when `allow(req)` is true — e.g. a
 * PAYMENT_SLIP upload, which a lapsed company needs in order to pay. Run it after the
 * body is parsed/validated.
 */
export function readOnlyGuardExcept(allow: (req: Request) => boolean): RequestHandler {
  return (req, _res, next) => {
    if (blocked(req) && !allow(req)) throw readOnlyError();
    next();
  };
}
