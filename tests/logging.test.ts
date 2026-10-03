import { describe, expect, it, vi } from 'vitest';
import { logger, testLogSink } from '../src/config/logger.js';
import { api, bearer, device, lastOtp, loginMobile, refreshMobile, SEED, useFreshDatabase } from './helpers.js';

useFreshDatabase();

/** Matches a 6-digit code only when it is not part of a longer number (e.g. a timestamp). */
const standalone = (digits: string) => new RegExp(`(?<!\\d)${digits}(?!\\d)`);

describe('logs never contain secrets', () => {
  it('passwords, tokens, cookies and OTP codes are absent from every log line', async () => {
    testLogSink.length = 0;
    const logSpy = vi.spyOn(logger, 'info');
    const secrets: string[] = [];
    const codes: string[] = [];
    const { owner } = SEED.malik;

    // Password login (web + mobile) and a failed attempt
    const web = await api().post('/api/v1/auth/login').send({ login: owner.phone, password: owner.password });
    const cookieHeader = (web.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    secrets.push(owner.password, ...cookieHeader.map((c) => c.split('=')[1]!));
    await api().get('/api/v1/auth/me').set('Cookie', cookieHeader.join('; '));
    await api().post('/api/v1/auth/login').send({ login: owner.phone, password: 'Wrong#Password1' });
    secrets.push('Wrong#Password1');

    const mobile = await loginMobile(owner.phone, owner.password);
    secrets.push(mobile.accessToken, mobile.refreshToken);
    const rotated = await refreshMobile(mobile.refreshToken);
    secrets.push(rotated.body.data.accessToken, rotated.body.data.refreshToken);
    await refreshMobile(mobile.refreshToken); // reuse → warn log

    // OTP flow
    await api().post('/api/v1/auth/otp/request').send({ phone: owner.phone });
    const otp = lastOtp(owner.phone);
    codes.push(otp);
    await api().post('/api/v1/auth/otp/verify').send({ phone: owner.phone, code: otp, client: 'mobile', device: device() });

    // Forgot / reset
    await api().post('/api/v1/auth/password/forgot').send({ login: owner.phone });
    const resetCode = lastOtp(owner.phone);
    codes.push(resetCode);
    await api().post('/api/v1/auth/password/reset').send({ login: owner.phone, code: resetCode, newPassword: 'Brand#New2026' });
    secrets.push('Brand#New2026');

    // Password change + invitation token in the URL
    const s = await loginMobile(owner.phone, 'Brand#New2026');
    await api().patch('/api/v1/auth/me').set(bearer(s.accessToken)).send({ currentPassword: 'Brand#New2026', newPassword: 'Second#2026' });
    secrets.push('Second#2026', SEED.invitation.token);
    await api().post(`/api/v1/invitations/${SEED.invitation.token}/accept`).send({ password: 'Kamran#2026' });
    secrets.push('Kamran#2026');

    // Explicitly logging sensitive objects is redacted too
    logger.info({ password: 'Direct#Leak1', body: { refreshToken: 'direct-leak-token-xyz' } }, 'manual');
    secrets.push('Direct#Leak1', 'direct-leak-token-xyz');

    const output = testLogSink.join('\n');
    expect(testLogSink.length).toBeGreaterThan(10);
    expect(logSpy).toHaveBeenCalled();
    for (const secret of secrets) expect(output, `leaked: ${secret.slice(0, 12)}…`).not.toContain(secret);
    for (const code of codes) expect(output).not.toMatch(standalone(code));
    expect(output).not.toMatch(/"authorization"/i);
    expect(output).not.toMatch(/"cookie"/i);
    expect(output).toContain('[REDACTED]');
    logSpy.mockRestore();
  });
});
