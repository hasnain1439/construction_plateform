import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { apiOverview, TAGS } from './overview.js';

/**
 * Single registry every module adds its routes to (see modules/<name>/<name>.docs.ts).
 * Schemas carry examples via Zod's native `.meta({ example })`, so the same schema
 * files can be shared with the frontend without pulling in OpenAPI tooling.
 */
export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'access_token',
  description: 'Web clients: httpOnly access_token cookie set by login/refresh.',
});
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Mobile clients: `Authorization: Bearer <accessToken>`. Platform admins use the same scheme with a platform token.',
});

export const ErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_ERROR' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });

export function success<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data });
}

type Responses = NonNullable<RouteConfig['responses']>;

/** Builds error responses listing the codes a route can return. */
export function errors(map: Record<number, string[]>): Responses {
  const out: Responses = {};
  for (const [status, codes] of Object.entries(map)) {
    out[status] = {
      description: codes.join(' | '),
      content: { 'application/json': { schema: ErrorResponse } },
    };
  }
  return out;
}

export function jsonBody<T extends z.ZodType>(schema: T, example?: unknown) {
  return {
    required: true,
    content: { 'application/json': { schema, ...(example === undefined ? {} : { example }) } },
  };
}

type Security = Array<Record<string, string[]>>;
export const companySecurity: Security = [{ cookieAuth: [] }, { bearerAuth: [] }];
export const platformSecurity: Security = [{ bearerAuth: [] }];

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Construction Platform API',
      version: '1.0.0',
      description: apiOverview(),
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: TAGS,
  });
}
