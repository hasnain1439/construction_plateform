import type { ErrorRequestHandler, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { ZodError } from 'zod';
import { isProduction } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { tryGetCtx } from '../context/requestContext.js';
import { Prisma } from '../db/prisma.js';
import { AppError, NotFound } from '../errors/AppError.js';
import { safeUrl } from '../utils/safeUrl.js';

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
    // No connection / transaction slot in time: temporary, safe for the client to retry.
    if (err.code === 'P2028' || err.code === 'P1001' || err.code === 'P1002' || err.code === 'P1017') {
      return new AppError(503, 'SERVICE_BUSY', 'The server is busy. Please try again in a moment.');
    }
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError(400, 'FILE_TOO_LARGE', 'File is larger than 10 MB');
    return new AppError(400, 'INVALID_UPLOAD', `Upload rejected: ${err.message}`, { reason: err.code });
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
  throw new NotFound('ROUTE_NOT_FOUND', `Route ${req.method} ${safeUrl(req.path)} not found`);
};

/** Converts every error into `{ success: false, error: { code, message, details? } }`. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const ctx = tryGetCtx();
  const requestId = ctx?.requestId ?? (typeof req.id === 'string' ? req.id : undefined);
  const known = toAppError(err);

  if (known) {
    if (known.status >= 500) logger.error({ err, requestId }, known.message);
    // `errorCode`, not `code`: the logger redacts `code` (OTP codes).
    else logger.info({ requestId, errorCode: known.code, status: known.status }, 'request rejected');
  } else {
    logger.error({ err, requestId, method: req.method, path: safeUrl(req.path) }, 'unhandled error');
  }

  const appError = known ?? new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
  const body: ErrorBody = {
    success: false,
    error: { code: appError.code, message: appError.message },
  };
  if (appError.details !== undefined) body.error.details = appError.details;
  if (!isProduction && !known && err instanceof Error && err.stack) body.error.stack = err.stack;

  // Mid-stream failure (e.g. a file download): we can't send JSON any more, so end the
  // connection instead of leaving the client hanging.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (appError.status === 503) res.setHeader('Retry-After', '1');
  res.status(appError.status).json(body);
};
