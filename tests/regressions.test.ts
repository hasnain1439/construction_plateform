/**
 * Regression tests for issues found in the full review (live testing + code review).
 * Each block names the problem it guards against.
 */
import { describe, expect, it } from 'vitest';
import { testLogSink } from '../src/config/logger.js';
import { prismaAdmin } from '../src/core/db/prisma.js';
import { safeUrl } from '../src/core/utils/safeUrl.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { lastSmsTo } from '../src/modules/auth/sms.provider.js';
import {
  ageOtps,
  api,
  bearer,
  device,
  lastOtp,
  loginMobile,
  pathOf,
  pngBytes,
  refreshMobile,
  SEED,
  upload,
  useFreshDatabase,
} from './helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
const pm = () => loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
const me = (token: string) => api().get('/api/v1/auth/me').set(bearer(token));

describe('access tokens die with their login (not 15 min later)', () => {
  it('logout', async () => {
    const s = await owner();
    expect((await me(s.accessToken)).status).toBe(200);
    await api().post('/api/v1/auth/logout').set(bearer(s.accessToken));
    const res = await me(s.accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('logout-all ends every device', async () => {
    const a = await owner();
    const b = await owner();
    await api().post('/api/v1/auth/logout-all').set(bearer(a.accessToken));
    expect((await me(b.accessToken)).status).toBe(401);
  });

  it('deactivation', async () => {
    const o = await owner();
    const p = await pm();
    await api().delete(`/api/v1/users/${seeded().users.bilal.id}`).set(bearer(o.accessToken));
    const res = await api().get('/api/v1/users').set(bearer(p.accessToken));
    expect(res.status).toBe(401);
  });

  it('a user marked INACTIVE directly (sessions untouched) is still refused', async () => {
    const p = await pm();
    await prismaAdmin.user.update({ where: { id: seeded().users.bilal.id }, data: { status: 'INACTIVE' } });
    const res = await me(p.accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('device revoke', async () => {
    const o = await owner();
    const p = await pm();
    const dev = await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: p.deviceId } });
    await api().delete(`/api/v1/devices/${dev.id}`).set(bearer(o.accessToken));
    const res = await me(p.accessToken);
    expect(res.status).toBe(401);
    expect(['DEVICE_REVOKED', 'SESSION_REVOKED']).toContain(res.body.error.code);
  });

  it('password change ends other logins but keeps the current one', async () => {
    const a = await owner();
    const b = await owner();
    await api().patch('/api/v1/auth/me').set(bearer(a.accessToken)).send({ currentPassword: SEED.malik.owner.password, newPassword: 'Changed#2026' });
    expect((await me(a.accessToken)).status).toBe(200);
    expect((await me(b.accessToken)).status).toBe(401);
  });

  it('a normal refresh does NOT break the previous access token', async () => {
    const s = await owner();
    const r = await refreshMobile(s.refreshToken);
    expect(r.status).toBe(200);
    expect((await me(s.accessToken)).status).toBe(200);
    expect((await me(r.body.data.accessToken)).status).toBe(200);
  });

  it('refresh-token reuse kills access tokens of the whole family', async () => {
    const s = await owner();
    const r = await refreshMobile(s.refreshToken);
    await refreshMobile(s.refreshToken); // reuse
    expect((await me(r.body.data.accessToken)).status).toBe(401);
  });

  it('platform admin logout ends the admin access token', async () => {
    const login = await api().post('/api/v1/admin/auth/login').send({ email: SEED.admin.email, password: SEED.admin.password, client: 'mobile' });
    const token = login.body.data.accessToken as string;
    expect((await api().get('/api/v1/admin/auth/me').set(bearer(token))).status).toBe(200);
    await api().post('/api/v1/admin/auth/logout').set(bearer(token));
    const res = await api().get('/api/v1/admin/auth/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('refresh on a revoked device says DEVICE_REVOKED', () => {
  it('after DELETE /devices/:id', async () => {
    const o = await owner();
    const p = await pm();
    const dev = await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: p.deviceId } });
    await api().delete(`/api/v1/devices/${dev.id}`).set(bearer(o.accessToken));
    const res = await refreshMobile(p.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
  });
});

describe('password reset does not reveal companies without a valid code', () => {
  it('email shared by users with different phones', async () => {
    const { ahmed, malik } = seeded();
    const email = 'shared@example.pk';
    await prismaAdmin.user.update({ where: { id: seeded().users.khalid.id }, data: { email } });
    await prismaAdmin.user.updateMany({ where: { tenantId: ahmed.id, role: 'THEKEDAR' }, data: { email } });

    const blind = await api().post('/api/v1/auth/password/reset').send({ login: email, code: '000000', newPassword: 'Guess#2026' });
    expect(blind.status).toBe(400);
    expect(blind.body.error.code).toBe('OTP_INVALID');
    expect(JSON.stringify(blind.body)).not.toContain(SEED.malik.name);

    // A real code for Ahmed's phone resets Ahmed's password (not Khalid's)
    await api().post('/api/v1/auth/password/forgot').send({ login: email });
    const code = lastOtp(SEED.ahmed.owner.phone);
    const ok = await api().post('/api/v1/auth/password/reset').send({ login: email, code, newPassword: 'Ahmed#2027' });
    expect(ok.status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ login: SEED.ahmed.owner.phone, password: 'Ahmed#2027' })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password })).status).toBe(200);
    void malik;
  });

  it('same phone in two companies: the list only appears after the code is proven', async () => {
    const { users, malik } = seeded();
    const hash = await hashPassword('Rafaqat#2026');
    await prismaAdmin.user.updateMany({ where: { id: { in: [users.rafaqatMalik.id, users.rafaqatAhmed.id] } }, data: { passwordHash: hash } });
    const phone = SEED.malik.munshi.phone;
    const guess = await api().post('/api/v1/auth/password/reset').send({ login: phone, code: '000000', newPassword: 'Guess#2026' });
    expect(guess.status).toBe(400);

    await ageOtps(phone);
    await api().post('/api/v1/auth/password/forgot').send({ login: phone });
    const code = lastOtp(phone);
    const list = await api().post('/api/v1/auth/password/reset').send({ login: phone, code, newPassword: 'Rafaqat#2027' });
    expect(list.status).toBe(409);
    expect(list.body.error.code).toBe('MULTIPLE_COMPANIES');
    const picked = await api().post('/api/v1/auth/password/reset').send({ login: phone, code, newPassword: 'Rafaqat#2027', tenantId: malik.id });
    expect(picked.status).toBe(200);
  });
});

