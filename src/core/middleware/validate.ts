import type { RequestHandler } from 'express';
import { z } from 'zod';

export interface RequestSchemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

/**
 * Validates and replaces `req.body` / `req.params` / `req.query` with the parsed
 * (coerced, defaulted, stripped) output. Failures become a ZodError, which the error
 * handler turns into 400 VALIDATION_ERROR with per-field messages.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
    if (schemas.query) {
      // Express 5 exposes req.query through a getter; shadow it with the parsed value.
      Object.defineProperty(req, 'query', {
        value: schemas.query.parse(req.query),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    next();
  };
}
