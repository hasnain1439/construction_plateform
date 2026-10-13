import { afterEach, describe, expect, it, vi } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import {
  CloudApiWhatsAppProvider,
  trySendWhatsApp,
  useWhatsAppProviderForTests,
  whatsAppProvider,
  whatsAppTemplates,
  type CloudApiConfig,
} from '../../src/modules/auth/whatsapp.provider.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

/** The Cloud API is a mocked fetch: tests never reach Meta. */
const seeded = useFreshDatabase();

const config: CloudApiConfig = {
  phoneNumberId: '1098765432',
  accessToken: 'EAAG-test-token',
  apiVersion: 'v21.0',
  baseUrl: 'https://graph.facebook.com',
  language: 'en',
  templates: { INVOICE: 'invoice_issued', STATEMENT: 'account_statement', INVITE: 'team_invite', OTP: 'login_code' },
};

function cloudApi(status = 200, body: unknown = { messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgM' }] }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}
const sentBody = (fetchMock: ReturnType<typeof cloudApi>, i = 0) => JSON.parse(fetchMock.mock.calls[i]![1]!.body as string);
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);

afterEach(() => useWhatsAppProviderForTests(undefined));

describe('WhatsApp disabled (default)', () => {
  it('sends and logs nothing; invites still go by SMS', async () => {
    expect(whatsAppProvider().enabled).toBe(false);
    expect(await trySendWhatsApp({ to: '+923001112233', type: 'OTP', params: ['123456'] })).toBe(false);

    const phone = '+923451119900';
    const res = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'Naveed', phone, role: 'MUNSHI' });
    expect(res.status).toBe(201);
    expect(lastSmsTo(phone)?.body).toContain('/invite/');
    expect(await prismaAdmin.messageDelivery.count({ where: { channel: 'WHATSAPP' } })).toBe(0);
    // The SMS was logged with the company.
    expect(await prismaAdmin.messageDelivery.findFirst({ where: { channel: 'SMS', type: 'INVITE' } })).toMatchObject({ tenantId: seeded().malik.id, status: 'SENT' });
  });
});

describe('WhatsApp Cloud API (enabled, mocked fetch)', () => {
  it('an invite also goes as the team_invite template (name, company, role, link) and is logged', async () => {
    const fetchMock = cloudApi();
    useWhatsAppProviderForTests(new CloudApiWhatsAppProvider(config, fetchMock));

    const phone = '+923451119901';
    const res = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'Naveed', phone, role: 'MUNSHI' });
    expect(res.status).toBe(201);
    expect(lastSmsTo(phone)).toBeTruthy(); // SMS stays

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/1098765432/messages');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer EAAG-test-token');
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '923451119901', type: 'template', template: { name: 'team_invite', language: { code: 'en' } } });
    const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params.slice(0, 3)).toEqual(['Naveed', SEED.malik.name, 'Munshi']);
    expect(params[3]).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);

    const row = await prismaAdmin.messageDelivery.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    expect(row).toMatchObject({ type: 'INVITE', provider: 'whatsapp-cloud', status: 'SENT', providerId: 'wamid.HBgM', tenantId: seeded().malik.id, to: '+92345*****01' });
  });

  it('a login code also goes as the authentication template (body + copy-code button)', async () => {
    const fetchMock = cloudApi();
    useWhatsAppProviderForTests(new CloudApiWhatsAppProvider(config, fetchMock));
    const phone = SEED.malik.munshi2.phone;
    expect((await api().post('/api/v1/auth/otp/request').send({ phone })).status).toBe(200);
    const code = /\b(\d{6})\b/.exec(lastSmsTo(phone)!.body)![1];
    expect(sentBody(fetchMock).template).toEqual({
      name: 'login_code',
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    });
  });

  it('an API error is logged FAILED and never fails the request', async () => {
    const fetchMock = cloudApi(400, { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } });
    useWhatsAppProviderForTests(new CloudApiWhatsAppProvider(config, fetchMock));
    const phone = '+923451119902';
    const res = await api().post('/api/v1/invitations').set(await owner()).send({ name: 'Naveed', phone, role: 'MUNSHI' });
    expect(res.status).toBe(201);
    const row = await prismaAdmin.messageDelivery.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('HTTP 400');
    expect(row.error).toContain('Template name does not exist');
  });

  it('invoice and statement templates', async () => {
    const fetchMock = cloudApi();
    useWhatsAppProviderForTests(new CloudApiWhatsAppProvider(config, fetchMock));
    expect(await whatsAppTemplates.invoice('+923001234567', { client: 'Ahmed Raza', invoiceNo: 'INV-2026-0001', amount: 'Rs 5,00,000', url: 'https://x/pdf' })).toBe(true);
    expect(await whatsAppTemplates.statement('+923001234567', { client: 'Ahmed Raza', period: 'Oct 2026', balance: 'Rs 1,00,000', url: 'https://x/s' })).toBe(true);
    expect(sentBody(fetchMock, 0).template.name).toBe('invoice_issued');
    expect(sentBody(fetchMock, 0).template.components).toEqual([
      { type: 'body', parameters: ['Ahmed Raza', 'INV-2026-0001', 'Rs 5,00,000', 'https://x/pdf'].map((text) => ({ type: 'text', text })) },
    ]);
    expect(sentBody(fetchMock, 1).template.name).toBe('account_statement');
  });
});
