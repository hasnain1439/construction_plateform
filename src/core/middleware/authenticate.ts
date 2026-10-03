import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { getCtx } from '../context/requestContext.js';
import { Unauthorized } from '../errors/AppError.js';
import { COOKIES, verifyAccessToken, type Audience } from '../auth/jwt.js';

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

/**
 * Company-user authentication. Reads the access token from `Authorization: Bearer`
 * (mobile) or the `access_token` cookie (web); verifies HS256, issuer and the
 * `company` audience. Platform-admin tokens are rejected here.
 */
export const authenticate = authenticateFor('company');

/** Platform-admin authentication (`platform` audience, `admin_access_token` cookie). */
export const authenticatePlatform = authenticateFor('platform');
