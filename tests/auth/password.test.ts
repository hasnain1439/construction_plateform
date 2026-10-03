import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { mailProvider, ConsoleMailProvider } from '../../src/modules/auth/mail.provider.js';
import { api, lastOtp, loginMobile, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const { owner } = SEED.malik;

describe('forgot / reset password', () => {
  it('unknown login still answers { sent: true } and sends nothing', async () => {
    const res = await api().post('/api/v1/auth/password/forgot').send({ login: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true });
    expect(await prismaAdmin.otpCode.count()).toBe(0);
  });

  it('reset with the SMS code sets the password and revokes ALL sessions', async () => {
    const a = await loginMobile(owner.phone, owner.password);
    const b = await loginMobile(owner.phone, owner.password);

    const forgot = await api().post('/api/v1/auth/password/forgot').send({ login: owner.email });
    expect(forgot.body.data).toEqual({ sent: true });
    const code = lastOtp(owner.phone);

    // Email copy carries the same code
    const mail = mailProvider() as ConsoleMailProvider;
    expect(mail.outbox.at(-1)).toMatchObject({ to: owner.email });
    expect(mail.outbox.at(-1)!.text).toContain(code);

    const reset = await api()
      .post('/api/v1/auth/password/reset')
      .send({ login: owner.phone, code, newPassword: 'Reset#2026' });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toEqual({ reset: true });

    expect((await refreshMobile(a.refreshToken)).status).toBe(401);
    expect((await refreshMobile(b.refreshToken)).status).toBe(401);
    expect(await prismaAdmin.session.count({ where: { userId: seeded().users.khalid.id, revokedAt: null } })).toBe(0);

    expect((await api().post('/api/v1/auth/login').send({ login: owner.phone, password: 'Reset#2026' })).status).toBe(200);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'auth.password_reset' } })).toBe(1);

    // Code is single-use
    const again = await api().post('/api/v1/auth/password/reset').send({ login: owner.phone, code, newPassword: 'Again#2026' });
    expect(again.status).toBe(400);
  });

  it('reset clears an account lock', async () => {
    await prismaAdmin.user.update({
      where: { id: seeded().users.khalid.id },
      data: { lockedUntil: new Date(Date.now() + 600_000), failedLoginCount: 0 },
    });
    await api().post('/api/v1/auth/password/forgot').send({ login: owner.phone });
    const res = await api()
      .post('/api/v1/auth/password/reset')
      .send({ login: owner.phone, code: lastOtp(owner.phone), newPassword: 'Unlock#2026' });
    expect(res.status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ login: owner.phone, password: 'Unlock#2026' })).status).toBe(200);
  });

  it('wrong reset code → 400 OTP_INVALID; weak password → 400 VALIDATION_ERROR', async () => {
    await api().post('/api/v1/auth/password/forgot').send({ login: owner.phone });
    const code = lastOtp(owner.phone);
    const wrong = await api()
      .post('/api/v1/auth/password/reset')
      .send({ login: owner.phone, code: code === '999999' ? '111111' : '999999', newPassword: 'Reset#2026' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('OTP_INVALID');

    const weak = await api().post('/api/v1/auth/password/reset').send({ login: owner.phone, code, newPassword: 'password' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });
});
