import type * as SentrySdk from '@sentry/node';
import type { RequestContext } from '../context/requestContext.js';
import { hashUserId } from './hash.js';
import { scrubString } from './scrub.js';

/**
 * The per-request Sentry helpers (used by the middlewares), without importing `@sentry/node`:
 * the SDK takes ~0.5 s to load, and it is already loaded by `sentry.ts` through `instrument.ts`
 * whenever Sentry is on. `initSentry()` hands the SDK over here; until then (no SENTRY_DSN,
 * tests) every helper is a no-op.
 */
let sdk: typeof SentrySdk | undefined;

/** Called by initSentry() / closeSentryForTests() only. */
export function setSentrySdk(next: typeof SentrySdk | undefined): void {
  sdk = next;
}

/**
 * Tags the current request's isolation scope (errors AND the request's transaction):
 * requestId, tenantId, and the hashed user id — never the raw user id, name or phone.
 */
export function tagSentryScope(ctx: Pick<RequestContext, 'requestId' | 'tenantId' | 'userId' | 'actorType'>): void {
  if (!sdk) return;
  const scope = sdk.getIsolationScope();
  scope.setTag('requestId', ctx.requestId);
  scope.setTag('actorType', ctx.actorType);
  if (ctx.tenantId) scope.setTag('tenantId', ctx.tenantId);
  if (ctx.userId) {
    const id = hashUserId(ctx.userId);
    scope.setTag('userIdHash', id);
    scope.setUser({ id });
  }
}

/** Reports an unexpected error with the request's tags. No-op when Sentry is off. */
export function captureError(
  err: unknown,
  ctx?: Pick<RequestContext, 'requestId' | 'tenantId' | 'userId' | 'actorType'>,
  extra?: { method?: string; path?: string },
): string | undefined {
  if (!sdk) return undefined;
  return sdk.withScope((scope) => {
    if (ctx) {
      scope.setTag('requestId', ctx.requestId);
      scope.setTag('actorType', ctx.actorType);
      if (ctx.tenantId) scope.setTag('tenantId', ctx.tenantId);
      if (ctx.userId) {
        const id = hashUserId(ctx.userId);
        scope.setTag('userIdHash', id);
        scope.setUser({ id });
      }
    }
    if (extra?.method) scope.setTag('http.method', extra.method);
    if (extra?.path) scope.setTag('route', scrubString(extra.path));
    return sdk!.captureException(err);
  });
}
