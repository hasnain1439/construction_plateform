import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '../../generated/prisma/enums.js';

export type ActorType = 'ANONYMOUS' | 'USER' | 'PLATFORM_ADMIN';

export interface RequestContext {
  requestId: string;
  ip: string | undefined;
  userAgent: string | undefined;
  actorType: ActorType;
  userId?: string;
  tenantId?: string;
  role?: UserRole | 'PLATFORM_ADMIN';
  permissions: string[];
  /** Current session id (`sid` claim). */
  sessionId?: string;
  /** Set by tenantContext when the company is READ_ONLY. */
  readOnly?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithCtx<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current request's context. Throws outside a request. */
export function getCtx(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('getCtx() called outside a request context');
  return ctx;
}

export function tryGetCtx(): RequestContext | undefined {
  return storage.getStore();
}
