import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

describe('API docs', () => {
  it('serves the OpenAPI spec with the overview, tags and every auth route', async () => {
    const res = await api().get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.description).toContain('Roles & permissions');
    expect(res.body.info.description).toContain('MULTIPLE_COMPANIES');
    expect(res.body.tags.map((t: { name: string }) => t.name)).toEqual(['Health', 'Auth', 'Platform admin auth']);
    expect(Object.keys(res.body.paths)).toHaveLength(17);
    expect(Object.keys(res.body.components.securitySchemes)).toEqual(['cookieAuth', 'bearerAuth']);
  });

  it('serves the themed Swagger UI', async () => {
    const res = await api().get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Construction Platform API</title>');
    expect(res.text).toContain('--brand: #f59e0b');
    expect(res.text).toContain('data:image/svg+xml');
    expect(res.text).toContain('name="viewport"');
    expect((await api().get('/api/docs')).headers['location']).toBe('/api/docs/');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("style-src 'self' https: 'unsafe-inline'");

    const init = await api().get('/api/docs/swagger-ui-init.js');
    expect(init.text).toContain('"persistAuthorization": true');
    expect(init.text).toContain('"withCredentials": true');
  });
});
