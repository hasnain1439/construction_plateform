import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import type { AttachmentKind } from '../../generated/prisma/enums.js';
import * as repo from './attachments.repository.js';
import type { AttachmentDto, FileQuery } from './attachments.schema.js';
import { contentMatchesMime, EXTENSIONS, KIND_MIME_TYPES, MOBILE_MAX_BYTES, safeFileName } from './fileTypes.js';
import { shareUrl, storage, storageForKey, verifyFileSignature, verifyShareSignature, type SignedUrlOptions } from './storage.provider.js';

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Signed URL for any stored attachment (also used for logos and profile photos). */
export async function signedUrlFor(attachment: { storageKey: string }, options?: SignedUrlOptions) {
  return storageForKey(attachment.storageKey).getSignedUrl(attachment.storageKey, env.SIGNED_URL_TTL_SECONDS, options);
}

/** QA-B-15: signed URL that names the file (`fileName`) — exports, documents. `download` = save, not preview. */
export async function namedSignedUrl(attachment: { storageKey: string; fileName: string }, download = false) {
  return signedUrlFor(attachment, { fileName: attachment.fileName, download });
}

/**
 * QA-B-02 · kinds a durable share link may open: the PDFs the server makes and shares on WhatsApp
 * (invoice, receipt, statement; change-order slip / handover = DOCUMENT; estimate / quote = REPORT).
 */
export const SHAREABLE_KINDS: ReadonlySet<AttachmentKind> = new Set<AttachmentKind>(['INVOICE_PDF', 'RECEIPT_PDF', 'STATEMENT_PDF', 'DOCUMENT', 'REPORT']);

/** Durable share link of a server-made PDF ({ url, expiresAt } — SHARE_LINK_TTL_DAYS). */
export function shareLinkFor(attachment: { id: string; tenantId: string }) {
  return shareUrl(attachment.id, attachment.tenantId);
}

/**
 * GET /public/files/:id — checks the share signature (purpose `share:`), expiry, that the attachment
 * exists in that company and is a shareable PDF, and returns a fresh short-lived signed storage URL
 * (any provider) for the 302. Errors: 403 INVALID_SIGNATURE / LINK_EXPIRED, 404 ATTACHMENT_NOT_FOUND.
 */
export async function openShareLink(id: string, query: { tid: string; exp: number; sig: string }): Promise<string> {
  if (!verifyShareSignature(id, query.tid, query.exp, query.sig)) throw new Forbidden('INVALID_SIGNATURE', 'This link is not valid');
  if (query.exp <= Math.floor(Date.now() / 1000)) throw new Forbidden('LINK_EXPIRED', 'This link has expired. Ask for a new one.');
  const row = await withTenant(query.tid, (tx) => repo.findAttachment(tx, id));
  if (!row || row.tenantId !== query.tid || !SHAREABLE_KINDS.has(row.kind) || row.mimeType !== 'application/pdf') throw new NotFound('ATTACHMENT_NOT_FOUND', 'This document is no longer available');
  return (await signedUrlFor(row, { fileName: row.fileName })).url;
}

/** Same as signedUrlFor, or null when there is no attachment. */
export async function optionalSignedUrl(
  attachment: { storageKey: string } | null | undefined,
  options?: SignedUrlOptions,
): Promise<string | null> {
  return attachment ? (await signedUrlFor(attachment, options)).url : null;
}

