import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, device, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();

const body = {
  companyName: 'Malik & Sons Builders',
  ownerName: 'Usman Tariq',
  phone: '+92 345 7654321',
  email: 'Usman@Example.PK',
  password: 'Builder#2026',
  region: 'KARACHI_SINDH',
  marlaStandard: 272.25,
  client: 'mobile',
  device: device(),
};

describe('POST /auth/signup', () => {
  it('creates tenant, settings, 14-day trial subscription and THEKEDAR owner, and returns tokens', async () => {
    const res = await api().post('/api/v1/auth/signup').send(body);

    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data.accessToken).toEqual(expect.any(String));
    expect(data.refreshToken).toEqual(expect.any(String));
    expect(data.accessTokenExpiresIn).toBe(900);
    expect(data.user).toMatchObject({ name: 'Usman Tariq', phone: '+923457654321', email: 'usman@example.pk', role: 'THEKEDAR' });
    // Slug collides with the seeded company → suffixed
    expect(data.tenant).toMatchObject({ name: 'Malik & Sons Builders', slug: 'malik-and-sons-builders-2', region: 'KARACHI_SINDH', marlaStandard: 272.25, readOnly: false });
    expect(data.subscription).toMatchObject({ plan: { code: 'TRIAL' }, status: 'TRIAL' });
    expect(data.permissions).toContain('users.manage');

    const tenant = await prismaAdmin.tenant.findUniqueOrThrow({
      where: { id: data.tenant.id },
      include: { settings: true, subscription: true, users: true, sessions: true, devices: true, auditLogs: true },
    });
    expect(tenant.settings).not.toBeNull();
    expect(tenant.users).toHaveLength(1);
    expect(tenant.users[0]!.passwordHash).not.toContain('Builder#2026');
    expect(tenant.sessions).toHaveLength(1);
    expect(tenant.devices).toHaveLength(1);
    expect(tenant.auditLogs.map((a) => a.action)).toContain('tenant.signup');

    const trialMs = tenant.subscription!.trialEndsAt!.getTime() - Date.now();
    expect(trialMs).toBeGreaterThan(13.9 * 86_400_000);
    expect(trialMs).toBeLessThanOrEqual(14 * 86_400_000);

    // Refresh token is stored hashed only
    expect(tenant.sessions[0]!.tokenHash).not.toBe(data.refreshToken);
  });

  it('rejects a phone that already owns a company with 409 PHONE_TAKEN', async () => {
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...body, phone: '0300-1234567', device: device() }); // Khalid (seeded THEKEDAR)
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_TAKEN');

    const first = await api().post('/api/v1/auth/signup').send({ ...body, device: device() });
    expect(first.status).toBe(201);
    const second = await api().post('/api/v1/auth/signup').send({ ...body, companyName: 'Another Co', device: device() });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PHONE_TAKEN');
  });

  it('validates input with field errors', async () => {
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ companyName: 'X', ownerName: 'Al', phone: '12345', password: 'short', region: 'LAHORE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.fields.map((f: { field: string }) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['companyName', 'phone', 'password', 'region']));
  });

  it('web signup sets cookies instead of returning tokens', async () => {
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...body, phone: '03451112222', client: 'web', device: undefined });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeUndefined();
    expect(String(res.headers['set-cookie'])).toContain('access_token=');
    expect(SEED.malik.slug).toBe('malik-and-sons-builders');
  });
});
