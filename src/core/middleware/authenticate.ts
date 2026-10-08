import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { getCtx } from '../context/requestContext.js';
import { BadRequest, NotFound, Unauthorized } from '../errors/AppError.js';
import { ACT_AS_HEADER, adminSessionAlive, systemUserId, tenantExists } from '../../modules/auth/actAs.js';
import { COOKIES, verifyAccessToken, type Audience } from '../auth/jwt.js';
import { PERMISSIONS } from '../auth/permissions.js';

function readToken(req: Request, audience: Audience): string | undefined {
  const header = req.get('authorization');
  if (header) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
  }
  const cookie: unknown = req.cookies?.[COOKIES[audience].access];
  return typeof cookie === 'string' && cookie ? cookie : undefined;
}

function authenticateFor(audience: Audience): RequestHandler {
  return (req, _res, next) => {
    const token = readToken(req, audience);
    if (!token) throw new Unauthorized('UNAUTHENTICATED', 'Authentication required');

    let claims;
    try {
      claims = verifyAccessToken(token, audience);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new Unauthorized('TOKEN_EXPIRED', 'Access token expired');
      throw new Unauthorized('TOKEN_INVALID', 'Invalid access token');
    }

    const ctx = getCtx();
    ctx.userId = claims.sub;
    ctx.sessionId = claims.sid;
    if (claims.aud === 'company') {
      ctx.actorType = 'USER';
      ctx.tenantId = claims.tid;
      ctx.role = claims.role;
      ctx.permissions = claims.perms;
    } else {
      ctx.actorType = 'PLATFORM_ADMIN';
      ctx.role = 'PLATFORM_ADMIN';
      ctx.permissions = [];
    }
    next();
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const companyAuth = authenticateFor('company');
const platformAuth = authenticateFor('platform');

/**
 * Super admin acting inside a company: a valid platform token + `X-Act-As-Tenant`. The
 * request then runs as that company's system user (THEKEDAR, every permission) and keeps
 * the admin's id for the audit log. See modules/auth/actAs.ts.
 */
async function actAs(req: Request, tenantId: string): Promise<void> {
  if (!UUID.test(tenantId)) throw new BadRequest('INVALID_TENANT', 'X-Act-As-Tenant must be a company id');
  platformAuth(req, {} as never, () => undefined); // verifies the platform token, fills the context
  const ctx = getCtx();
  if (ctx.actorType !== 'PLATFORM_ADMIN' || !ctx.sessionId || !(await adminSessionAlive(ctx.sessionId))) {
    throw new Unauthorized('SESSION_REVOKED', 'You have been signed out. Please log in again.');
  }
  if (!(await tenantExists(tenantId))) throw new NotFound('TENANT_NOT_FOUND', 'Company not found');
  ctx.platformAdminId = ctx.userId;
  ctx.actorType = 'USER';
  ctx.tenantId = tenantId;
  ctx.userId = await systemUserId(tenantId);
  ctx.role = 'THEKEDAR';
  ctx.permissions = [...PERMISSIONS];
  ctx.sessionId = undefined;
}

/**
 * Company-user authentication. Reads the access token from `Authorization: Bearer`
 * (mobile) or the `access_token` cookie (web); verifies HS256, issuer and the
 * `company` audience. Platform-admin tokens are rejected here — except with
 * `X-Act-As-Tenant`, where a platform super admin works inside that company.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  const actingFor = req.get(ACT_AS_HEADER);
  if (actingFor) {
    await actAs(req, actingFor.trim());
    next();
    return;
  }
  companyAuth(req, res, next);
};

/** Platform-admin authentication (`platform` audience, `admin_access_token` cookie). */
export const authenticatePlatform = authenticateFor('platform');
