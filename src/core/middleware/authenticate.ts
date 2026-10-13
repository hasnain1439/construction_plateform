import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { getCtx } from '../context/requestContext.js';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../errors/AppError.js';
import {
  ACT_AS_HEADER,
  ACT_AS_SAFE_METHODS,
  ACT_AS_SESSION_HEADER,
  adminSessionAlive,
  liveActAsSession,
  systemUserId,
  tenantExists,
} from '../../modules/auth/actAs.js';
import { COOKIES, verifyAccessToken, type Audience } from '../auth/jwt.js';
import { ownerAccess } from '../auth/access.js';
import { tagSentryScope } from '../observability/sentryScope.js';

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
      // Effective permissions are resolved per request by tenantContext (never trusted from the token).
      ctx.permissions = [];
    } else {
      ctx.actorType = 'PLATFORM_ADMIN';
      ctx.role = 'PLATFORM_ADMIN';
      ctx.permissions = [];
    }
    tagSentryScope(ctx); // requestId / tenantId / hashed user id on errors + traces (no-op without Sentry)
    next();
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const companyAuth = authenticateFor('company');
const platformAuth = authenticateFor('platform');

/**
 * Super admin acting inside a company: a valid platform token + `X-Act-As-Tenant` + a live
 * `X-Act-As-Session` of this admin in this company (403 ACT_AS_SESSION_* otherwise). A
 * READ_ONLY session may only read (403 ACT_AS_READ_ONLY). The request then runs as that
 * company's system user (THEKEDAR, every permission) and keeps the admin's id and the session
 * for the audit log. See modules/auth/actAs.ts.
 */
async function actAs(req: Request, tenantId: string): Promise<void> {
  if (!UUID.test(tenantId)) throw new BadRequest('INVALID_TENANT', 'X-Act-As-Tenant must be a company id');
  platformAuth(req, {} as never, () => undefined); // verifies the platform token, fills the context
  const ctx = getCtx();
  if (ctx.actorType !== 'PLATFORM_ADMIN' || !ctx.sessionId || !(await adminSessionAlive(ctx.sessionId))) {
    throw new Unauthorized('SESSION_REVOKED', 'You have been signed out. Please log in again.');
  }
  if (!(await tenantExists(tenantId))) throw new NotFound('TENANT_NOT_FOUND', 'Company not found');
  const session = await liveActAsSession(req.get(ACT_AS_SESSION_HEADER)?.trim() || undefined, ctx.userId!, tenantId);
  if (session.mode === 'READ_ONLY' && !ACT_AS_SAFE_METHODS.has(req.method)) {
    throw new Forbidden('ACT_AS_READ_ONLY', 'This support session is read-only. Switch it to write mode (with a reason) to make changes.');
  }
  ctx.actAs = session;
  ctx.platformAdminId = ctx.userId;
  ctx.actorType = 'USER';
  ctx.tenantId = tenantId;
  ctx.userId = await systemUserId(tenantId);
  ctx.role = 'THEKEDAR';
  ctx.access = ownerAccess();
  ctx.permissions = ctx.access.permissions;
  ctx.sessionId = undefined;
  tagSentryScope(ctx);
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
