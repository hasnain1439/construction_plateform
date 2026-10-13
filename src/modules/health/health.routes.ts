import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/asyncHandler.js';
import { ok } from '../../core/http/response.js';
import { registry, success } from '../../core/openapi/registry.js';
import { readiness } from './health.service.js';

export const healthRouter = Router();

/** Liveness: the process answers. No database or other dependency is touched. */
healthRouter.get('/health', (_req, res) => {
  ok(res, { status: 'ok' });
});

/** Readiness: database, file storage and the job scheduler. 503 when any check fails. */
healthRouter.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    const result = await readiness();
    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 'ok') {
      ok(res, result);
      return;
    }
    res.status(503).json({
      success: false,
      error: { code: 'NOT_READY', message: 'One or more dependencies are unavailable', details: result },
    });
  }),
);

const check = z.object({
  ok: z.boolean(),
  latencyMs: z.number().meta({ example: 2.4 }),
  error: z.string().optional().meta({ description: 'Error code only (e.g. P1001, TIMEOUT, NoSuchBucket (404)) — never connection details.' }),
});

const ReadinessSchema = z
  .object({
    status: z.enum(['ok', 'fail']),
    checks: z.object({
      database: check,
      storage: check.extend({
        provider: z.enum(['local', 'cloudinary', 's3']).or(z.string()),
        cached: z.boolean().optional().meta({ description: 'Result reused from the last 30 s (S3 / Cloudinary probes are not free).' }),
        skipped: z.boolean().optional(),
      }),
      scheduler: check.extend({
        enabled: z.boolean().meta({ description: 'false only under NODE_ENV=test' }),
        running: z.boolean().meta({ description: 'This process has scheduled its background jobs.' }),
        jobs: z
          .array(z.object({ name: z.string(), lastStatus: z.string(), lastFinishedAt: z.string().nullable() }))
          .optional()
          .meta({ description: 'Last run of each tracked job (informational; a FAILED job does not make the API unready).' }),
      }),
    }),
  })
  .meta({ id: 'Readiness' });

export function registerHealthDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness check',
    description: 'Answers as long as the process is up. Touches no database or other dependency — use it for restart (liveness) probes.',
    responses: {
      200: {
        description: 'API is up',
        content: { 'application/json': { schema: success(z.object({ status: z.literal('ok') })) } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/health/ready',
    tags: ['Health'],
    summary: 'Readiness check',
    description:
      'Database (`SELECT 1`), file storage (local folder writable / S3 HeadBucket / Cloudinary ping, cached 30 s) and the job scheduler (job status table reachable). ' +
      'Use it for load-balancer / rollout (readiness) probes. Each check has a 3 s budget. Not rate limited, not logged, not traced.',
    responses: {
      200: { description: 'Ready', content: { 'application/json': { schema: success(ReadinessSchema) } } },
      503: {
        description: 'NOT_READY — `error.details` has the same per-check object',
        content: {
          'application/json': {
            schema: z.object({
              success: z.literal(false),
              error: z.object({ code: z.literal('NOT_READY'), message: z.string(), details: ReadinessSchema }),
            }),
          },
        },
      },
    },
  });
}
