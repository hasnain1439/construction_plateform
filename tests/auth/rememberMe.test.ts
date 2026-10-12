import { describe, expect, it } from 'vitest';
import { api, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();

const setCookies = (res: { headers: Record<string, unknown> }) => (res.headers['set-cookie'] as string[] | undefined) ?? [];
const cookie = (res: { headers: Record<string, unknown> }, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));
const pair = (c: string | undefined) => c?.split(';')[0] ?? '';
const login = (rememberMe?: boolean) =>
  api()
    .post('/api/v1/auth/login')
    .send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password, client: 'web', ...(rememberMe === undefined ? {} : { rememberMe }) });

describe('"Remember me" on web sign-in', () => {
  it('remembered (default): the sign-in cookies have an expiry', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(cookie(res, 'refresh_token')).toMatch(/Max-Age=\d+/);
    expect(cookie(res, 'access_token')).toMatch(/Max-Age=\d+/);
  });

  it('not remembered: session cookies only, and a refresh keeps it that way', async () => {
    const res = await login(false);
    expect(res.status).toBe(200);
    const refresh = cookie(res, 'refresh_token');
    expect(refresh).toBeDefined();
    expect(refresh).not.toMatch(/Max-Age|Expires/);
    expect(cookie(res, 'access_token')).not.toMatch(/Max-Age|Expires/);
    const marker = cookie(res, 'refresh_token_session');
    expect(marker).toBeDefined();

    const refreshed = await api().post('/api/v1/auth/refresh').set('Cookie', [pair(refresh), pair(marker)].join('; ')).send({ client: 'web' });
    expect(refreshed.status).toBe(200);
    expect(cookie(refreshed, 'refresh_token')).not.toMatch(/Max-Age|Expires/);
  });

  it('a remembered sign-in clears an earlier session-only marker (and sends no empty cookie otherwise)', async () => {
    expect(cookie(await login(true), 'refresh_token_session')).toBeUndefined();
    const res = await api()
      .post('/api/v1/auth/login')
      .set('Cookie', 'refresh_token_session=1')
      .send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password, client: 'web', rememberMe: true });
    expect(res.status).toBe(200);
    expect(cookie(res, 'refresh_token_session')).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('platform admin login honours it too', async () => {
    const res = await api().post('/api/v1/admin/auth/login').send({ email: 'admin@platform.local', password: 'Admin#2026', client: 'web', rememberMe: false });
    expect(res.status).toBe(200);
    expect(cookie(res, 'admin_refresh_token')).not.toMatch(/Max-Age|Expires/);
  });
});
