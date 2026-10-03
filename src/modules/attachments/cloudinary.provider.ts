import type { Readable } from 'node:stream';
import { v2 as cloudinarySdk, type UploadApiResponse } from 'cloudinary';
import type { SignedUrlOptions, StorageProvider } from './storage.provider.js';

type ResourceType = 'image' | 'video' | 'raw';

const KEY_PREFIX = 'cloudinary:';
/** Canonical key handed to put(): tenantId/yyyy/mm/<attachmentId>.<ext> */
const CANONICAL_KEY = /^([0-9a-f-]{36})\/(\d{4})\/(\d{2})\/([0-9a-f-]{36})\.[a-z0-9]{1,5}$/;

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Token-based auth key (Cloudinary console). When set, thumbnail URLs expire too. */
  authTokenKey?: string;
}

/** Cloudinary resource type for a MIME type: images → image, audio → video, PDF → raw. */
export function resourceTypeFor(mime: string): ResourceType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'video';
  return 'raw';
}

export function isCloudinaryKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX);
}

/** Stored key: `cloudinary:<resource_type>:<public_id>` */
export function cloudinaryKey(resourceType: ResourceType, publicId: string): string {
  return `${KEY_PREFIX}${resourceType}:${publicId}`;
}

export function parseCloudinaryKey(key: string): { resourceType: ResourceType; publicId: string } {
  const match = /^cloudinary:(image|video|raw):(construction\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36})$/.exec(key);
  if (!match) throw new Error(`Invalid Cloudinary storage key: ${key}`);
  return { resourceType: match[1] as ResourceType, publicId: match[2]! };
}

/**
 * Stores attachments in Cloudinary as **authenticated** assets (never public):
 * folder `construction/{tenantId}/{yyyy}/{mm}`, public_id = attachment id.
 *
 * - Originals: `private_download_url` with `expires_at` — signed and expiring.
 * - Image thumbnails (`thumbnailWidth`): resized, auto quality/format delivery URL. It
 *   expires only with a token-based auth key (CLOUDINARY_AUTH_TOKEN_KEY, a paid Cloudinary
 *   feature); without one we fall back to the expiring original rather than hand out a
 *   URL that never expires.
 */
export class CloudinaryStorageProvider implements StorageProvider {
  readonly name = 'cloudinary';
  private readonly sdk = cloudinarySdk;

  constructor(private readonly config: CloudinaryConfig) {
    this.sdk.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: true,
    });
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<string> {
    const match = CANONICAL_KEY.exec(key);
    if (!match) throw new Error(`Invalid storage key: ${key}`);
    const [, tenantId, yyyy, mm, attachmentId] = match;
    const resourceType = resourceTypeFor(mime);

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = this.sdk.uploader.upload_stream(
        {
          type: 'authenticated',
          folder: `construction/${tenantId}/${yyyy}/${mm}`,
          public_id: attachmentId,
          resource_type: resourceType,
          overwrite: false,
          unique_filename: false,
          use_filename: false,
        },
        (error, response) => (error || !response ? reject(error ?? new Error('Cloudinary upload failed')) : resolve(response)),
      );
      stream.end(buffer);
    });
    return cloudinaryKey(resourceType, result.public_id);
  }

  async getSignedUrl(key: string, ttlSec: number, options: SignedUrlOptions = {}): Promise<{ url: string; expiresAt: Date }> {
    const { resourceType, publicId } = parseCloudinaryKey(key);
    const expiresAtSec = Math.floor(Date.now() / 1000) + ttlSec;
    const expiresAt = new Date(expiresAtSec * 1000);

    if (options.thumbnailWidth && resourceType === 'image' && this.config.authTokenKey) {
      const url = this.sdk.url(publicId, {
        resource_type: 'image',
        type: 'authenticated',
        secure: true,
        sign_url: true,
        auth_token: { key: this.config.authTokenKey, duration: ttlSec },
        transformation: [{ width: options.thumbnailWidth, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
      });
      return { url, expiresAt };
    }

    const url = this.sdk.utils.private_download_url(publicId, '', {
      resource_type: resourceType,
      type: 'authenticated',
      expires_at: expiresAtSec,
    });
    return { url, expiresAt };
  }

  async delete(key: string): Promise<void> {
    const { resourceType, publicId } = parseCloudinaryKey(key);
    await this.sdk.uploader.destroy(publicId, { resource_type: resourceType, type: 'authenticated', invalidate: true });
  }

  /** Files are served by Cloudinary directly (signed URLs), never streamed through the API. */
  async open(): Promise<{ stream: Readable; size: number }> {
    throw new Error('CloudinaryStorageProvider does not stream files; use getSignedUrl');
  }
}
