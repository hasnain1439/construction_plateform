import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TOKENS = { accessToken: 'a.b.c', accessTokenExpiresIn: 900, refreshToken: 'r'.repeat(20) };

/** token.service with NODE_ENV set to `mode` (env is read once at import, so reload the modules). */
async function cookiesIn(mode: 'production' | 'test', audience: 'company' | 'platform', persist = true) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', mode);
  vi.stubEnv('BCRYPT_ROUNDS', '12'); // production refuses fewer
  vi.stubEnv('ALLOW_DEV_PROVIDERS_IN_PRODUCTION', 'true'); // console SMS / mail, local storage
  const { deliverTokens, clearAuthCookies } = await import('../../src/modules/auth/token.service.js');
  const app = express();
  app.post('/in', (_req, res) => {
    res.json(deliverTokens(res, 'web', audience, TOKENS, persist));
  });
  app.post('/out', (_req, res) => {
    clearAuthCookies(res, audience);
    res.json({});
  });
  const set = (await request(app).post('/in')).headers['set-cookie'] as unknown as string[];
  const cleared = (await request(app).post('/out')).headers['set-cookie'] as unknown as string[];
  return { set, cleared };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('auth cookies', () => {
  it.each(['company', 'platform'] as const)('production (%s): every cookie is HttpOnly, Secure and SameSite', async (audience) => {
    const { set, cleared } = await cookiesIn('production', audience, false);
    expect(set.length).toBeGreaterThanOrEqual(3); // access, refresh, session-only marker
    for (const cookie of [...set, ...cleared]) {
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*SameSite=(Strict|Lax)/i);
    }
    // The refresh token never travels cross-site and only to the refresh path.
    const refresh = set.find((c) => /^(admin_)?refresh_token=/.test(c))!;
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/(admin\/)?auth/);
  });

  it('outside production cookies are not Secure (http://localhost) but keep HttpOnly + SameSite', async () => {
    const { set } = await cookiesIn('test', 'company');
    for (const cookie of set) {
      expect(cookie).not.toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=/i);
    }
  });
});
