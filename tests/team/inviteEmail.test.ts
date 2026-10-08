import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { lastMailTo } from '../../src/modules/auth/mail.provider.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, device, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const linkIn = (text: string | undefined) => /\/invite\/([A-Za-z0-9_-]+)/.exec(text ?? '')?.[1];

describe('invites and login codes by email as well as SMS', () => {
  it('a new company: the owner gets the invite link by SMS and email', async () => {
    const res = await api()
      .post('/api/v1/admin/tenants')
      .set(bearer((await loginAdmin()).accessToken))
      .send({
        company: { name: 'Mail Test Builders', phone: '042-35000001', region: 'PUNJAB_KP' },
        owner: { name: 'Bilal Khan', phone: '03452229991', email: 'bilal@example.com' },
        subscription: { mode: 'TRIAL', planCode: 'STARTER' },
      });
    expect(res.status).toBe(201);
    const mail = lastMailTo('bilal@example.com');
    expect(mail?.subject).toContain('Mail Test Builders');
    expect(mail?.html).toContain('Accept invitation');
    expect(linkIn(mail?.text)).toBeTruthy();
    expect(linkIn(mail?.text)).toBe(linkIn(lastSmsTo('+923452229991')?.body));
  });

  it('a munshi invite goes by SMS and email; the munshi may choose a password and sign in with it or with a code', async () => {
    const phone = '+923451119988';
    const email = 'usman.munshi@example.com';
    const sent = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'Usman Munshi', phone, email, role: 'MUNSHI' });
    expect(sent.status).toBe(201);
    const mail = lastMailTo(email);
    expect(mail?.subject).toContain('invited');
    expect(mail?.text).toContain('Munshi');
    const token = linkIn(mail?.text)!;
    expect(token).toBe(linkIn(lastSmsTo(phone)?.body));

    const accepted = await api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', device: device(), password: 'Usman#2026' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.user.role).toBe('MUNSHI');

    // Option 1: phone + password.
    const byPassword = await api().post('/api/v1/auth/login').send({ login: phone, password: 'Usman#2026', client: 'mobile', device: device() });
    expect(byPassword.status).toBe(200);

    // Option 2: phone + code — the code also arrives by email.
    const requested = await api().post('/api/v1/auth/otp/request').send({ phone, purpose: 'LOGIN' });
    expect(requested.status).toBe(200);
    expect(requested.body.data.emailed).toBe(true);
    const code = /\b(\d{6})\b/.exec(lastMailTo(email)?.text ?? '')?.[1];
    expect(code).toBeTruthy();
    const byCode = await api().post('/api/v1/auth/otp/verify').send({ phone, code, client: 'mobile', device: device() });
    expect(byCode.status).toBe(200);
    expect(byCode.body.data.user.role).toBe('MUNSHI');
  });

  it('without an email only the SMS is sent', async () => {
    const phone = '+923451119977';
    const sent = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'No Mail', phone, role: 'MUNSHI' });
    expect(sent.status).toBe(201);
    expect(linkIn(lastSmsTo(phone)?.body)).toBeTruthy();
    const inv = await prismaAdmin.invitation.findFirstOrThrow({ where: { phone } });
    expect(inv.email).toBeNull();
  });
});
