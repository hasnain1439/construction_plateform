import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, device, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
const USMAN = '+923451112233';

function tokenFromSms(phone: string): string {
  const body = lastSmsTo(phone)?.body ?? '';
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(body)?.[1];
  if (!token) throw new Error(`no invite link in SMS: ${body}`);
  return token;
}

const accept = (token: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', device: device(), ...body });

/** Pretend the invitation was created/resent long enough ago to resend. */
async function age(id: string) {
  await prismaAdmin.invitation.update({ where: { id }, data: { createdAt: new Date(Date.now() - 120_000), lastResentAt: null } });
}

describe('invitations', () => {
  it('PM cannot invite (403)', async () => {
    const p = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    const res = await api().post('/api/v1/invitations').set(bearer(p.accessToken)).send({ name: 'X Y', phone: USMAN, role: 'MUNSHI' });
    expect(res.status).toBe(403);
  });

  it('invite → SMS with link → accept creates the user with projects', async () => {
    const s = await owner();
    const { dha } = seeded().projects;
    const res = await api()
      .post('/api/v1/invitations')
      .set(bearer(s.accessToken))
      .send({ name: 'Usman Ghani', phone: '0345-1112233', role: 'PM', projectIds: [dha.id], canSeeFinancials: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', devInviteUrl: expect.stringContaining('/invite/') });
    const days = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);

    const sms = lastSmsTo(USMAN)!;
    expect(sms.body).toContain('Malik & Sons Builders ne aap ko Project Manager ke taur par invite kiya hai:');
    const token = tokenFromSms(USMAN);
    expect(res.body.data.devInviteUrl).toContain(token);
    const row = await prismaAdmin.invitation.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.tokenHash).not.toContain(token);

    const accepted = await accept(token, { password: 'Usman#2026' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.user).toMatchObject({ phone: USMAN, role: 'PM', canSeeFinancials: true });
    expect(await prismaAdmin.userProjectAccess.count({ where: { userId: accepted.body.data.user.id, projectId: dha.id } })).toBe(1);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'invite.create' } })).toBe(1);
  });

  it('canSeeFinancials defaults to the company setting for PMs', async () => {
    const s = await owner();
    await api().patch('/api/v1/company/settings').set(bearer(s.accessToken)).send({ pmCanSeeFinancials: true });
    const res = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Usman Ghani', phone: USMAN, role: 'PM' });
    const row = await prismaAdmin.invitation.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.canSeeFinancials).toBe(true);
  });

  it('duplicate pending → 409 INVITE_PENDING; existing member → 409 ALREADY_MEMBER; foreign project → 400', async () => {
    const s = await owner();
    const body = { name: 'Usman Ghani', phone: USMAN, role: 'MUNSHI' };
    expect((await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send(body)).status).toBe(201);
    const dup = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVITE_PENDING');

    const member = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Bilal', phone: SEED.malik.pm.phone, role: 'PM' });
    expect(member.status).toBe(409);
    expect(member.body.error.code).toBe('ALREADY_MEMBER');

    const foreign = await api()
      .post('/api/v1/invitations')
      .set(bearer(s.accessToken))
      .send({ name: 'Someone', phone: '+923451110000', role: 'MUNSHI', projectIds: [seeded().projects.ahmedProject.id] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('INVALID_PROJECT');

    const munshiFin = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Someone', phone: '+923451110001', role: 'MUNSHI', canSeeFinancials: true });
    expect(munshiFin.status).toBe(400);
  });

  it('cancelled invitation → accept 410 INVITE_CANCELLED; accepted one cannot be cancelled', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Usman Ghani', phone: USMAN, role: 'MUNSHI' });
    const token = tokenFromSms(USMAN);
    const cancel = await api().delete(`/api/v1/invitations/${res.body.data.id}`).set(bearer(s.accessToken));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    const accepted = await accept(token);
    expect(accepted.status).toBe(410);
    expect(accepted.body.error.code).toBe('INVITE_CANCELLED');
    expect((await api().delete(`/api/v1/invitations/${res.body.data.id}`).set(bearer(s.accessToken))).status).toBe(409);

    const kamran = await prismaAdmin.invitation.findFirstOrThrow({ where: { phone: SEED.invitation.phone } });
    await accept(SEED.invitation.token, { password: 'Kamran#2026' });
    const late = await api().delete(`/api/v1/invitations/${kamran.id}`).set(bearer(s.accessToken));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
  });

  it('resend within 60 s → 429; afterwards a new link works and the old one stops', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Usman Ghani', phone: USMAN, role: 'MUNSHI' });
    const oldToken = tokenFromSms(USMAN);
    const early = await api().post(`/api/v1/invitations/${res.body.data.id}/resend`).set(bearer(s.accessToken));
    expect(early.status).toBe(429);
    expect(early.body.error.code).toBe('INVITE_RESEND_WAIT');
    expect(early.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    await age(res.body.data.id);
    const again = await api().post(`/api/v1/invitations/${res.body.data.id}/resend`).set(bearer(s.accessToken));
    expect(again.status).toBe(200);
    const newToken = tokenFromSms(USMAN);
    expect(newToken).not.toBe(oldToken);
    expect((await api().post(`/api/v1/invitations/${res.body.data.id}/resend`).set(bearer(s.accessToken))).status).toBe(429);

    expect((await accept(oldToken)).status).toBe(404);
    expect((await accept(newToken)).status).toBe(201);
  });

  it('expired invitations are marked lazily and can be resent', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'Usman Ghani', phone: USMAN, role: 'MUNSHI' });
    await prismaAdmin.invitation.update({ where: { id: res.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await age(res.body.data.id);

    const pending = await api().get('/api/v1/invitations').set(bearer(s.accessToken));
    expect(pending.body.data.map((i: { name: string }) => i.name)).toEqual(['Kamran Shah']);
    const expired = await api().get('/api/v1/invitations?status=EXPIRED').set(bearer(s.accessToken));
    expect(expired.body.data).toHaveLength(1);
    expect(expired.body.data[0]).toMatchObject({ name: 'Usman Ghani', status: 'EXPIRED', invitedBy: { name: 'Khalid Malik' } });
    expect((await prismaAdmin.invitation.findUniqueOrThrow({ where: { id: res.body.data.id } })).status).toBe('EXPIRED');

    const resent = await api().post(`/api/v1/invitations/${res.body.data.id}/resend`).set(bearer(s.accessToken));
    expect(resent.status).toBe(200);
    expect(resent.body.data.status).toBe('PENDING');
  });

  it('PM invites count pending PM invites against the plan (402); Munshi invites are free', async () => {
    const s = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password); // Starter: 3 office users, 1 used
    const invite = (phone: string, role: string) =>
      api().post('/api/v1/invitations').set(bearer(s.accessToken)).send({ name: 'New Person', phone, role });
    expect((await invite('+923450000041', 'PM')).status).toBe(201);
    expect((await invite('+923450000042', 'PM')).status).toBe(201);
    const third = await invite('+923450000043', 'PM');
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect((await invite('+923450000044', 'MUNSHI')).status).toBe(201);
  });
});
