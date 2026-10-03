import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { hashPassword } from '../../src/modules/auth/auth.service.js';
import { api, device, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const { owner, pm } = SEED.malik;

function cookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
}

describe('POST /auth/login', () => {
  it('web login sets httpOnly access and refresh cookies, no tokens in body', async () => {
    const res = await api().post('/api/v1/auth/login').send({ login: '0300 1234567', password: owner.password });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.user.role).toBe('THEKEDAR');

    const set = cookies(res);
    const access = set.find((c) => c.startsWith('access_token='));
    const refresh = set.find((c) => c.startsWith('refresh_token='));
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);

    // The cookie alone authenticates
    const me = await api().get('/api/v1/auth/me').set('Cookie', access!.split(';')[0]!);
    expect(me.status).toBe(200);
  });

  it('mobile login returns tokens in the body and sets no cookies', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ login: owner.email, password: owner.password, client: 'mobile', device: device() });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.accessTokenExpiresIn).toBe(900);
    expect(cookies(res)).toHaveLength(0);
  });

  it('same error for unknown login and wrong password', async () => {
    const unknown = await api().post('/api/v1/auth/login').send({ login: '03009999999', password: 'Whatever#1' });
    const wrong = await api().post('/api/v1/auth/login').send({ login: owner.phone, password: 'Wrong#2026' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 wrong passwords (423), even for the correct password', async () => {
    for (let i = 1; i <= 4; i++) {
      const res = await api().post('/api/v1/auth/login').send({ login: pm.phone, password: `Wrong#${i}` });
      expect(res.status).toBe(401);
    }
    const fifth = await api().post('/api/v1/auth/login').send({ login: pm.phone, password: 'Wrong#5' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(14 * 60);

    const correct = await api().post('/api/v1/auth/login').send({ login: pm.phone, password: pm.password });
    expect(correct.status).toBe(423);
    expect(correct.body.error.code).toBe('ACCOUNT_LOCKED');

    const failures = await prismaAdmin.auditLog.count({ where: { action: 'auth.login_failed', actorId: seeded().users.bilal.id } });
    expect(failures).toBe(5);

    // Once the lock expires, the correct password works and the counter resets.
    await prismaAdmin.user.update({ where: { id: seeded().users.bilal.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const after = await api().post('/api/v1/auth/login').send({ login: pm.phone, password: pm.password });
    expect(after.status).toBe(200);
    const bilal = await prismaAdmin.user.findUniqueOrThrow({ where: { id: seeded().users.bilal.id } });
    expect(bilal.failedLoginCount).toBe(0);
    expect(bilal.lockedUntil).toBeNull();
  });

  it('OTP-only users are told to use OTP login', async () => {
    const { users } = seeded();
    // Remove Rafaqat's second company so the phone matches a single user
    await prismaAdmin.user.delete({ where: { id: users.rafaqatAhmed.id } });
    const res = await api().post('/api/v1/auth/login').send({ login: SEED.malik.munshi.phone, password: 'Anything#1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('USE_OTP_LOGIN');
  });

  it('MULTIPLE_COMPANIES when the password matches in several companies; tenantId picks one', async () => {
    const { users, malik, ahmed } = seeded();
    const passwordHash = await hashPassword('Rafaqat#2026');
    await prismaAdmin.user.updateMany({
      where: { id: { in: [users.rafaqatMalik.id, users.rafaqatAhmed.id] } },
      data: { passwordHash },
    });

    const res = await api().post('/api/v1/auth/login').send({ login: SEED.malik.munshi.phone, password: 'Rafaqat#2026' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MULTIPLE_COMPANIES');
    expect(res.body.error.details.companies).toEqual(
      expect.arrayContaining([
        { tenantId: malik.id, name: SEED.malik.name, role: 'MUNSHI' },
        { tenantId: ahmed.id, name: SEED.ahmed.name, role: 'MUNSHI' },
      ]),
    );

    const picked = await api()
      .post('/api/v1/auth/login')
      .send({ login: SEED.malik.munshi.phone, password: 'Rafaqat#2026', tenantId: ahmed.id });
    expect(picked.status).toBe(200);
    expect(picked.body.data.tenant.id).toBe(ahmed.id);
  });

  it('records device, session and audit on success', async () => {
    const dev = device('IOS');
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ login: owner.phone, password: owner.password, client: 'mobile', device: dev });
    expect(res.status).toBe(200);
    const { khalid } = seeded().users;
    const deviceRow = await prismaAdmin.device.findUniqueOrThrow({
      where: { userId_clientDeviceId: { userId: khalid.id, clientDeviceId: dev.deviceId } },
    });
    expect(deviceRow.platform).toBe('IOS');
    expect(await prismaAdmin.session.count({ where: { deviceId: deviceRow.id } })).toBe(1);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'auth.login', actorId: khalid.id } })).toBe(1);
  });
});
