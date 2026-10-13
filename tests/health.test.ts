import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db/prisma.js';
import { useStorageProviderForTests, type StorageProvider } from '../src/modules/attachments/storage.provider.js';
import { resetReadinessCacheForTests } from '../src/modules/health/health.service.js';
import { api } from './helpers.js';

// The readiness database check gives up after 3 s. Open the first connection (and start the
// query engine) up front, so a busy machine (files run in parallel) can't make it time out.
beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

afterEach(() => {
  useStorageProviderForTests(undefined);
  resetReadinessCacheForTests();
});

describe('GET /health', () => {
  it('answers ok without authentication', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('unknown routes answer 404 ROUTE_NOT_FOUND', async () => {
    const res = await api().get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

const fakeStorage = (healthCheck?: () => Promise<void>): StorageProvider => ({
  name: 'fake',
  put: async (key) => key,
  getSignedUrl: async () => ({ url: 'x', expiresAt: new Date() }),
  delete: async () => undefined,
  open: async () => {
    throw new Error('no');
  },
  ...(healthCheck ? { healthCheck } : {}),
});

describe('GET /health/ready', () => {
  it('200 with per-check details: database, storage (local folder), scheduler', async () => {
    const res = await api().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
    const { status, checks } = res.body.data;
    expect(status).toBe('ok');
    expect(checks.database).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
    expect(checks.storage).toMatchObject({ ok: true, provider: 'local' });
    expect(checks.scheduler).toMatchObject({ ok: true, enabled: false, running: false, jobs: expect.any(Array) });
  });

  it('503 NOT_READY when storage is unreachable — error code only, no details leaked', async () => {
    useStorageProviderForTests(
      fakeStorage(async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND secret-bucket.s3.amazonaws.com'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
      }),
    );
    const res = await api().get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_READY');
    const { status, checks } = res.body.error.details;
    expect(status).toBe('fail');
    expect(checks.database.ok).toBe(true);
    expect(checks.storage).toMatchObject({ ok: false, provider: 'fake', error: 'NoSuchBucket (404)' });
    expect(JSON.stringify(res.body)).not.toContain('secret-bucket');
  });

  it('a storage check that hangs times out instead of blocking the probe', async () => {
    useStorageProviderForTests(fakeStorage(() => new Promise(() => undefined)));
    const started = Date.now();
    const res = await api().get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.details.checks.storage.error).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('storage results are cached for 30 s', async () => {
    let calls = 0;
    useStorageProviderForTests(fakeStorage(async () => void calls++));
    await api().get('/health/ready');
    const second = await api().get('/health/ready');
    expect(calls).toBe(1);
    expect(second.body.data.checks.storage.cached).toBe(true);
  });

  it('is documented in OpenAPI with 200 and 503', async () => {
    const spec = (await api().get('/api/docs.json')).body;
    expect(Object.keys(spec.paths['/health/ready'].get.responses)).toEqual(['200', '503']);
    expect(spec.paths['/health'].get).toBeDefined();
  });
});
