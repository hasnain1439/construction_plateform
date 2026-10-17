import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDisposition, type SignedUrlOptions, type StorageProvider } from './storage.provider.js';

const KEY_PREFIX = 's3:';
/** Canonical key handed to put(): tenantId/yyyy/mm/<attachmentId>.<ext> */
const CANONICAL_KEY = /^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

export interface S3Config {
  bucket: string;
  region: string;
  /** Non-AWS endpoint (Cloudflare R2, MinIO…). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** 'AES256' (default) or 'none' for services that reject the header. */
  serverSideEncryption?: 'AES256' | 'none';
}

export function isS3Key(key: string): boolean {
  return key.startsWith(KEY_PREFIX);
}

/** Stored key `s3:<tenantId>/yyyy/mm/<id>.<ext>` → object key in the bucket. */
export function parseS3Key(key: string): string {
  const objectKey = key.slice(KEY_PREFIX.length);
  if (!isS3Key(key) || !CANONICAL_KEY.test(objectKey)) throw new Error(`Invalid S3 storage key: ${key}`);
  return objectKey;
}

export function s3Key(canonicalKey: string): string {
  if (!CANONICAL_KEY.test(canonicalKey)) throw new Error(`Invalid storage key: ${canonicalKey}`);
  return `${KEY_PREFIX}${canonicalKey}`;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
  });
}

/**
 * Private S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). Objects are written with
 * server-side encryption (AES256) and never made public; clients get presigned GET URLs that
 * expire after SIGNED_URL_TTL_SECONDS. Stored key: `s3:<tenantId>/yyyy/mm/<id>.<ext>`.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  readonly client: S3Client;

  constructor(
    private readonly config: S3Config,
    client?: S3Client,
  ) {
    this.client = client ?? createS3Client(config);
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<string> {
    const stored = s3Key(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        ContentType: mime,
        ContentLength: buffer.length,
        ...(this.config.serverSideEncryption === 'none' ? {} : { ServerSideEncryption: 'AES256' as const }),
      }),
    );
    return stored;
  }

  /** True when the object is already in the bucket (storage migration idempotency). */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: parseS3Key(key) }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return false;
      throw err;
    }
  }

  async getSignedUrl(key: string, ttlSec: number, options: SignedUrlOptions = {}): Promise<{ url: string; expiresAt: Date }> {
    // QA-B-15: the browser saves the file under its attachment name (signed response header override).
    const disposition = options.fileName ? { ResponseContentDisposition: contentDisposition(options.fileName, options.download) } : {};
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: parseS3Key(key), ...disposition }), { expiresIn: ttlSec });
    return { url, expiresAt: new Date(Date.now() + ttlSec * 1000) };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: parseS3Key(key) }));
  }

  /** The bucket exists and these credentials may use it (HeadBucket — no object is read). */
  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }

  /** Files are served by presigned URLs, never streamed through the API. */
  async open(): Promise<{ stream: Readable; size: number }> {
    throw new Error('S3StorageProvider does not stream files; use getSignedUrl');
  }
}
