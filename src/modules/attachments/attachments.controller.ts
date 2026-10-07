import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { AttachmentKindInput, FileQuery } from './attachments.schema.js';
import * as service from './attachments.service.js';

export async function upload(req: Request, res: Response) {
  const { kind, clientId } = req.body as { kind: AttachmentKindInput; clientId?: string };
  const result = await service.upload(req.file, kind, clientId);
  return result.created ? created(res, result.data) : ok(res, result.data);
}

export async function getMetadata(req: Request, res: Response) {
  return ok(res, await service.getMetadata(String(req.params['id'])));
}

export async function downloadFile(req: Request, res: Response) {
  const file = await service.openSignedFile(String(req.params['id']), req.query as unknown as FileQuery);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('Cache-Control', `private, max-age=${file.maxAge}`);
  // The web app (another origin) embeds these as <img>/<audio>; helmet defaults to same-origin.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  try {
    // pipeline closes the file handle if the client disconnects or the read fails.
    await pipeline(file.stream, res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return; // client went away
    throw err;
  }
}
