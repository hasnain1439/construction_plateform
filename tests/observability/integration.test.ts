import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testLogSink } from '../../src/config/logger.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setAnalyticsSinkForTests, type AnalyticsMessage } from '../../src/core/observability/analytics.js';
import { hashUserId } from '../../src/core/observability/hash.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';
import { seedMalikStockAndLabor } from '../dashboard/fixtures.js';
import { today } from '../labor/fixtures.js';

const seeded = useFreshDatabase();
let events: AnalyticsMessage[] = [];

beforeEach(() => {
  events = [];
  setAnalyticsSinkForTests({ capture: (m) => void events.push(m), shutdown: async () => undefined });
});
afterEach(() => setAnalyticsSinkForTests(undefined));

describe('request logs carry tenantId / userId', () => {
  it('the request line and logs written while handling it have the caller ids', async () => {
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const owner = await prismaAdmin.user.findFirstOrThrow({ where: { phone: SEED.malik.owner.phone, tenantId: seeded().malik.id } });
    testLogSink.length = 0;
    const res = await api().get('/api/v1/does-not-exist-for-logs').set(bearer(s.accessToken));
    expect(res.status).toBe(404);
    const lines = testLogSink.map((l) => JSON.parse(l) as Record<string, unknown>);
    const requestLine = lines.find((l) => (l['req'] as { url?: string } | undefined)?.url === '/api/v1/does-not-exist-for-logs');
    expect(requestLine).toBeDefined();
    // Unauthenticated 404 route: no ids. An authenticated route below has them.
    testLogSink.length = 0;
    await api().get('/api/v1/auth/me').set(bearer(s.accessToken));
    const meLine = testLogSink.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => (l['req'] as { url?: string } | undefined)?.url === '/api/v1/auth/me');
    expect(meLine).toMatchObject({ tenantId: seeded().malik.id, userId: owner.id });
  });
});

describe('product analytics events', () => {
  beforeEach(async () => {
    await seedMalikStockAndLabor(seeded());
  });

  it('sync push: hazri_marked for applied attendance, one sync_error per failing batch — no money or names', async () => {
    const s = seeded();
    const munshi = await loginMunshi(s.malik.id);
    const dha = s.projects.dha.id;
    const shahid = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: s.malik.id, name: 'Shahid' } });
    const m = (type: string, payload: Record<string, unknown>) => ({ clientId: uuidv7(), type, payload, deviceCreatedAt: new Date().toISOString() });
    const res = await api()
      .post('/api/v1/sync/push')
      .set(bearer(munshi.accessToken))
      .send({
        mutations: [
          m('ATTENDANCE_UPSERT', { projectId: dha, date: today(), entries: [{ workerId: shahid.id, status: 'FULL' }] }),
          m('CASH_EXPENSE_CREATE', { projectId: dha, category: 'OTHER', amountPaisa: '99900000', description: 'Too much for Shahid' }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['APPLIED', 'REJECTED']);

    expect(events.map((e) => e.event)).toEqual(['hazri_marked', 'sync_error']);
    const munshiUser = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: s.malik.id, role: 'MUNSHI', phone: SEED.malik.munshi.phone } });
    for (const e of events) {
      expect(e.distinctId).toBe(hashUserId(munshiUser.id));
      expect(e.groups).toEqual({ company: s.malik.id });
    }
    expect(events[0]!.properties).toMatchObject({ source: 'sync', count: 1 });
    expect(events[1]!.properties).toMatchObject({ kind: 'push', status: 'rejected', count: 1, error_code: 'INSUFFICIENT_CASH' });
    const json = JSON.stringify(events);
    for (const secret of ['99900000', 'Shahid', munshiUser.id, SEED.malik.munshi.phone]) expect(json).not.toContain(secret);
  });
});
