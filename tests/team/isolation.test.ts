import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();

describe('tenant isolation (Ahmed Constructions vs Malik & Sons)', () => {
  it("Ahmed cannot see or change Malik's users, invitations or devices (404)", async () => {
    const malik = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const ahmed = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const { users } = seeded();
    const auth = bearer(ahmed.accessToken);

    const list = await api().get('/api/v1/users').set(auth);
    expect(list.body.data.map((u: { name: string }) => u.name).sort()).toEqual(['Ahmed Raza', 'Rafaqat Ali']);
    expect(list.body.data.every((u: { id: string }) => u.id !== users.bilal.id)).toBe(true);

    expect((await api().get(`/api/v1/users/${users.bilal.id}`).set(auth)).status).toBe(404);
    expect((await api().patch(`/api/v1/users/${users.bilal.id}`).set(auth).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().delete(`/api/v1/users/${users.bilal.id}`).set(auth)).status).toBe(404);
    expect((await api().post(`/api/v1/users/${users.bilal.id}/reactivate`).set(auth)).status).toBe(404);
    expect((await api().put(`/api/v1/users/${users.bilal.id}/projects`).set(auth).send({ projectIds: [] })).status).toBe(404);

    const kamran = await prismaAdmin.invitation.findFirstOrThrow({ where: { phone: SEED.invitation.phone } });
    expect((await api().get('/api/v1/invitations').set(auth)).body.data).toEqual([]);
    expect((await api().delete(`/api/v1/invitations/${kamran.id}`).set(auth)).status).toBe(404);
    await prismaAdmin.invitation.update({ where: { id: kamran.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    expect((await api().post(`/api/v1/invitations/${kamran.id}/resend`).set(auth)).status).toBe(404);

    const malikDevice = await prismaAdmin.device.findFirstOrThrow({ where: { clientDeviceId: malik.deviceId } });
    expect((await api().get('/api/v1/devices').set(auth)).body.data.map((d: { id: string }) => d.id)).not.toContain(malikDevice.id);
    expect((await api().delete(`/api/v1/devices/${malikDevice.id}`).set(auth)).status).toBe(404);

    // Nothing changed on Malik's side
    const bilal = await prismaAdmin.user.findUniqueOrThrow({ where: { id: users.bilal.id } });
    expect(bilal).toMatchObject({ name: 'Bilal Ahmed', status: 'ACTIVE' });
    expect((await prismaAdmin.invitation.findUniqueOrThrow({ where: { id: kamran.id } })).status).toBe('PENDING');
    expect((await prismaAdmin.device.findUniqueOrThrow({ where: { id: malikDevice.id } })).revokedAt).toBeNull();
  });

  it("Ahmed's company endpoints only show Ahmed's data", async () => {
    const ahmed = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const company = await api().get('/api/v1/company').set(bearer(ahmed.accessToken));
    expect(company.body.data.name).toBe(SEED.ahmed.name);
  });
});
