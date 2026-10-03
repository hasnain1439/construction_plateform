import type { RequestHandler } from 'express';
import type { UserRole } from '../../generated/prisma/enums.js';
import type { Permission } from '../auth/permissions.js';
import { getCtx } from '../context/requestContext.js';
import { Forbidden, Unauthorized } from '../errors/AppError.js';

/** Allows only company users with one of `roles`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, _res, next) => {
    const ctx = getCtx();
    if (ctx.actorType !== 'USER' || !ctx.role) throw new Unauthorized('UNAUTHENTICATED', 'Authentication required');
    if (!roles.includes(ctx.role as UserRole)) throw new Forbidden('FORBIDDEN', 'Your role cannot do this');
    next();
  };
}

/** Allows only company users holding every permission in `perms`. */
export function requirePermission(...perms: Permission[]): RequestHandler {
  return (_req, _res, next) => {
    const ctx = getCtx();
    if (ctx.actorType !== 'USER') throw new Unauthorized('UNAUTHENTICATED', 'Authentication required');
    const missing = perms.filter((p) => !ctx.permissions.includes(p));
    if (missing.length) throw new Forbidden('FORBIDDEN', 'You do not have permission to do this', { missing });
    next();
  };
}
