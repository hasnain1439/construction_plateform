import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../core/http/response.js';
import { registry, success } from '../../core/openapi/registry.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  ok(res, { status: 'ok' });
});

export function registerHealthDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness check',
    responses: {
      200: {
        description: 'API is up',
        content: { 'application/json': { schema: success(z.object({ status: z.literal('ok') })) } },
      },
    },
  });
}
