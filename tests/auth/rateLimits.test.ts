import express, { type RequestHandler, type Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';
import { authIpRateLimit, authRateLimit, createRateLimit, otpSendRateLimit, syncPushRateLimit } from '../../src/core/middleware/rateLimit.js';
import { adminAuthRouter, authRouter, invitationRouter } from '../../src/modules/auth/auth.routes.js';
import { syncRouter } from '../../src/modules/sync/sync.routes.js';

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } };

function handlersOf(router: Router, method: string, path: string): RequestHandler[] {
  const layer = (router.stack as unknown as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

describe('rate limits are wired on the sensitive routes', () => {
  it.each([
    [authRouter, '/login'],
    [authRouter, '/signup'],
    [authRouter, '/otp/request'],
    [authRouter, '/otp/verify'],
    [authRouter, '/password/forgot'],
    [authRouter, '/password/reset'],
    [invitationRouter, '/:token/accept'],
    [adminAuthRouter, '/login'],
  ] as const)('%#: per IP + identifier and per IP', (router, path) => {
    const handlers = handlersOf(router, 'post', path);
    expect(handlers).toContain(authRateLimit);
    expect(handlers).toContain(authIpRateLimit);
  });

  it('routes that send a code also have the hourly per-IP send cap', () => {
    expect(handlersOf(authRouter, 'post', '/otp/request')).toContain(otpSendRateLimit);
    expect(handlersOf(authRouter, 'post', '/password/forgot')).toContain(otpSendRateLimit);
    expect(handlersOf(authRouter, 'post', '/login')).not.toContain(otpSendRateLimit);
  });

  it('sync push is limited per user, after authentication', () => {
    const handlers = handlersOf(syncRouter, 'post', '/push');
    const at = handlers.indexOf(syncPushRateLimit);
    expect(at).toBeGreaterThan(0); // after authenticate / tenantContext
  });
});

describe('createRateLimit', () => {
  it('answers 429 RATE_LIMITED with retryAfterSeconds and RateLimit headers once the budget is spent', async () => {
    const app = express();
    app.post('/x', createRateLimit({ windowMs: 60_000, limit: 2, keyGenerator: () => 'same' }), (_req, res) => {
      res.json({ ok: true });
    });
    expect((await request(app).post('/x')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(200);
    const third = await request(app).post('/x');
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: expect.any(String), details: { retryAfterSeconds: 60 } } });
    expect(third.headers['ratelimit-policy']).toBeDefined();
  });
});

describe('login code lifetime setting', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost/db',
    DATABASE_ADMIN_URL: 'postgresql://u:p@localhost/db',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_REFRESH_PEPPER: 'y'.repeat(32),
  };
  it('OTP_TTL_SECONDS is capped at 10 minutes', () => {
    expect(envSchema.safeParse({ ...base, OTP_TTL_SECONDS: '600' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, OTP_TTL_SECONDS: '601' }).success).toBe(false);
    expect(envSchema.parse(base).OTP_TTL_SECONDS).toBe(300);
  });
});
