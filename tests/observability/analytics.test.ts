import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithCtx, type RequestContext } from '../../src/core/context/requestContext.js';
import { analyticsEnabled, filterProps, setAnalyticsSinkForTests, track, type AnalyticsEvent, type AnalyticsMessage } from '../../src/core/observability/analytics.js';
import { hashUserId } from '../../src/core/observability/hash.js';

afterEach(() => setAnalyticsSinkForTests(undefined));

function memorySink() {
  const events: AnalyticsMessage[] = [];
  setAnalyticsSinkForTests({ capture: (m) => void events.push(m), shutdown: async () => undefined });
  return events;
}

const ctx = (extra: Partial<RequestContext> = {}): RequestContext => ({ requestId: 'r', ip: undefined, userAgent: undefined, actorType: 'USER', permissions: [], ...extra });

describe('hashUserId', () => {
  it('is the first 32 hex chars of sha256("user:" + id) — same in web and mobile', () => {
    expect(hashUserId('abc')).toBe(createHash('sha256').update('user:abc').digest('hex').slice(0, 32));
    expect(hashUserId('abc')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('filterProps', () => {
  it('keeps only allow-listed, harmless values', () => {
    expect(
      filterProps({
        client: 'web',
        method: 'password',
        count: 12,
        duration_ms: 340,
        offline: true,
        kind: 'SITE',
        // money and personal data
        amountPaisa: '1500000',
        totalPaisa: 500,
        rate: 1200,
        name: 'Khalid Malik',
        phone: '+923001234567',
        email: 'a@b.co',
        // allowed keys with unsafe values
        status: '+923001234567',
        role: 'a@b.co',
        error_code: '150000',
        source: 'Rs 15,000',
        platform: 'x'.repeat(65),
        app_version: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
        // numbers only for count / duration_ms
        kind2: 1,
        unknown: 'x',
      }),
    ).toEqual({ client: 'web', method: 'password', count: 12, duration_ms: 340, offline: true, kind: 'SITE' });
    expect(filterProps({ status: 7 })).toEqual({});
    expect(filterProps({ count: Number.NaN })).toEqual({});
  });
});

describe('track', () => {
  it('is a no-op when POSTHOG_KEY is empty', () => {
    expect(process.env['POSTHOG_KEY'] ?? '').toBe('');
    expect(analyticsEnabled()).toBe(false);
    expect(() => track('login', { client: 'web' }, { userId: 'u1', tenantId: 't1' })).not.toThrow();
  });

  it('sends the hashed user, the company group and filtered props only', () => {
    const events = memorySink();
    runWithCtx(ctx({ userId: 'user-1', tenantId: 'tenant-1' }), () => {
      track('invoice_issued', { kind: 'STAGE', ...({ amountPaisa: '100000', name: 'Client' } as object) });
    });
    expect(events).toEqual([{ distinctId: hashUserId('user-1'), event: 'invoice_issued', properties: { source: 'api', kind: 'STAGE' }, groups: { company: 'tenant-1' } }]);
  });

  it('drops unknown events and platform-admin support sessions', () => {
    const events = memorySink();
    track('page_view' as AnalyticsEvent, {}, { userId: 'u', tenantId: 't' });
    runWithCtx(ctx({ userId: 'sys', tenantId: 't', platformAdminId: 'admin' }), () => track('project_activated'));
    expect(events).toEqual([]);
  });
});
