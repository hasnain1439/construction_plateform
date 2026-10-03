import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { ageOtps, api, device, lastOtp, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const RAFAQAT = SEED.malik.munshi.phone;
const KHALID = SEED.malik.owner.phone;

const request = (phone: string) => api().post('/api/v1/auth/otp/request').send({ phone });
const verify = (phone: string, code: string, extra: Record<string, unknown> = {}) =>
  api().post('/api/v1/auth/otp/verify').send({ phone, code, client: 'mobile', device: device(), ...extra });

describe('OTP login', () => {
  it('request → verify signs in (single company)', async () => {
    const req = await request('0300-1234567');
    expect(req.status).toBe(200);
    expect(req.body.data).toEqual({ sent: true, expiresIn: 300, resendAfter: 60 });

    const res = await verify(KHALID, lastOtp(KHALID));
    expect(res.status).toBe(200);
    expect(res.body.data.user.phone).toBe(KHALID);
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    const otp = await prismaAdmin.otpCode.findFirstOrThrow({ where: { phone: KHALID } });
    expect(otp.consumedAt).not.toBeNull();
    expect(otp.tenantId).toBe(seeded().malik.id);
    expect(otp.codeHash).not.toBe(lastOtp(KHALID));
    expect(await prismaAdmin.auditLog.count({ where: { action: 'auth.otp_verified' } })).toBe(1);

    // A consumed code cannot be reused
    const again = await verify(KHALID, lastOtp(KHALID));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('OTP_INVALID');
  });

  it('MULTIPLE_COMPANIES for Rafaqat; resending with tenantId succeeds with the same code', async () => {
    await request(RAFAQAT);
    const code = lastOtp(RAFAQAT);

    const res = await verify(RAFAQAT, code);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MULTIPLE_COMPANIES');
    const companies = res.body.error.details.companies as Array<{ tenantId: string; name: string; role: string }>;
    expect(companies.map((c) => c.name).sort()).toEqual([SEED.ahmed.name, SEED.malik.name].sort());
    expect(companies.every((c) => c.role === 'MUNSHI')).toBe(true);

    const picked = await verify(RAFAQAT, code, { tenantId: seeded().malik.id });
    expect(picked.status).toBe(200);
    expect(picked.body.data.tenant.id).toBe(seeded().malik.id);
    expect(picked.body.data.permissions).toEqual(['site.entry']);
  });

  it('unknown phone → 404 PHONE_NOT_REGISTERED', async () => {
    const res = await request('03119876543');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PHONE_NOT_REGISTERED');
  });

  it('3 wrong codes → 429 and the code is invalidated', async () => {
    await request(KHALID);
    const code = lastOtp(KHALID);
    const wrong = code === '000000' ? '111111' : '000000';

    const first = await verify(KHALID, wrong);
    expect(first.status).toBe(400);
    expect(first.body.error.code).toBe('OTP_INVALID');
    expect(first.body.error.details.attemptsLeft).toBe(2);
    expect((await verify(KHALID, wrong)).status).toBe(400);
    const third = await verify(KHALID, wrong);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');

    const correctAfter = await verify(KHALID, code);
    expect(correctAfter.status).toBe(400);
  });

  it('expired code → 410 OTP_EXPIRED', async () => {
    await request(KHALID);
    await prismaAdmin.otpCode.updateMany({ where: { phone: KHALID }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(KHALID, lastOtp(KHALID));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('resend inside 60 s → 429 OTP_RESEND_WAIT; allowed afterwards; max 5 per hour', async () => {
    expect((await request(KHALID)).status).toBe(200);
    const early = await request(KHALID);
    expect(early.status).toBe(429);
    expect(early.body.error.code).toBe('OTP_RESEND_WAIT');
    expect(early.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(early.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(60);

    const old = lastOtp(KHALID);
    await ageOtps(KHALID, 61);
    expect((await request(KHALID)).status).toBe(200);
    // The previous code was invalidated by the resend
    const fresh = lastOtp(KHALID);
    if (fresh !== old) expect((await verify(KHALID, old)).status).toBe(400);

    for (let i = 0; i < 3; i++) {
      await ageOtps(KHALID, 61);
      expect((await request(KHALID)).status).toBe(200);
    }
    await prismaAdmin.$executeRaw`UPDATE "OtpCode" SET "lastSentAt" = now() - interval '2 minutes' WHERE phone = ${KHALID}`;
    const sixth = await request(KHALID);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('OTP_LIMIT_REACHED');
  });
});
