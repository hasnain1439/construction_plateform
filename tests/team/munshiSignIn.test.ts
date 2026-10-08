import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, device, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const asif = () => prismaAdmin.user.findFirstOrThrow({ where: { phone: SEED.malik.munshi2.phone } });

describe('munshi sign-in without SMS', () => {
  it('the owner gets a login code for a munshi; the munshi signs in with it (once)', async () => {
    const munshi = await asif();
    const res = await api().post(`/api/v1/users/${munshi.id}/login-code`).set(await owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone: munshi.phone, code: expect.stringMatching(/^\d{6}$/), expiresIn: expect.any(Number) });

    const verify = () => api().post('/api/v1/auth/otp/verify').send({ phone: munshi.phone, code: res.body.data.code, client: 'mobile', device: device() });
    const signedIn = await verify();
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: munshi.id, role: 'MUNSHI' });
    expect(signedIn.body.data.accessToken).toBeTruthy();
    expect((await verify()).status).not.toBe(200); // one use

    // Audited — without the code.
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'user.login_code_issued', entityId: munshi.id } });
    expect(JSON.stringify(audit)).not.toContain(res.body.data.code);
  });

  it('only for a munshi of the same company, by the owner', async () => {
    const s = seeded();
    const auth = await owner();
    const pm = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: s.malik.id, role: 'PM' } });
    expect((await api().post(`/api/v1/users/${pm.id}/login-code`).set(auth)).body.error.code).toBe('LOGIN_CODE_MUNSHI_ONLY');
    const otherCompany = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: s.ahmed.id, role: 'MUNSHI' } });
    expect((await api().post(`/api/v1/users/${otherCompany.id}/login-code`).set(auth)).status).toBe(404);
    const asPm = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    expect((await api().post(`/api/v1/users/${(await asif()).id}/login-code`).set(asPm)).status).toBe(403);
  });

  it('the owner sets a munshi password; the munshi then signs in with phone + password', async () => {
    const munshi = await asif();
    const login = () => api().post('/api/v1/auth/login').send({ login: munshi.phone, password: 'Asif#2026', client: 'mobile', device: device() });
    expect((await login()).status).not.toBe(200);
    const set = await api().put(`/api/v1/users/${munshi.id}/password`).set(await owner()).send({ password: 'Asif#2026' });
    expect(set.status).toBe(200);
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: munshi.id, role: 'MUNSHI' });
    // A weak password is refused; office users set their own.
    expect((await api().put(`/api/v1/users/${munshi.id}/password`).set(await owner()).send({ password: '123' })).status).toBe(400);
    const pm = await prismaAdmin.user.findFirstOrThrow({ where: { phone: SEED.malik.pm.phone } });
    expect((await api().put(`/api/v1/users/${pm.id}/password`).set(await owner()).send({ password: 'Asif#2026' })).body.error.code).toBe('PASSWORD_MUNSHI_ONLY');
  });
});
