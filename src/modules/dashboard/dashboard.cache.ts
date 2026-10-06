/**
 * 60-second in-memory cache for dashboard / finance aggregates, per tenant + user + query.
 * Any successful write request of the tenant clears its entries (simple and safe: the next
 * dashboard read is fresh). One process only — several API instances each keep their own.
 */
import type { RequestHandler } from 'express';
import { isTest } from '../../config/env.js';
import { tryGetCtx } from '../../core/context/requestContext.js';

export const DASHBOARD_TTL_MS = 60_000;

const store = new Map<string, { at: number; value: unknown }>();
/** Off in tests by default (they change rows directly); a cache test switches it on. */
let enabled = !isTest;
export const setDashboardCache = (on: boolean) => {
  enabled = on;
  store.clear();
};

export async function cached<T>(tenantId: string, key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  if (!enabled) return load();
  const k = `${tenantId}|${key}`;
  const hit = store.get(k);
  if (hit && now - hit.at < DASHBOARD_TTL_MS) return hit.value as T;
  const value = await load();
  store.set(k, { at: now, value });
  return value;
}

export function invalidateTenant(tenantId: string) {
  for (const k of store.keys()) if (k.startsWith(`${tenantId}|`)) store.delete(k);
}

export function clearDashboardCache() {
  store.clear();
}

/** Clears the tenant's cached aggregates after every successful POST / PUT / PATCH / DELETE. */
export const invalidateOnWrite: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const ctx = tryGetCtx();
  res.on('finish', () => {
    if (ctx?.tenantId && res.statusCode < 400) invalidateTenant(ctx.tenantId);
  });
  next();
};
