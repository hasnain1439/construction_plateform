/**
 * Pilot · Part 8 — the recipient's language on the server: the preference endpoint, OTP SMS,
 * invite SMS / email (+ the language carried to the new user), notifications rendered per
 * recipient (and re-rendered when the reader switches), Urdu PDFs (RTL, Urdu labels, font).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { lastMailTo } from '../../src/modules/auth/mail.provider.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { notify } from '../../src/modules/notifications/notifications.service.js';
import { ageOtps, api, bearer, device, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { mockPdf, pdfCalls } from '../billing/fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const setLanguage = (phone: string, language: 'ENGLISH' | 'ROMAN_URDU' | 'URDU') => prismaAdmin.user.updateMany({ where: { phone }, data: { language } });

describe('PATCH /auth/me/preferences', () => {
  it('any signed-in user sets en / roman / ur; /auth/me and the login result carry it', async () => {
    const login = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const me0 = await api().get('/api/v1/auth/me').set(bearer(login.accessToken));
    expect(me0.body.data.user.language).toBe('roman'); // default

    const res = await api().patch('/api/v1/auth/me/preferences').set(bearer(login.accessToken)).send({ language: 'ur' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ language: 'ur' });
    expect((await prismaAdmin.user.findUniqueOrThrow({ where: { id: seeded().users.khalid.id } })).language).toBe('URDU');
    expect((await api().get('/api/v1/auth/me').set(bearer(login.accessToken))).body.data.user.language).toBe('ur');

    const again = await api().post('/api/v1/auth/login').send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password, client: 'mobile', device: device() });
    expect(again.body.data.user.language).toBe('ur');

    // A munshi (OTP user) may too; bad values are refused.
    const m = await loginMunshi(seeded().malik.id);
    expect((await api().patch('/api/v1/auth/me/preferences').set(bearer(m.accessToken)).send({ language: 'en' })).body.data).toEqual({ language: 'en' });
    const bad = await api().patch('/api/v1/auth/me/preferences').set(bearer(m.accessToken)).send({ language: 'URDU' });
    expect(bad.status).toBe(400);
    expect((await api().patch('/api/v1/auth/me/preferences').send({ language: 'en' })).status).toBe(401);
  });

  it('PATCH /auth/me still accepts the old enum and the new code', async () => {
    const o = await owner();
    expect((await api().patch('/api/v1/auth/me').set(o).send({ language: 'ENGLISH' })).body.data.user.language).toBe('en');
    expect((await api().patch('/api/v1/auth/me').set(o).send({ language: 'ur' })).body.data.user.language).toBe('ur');
  });
});

describe('SMS in the recipient language', () => {
  it('the login code SMS (and email) follow the phone owner’s language', async () => {
    const phone = SEED.malik.munshi2.phone; // Asif, one company
    const otp = () => api().post('/api/v1/auth/otp/request').send({ phone, purpose: 'LOGIN' });

    await setLanguage(phone, 'URDU');
    expect((await otp()).status).toBe(200);
    expect(lastSmsTo(phone)!.body).toMatch(/^آپ کا لاگ اِن کوڈ \d{6} ہے۔/);

    await ageOtps(phone);
    await setLanguage(phone, 'ROMAN_URDU');
    await otp();
    expect(lastSmsTo(phone)!.body).toMatch(/^Aap ka login code \d{6} hai\./);

    await ageOtps(phone);
    await setLanguage(phone, 'ENGLISH');
    await otp();
    expect(lastSmsTo(phone)!.body).toMatch(/^Your login code is \d{6}\./);
    expect(lastSmsTo(phone)!.lang).toBe('en');
  });
});

describe('invitations carry a language', () => {
  it('invite SMS + email in the chosen language; on accept it becomes the user’s language', async () => {
    const phone = '+923451110001';
    const email = 'naveed.ur@example.com';
    const sent = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'Naveed', phone, email, role: 'MUNSHI', language: 'ur' });
    expect(sent.status).toBe(201);

    const sms = lastSmsTo(phone)!.body;
    expect(sms).toContain('نے آپ کو بطور منشی مدعو کیا ہے');
    const mail = lastMailTo(email)!;
    expect(mail.subject).toBe('Malik & Sons Builders کی طرف سے دعوت');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('دعوت قبول کریں');
    expect(mail.text).toContain('السلام علیکم Naveed،');

    const list = await api().get('/api/v1/invitations').set(await owner());
    expect(list.body.data.find((i: { phone: string }) => i.phone === phone).language).toBe('ur');

    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(sms)![1]!;
    const accepted = await api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', device: device() });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.user.language).toBe('ur');
  });

  it('without a language the invite uses the company default (Roman Urdu) — English when the company default is English', async () => {
    const o = await owner();
    await api().post('/api/v1/invitations').set(o).send({ name: 'Imran', phone: '+923451110002', email: 'imran@example.com', role: 'PM' });
    expect(lastSmsTo('+923451110002')!.body).toContain('Malik & Sons Builders ne aap ko Project Manager ke taur par invite kiya hai:');
    expect(lastMailTo('imran@example.com')!.subject).toBe('Malik & Sons Builders ki taraf se invite');

    await prismaAdmin.tenantSettings.update({ where: { tenantId: seeded().malik.id }, data: { defaultLanguage: 'ENGLISH' } });
    await api().post('/api/v1/invitations').set(o).send({ name: 'Zain', phone: '+923451110003', email: 'zain@example.com', role: 'MUNSHI' });
    expect(lastMailTo('zain@example.com')!.subject).toBe('You’re invited to Malik & Sons Builders');
    expect(lastSmsTo('+923451110003')!.body).toContain('invited you to join as Munshi');
  });
});

describe('notifications per recipient', () => {
  it('each recipient gets the text in their language; the inbox re-renders when the reader switches', async () => {
    const s = seeded();
    await setLanguage(SEED.malik.owner.phone, 'ENGLISH');
    await setLanguage(SEED.malik.pm.phone, 'URDU');
    await prismaAdmin.$transaction((tx) =>
      notify(tx, {
        tenantId: s.malik.id,
        recipients: ['THEKEDAR', { userIds: [s.users.bilal.id] }],
        type: 'TOPUP_REQUESTED',
        severity: 'INFO',
        text: { key: 'topupRequested', params: { amount: 'Rs 40,000', holder: 'Rafaqat Ali' } },
        ref: { type: 'TOPUP', id: s.projects.dha.id },
        actorId: null,
      }),
    );
    const rows = await prismaAdmin.notification.findMany({ where: { tenantId: s.malik.id, type: 'TOPUP_REQUESTED', refId: s.projects.dha.id }, include: { user: { select: { name: true } } } });
    const byName = Object.fromEntries(rows.map((r) => [r.user.name, r]));
    expect(byName['Khalid Malik']!.title).toBe('Top-up request: Rs 40,000');
    expect(byName['Bilal Ahmed']!.title).toBe('ٹاپ اپ کی درخواست: Rs 40,000');
    expect(byName['Bilal Ahmed']).toMatchObject({ textKey: 'topupRequested', params: { amount: 'Rs 40,000', holder: 'Rafaqat Ali' } });

    const o = await owner();
    const inbox = async () => (await api().get('/api/v1/notifications').set(o)).body.data.find((n: { type: string }) => n.type === 'TOPUP_REQUESTED');
    expect(await inbox()).toMatchObject({ title: 'Top-up request: Rs 40,000', body: 'Rafaqat Ali asked for Rs 40,000 more site cash.' });
    await api().patch('/api/v1/auth/me/preferences').set(o).send({ language: 'roman' });
    expect(await inbox()).toMatchObject({ title: 'Top-up ki darkhwast: Rs 40,000', body: 'Rafaqat Ali ne Rs 40,000 mazeed site cash maanga.' });
  });

  it('a critical notification SMS goes out in each recipient’s language', async () => {
    const s = seeded();
    await setLanguage(SEED.malik.owner.phone, 'URDU');
    await prismaAdmin.$transaction((tx) =>
      notify(tx, {
        tenantId: s.malik.id,
        recipients: ['THEKEDAR'],
        type: 'CHEQUE_BOUNCED',
        severity: 'CRITICAL',
        text: { key: 'chequeBounced', params: { project: 'DHA', cheque: 'MCB cheque 1', amount: 'Rs 5,000', reason: 'funds' } },
        ref: { type: 'PAYMENT', id: s.projects.dha.id },
        sms: true,
        actorId: null,
      }),
    );
    expect(lastSmsTo(SEED.malik.owner.phone)!.body).toBe('MCB cheque 1 (Rs 5,000) DHA باؤنس ہو گیا۔');
  });
});

describe('PDFs in the requesting user’s language', () => {
  beforeEach(() => mockPdf());

  it('Urdu: dir="rtl", Urdu labels, embedded Nastaliq font; ?lang= overrides; default = the user’s language', async () => {
    const o = await owner();
    const dha = seeded().projects.dha.id;

    const ur = await api().get(`/api/v1/projects/${dha}/owner-statement/pdf`).set(o).query({ lang: 'ur' });
    expect(ur.status).toBe(200);
    const html = pdfCalls.at(-1)!.html;
    expect(html).toContain('<html lang="ur" dir="rtl">');
    expect(html).toContain('حساب کا گوشوارہ');
    expect(html).toContain('ابتدائی بقایا');
    expect(html).toContain("font-family: 'Noto Nastaliq Urdu'");
    expect(html).toMatch(/src: url\(data:font\/woff2;base64,[A-Za-z0-9+/]{1000}/);
    expect(ur.body.data.whatsappText).toContain('بقایا');

    await api().get(`/api/v1/projects/${dha}/owner-statement/pdf`).set(o); // Khalid's own language: Roman Urdu
    expect(pdfCalls.at(-1)!.html).toContain('<html lang="en" dir="ltr">');
    expect(pdfCalls.at(-1)!.html).toContain('HISAAB');

    const report = await api().get('/api/v1/reports/stock-valuation').set(o).query({ format: 'pdf', lang: 'ur' });
    expect(report.status).toBe(200);
    expect(pdfCalls.at(-1)!.html).toContain('dir="rtl"');
    expect(pdfCalls.at(-1)!.html).toContain('اسٹاک کی قیمت');
    expect(pdfCalls.at(-1)!.html).toContain('<th>جگہ</th>');

    expect((await api().get(`/api/v1/projects/${dha}/owner-statement/pdf`).set(o).query({ lang: 'fr' })).status).toBe(400);
  });
});
