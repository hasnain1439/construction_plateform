import { afterEach, describe, expect, it, vi } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import {
  ConsoleSmsProvider,
  formatPhone,
  HttpSmsProvider,
  smsProvider,
  smsText,
  useSmsProviderForTests,
  type HttpSmsConfig,
} from '../../src/modules/auth/sms.provider.js';
import { api, SEED, useFreshDatabase } from '../helpers.js';

/** The HTTP gateway is a mocked fetch: tests never reach a real SMS gateway. */
const seeded = useFreshDatabase();
const PHONE = SEED.malik.munshi2.phone; // +923224567890

const base: HttpSmsConfig = {
  url: 'https://sms.example.pk/api/send',
  method: 'POST',
  contentType: 'json',
  auth: 'bearer',
  apiKey: 'secret-key-123',
  authHeader: 'X-API-Key',
  authQueryParam: 'api_key',
  senderId: 'MUNSHI',
  phoneFormat: 'international',
  idPath: 'data.id',
  timeoutMs: 5000,
};

function gateway(status: number, body: string) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));
}

afterEach(() => useSmsProviderForTests(undefined));

describe('HttpSmsProvider (mocked fetch)', () => {
  it('POSTs a JSON body with {to}, {message}, {sender}, bearer auth, and reads the message id', async () => {
    const fetchMock = gateway(200, JSON.stringify({ status: 'ok', data: { id: 'msg-981' } }));
    const result = await new HttpSmsProvider(base, fetchMock).send({ to: PHONE, body: 'Code "123456"\nbye', type: 'OTP' });
    expect(result).toEqual({ providerId: 'msg-981' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://sms.example.pk/api/send');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key-123');
    expect(JSON.parse(init!.body as string)).toEqual({ to: '923224567890', message: 'Code "123456"\nbye', sender: 'MUNSHI' });
  });

  it('GET with query-key auth, URL placeholders, local phone format and template id per type', async () => {
    const fetchMock = gateway(200, 'OK: 7781');
    const provider = new HttpSmsProvider(
      {
        ...base,
        method: 'GET',
        url: 'https://gw.example.pk/send?to={to}&text={message}&mask={sender}&tpl={templateId}',
        auth: 'query',
        authQueryParam: 'key',
        phoneFormat: 'local',
        successMatch: '^OK',
        idPath: undefined,
        templateIds: { INVITE: '42' },
      },
      fetchMock,
    );
    await provider.send({ to: PHONE, body: 'Join & build', type: 'INVITE' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('to')).toBe('03224567890');
    expect(url.searchParams.get('text')).toBe('Join & build');
    expect(url.searchParams.get('mask')).toBe('MUNSHI');
    expect(url.searchParams.get('tpl')).toBe('42');
    expect(url.searchParams.get('key')).toBe('secret-key-123');
    expect(fetchMock.mock.calls[0]![1]!.body).toBeUndefined();
  });

  it('form body with basic auth and a custom body template', async () => {
    const fetchMock = gateway(200, '{"ok":true}');
    await new HttpSmsProvider(
      { ...base, contentType: 'form', auth: 'basic', username: 'u', password: 'p', bodyTemplate: 'msisdn={to}&sms={message}&from={sender}&kind={type}' },
      fetchMock,
    ).send({ to: PHONE, body: 'a+b=c', type: 'NOTIFICATION' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ msisdn: '923224567890', sms: 'a+b=c', from: 'MUNSHI', kind: 'NOTIFICATION' });
  });

  it('custom header auth', async () => {
    const fetchMock = gateway(202, '');
    await new HttpSmsProvider({ ...base, auth: 'header', authHeader: 'X-Token' }, fetchMock).send({ to: PHONE, body: 'hi' });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['X-Token']).toBe('secret-key-123');
  });

  it('fails on non-2xx, on a failure match in a 200 answer, and when the success match is missing — without echoing the text or key', async () => {
    const body = 'Your code is 654321';
    await expect(new HttpSmsProvider(base, gateway(401, 'bad key secret-key-123')).send({ to: PHONE, body })).rejects.toThrow(/HTTP 401: bad key \[key\]/);
    await expect(new HttpSmsProvider({ ...base, failureMatch: 'error' }, gateway(200, `{"error":"blocked","echo":"${body}"}`)).send({ to: PHONE, body })).rejects.toThrow(
      /reported a failure: \{"error":"blocked","echo":"\[message\]"\}/,
    );
    await expect(new HttpSmsProvider({ ...base, successMatch: '"status":"sent"' }, gateway(200, '{"status":"queued?"}')).send({ to: PHONE, body })).rejects.toThrow(/not recognised/);
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed https://x?key=secret-key-123');
    });
    await expect(new HttpSmsProvider(base, unreachable).send({ to: PHONE, body })).rejects.toThrow('SMS gateway unreachable: TypeError');
  });

  it('phone formats', () => {
    expect(formatPhone('+923001234567', 'e164')).toBe('+923001234567');
    expect(formatPhone('+923001234567', 'international')).toBe('923001234567');
    expect(formatPhone('+923001234567', 'local')).toBe('03001234567');
  });
});

