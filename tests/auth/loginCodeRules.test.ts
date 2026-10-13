import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { ageOtps, api, bearer, device, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const asif = () => prismaAdmin.user.findFirstOrThrow({ where: { phone: SEED.malik.munshi2.phone } });
const issue = async (userId: string) => api().post(`/api/v1/users/${userId}/login-code`).set(await owner());
const verify = (phone: string, code: string) => api().post('/api/v1/auth/otp/verify').send({ phone, code, client: 'mobile', device: device() });

describe('munshi login codes: one use, ≤ 10 minutes, limited tries', () => {
  it('lasts at most 10 minutes (expiresIn and the stored expiry)', async () => {
    const munshi = await asif();
    const before = Date.now();
    const res = await issue(munshi.id);
    expect(res.status).toBe(200);
    expect(res.body.data.expiresIn).toBeLessThanOrEqual(600);
    const otp = await prismaAdmin.otpCode.findFirstOrThrow({ where: { phone: munshi.phone, consumedAt: null } });
    expect(otp.expiresAt.getTime() - before).toBeLessThanOrEqual(600_000 + 5_000);
  });

  it('wrong guesses burn the code: after 3 (≤ 5) the right code no longer works', async () => {
    const munshi = await asif();
    const { code } = (await issue(munshi.id)).body.data as { code: string };
    const wrong = code === '000000' ? '111111' : '000000';
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await verify(munshi.phone, wrong)).status);
    expect(statuses).toEqual([400, 400, 429]);
    expect((await verify(munshi.phone, code)).status).toBe(400);
  });

  it('a new code replaces the old one; an expired code is refused', async () => {
    const munshi = await asif();
    const first = (await issue(munshi.id)).body.data.code as string;
    await ageOtps(munshi.phone, 61);
    const second = (await issue(munshi.id)).body.data.code as string;
    if (first !== second) expect((await verify(munshi.phone, first)).status).toBe(400);

    await prismaAdmin.otpCode.updateMany({ where: { phone: munshi.phone, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await verify(munshi.phone, second);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('OTP_EXPIRED');
  });

  it('two sign-ins racing with the same code: only one wins', async () => {
    const munshi = await asif();
    const { code } = (await issue(munshi.id)).body.data as { code: string };
    const results = await Promise.all([verify(munshi.phone, code), verify(munshi.phone, code)]);
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
  });
});
