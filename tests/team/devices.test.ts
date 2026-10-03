import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);

async function deviceIdFor(clientDeviceId: string) {
  return (await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId } })).id;
}

describe('devices', () => {
  it('lists devices with user, sync fields and the current flag', async () => {
    const a = await owner();
    await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    const res = await api().get('/api/v1/devices').set(bearer(a.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    const mine = res.body.data.find((d: { current: boolean }) => d.current);
    expect(mine).toMatchObject({ user: { name: 'Khalid Malik', role: 'THEKEDAR' }, platform: 'ANDROID', pendingUploads: 0, lastSyncAt: null, revokedAt: null });
    expect(res.body.data.filter((d: { current: boolean }) => d.current)).toHaveLength(1);

    const filtered = await api().get(`/api/v1/devices?userId=${seeded().users.bilal.id}`).set(bearer(a.accessToken));
    expect(filtered.body.data.map((d: { user: { name: string } }) => d.user.name)).toEqual(['Bilal Ahmed']);
  });

  it('revoking a device ends its sessions → refresh 401 DEVICE_REVOKED', async () => {
    const a = await owner();
    const b = await owner();
    const id = await deviceIdFor(b.deviceId);
    const res = await api().delete(`/api/v1/devices/${id}`).set(bearer(a.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.revokedAt).toEqual(expect.any(String));

    const refresh = await refreshMobile(b.refreshToken);
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('DEVICE_REVOKED');
    expect(await prismaAdmin.session.count({ where: { deviceId: id, revokedAt: null } })).toBe(0);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'device.revoke', entityId: id } })).toBe(1);
    // Other device unaffected
    expect((await refreshMobile(a.refreshToken)).status).toBe(200);
  });

  it('a device revoked while its session is still open answers DEVICE_REVOKED', async () => {
    const a = await owner();
    const b = await owner();
    const id = await deviceIdFor(b.deviceId);
    // Revoke only the device row (as an admin tool might) — refresh must still refuse.
    await prismaAdmin.device.update({ where: { id }, data: { revokedAt: new Date() } });
    const refresh = await refreshMobile(b.refreshToken);
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('DEVICE_REVOKED');
    void a;
  });

  it('cannot revoke the current device (400)', async () => {
    const a = await owner();
    const id = await deviceIdFor(a.deviceId);
    const res = await api().delete(`/api/v1/devices/${id}`).set(bearer(a.accessToken));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_REVOKE_CURRENT_DEVICE');
  });

  it('refresh recomputes permissions: after canSeeFinancials=true the PM gets profit.view', async () => {
    const o = await owner();
    const b = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    const before = jwt.decode(b.accessToken) as { perms: string[] };
    expect(before.perms).not.toContain('profit.view');

    const patch = await api().patch(`/api/v1/users/${seeded().users.bilal.id}`).set(bearer(o.accessToken)).send({ canSeeFinancials: true });
    expect(patch.status).toBe(200);

    const refreshed = await refreshMobile(b.refreshToken);
    expect(refreshed.status).toBe(200);
    const after = jwt.decode(refreshed.body.data.accessToken) as { perms: string[]; role: string };
    expect(after.perms).toEqual(expect.arrayContaining(['profit.view', 'billing.view']));

    // Role changes also apply on refresh
    await api().patch(`/api/v1/users/${seeded().users.bilal.id}`).set(bearer(o.accessToken)).send({ role: 'MUNSHI' });
    const again = await refreshMobile(refreshed.body.data.refreshToken);
    const demoted = jwt.decode(again.body.data.accessToken) as { perms: string[]; role: string };
    expect(demoted.role).toBe('MUNSHI');
    expect(demoted.perms).toEqual(['site.entry']);
  });
});
