import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

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
