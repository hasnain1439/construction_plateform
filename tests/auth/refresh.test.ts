import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const { owner } = SEED.malik;

describe('POST /auth/refresh', () => {
  it('rotates: new tokens each time, old session revoked and linked', async () => {
    const session = await loginMobile(owner.phone, owner.password);

    const first = await refreshMobile(session.refreshToken);
    expect(first.status).toBe(200);
    const rt2 = first.body.data.refreshToken as string;
    expect(rt2).toEqual(expect.any(String));
    expect(rt2).not.toBe(session.refreshToken);
    expect(first.body.data.accessToken).toEqual(expect.any(String));

    const me = await api().get('/api/v1/auth/me').set(bearer(first.body.data.accessToken));
    expect(me.status).toBe(200);

    const sessions = await prismaAdmin.session.findMany({ where: { userId: seeded().users.khalid.id }, orderBy: { createdAt: 'asc' } });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[0]!.replacedById).toBe(sessions[1]!.id);
    expect(sessions[1]!.familyId).toBe(sessions[0]!.familyId);
    expect(sessions[1]!.revokedAt).toBeNull();

    const second = await refreshMobile(rt2);
    expect(second.status).toBe(200);
  });

  it('re-using a rotated token → 401 REFRESH_TOKEN_REUSED and revokes the whole family', async () => {
    const session = await loginMobile(owner.phone, owner.password);
    const rotated = await refreshMobile(session.refreshToken);
    const rt2 = rotated.body.data.refreshToken as string;

    const reuse = await refreshMobile(session.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    const family = await prismaAdmin.session.findMany({ where: { userId: seeded().users.khalid.id } });
    expect(family.every((s) => s.revokedAt !== null)).toBe(true);

    // The legitimate holder's newest token is dead too
    const afterwards = await refreshMobile(rt2);
    expect(afterwards.status).toBe(401);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } })).toBe(1);
  });

  it('other families are untouched by reuse detection', async () => {
    const a = await loginMobile(owner.phone, owner.password);
    const b = await loginMobile(owner.phone, owner.password);
    await refreshMobile(a.refreshToken);
    expect((await refreshMobile(a.refreshToken)).body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await refreshMobile(b.refreshToken)).status).toBe(200);
  });

  it('a revoked device cannot refresh → 401 DEVICE_REVOKED', async () => {
    const session = await loginMobile(owner.phone, owner.password);
    await prismaAdmin.device.update({
      where: { userId_clientDeviceId: { userId: seeded().users.khalid.id, clientDeviceId: session.deviceId } },
      data: { revokedAt: new Date() },
    });
    const res = await refreshMobile(session.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
  });

  it('garbage / missing token → 401 REFRESH_INVALID', async () => {
    const res = await refreshMobile('x'.repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_INVALID');
    const web = await api().post('/api/v1/auth/refresh').send({});
    expect(web.status).toBe(401);
    expect(web.body.error.code).toBe('REFRESH_INVALID');
  });

  it('web refresh reads the cookie and sets new cookies', async () => {
    const login = await api().post('/api/v1/auth/login').send({ login: owner.phone, password: owner.password });
    const set = login.headers['set-cookie'] as unknown as string[];
    const refreshCookie = set.find((c) => c.startsWith('refresh_token='))!.split(';')[0]!;

    const res = await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    const newSet = res.headers['set-cookie'] as unknown as string[];
    expect(newSet.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(newSet.find((c) => c.startsWith('refresh_token='))!.split(';')[0]).not.toBe(refreshCookie);
  });

  it('logout revokes the session; logout-all revokes every session', async () => {
    const a = await loginMobile(owner.phone, owner.password);
    const b = await loginMobile(owner.phone, owner.password);
    const c = await loginMobile(owner.phone, owner.password);

    const out = await api().post('/api/v1/auth/logout').set(bearer(a.accessToken));
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ loggedOut: true });
    expect((await refreshMobile(a.refreshToken)).status).toBe(401);
    expect((await refreshMobile(b.refreshToken)).status).toBe(200);

    const all = await api().post('/api/v1/auth/logout-all').set(bearer(c.accessToken));
    expect(all.status).toBe(200);
    expect((await refreshMobile(c.refreshToken)).status).toBe(401);
    expect(await prismaAdmin.session.count({ where: { userId: seeded().users.khalid.id, revokedAt: null } })).toBe(0);
  });
});
