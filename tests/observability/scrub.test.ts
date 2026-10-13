import { describe, expect, it } from 'vitest';
import { REDACTED, scrubBreadcrumb, scrubEvent, scrubString, scrubValue } from '../../src/core/observability/scrub.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const REFRESH = 'Zx9aQ3vL0pT6mN2bR8cW4yK7eH1jU5sD0fG3hJ6kL9zX2cV5bN8m';

describe('scrubString', () => {
  it.each([
    ['call me on +923001234567 please', '+923001234567'],
    ['phone 03001234567', '03001234567'],
    ['phone 0300-1234567', '0300-1234567'],
    ['intl 923001234567', '923001234567'],
    ['uae +971501234567', '+971501234567'],
    ['mail ali.khan@example.com now', 'ali.khan@example.com'],
    ['cnic 35202-1234567-1', '35202-1234567-1'],
    [`Authorization: Bearer ${JWT}`, JWT],
    [`token ${JWT}`, JWT],
    [`refresh ${REFRESH}`, REFRESH],
    ['GET /x?token=abc123secret&page=2', 'abc123secret'],
    ['/attachments/1/file?sig=s3cr3tSig&exp=1', 's3cr3tSig'],
  ])('masks %s', (input, secret) => {
    expect(scrubString(input)).not.toContain(secret);
  });

  it('keeps UUIDs, dates, error codes and short numbers', () => {
    const text = 'project 0192f3a4-5b6c-7d8e-9f01-23456789abcd on 2026-10-13: PROJECT_NOT_READY (3 errors)';
    expect(scrubString(text)).toBe(text);
  });
});

describe('scrubValue', () => {
  it('redacts sensitive keys at any depth and scrubs strings', () => {
    const out = scrubValue({
      password: 'Secret#123',
      nested: { refreshToken: 'x', phone: '+923001234567', otp: '123456', code: '654321', note: 'mail a@b.co' },
      list: [{ authorization: 'Bearer abc' }],
      count: 3,
    });
    expect(out).toEqual({
      password: REDACTED,
      nested: { refreshToken: REDACTED, phone: REDACTED, otp: REDACTED, code: REDACTED, note: 'mail [email]' },
      list: [{ authorization: REDACTED }],
      count: 3,
    });
  });
});

describe('scrubEvent (Sentry beforeSend)', () => {
  it('drops bodies, cookies, auth headers, query strings and user details', () => {
    const event = scrubEvent({
      message: 'login failed for +923001234567',
      user: { id: 'abc123', email: 'owner@example.com', ip_address: '1.2.3.4', username: 'Khalid' },
      request: {
        url: 'https://api.example.com/api/v1/invitations/sEcReTiNvItEtOkEn123/accept?x=1',
        method: 'POST',
        data: { login: '03001234567', password: 'Secret#123' },
        cookies: { access_token: JWT },
        query_string: 'code=123456',
        headers: {
          authorization: `Bearer ${JWT}`,
          cookie: `access_token=${JWT}`,
          'x-act-as-session': 's1',
          'user-agent': 'okhttp',
          'x-forwarded-for': '1.2.3.4',
        },
      },
      exception: { values: [{ type: 'Error', value: `bad token ${JWT} for ali@example.com` }] },
      breadcrumbs: [{ message: 'sms to +923331234567', data: { url: '/api/v1/attachments/1/file?sig=abc&exp=1', 'http.query': 'sig=abc' } }],
      extra: { body: { otp: '123456' }, phone: '03001234567' },
      tags: { tenantId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' },
    });
    const json = JSON.stringify(event);
    for (const secret of [JWT, 'Secret#123', '03001234567', '+923001234567', '+923331234567', 'owner@example.com', 'ali@example.com', '1.2.3.4', 'Khalid', 'sEcReTiNvItEtOkEn123', 'sig=abc', '123456']) {
      expect(json, secret).not.toContain(secret);
    }
    expect(event.user).toEqual({ id: 'abc123' });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toEqual({ 'user-agent': 'okhttp' });
    expect(event.tags).toEqual({ tenantId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' });
  });

  it('scrubs transaction span descriptions and data', () => {
    const event = scrubEvent({
      transaction: 'GET /api/v1/invitations/sEcReTiNvItEtOkEn123',
      spans: [{ description: 'GET https://sms.example.com/send?to=923001234567&api_key=k3y', data: { 'http.query': 'to=923001234567', 'url.full': 'https://x/?api_key=k3y' } }],
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain('923001234567');
    expect(json).not.toContain('k3y');
    expect(json).not.toContain('sEcReTiNvItEtOkEn123');
  });

  it('breadcrumbs lose query data', () => {
    const crumb = scrubBreadcrumb({ category: 'http', data: { url: '/x?token=t0k3n', 'http.query': 'token=t0k3n' } });
    expect(JSON.stringify(crumb)).not.toContain('t0k3n');
  });
});
