import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { ageOtps, api, bearer, lastOtp, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();

const phone = SEED.malik.munshi.phone;
const phoneDevice = (id: string) => ({ deviceId: id, platform: 'ANDROID', model: 'Infinix Hot 30', appVersion: '1.0.0' });

async function otpLogin(device: ReturnType<typeof phoneDevice>) {
  await ageOtps(phone, 120);
  expect((await api().post('/api/v1/auth/otp/request').send({ phone })).status).toBe(200);
  return api().post('/api/v1/auth/otp/verify').send({ phone, code: lastOtp(phone), tenantId: seeded().malik.id, client: 'mobile', device });
}

describe('mobile auth', () => {
  it('GET /auth/mobile-config is public', async () => {
    const res = await api().get('/api/v1/auth/mobile-config');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ minimumAppVersion: '1.0.0', apiVersion: 'v1', otpLength: 6, otpResendSeconds: 60, maxUploadBytes: 2 * 1024 * 1024, features: { offlineSync: true } });
  });

  it('OTP login gives tokens in the body, registers the phone; refresh rotates once', async () => {
    const res = await otpLogin(phoneDevice('infinix-hot30-0001'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: 'infinix-hot30-0001' } })).toMatchObject({ platform: 'ANDROID', model: 'Infinix Hot 30', appVersion: '1.0.0', revokedAt: null });
    const first = await refreshMobile(res.body.data.refreshToken);
    expect(first.status).toBe(200);
    // Using the old refresh token again is token reuse → the whole family is ended.
    expect((await refreshMobile(res.body.data.refreshToken)).status).toBe(401);
    expect((await refreshMobile(first.body.data.refreshToken)).status).toBe(401);
  });

  it('a phone the office revoked cannot sign in, pull or push again; a fresh install can sign in', async () => {
    const res = await otpLogin(phoneDevice('lost-phone-0001'));
    const auth = bearer(res.body.data.accessToken);
    await prismaAdmin.device.updateMany({ where: { clientDeviceId: 'lost-phone-0001' }, data: { revokedAt: new Date() } });
    expect((await api().get('/api/v1/sync/pull').set(auth)).body.error.code).toBe('DEVICE_REVOKED');
    expect((await api().post('/api/v1/sync/push').set(auth).send({ mutations: [{ clientId: '0199a8c0-0000-7000-8000-00000000ff01', type: 'WORKER_CREATE', payload: { name: 'Naveed', type: 'MAZDOOR' } }] })).body.error.code).toBe(
      'DEVICE_REVOKED',
    );
    const again = await otpLogin(phoneDevice('lost-phone-0001'));
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('DEVICE_REVOKED');
    expect((await otpLogin(phoneDevice('new-install-0002'))).status).toBe(200);
  });
});
