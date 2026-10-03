import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { normalizePkPhone } from '../utils/phone.js';

function identifierOf(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = [body['login'], body['phone'], body['email']].find((v): v is string => typeof v === 'string');
  if (!raw) return '-';
  return normalizePkPhone(raw) ?? raw.trim().toLowerCase();
}

function rejected(_req: Request, res: Response, _next: unknown, options: { windowMs: number }) {
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.', details: { retryAfterSeconds } },
  });
}

/**
 * Login / OTP / forgot-password limiter: AUTH_RATE_LIMIT_MAX (default 10) requests
 * per minute per IP + identifier (phone/email). Must run after express.json().
 */
export const authRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '0.0.0.0')}|${identifierOf(req)}`,
  handler: rejected,
});

/** Broad per-IP limiter for the whole API. */
export const generalRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.GENERAL_RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rejected,
});
