import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { apiPublicUrl, env } from '../../config/env.js';
import { CloudinaryStorageProvider, isCloudinaryKey } from './cloudinary.provider.js';
import { isS3Key, S3StorageProvider, type S3Config } from './s3.provider.js';

export interface SignedUrlOptions {
  /** Images only: resized preview of this width (providers that can't, return the original). */
  thumbnailWidth?: number;
  /**
   * QA-B-15: the name the browser saves the file under (attachment `fileName`). Local: last path
   * segment of the URL + Content-Disposition; S3: ResponseContentDisposition; Cloudinary: not
   * supported by its private download API (the file is named after its public id).
   */
  fileName?: string;
  /** QA-B-15: `Content-Disposition: attachment` (save, don't preview). Cloudinary: `attachment=true`. */
  download?: boolean;
}

/** `inline|attachment; filename="ascii"; filename*=UTF-8''utf8` — every browser picks the name up. */
export function contentDisposition(fileName: string, download = false): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Where attachment bytes live. Callers pass a canonical key
 * `tenantId/yyyy/mm/<attachmentId>.<ext>`; `put` returns the key to store on the
 * Attachment row (a provider may use its own format, e.g. `cloudinary:image:<public_id>`).
 */
export interface StorageProvider {
  readonly name: string;
  /** Stores the bytes and returns the storage key to persist. */
  put(key: string, buffer: Buffer, mime: string): Promise<string>;
  /** Short-lived URL a client can GET without other credentials. */
  getSignedUrl(key: string, ttlSec: number, options?: SignedUrlOptions): Promise<{ url: string; expiresAt: Date }>;
  delete(key: string): Promise<void>;
  /** Streams bytes through this API (local provider only). */
  open(key: string): Promise<{ stream: Readable; size: number }>;
  /** Readiness probe (GET /health/ready): resolves when the store is reachable, throws otherwise. */
  healthCheck?(): Promise<void>;
}

const KEY_PATTERN = /^([0-9a-f-]{36})\/(\d{4})\/(\d{2})\/([0-9a-f-]{36})\.([a-z0-9]{1,5})$/;

/** Splits a storage key into tenant and attachment id. Throws for anything unexpected. */
export function parseStorageKey(key: string): { tenantId: string; attachmentId: string } {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new Error(`Invalid storage key: ${key}`);
  return { tenantId: match[1]!, attachmentId: match[4]! };
}

/** HMAC over attachment id + tenant + expiry. The pepper never leaves the server. */
export function fileSignature(attachmentId: string, tenantId: string, exp: number): string {
  return createHmac('sha256', env.JWT_REFRESH_PEPPER).update(`attachment:${attachmentId}:${tenantId}:${exp}`).digest('base64url');
}

export function verifyFileSignature(attachmentId: string, tenantId: string, exp: number, sig: string): boolean {
  return sameSignature(fileSignature(attachmentId, tenantId, exp), sig);
}

const sameSignature = (expectedSig: string, sig: string) => {
  const expected = Buffer.from(expectedSig);
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/**
 * QA-B-02 · durable share link (WhatsApp): its own HMAC purpose (`share:`), so a share signature
 * never opens /attachments/:id/file and a file signature never opens /public/files/:id.
 */
export function shareSignature(attachmentId: string, tenantId: string, exp: number): string {
  return createHmac('sha256', env.JWT_REFRESH_PEPPER).update(`share:${attachmentId}:${tenantId}:${exp}`).digest('base64url');
}

export function verifyShareSignature(attachmentId: string, tenantId: string, exp: number, sig: string): boolean {
  return sameSignature(shareSignature(attachmentId, tenantId, exp), sig);
}

/** `<API>/api/v1/public/files/:id?tid&exp&sig`, valid SHARE_LINK_TTL_DAYS (default 30). */
export function shareUrl(attachmentId: string, tenantId: string, now = Date.now()): { url: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + env.SHARE_LINK_TTL_DAYS * 86_400;
  const query = new URLSearchParams({ tid: tenantId, exp: String(exp), sig: shareSignature(attachmentId, tenantId, exp) });
  return { url: `${apiPublicUrl}/api/v1/public/files/${attachmentId}?${query}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Stores files on the local disk under STORAGE_DIR. Signed URLs point back at this API:
 * /api/v1/attachments/:id/file?tid=&exp=&sig=
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    parseStorageKey(key); // rejects traversal and anything not generated by us
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Storage path escapes the root');
    return full;
  }

  async put(key: string, buffer: Buffer): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer, { flag: 'wx' });
    return key;
  }

  async getSignedUrl(key: string, ttlSec: number, options: SignedUrlOptions = {}): Promise<{ url: string; expiresAt: Date }> {
    const { tenantId, attachmentId } = parseStorageKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const query = new URLSearchParams({ tid: tenantId, exp: String(exp), sig: fileSignature(attachmentId, tenantId, exp), ...(options.download ? { dl: '1' } : {}) });
    // QA-B-15: the file name as the last path segment, so "Save as" / the PDF viewer use it.
    const name = options.fileName ? `/${encodeURIComponent(options.fileName)}` : '';
    return { url: `${apiPublicUrl}/api/v1/attachments/${attachmentId}/file${name}?${query}`, expiresAt: new Date(exp * 1000) };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async open(key: string): Promise<{ stream: Readable; size: number }> {
    const path = this.pathFor(key);
    const info = await stat(path);
    return { stream: createReadStream(path), size: info.size };
  }

  /** The storage folder exists (or can be created) and is writable. */
  async healthCheck(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.W_OK);
  }
}

let local: LocalStorageProvider | undefined;
let cloudinary: StorageProvider | undefined;
let s3: StorageProvider | undefined;
let override: StorageProvider | undefined;

function localProvider(): LocalStorageProvider {
  return (local ??= new LocalStorageProvider(env.STORAGE_DIR));
}

function cloudinaryProvider(): StorageProvider {
  if (override) return override;
  if (!cloudinary) {
    cloudinary = new CloudinaryStorageProvider({
      cloudName: env.CLOUDINARY_CLOUD_NAME!,
      apiKey: env.CLOUDINARY_API_KEY!,
      apiSecret: env.CLOUDINARY_API_SECRET!,
      authTokenKey: env.CLOUDINARY_AUTH_TOKEN_KEY,
    });
  }
  return cloudinary;
}

export function s3ConfigFromEnv(): S3Config {
  return {
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION!,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    serverSideEncryption: env.S3_SERVER_SIDE_ENCRYPTION,
  };
}

function s3Provider(): StorageProvider {
  if (override) return override;
  return (s3 ??= new S3StorageProvider(s3ConfigFromEnv()));
}

/** Provider for NEW uploads (STORAGE_PROVIDER). */
export function storage(): StorageProvider {
  if (override) return override;
  if (env.STORAGE_PROVIDER === 'cloudinary') return cloudinaryProvider();
  if (env.STORAGE_PROVIDER === 's3') return s3Provider();
  return localProvider();
}

/**
 * Provider that holds an EXISTING key. Keys say where they live, so switching
 * STORAGE_PROVIDER keeps older files readable.
 */
export function storageForKey(key: string): StorageProvider {
  if (isCloudinaryKey(key)) return cloudinaryProvider();
  if (isS3Key(key)) return s3Provider();
  return localProvider();
}

/** Tests only: route uploads (and cloudinary / s3 keys) to a given provider; undefined resets. */
export function useStorageProviderForTests(provider: StorageProvider | undefined): void {
  override = provider;
}
