import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  acceptInvitationBody,
  adminLoginBody,
  forgotPasswordBody,
  loginBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
  resetPasswordBody,
  signupBody,
  updateMeBody,
} from '../src/modules/auth/auth.schema.js';
import { updateCompanyBody, updateSettingsBody, createHolidayBody } from '../src/modules/company/company.schema.js';
import { createInvitationBody, setUserProjectsBody, updateUserBody } from '../src/modules/team/team.schema.js';
import { api } from './helpers.js';

const BODY_SCHEMAS: Record<string, z.ZodType> = {
  'patch /api/v1/company': updateCompanyBody,
  'patch /api/v1/company/settings': updateSettingsBody,
  'post /api/v1/company/holidays': createHolidayBody,
  'patch /api/v1/users/{id}': updateUserBody,
  'put /api/v1/users/{id}/projects': setUserProjectsBody,
  'post /api/v1/invitations': createInvitationBody,
  'post /api/v1/auth/signup': signupBody,
  'post /api/v1/auth/login': loginBody,
  'post /api/v1/auth/otp/request': otpRequestBody,
  'post /api/v1/auth/otp/verify': otpVerifyBody,
  'post /api/v1/auth/refresh': refreshBody,
  'post /api/v1/auth/password/forgot': forgotPasswordBody,
  'post /api/v1/auth/password/reset': resetPasswordBody,
  'patch /api/v1/auth/me': updateMeBody,
  'post /api/v1/invitations/{token}/accept': acceptInvitationBody,
  'post /api/v1/admin/auth/login': adminLoginBody,
  'post /api/v1/admin/auth/refresh': refreshBody,
};

type Spec = {
  paths: Record<string, Record<string, { requestBody?: { content: Record<string, { examples?: Record<string, { value: unknown }> }> } }>>;
};

describe('API docs', () => {
  it('serves the OpenAPI spec with the overview, tags and every auth route', async () => {
    const res = await api().get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.description).toContain('Getting started');
    expect(res.body.info.description).toContain('Common error codes');
    expect(res.body.info.description).toContain('What to do');
    expect(res.body.tags.map((t: { name: string }) => t.name)).toEqual([
      'Health',
      'Auth',
      'Company',
      'Team',
      'Attachments',
      'Platform admin auth',
    ]);
    expect(Object.keys(res.body.paths)).toHaveLength(33);
    expect(Object.keys(res.body.components.securitySchemes)).toEqual(['cookieAuth', 'bearerAuth']);
  });

  it('every request body has ready-to-run examples that pass validation', async () => {
    const spec = (await api().get('/api/docs.json')).body as Spec;
    const withBody = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => op.requestBody?.content['application/json'])
        .map(([method, op]) => ({ key: `${method} ${path}`, examples: op.requestBody!.content['application/json']?.examples })),
    );
    expect(withBody.map((b) => b.key).sort()).toEqual(Object.keys(BODY_SCHEMAS).sort());

    for (const { key, examples } of withBody) {
      expect(examples, `${key} has no examples`).toBeDefined();
      for (const [name, example] of Object.entries(examples!)) {
        // "❌ … → 400" examples demonstrate validation errors on purpose.
        if ((example as { summary?: string }).summary?.includes('→ 400')) continue;
        const parsed = BODY_SCHEMAS[key]!.safeParse(example.value);
        expect(parsed.success, `${key} example "${name}": ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      }
    }
  });

  it('the invitation token path parameter has the seeded example', async () => {
    const spec = (await api().get('/api/docs.json')).body;
    const params = spec.paths['/api/v1/invitations/{token}/accept'].post.parameters;
    expect(params[0]).toMatchObject({ name: 'token', in: 'path', required: true });
    expect(JSON.stringify(params[0])).toContain('dev-invite-kamran-shah-2026-0001');
  });

  it('serves the themed Swagger UI', async () => {
    const res = await api().get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Construction Platform API</title>');
    expect(res.text).toContain('--accent: #f59e0b');
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
