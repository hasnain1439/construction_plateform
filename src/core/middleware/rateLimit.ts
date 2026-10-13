import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { tryGetCtx } from '../context/requestContext.js';
import { normalizePkPhone } from '../utils/phone.js';

/*
 * Rate limits (per API instance, in memory — behind several instances use a shared store,
 * see docs/SECURITY.md). Every limiter answers 429 RATE_LIMITED with details.retryAfterSeconds.
 *
 *   authRateLimit       AUTH_RATE_LIMIT_MAX (10) / min   per IP + phone/email (or invite token)
 *   authIpRateLimit     AUTH_IP_RATE_LIMIT_MAX (30) / min per IP, shared by every sign-in route
 *   otpSendRateLimit    OTP_SEND_IP_RATE_LIMIT_MAX (20) / h per IP — routes that send an SMS/email code
 *   syncPushRateLimit   SYNC_PUSH_RATE_LIMIT_MAX (60) / min per signed-in user
 *   generalRateLimit    GENERAL_RATE_LIMIT_MAX (300) / min per IP for the whole API
 *
 * On top of these, in the services: OTP resend wait 60 s and 5 codes / phone / hour, 3 wrong
 * tries consume a code, password lock-out after repeated failures (auth.service.ts).
 */

function identifierOf(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = [body['login'], body['phone'], body['email']].find((v): v is string => typeof v === 'string');
  if (raw) return normalizePkPhone(raw) ?? raw.trim().toLowerCase();
  const token = req.params?.['token'];
  return typeof token === 'string' && token ? `invite:${token.slice(0, 64)}` : '-';
}

const ipOf = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

function rejected(_req: Request, res: Response, _next: unknown, options: { windowMs: number }) {
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.', details: { retryAfterSeconds } },
  });
}

/** A limiter with this API's 429 body and draft-8 RateLimit headers. */
export function createRateLimit(options: { windowMs: number; limit: number; keyGenerator?: (req: Request) => string }): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    handler: rejected,
  });
}

/**
 * Login / OTP / forgot + reset password / invitation accept: AUTH_RATE_LIMIT_MAX (default 10)
 * requests per minute per IP + identifier (phone / email, or the invitation token).
 * Must run after express.json().
 */
export const authRateLimit = createRateLimit({
  windowMs: 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => `${ipOf(req)}|${identifierOf(req)}`,
});

/**
 * One budget per IP across every sign-in route, so rotating phone numbers / emails from one
 * address (credential stuffing, OTP guessing across accounts) still hits a wall.
 */
export const authIpRateLimit = createRateLimit({ windowMs: 60_000, limit: env.AUTH_IP_RATE_LIMIT_MAX, keyGenerator: ipOf });

/** Routes that send a code by SMS / email: caps SMS pumping from one IP across many phones. */
export const otpSendRateLimit = createRateLimit({ windowMs: 3_600_000, limit: env.OTP_SEND_IP_RATE_LIMIT_MAX, keyGenerator: ipOf });

/** Per signed-in user (after authenticate); the mobile app treats 429 as "try again later". */
export const syncPushRateLimit = createRateLimit({
  windowMs: 60_000,
  limit: env.SYNC_PUSH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const ctx = tryGetCtx();
    return ctx?.userId ? `user:${ctx.userId}` : `ip:${ipOf(req)}`;
  },
});

/** Broad per-IP limiter for the whole API. */
export const generalRateLimit = createRateLimit({ windowMs: 60_000, limit: env.GENERAL_RATE_LIMIT_MAX });