describe('OTP attempt limit holds under parallel guessing', () => {
  it('10 parallel wrong codes → at most 3 counted, then the code is dead', async () => {
    const phone = SEED.malik.owner.phone;
    await api().post('/api/v1/auth/otp/request').send({ phone });
    const code = lastOtp(phone);
    const wrong = code === '111111' ? '222222' : '111111';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api().post('/api/v1/auth/otp/verify').send({ phone, code: wrong, client: 'mobile', device: device() })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBe(1);
    expect(statuses.every((s) => s === 400 || s === 429)).toBe(true);
    const otp = await prismaAdmin.otpCode.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: 'desc' } });
    expect(otp.attempts).toBe(3);
    expect(otp.consumedAt).not.toBeNull();
    // The correct code no longer works
    expect((await api().post('/api/v1/auth/otp/verify').send({ phone, code, client: 'mobile', device: device() })).status).toBe(400);
  });
});

describe('invitation edge cases', () => {
  it('pending PM invites reserve a seat against promotions and reactivations', async () => {
    const { ahmed, users } = seeded(); // Starter: 3; owner = 1
    const s = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    await prismaAdmin.user.create({ data: { tenantId: ahmed.id, name: 'PM One', phone: '+923450000051', role: 'PM' } });
    expect((await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Seat Holder', phone: '+923450000052', role: 'PM' })).status).toBe(201);
    // 2 active + 1 pending PM = full
    const promote = await api().patch(`/api/v1/users/${users.rafaqatAhmed.id}`).set(bearer(s.accessToken)).send({ role: 'PM' });
    expect(promote.status).toBe(402);
  });

  it('invite with an email already used by a member → 409 EMAIL_TAKEN', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Copy Cat', phone: '+923450000061', email: 'khalid@maliksons.pk', role: 'MUNSHI' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it("resending an old expired invite is refused while a newer one is pending", async () => {
    const s = await owner();
    const first = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Twice', phone: '+923450000071', role: 'MUNSHI' });
    await prismaAdmin.invitation.update({ where: { id: first.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 120_000) } });
    const second = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Twice', phone: '+923450000071', role: 'MUNSHI' });
    expect(second.status).toBe(201);
    const resend = await api().post(`/api/v1/invitations/${first.body.data.id}/resend`).set(bearer(s.accessToken));
    expect(resend.status).toBe(409);
    expect(resend.body.error.code).toBe('INVITE_PENDING');
  });

  it('a link replaced by a resend stops working even if read just before', async () => {
    const s = await owner();
    const inv = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Old Link', phone: '+923450000081', role: 'MUNSHI' });
    const oldToken = /\/invite\/([A-Za-z0-9_-]+)/.exec(lastSmsTo('+923450000081')!.body)![1]!;
    await prismaAdmin.invitation.update({ where: { id: inv.body.data.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await api().post(`/api/v1/invitations/${inv.body.data.id}/resend`).set(bearer(s.accessToken));
    expect((await api().post(`/api/v1/invitations/${oldToken}/accept`).send({ client: 'web' })).status).toBe(404);
  });

  it('cancel and accept racing: exactly one wins and the row stays consistent', async () => {
    const s = await owner();
    const inv = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Racer', phone: '+923450000091', role: 'MUNSHI' });
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(lastSmsTo('+923450000091')!.body)![1]!;
    const [cancel, accept] = await Promise.all([
      api().delete(`/api/v1/invitations/${inv.body.data.id}`).set(bearer(s.accessToken)),
      api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'web' }),
    ]);
    const row = await prismaAdmin.invitation.findUniqueOrThrow({ where: { id: inv.body.data.id } });
    const member = await prismaAdmin.user.findFirst({ where: { phone: '+923450000091' } });
    if (accept.status === 201) {
      expect(cancel.status).toBe(409);
      expect(row.status).toBe('ACCEPTED');
      expect(member).not.toBeNull();
    } else {
      expect(cancel.status).toBe(200);
      expect(accept.status).toBe(410);
      expect(row.status).toBe('CANCELLED');
      expect(member).toBeNull();
    }
  });
});

describe('concurrency on team endpoints', () => {
  it('parallel PUT /users/:id/projects never errors and leaves one consistent list', async () => {
    const s = await owner();
    const { users, projects } = seeded();
    const bodies = [[projects.dha.id], [projects.bahria.id], [projects.dha.id, projects.bahria.id], []];
    const res = await Promise.all(bodies.map((projectIds) => api().put(`/api/v1/users/${users.bilal.id}/projects`).set(bearer(s.accessToken)).send({ projectIds })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });
});

describe('secrets stay out of logs', () => {
  it('safeUrl strips invitation tokens and signed-link queries, keeps invitation ids', () => {
    expect(safeUrl('/api/v1/invitations/abcDEF123_-xyz/accept')).toBe('/api/v1/invitations/[REDACTED]/accept');
    expect(safeUrl('/api/v1/invitations/0199a8c0-0000-7000-8000-000000000001/resend')).toBe('/api/v1/invitations/0199a8c0-0000-7000-8000-000000000001/resend');
    expect(safeUrl('/api/v1/attachments/x/file?tid=a&exp=1&sig=SECRET')).toBe('/api/v1/attachments/x/file?[REDACTED]');
    expect(safeUrl('/api/v1/users?page=2')).toBe('/api/v1/users?page=2');
  });

  it('a signed file download does not log the signature; error codes are logged', async () => {
    const s = await owner();
    const up = await upload(s.accessToken, 'LOGO', pngBytes());
    const sig = new URL(up.body.data.url).searchParams.get('sig')!;
    testLogSink.length = 0;
    await api().get(pathOf(up.body.data.url));
    await api().post('/api/v1/auth/login').send({ login: SEED.malik.owner.phone, password: 'Wrong#2026' });
    const output = testLogSink.join('\n');
    expect(output).not.toContain(sig);
    expect(output).toContain('"errorCode":"INVALID_CREDENTIALS"');
  });
});
