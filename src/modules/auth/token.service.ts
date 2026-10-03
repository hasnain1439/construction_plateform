import { randomUUID } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { accessTokenTtlSeconds, env, isProduction } from '../../config/env.js';
import { COOKIES, signAccessToken, type Audience } from '../../core/auth/jwt.js';
import { permissionsFor } from '../../core/auth/permissions.js';
import { hashSecret, randomToken } from '../../core/utils/crypto.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import type { Client } from './auth.schema.js';

const REFRESH_TOKEN_BYTES = 48;

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
}

/** A fresh opaque refresh token and the hash we store. The raw token is never persisted. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomToken(REFRESH_TOKEN_BYTES);
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return hashSecret(token);
}

export function newFamilyId(): string {
  return randomUUID();
}

export function refreshExpiry(now = new Date()): Date {
  return new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

export function companyAccessToken(
  user: { id: string; tenantId: string; role: UserRole; canSeeFinancials: boolean },
  sessionId: string,
): { token: string; permissions: string[] } {
  const permissions = permissionsFor(user);
  const token = signAccessToken({
    aud: 'company',
    sub: user.id,
    tid: user.tenantId,
    role: user.role,
    perms: permissions,
    sid: sessionId,
  });
  return { token, permissions };
}

export function platformAccessToken(adminId: string, sessionId: string): string {
  return signAccessToken({ aud: 'platform', sub: adminId, sid: sessionId, role: 'PLATFORM_ADMIN' });
}

// ─── Delivery: cookies (web) or body (mobile) ──────────────────────────────

function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function setAuthCookies(res: Response, audience: Audience, tokens: IssuedTokens): void {
  const names = COOKIES[audience];
  res.cookie(names.access, tokens.accessToken, {
    ...baseCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: accessTokenTtlSeconds * 1000,
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...baseCookie(),
    sameSite: 'strict',
    path: names.refreshPath,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearAuthCookies(res: Response, audience: Audience): void {
  const names = COOKIES[audience];
  res.clearCookie(names.access, { ...baseCookie(), sameSite: 'lax', path: '/' });
  res.clearCookie(names.refresh, { ...baseCookie(), sameSite: 'strict', path: names.refreshPath });
}

/**
 * Web: sets httpOnly cookies and returns only the expiry.
 * Mobile: returns both tokens for the app to keep in secure storage.
 */
export function deliverTokens(
  res: Response,
  client: Client,
  audience: Audience,
  tokens: IssuedTokens,
): { accessTokenExpiresIn: number; accessToken?: string; refreshToken?: string } {
  if (client === 'mobile') {
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      refreshToken: tokens.refreshToken,
    };
  }
  setAuthCookies(res, audience, tokens);
  return { accessTokenExpiresIn: tokens.accessTokenExpiresIn };
}

/** Refresh token from the body (mobile) or the refresh cookie (web). */
export function readRefreshToken(req: Request, audience: Audience, bodyToken?: string): string | undefined {
  if (bodyToken) return bodyToken;
  const cookie: unknown = req.cookies?.[COOKIES[audience].refresh];
  return typeof cookie === 'string' && cookie ? cookie : undefined;
}

export { accessTokenTtlSeconds };
