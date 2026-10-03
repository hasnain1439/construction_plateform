import type { RequestHandler } from 'express';
import type { TenantStatus } from '../../generated/prisma/enums.js';
import { getCtx } from '../context/requestContext.js';
import { withTenant } from '../db/withTenant.js';
import { Forbidden, Unauthorized } from '../errors/AppError.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { status: TenantStatus; expiresAt: number }>();

async function tenantStatus(tenantId: string): Promise<TenantStatus | null> {
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.status;
  const tenant = await withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
  );
  if (!tenant) return null;
  cache.set(tenantId, { status: tenant.status, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant.status;
}

/** Call after changing a tenant's status so the change applies immediately. */
export function invalidateTenantStatus(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * For company tokens: blocks SUSPENDED/CLOSED companies (403) and flags READ_ONLY
 * ones in the context for readOnlyGuard. Status is cached for 60 s per tenant.
 */
export const tenantContext: RequestHandler = async (_req, _res, next) => {
  const ctx = getCtx();
  if (ctx.actorType !== 'USER' || !ctx.tenantId) throw new Unauthorized('UNAUTHENTICATED', 'Company login required');

  const status = await tenantStatus(ctx.tenantId);
  if (!status) throw new Unauthorized('TOKEN_INVALID', 'Company no longer exists');
  if (status === 'SUSPENDED' || status === 'CLOSED') {
    throw new Forbidden('COMPANY_SUSPENDED', 'This company account is suspended. Please contact support.');
  }
  ctx.readOnly = status === 'READ_ONLY';
  next();
};
