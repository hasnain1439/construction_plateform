import { afterEach, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/node';
import { captureError, closeSentryForTests, initSentry, sentryEnabled, tagSentryScope } from '../../src/core/observability/sentry.js';
import { hashUserId } from '../../src/core/observability/hash.js';

const base = { SENTRY_DSN: undefined, SENTRY_ENVIRONMENT: undefined, SENTRY_RELEASE: undefined, SENTRY_TRACES_SAMPLE_RATE: 0, NODE_ENV: 'test' as const };

afterEach(async () => {
  await closeSentryForTests();
});

describe('Sentry (API)', () => {
  it('is completely off when SENTRY_DSN is empty', () => {
    expect(process.env['SENTRY_DSN'] ?? '').toBe('');
    expect(initSentry(base)).toBe(false);
    expect(sentryEnabled()).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    // Helpers are no-ops (no throw, nothing captured).
    tagSentryScope({ requestId: 'r1', actorType: 'USER', tenantId: 't1', userId: 'u1' });
    expect(captureError(new Error('boom'), { requestId: 'r1', actorType: 'USER' })).toBeUndefined();
  });

  it('with a DSN, errors carry requestId / tenantId / hashed user and are scrubbed', async () => {
    const sent: string[] = [];
    const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, async (request) => {
        sent.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      });
    expect(initSentry({ ...base, SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1' }, { transport, defaultIntegrations: false })).toBe(true);
    expect(sentryEnabled()).toBe(true);

    const userId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    const tenantId = '0192f3a4-5b6c-7d8e-9f01-000000000001';
    const id = captureError(
      new Error('SMS to +923001234567 failed for owner@example.com'),
      { requestId: 'req-1', actorType: 'USER', tenantId, userId },
      { method: 'POST', path: '/api/v1/auth/otp/request' },
    );
    expect(id).toEqual(expect.any(String));
    await Sentry.flush(2000);

    const payload = sent.join('\n');
    expect(payload).toContain('"requestId":"req-1"');
    expect(payload).toContain(`"tenantId":"${tenantId}"`);
    expect(payload).toContain(hashUserId(userId));
    expect(payload).not.toContain(userId);
    expect(payload).not.toContain('+923001234567');
    expect(payload).not.toContain('owner@example.com');
  });
});
