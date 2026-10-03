import type { ErrorRequestHandler, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { isProduction } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { tryGetCtx } from '../context/requestContext.js';
import { Prisma } from '../db/prisma.js';
import { AppError, NotFound } from '../errors/AppError.js';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown; stack?: string };
}

function uniqueFields(err: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = (err.meta ?? {}) as Record<string, unknown>;
  if (Array.isArray(meta['target'])) return meta['target'].map(String);
  if (typeof meta['target'] === 'string') return [meta['target']];
  // Driver-adapter errors carry the constraint under driverAdapterError.cause.
  const cause = (meta['driverAdapterError'] as { cause?: { constraint?: { fields?: string[] } } } | undefined)?.cause;
  return cause?.constraint?.fields?.map((f) => f.replace(/"/g, '')) ?? [];
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    const fields = err.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', { fields });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = uniqueFields(err).filter((f) => f !== 'tenantId');
      const field = fields[0];
      return new AppError(409, 'ALREADY_EXISTS', field ? `${field} already exists` : 'Record already exists', { fields });
    }
    if (err.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Record not found');
    if (err.code === 'P2003') return new AppError(400, 'INVALID_REFERENCE', 'A referenced record does not exist');
  }

  if (err instanceof jwt.TokenExpiredError) return new AppError(401, 'TOKEN_EXPIRED', 'Token expired');
  if (err instanceof jwt.JsonWebTokenError) return new AppError(401, 'TOKEN_INVALID', 'Invalid token');

  // body-parser errors
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  return null;
}

export const notFoundHandler: RequestHandler = (req) => {
  throw new NotFound('ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

/** Converts every error into `{ success: false, error: { code, message, details? } }`. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const ctx = tryGetCtx();
  const requestId = ctx?.requestId ?? (typeof req.id === 'string' ? req.id : undefined);
  const known = toAppError(err);

  if (known) {
    if (known.status >= 500) logger.error({ err, requestId }, known.message);
    else logger.info({ requestId, code: known.code, status: known.status }, 'request rejected');
  } else {
    logger.error({ err, requestId, method: req.method, path: req.path }, 'unhandled error');
  }

  const appError = known ?? new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
  const body: ErrorBody = {
    success: false,
    error: { code: appError.code, message: appError.message },
  };
  if (appError.details !== undefined) body.error.details = appError.details;
  if (!isProduction && !known && err instanceof Error && err.stack) body.error.stack = err.stack;

  if (res.headersSent) return;
  res.status(appError.status).json(body);
};
