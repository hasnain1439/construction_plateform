import { randomUUID } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { accessTokenTtlSeconds, env, isProduction } from '../../config/env.js';
import { COOKIES, signAccessToken, type Audience } from '../../core/auth/jwt.js';
import { legacyPermissions, type Access } from '../../core/auth/access.js';
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

/**
 * The `perms` claim carries only the short legacy list (informational, kept for old clients);
 * the API resolves the real permissions from the database on every request (tenantContext).
 */
export function companyAccessToken(
  user: { id: string; tenantId: string; role: UserRole },
  sessionId: string,
  access: Access,
): { token: string; permissions: string[] } {
  const permissions = access.permissions;
  const token = signAccessToken({
    aud: 'company',
    sub: user.id,
    tid: user.tenantId,
    role: user.role,
    perms: legacyPermissions(access),
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

/** Marker sent with refresh requests: the sign-in chose "don't remember me" (session cookies only). */
const sessionOnlyCookie = (audience: Audience) => `${COOKIES[audience].refresh}_session`;

/**
 * `persist` false ("remember me" unticked): no maxAge, so the browser drops the cookies when it
 * closes; a marker cookie keeps that choice across token refreshes.
 */
function setAuthCookies(res: Response, audience: Audience, tokens: IssuedTokens, persist: boolean, hadSessionMarker: boolean): void {
  const names = COOKIES[audience];
  res.cookie(names.access, tokens.accessToken, {
    ...baseCookie(),
    sameSite: 'lax',
    path: '/',
    ...(persist ? { maxAge: accessTokenTtlSeconds * 1000 } : {}),
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...baseCookie(),
    sameSite: 'strict',
    path: names.refreshPath,
    ...(persist ? { maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 } : {}),
  });
  // Only clear a marker the browser actually sent (no empty Set-Cookie on every remembered sign-in).
  if (persist) {
    if (hadSessionMarker) res.clearCookie(sessionOnlyCookie(audience), { ...baseCookie(), sameSite: 'strict', path: names.refreshPath });
  } else res.cookie(sessionOnlyCookie(audience), '1', { ...baseCookie(), sameSite: 'strict', path: names.refreshPath });
}

/** On refresh: keep the sign-in's "remember me" choice. */
export function rememberedChoice(req: Request, audience: Audience): boolean {
  return req.cookies?.[sessionOnlyCookie(audience)] !== '1';
}

export function clearAuthCookies(res: Response, audience: Audience): void {
  const names = COOKIES[audience];
  res.clearCookie(names.access, { ...baseCookie(), sameSite: 'lax', path: '/' });
  res.clearCookie(names.refresh, { ...baseCookie(), sameSite: 'strict', path: names.refreshPath });
  res.clearCookie(sessionOnlyCookie(audience), { ...baseCookie(), sameSite: 'strict', path: names.refreshPath });
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
  /** Web only: false = cookies end with the browser session. */
  persist = true,
  /** The request carried the session-only marker (so a remembered sign-in must clear it). */
  hadSessionMarker = false,
): { accessTokenExpiresIn: number; accessToken?: string; refreshToken?: string } {
  if (client === 'mobile') {
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      refreshToken: tokens.refreshToken,
    };
  }
  setAuthCookies(res, audience, tokens, persist, hadSessionMarker);
  return { accessTokenExpiresIn: tokens.accessTokenExpiresIn };
}

/** Refresh token from the body (mobile) or the refresh cookie (web). */
export function readRefreshToken(req: Request, audience: Audience, bodyToken?: string): string | undefined {
  if (bodyToken) return bodyToken;
  const cookie: unknown = req.cookies?.[COOKIES[audience].refresh];
  return typeof cookie === 'string' && cookie ? cookie : undefined;
}

export { accessTokenTtlSeconds };
