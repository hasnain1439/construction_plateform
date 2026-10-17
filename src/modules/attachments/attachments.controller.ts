import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { corsOrigins, env } from '../../config/env.js';
import { created, ok } from '../../core/http/response.js';
import type { AttachmentKindInput, FileQuery } from './attachments.schema.js';
import * as service from './attachments.service.js';
import { contentDisposition } from './storage.provider.js';

/** 'self' + the web app (APP_URL and the CORS origins). */
const FILE_FRAME_ANCESTORS = ["'self'", ...new Set([new URL(env.APP_URL).origin, ...corsOrigins])].join(' ');

export async function upload(req: Request, res: Response) {
  const { kind, clientId } = req.body as { kind: AttachmentKindInput; clientId?: string };
  const result = await service.upload(req.file, kind, clientId);
  return result.created ? created(res, result.data) : ok(res, result.data);
}

export async function getMetadata(req: Request, res: Response) {
  return ok(res, await service.getMetadata(String(req.params['id'])));
}

export async function downloadFile(req: Request, res: Response) {
  const query = req.query as unknown as FileQuery;
  const file = await service.openSignedFile(String(req.params['id']), query);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', contentDisposition(file.fileName, query.dl === '1'));
  res.setHeader('Cache-Control', `private, max-age=${file.maxAge}`);
  // The web app (another origin) embeds these as <img>/<audio>; helmet defaults to same-origin.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // …and shows PDFs in an <iframe>: only the web app's origins may frame a file (helmet's
  // default frame-ancestors 'self' + X-Frame-Options SAMEORIGIN would block it). Uploads are
  // limited to images / PDF / audio by magic bytes and served with nosniff.
  res.removeHeader('X-Frame-Options');
  const csp = String(res.getHeader('Content-Security-Policy') ?? '');
  const ancestors = `frame-ancestors ${FILE_FRAME_ANCESTORS}`;
  res.setHeader('Content-Security-Policy', /frame-ancestors [^;]*/.test(csp) ? csp.replace(/frame-ancestors [^;]*/, ancestors) : [csp, ancestors].filter(Boolean).join(';'));
  try {
    // pipeline closes the file handle if the client disconnects or the read fails.
    await pipeline(file.stream, res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return; // client went away
    throw err;
  }
}
