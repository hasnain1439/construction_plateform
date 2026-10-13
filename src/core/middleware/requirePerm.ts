import type { Request, RequestHandler } from 'express';
import { accessOf, assertApprovalLimit, permissionDenied } from '../auth/access.js';
import { CATALOG_BY_KEY } from '../auth/permissionCatalog.js';
import { getCtx } from '../context/requestContext.js';
import { Unauthorized } from '../errors/AppError.js';

export interface RequirePermOptions {
  /**
   * Amount (paisa) the request approves or pays, for the approval limit of `key`. Runs before
   * validation, so return undefined for anything that doesn't parse (validation then answers 400).
   */
  amountFrom?: (req: Request) => bigint | number | string | null | undefined;
  /** With several keys: one of them is enough (default: all are needed). */
  any?: boolean;
}

function toPaisa(v: bigint | number | string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
    return /^-?\d+$/.test(v.trim()) ? BigInt(v.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Company routes: the caller must hold `key` (or every key / any key of a list) in their
 * effective permissions (THEKEDAR holds all). Denied → 403 PERMISSION_DENIED with
 * `details.permission`. With `amountFrom`, an amount above the caller's approval limit of the
 * (first) key → 403 APPROVAL_LIMIT_EXCEEDED.
 *
 * Runs after authenticate + tenantContext (which resolve the caller's permissions).
 */
export function requirePerm(key: string | string[], opts: RequirePermOptions = {}): RequestHandler {
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) if (!CATALOG_BY_KEY.has(k)) throw new Error(`requirePerm: unknown permission ${k}`);
  const handler: RequestHandler & { permission?: { keys: string[]; any: boolean } } = (req, _res, next) => {
    const ctx = getCtx();
    if (ctx.actorType !== 'USER' || !ctx.access) throw new Unauthorized('UNAUTHENTICATED', 'Authentication required');
    const access = accessOf();
    if (opts.any) {
      if (!keys.some((k) => access.has.has(k))) throw permissionDenied(keys);
    } else {
      const missing = keys.find((k) => !access.has.has(k));
      if (missing) throw permissionDenied(missing);
    }
    if (opts.amountFrom) {
      const amount = toPaisa(opts.amountFrom(req));
      if (amount !== null) assertApprovalLimit(keys[0]!, amount);
    }
    next();
  };
  // Read by listRoutes() (docs / parity tooling).
  handler.permission = { keys, any: Boolean(opts.any) };
  return handler;
}
