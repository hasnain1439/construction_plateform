import jwt from 'jsonwebtoken';
import { accessTokenTtlSeconds, env } from '../../config/env.js';
import type { UserRole } from '../../generated/prisma/enums.js';

export const JWT_ISSUER = 'construction-api';
export type Audience = 'company' | 'platform';

/** Cookie names. Company and platform sessions never share cookies. */
export const COOKIES = {
  company: { access: 'access_token', refresh: 'refresh_token', refreshPath: '/api/v1/auth' },
  platform: { access: 'admin_access_token', refresh: 'admin_refresh_token', refreshPath: '/api/v1/admin/auth' },
} as const;

export interface CompanyClaims {
  aud: 'company';
  sub: string;
  tid: string;
  role: UserRole;
  perms: string[];
  sid: string;
}

export interface PlatformClaims {
  aud: 'platform';
  sub: string;
  sid: string;
  role: 'PLATFORM_ADMIN';
}

export type AccessClaims = CompanyClaims | PlatformClaims;

export function signAccessToken(claims: AccessClaims): string {
  const { aud, sub, ...rest } = claims;
  return jwt.sign(rest, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: aud,
    subject: sub,
    expiresIn: accessTokenTtlSeconds,
  });
}

/** Verifies signature, algorithm, issuer, audience and expiry. Throws jsonwebtoken errors. */
export function verifyAccessToken<A extends Audience>(
  token: string,
  audience: A,
): A extends 'company' ? CompanyClaims : PlatformClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience,
  });
  if (typeof payload === 'string' || !payload.sub || typeof payload['sid'] !== 'string') {
    throw new jwt.JsonWebTokenError('malformed token');
  }
  if (audience === 'company' && (typeof payload['tid'] !== 'string' || !Array.isArray(payload['perms']))) {
    throw new jwt.JsonWebTokenError('malformed token');
  }
  return { ...payload, aud: audience } as unknown as A extends 'company' ? CompanyClaims : PlatformClaims;
}