describe('SMS templates per message type', () => {
  it('uses SMS_TEMPLATES[type] filled with the params, or the built-in text', () => {
    const templates = { OTP: 'Munshi App code: {code} ({minutes} min)', INVITE: '{company}: {url} — {nope}' };
    expect(smsText({ to: PHONE, body: 'built-in', type: 'OTP', params: { code: '123456', minutes: 5 } }, templates)).toBe('Munshi App code: 123456 (5 min)');
    // Unknown placeholder → never send "{nope}" to a user.
    expect(smsText({ to: PHONE, body: 'built-in', type: 'INVITE', params: { company: 'X', url: 'u' } }, templates)).toBe('built-in');
    expect(smsText({ to: PHONE, body: 'built-in', type: 'DISPATCH' }, templates)).toBe('built-in');
    expect(smsText({ to: PHONE, body: 'built-in', type: 'OTP', params: { code: '1' } }, undefined)).toBe('built-in');
  });
});

describe('message delivery log', () => {
  it('a login code through the HTTP gateway is logged SENT with a masked phone and the provider id', async () => {
    const fetchMock = gateway(200, JSON.stringify({ data: { id: 'gw-1' } }));
    useSmsProviderForTests(new HttpSmsProvider(base, fetchMock));
    expect(smsProvider().name).toBe('http');

    const res = await api().post('/api/v1/auth/otp/request').send({ phone: PHONE });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await prismaAdmin.messageDelivery.findMany({ where: { channel: 'SMS' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'SMS', type: 'OTP', provider: 'http', status: 'SENT', providerId: 'gw-1', error: null, tenantId: null });
    expect(rows[0]!.to).toBe('+92322*****90');
  });

  it('a gateway failure is logged FAILED (no code in the error) and the request answers 503 SMS_UNAVAILABLE; a retry works at once', async () => {
    useSmsProviderForTests(new HttpSmsProvider(base, gateway(500, 'gateway down for 123456')));
    const res = await api().post('/api/v1/auth/otp/request').send({ phone: PHONE });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SMS_UNAVAILABLE');

    const row = await prismaAdmin.messageDelivery.findFirstOrThrow({ where: { channel: 'SMS' } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('HTTP 500');
    expect(row.error).not.toMatch(/\d{6}/);

    // The undelivered code was dropped: no 60 s resend wait.
    useSmsProviderForTests(new ConsoleSmsProvider());
    expect((await api().post('/api/v1/auth/otp/request').send({ phone: PHONE })).status).toBe(200);
  });

  it('company messages carry the tenant; a company reads only its own rows (RLS), platform rows stay hidden', async () => {
    const { malik, ahmed } = seeded();
    await prismaAdmin.messageDelivery.createMany({
      data: [
        { channel: 'SMS', type: 'DISPATCH', provider: 'console', to: '+92300*****67', status: 'SENT', tenantId: malik.id },
        { channel: 'EMAIL', type: 'INVITE', provider: 'console', to: 'a***@b.pk', status: 'SENT', tenantId: ahmed.id },
        { channel: 'SMS', type: 'OTP', provider: 'console', to: '+92300*****11', status: 'SENT', tenantId: null },
      ],
    });
    const visible = await withTenant(malik.id, (tx) => tx.messageDelivery.findMany());
    expect(visible.map((r) => r.type)).toEqual(['DISPATCH']);
    // app_user may only read.
    await expect(
      withTenant(malik.id, (tx) => tx.messageDelivery.create({ data: { channel: 'SMS', type: 'X', provider: 'p', to: 't', tenantId: malik.id } })),
    ).rejects.toThrow();
  });
});
