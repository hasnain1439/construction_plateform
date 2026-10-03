import type { RequestHandler } from 'express';
import { getCtx } from '../context/requestContext.js';
import { Forbidden } from '../errors/AppError.js';
import { authenticatePlatform } from './authenticate.js';

const assertPlatformAdmin: RequestHandler = (_req, _res, next) => {
  const ctx = getCtx();
  if (ctx.actorType !== 'PLATFORM_ADMIN' || ctx.role !== 'PLATFORM_ADMIN') {
    throw new Forbidden('FORBIDDEN', 'Platform admin access required');
  }
  next();
};

/** Authenticates a `platform`-audience token and requires the PLATFORM_ADMIN role. */
export const requirePlatformAdmin: RequestHandler[] = [authenticatePlatform, assertPlatformAdmin];