async function toDto(row: {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  createdAt: Date;
}): Promise<AttachmentDto> {
  const signed = await signedUrlFor(row);
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: signed.url,
    urlExpiresAt: signed.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Stores one file. With a `clientId` (mobile app) a retry returns the attachment already
 * stored ({ created: false }); voice notes and mobile photos must be ≤ 2 MB.
 */
export async function upload(file: UploadedFile | undefined, kind: AttachmentKind, clientId?: string): Promise<{ created: boolean; data: AttachmentDto }> {
  const ctx0 = getCtx();
  if (clientId) {
    const existing = await withTenant(ctx0.tenantId!, (tx) => repo.findByClientId(tx, ctx0.tenantId!, clientId));
    if (existing) return { created: false, data: await toDto(existing) };
  }
  if (!file) throw new BadRequest('FILE_REQUIRED', 'Attach a file in the "file" field');
  if ((kind === 'VOICE_NOTE' || clientId) && file.size > MOBILE_MAX_BYTES) {
    throw new BadRequest('FILE_TOO_LARGE', `${kind === 'VOICE_NOTE' ? 'Voice notes' : 'Photos from the app'} must be 2 MB or less`, { maxBytes: MOBILE_MAX_BYTES });
  }
  const allowed = KIND_MIME_TYPES[kind];
  if (!allowed.includes(file.mimetype)) {
    throw new BadRequest('INVALID_FILE_TYPE', `${kind} accepts ${allowed.join(', ')}`, { allowed });
  }
  if (!contentMatchesMime(file.buffer, file.mimetype)) {
    throw new BadRequest('INVALID_FILE_TYPE', 'The file content does not match its type');
  }

  const ctx = getCtx();
  const tenantId = ctx.tenantId!;
  const id = uuidv7();
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const storageKey = `${tenantId}/${now.getUTCFullYear()}/${month}/${id}.${EXTENSIONS[file.mimetype]}`;

  // The provider may store it under its own key (e.g. cloudinary:image:<public_id>).
  const storedKey = await storage().put(storageKey, file.buffer, file.mimetype);
  try {
    const row = await withTenant(tenantId, async (tx) => {
      const created = await repo.createAttachment(tx, {
        id,
        tenantId,
        kind,
        storageKey: storedKey,
        fileName: safeFileName(file.originalname, file.mimetype),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedById: ctx.userId!,
        clientId: clientId ?? null,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: 'USER',
        actorId: ctx.userId!,
        action: 'attachment.upload',
        entityType: 'Attachment',
        entityId: id,
        details: { kind, mimeType: file.mimetype, sizeBytes: file.size },
      });
      return created;
    });
    return { created: true, data: await toDto(row) };
  } catch (err) {
    // Don't leave orphaned bytes behind when the row couldn't be written.
    await storageForKey(storedKey).delete(storedKey).catch((cleanupErr: unknown) => logger.error({ err: cleanupErr }, 'orphan cleanup failed'));
    // Two retries of the same upload racing: the other one won — return it.
    if (clientId) {
      const existing = await withTenant(tenantId, (tx) => repo.findByClientId(tx, tenantId, clientId));
      if (existing) return { created: false, data: await toDto(existing) };
    }
    throw err;
  }
}

export async function getMetadata(id: string): Promise<AttachmentDto> {
  const row = await withTenant(getCtx().tenantId!, (tx) => repo.findAttachment(tx, id));
  if (!row) throw new NotFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  return toDto(row);
}

/**
 * Validates a signed link and opens the file. No login needed — the signature is the
 * credential — but it only works for the tenant and attachment it was issued for.
 */
export async function openSignedFile(
  id: string,
  query: FileQuery,
): Promise<{ stream: Readable; size: number; mimeType: string; fileName: string; maxAge: number }> {
  if (!verifyFileSignature(id, query.tid, query.exp, query.sig)) {
    throw new Forbidden('INVALID_SIGNATURE', 'This file link is not valid');
  }
  const secondsLeft = query.exp - Math.floor(Date.now() / 1000);
  if (secondsLeft <= 0) throw new Forbidden('LINK_EXPIRED', 'This file link has expired. Request a new one.');

  const row = await withTenant(query.tid, (tx) => repo.findAttachment(tx, id));
  if (!row) throw new NotFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  const file = await storageForKey(row.storageKey)
    .open(row.storageKey)
    .catch(() => {
      throw new NotFound('ATTACHMENT_NOT_FOUND', 'File is missing from storage');
    });
  return { ...file, mimeType: row.mimeType, fileName: row.fileName, maxAge: secondsLeft };
}
