import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();

async function adminLogin() {
  const res = await api()
    .post('/api/v1/admin/auth/login')
    .send({ email: SEED.admin.email, password: SEED.admin.password, client: 'mobile' });
  expect(res.status).toBe(200);
  return res.body.data as { accessToken: string; refreshToken: string; admin: { email: string } };
}

describe('platform admin vs company tokens', () => {
  it('platform admin can log in and read its profile; token has platform audience', async () => {
    const admin = await adminLogin();
    const claims = jwt.decode(admin.accessToken) as Record<string, unknown>;
    expect(claims).toMatchObject({ aud: 'platform', role: 'PLATFORM_ADMIN', iss: 'construction-api' });
    expect(claims['tid']).toBeUndefined();

    const me = await api().get('/api/v1/admin/auth/me').set(bearer(admin.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(SEED.admin.email);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'admin.login', tenantId: null } })).toBe(1);
  });

  it('platform admin token is rejected on company routes', async () => {
    const admin = await adminLogin();
    const res = await api().get('/api/v1/auth/me').set(bearer(admin.accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('company token is rejected on platform routes', async () => {
    const company = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const res = await api().get('/api/v1/admin/auth/me').set(bearer(company.accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('company user credentials do not work on admin login and vice versa', async () => {
    const res = await api()
      .post('/api/v1/admin/auth/login')
      .send({ email: SEED.malik.owner.email, password: SEED.malik.owner.password });
    expect(res.status).toBe(401);
    const company = await api().post('/api/v1/auth/login').send({ login: SEED.admin.email, password: SEED.admin.password });
    expect(company.status).toBe(401);
  });

  it('admin refresh rotates and detects reuse; logout revokes', async () => {
    const admin = await adminLogin();
    const r1 = await api().post('/api/v1/admin/auth/refresh').send({ client: 'mobile', refreshToken: admin.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await api().post('/api/v1/admin/auth/refresh').send({ client: 'mobile', refreshToken: admin.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    const fresh = await adminLogin();
    expect((await api().post('/api/v1/admin/auth/logout').set(bearer(fresh.accessToken))).status).toBe(200);
    const after = await api().post('/api/v1/admin/auth/refresh').send({ client: 'mobile', refreshToken: fresh.refreshToken });
    expect(after.status).toBe(401);
  });

  it('admin lockout after 5 wrong passwords', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await api().post('/api/v1/admin/auth/login').send({ email: SEED.admin.email, password: `Wrong#${i}` });
      expect(res.status).toBe(401);
    }
    const fifth = await api().post('/api/v1/admin/auth/login').send({ email: SEED.admin.email, password: 'Wrong#5' });
    expect(fifth.status).toBe(423);
    const correct = await api().post('/api/v1/admin/auth/login').send({ email: SEED.admin.email, password: SEED.admin.password });
    expect(correct.status).toBe(423);
  });

  it('tokens signed with another secret or expired are rejected', async () => {
    const forged = jwt.sign({ tid: 'x', role: 'THEKEDAR', perms: [], sid: 'x' }, 'not-the-secret-not-the-secret-123456', {
      audience: 'company',
      issuer: 'construction-api',
      subject: 'x',
    });
    expect((await api().get('/api/v1/auth/me').set(bearer(forged))).body.error.code).toBe('TOKEN_INVALID');

    const expired = jwt.sign(
      { tid: 'x', role: 'THEKEDAR', perms: [], sid: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
      process.env['JWT_ACCESS_SECRET']!,
      { audience: 'company', issuer: 'construction-api', subject: 'x' },
    );
    expect((await api().get('/api/v1/auth/me').set(bearer(expired))).body.error.code).toBe('TOKEN_EXPIRED');
  });
});
