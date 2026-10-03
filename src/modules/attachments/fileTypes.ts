import type { AttachmentKind } from '../../generated/prisma/enums.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const IMAGES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const PDF = ['application/pdf'] as const;
const AUDIO = ['audio/mpeg', 'audio/mp4', 'audio/ogg'] as const;

export const ALLOWED_MIME_TYPES: readonly string[] = [...IMAGES, ...PDF, ...AUDIO];

/** Which file types each kind accepts. */
export const KIND_MIME_TYPES: Record<AttachmentKind, readonly string[]> = {
  LOGO: IMAGES,
  PROFILE_PHOTO: IMAGES,
  SITE_PHOTO: IMAGES,
  RECEIPT: [...IMAGES, ...PDF],
  DOCUMENT: [...IMAGES, ...PDF],
  VOICE_NOTE: AUDIO,
};

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

const ascii = (buf: Buffer, start: number, text: string) => buf.subarray(start, start + text.length).toString('latin1') === text;

/**
 * Checks the file's leading bytes really are the declared type, so a renamed
 * executable or HTML file can't be stored as an "image".
 */
export function contentMatchesMime(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/jpeg':
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png':
      return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return buf.length > 12 && ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP');
    case 'application/pdf':
      return ascii(buf, 0, '%PDF-');
    case 'audio/mpeg':
      return ascii(buf, 0, 'ID3') || (buf.length > 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0);
    case 'audio/mp4':
      return buf.length > 12 && ascii(buf, 4, 'ftyp');
    case 'audio/ogg':
      return ascii(buf, 0, 'OggS');
    default:
      return false;
  }
}

/** Keeps a display-safe file name: no path parts or control characters, max 200 chars. */
export function safeFileName(name: string, mime: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 200);
  return cleaned || `file.${EXTENSIONS[mime] ?? 'bin'}`;
}
