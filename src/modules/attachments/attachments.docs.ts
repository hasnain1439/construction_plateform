import { z } from 'zod';
import { companySecurity, errors, registry, success } from '../../core/openapi/registry.js';
import { attachmentDto, attachmentKindSchema } from './attachments.schema.js';

const tags = ['Attachments'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'], 403: ['COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'] };
const idParam = z.object({ id: z.uuid().meta({ description: 'Attachment id (from the upload response)' }) });

const exampleAttachment = {
  success: true,
  data: {
    id: '0199a8c0-0000-7000-8000-00000000a001',
    kind: 'LOGO',
    fileName: 'malik-sons-logo.png',
    mimeType: 'image/png',
    sizeBytes: 48213,
    url: 'http://localhost:4000/api/v1/attachments/0199a8c0-0000-7000-8000-00000000a001/file?tid=…&exp=1767225600&sig=…',
    urlExpiresAt: '2026-10-03T12:15:00.000Z',
    createdAt: '2026-10-03T12:00:00.000Z',
  },
};

export function registerAttachmentsDocs(): void {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/attachments',
    tags,
    summary: 'Upload a file (logo, photo, receipt, document, voice note)',
    description:
      'Multipart upload, max **10 MB**. Any company role.\n\n' +
      '| kind | Accepts |\n|---|---|\n' +
      '| LOGO, PROFILE_PHOTO, SITE_PHOTO | JPEG, PNG, WebP |\n' +
      '| RECEIPT, DOCUMENT, PAYMENT_SLIP, CHALLAN | JPEG, PNG, WebP, PDF |\n' +
      '| VOICE_NOTE | MP3, M4A, OGG |\n\n' +
      'The file content is checked, not just its name. The response `url` is signed and expires (default 10 min).',
    security: companySecurity,
    request: {
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: z.string().meta({ format: 'binary', description: 'The file' }),
              kind: attachmentKindSchema,
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Stored', content: { 'application/json': { schema: success(attachmentDto), example: exampleAttachment } } },
      ...errors({ 400: ['VALIDATION_ERROR', 'FILE_REQUIRED', 'FILE_TOO_LARGE', 'INVALID_FILE_TYPE', 'INVALID_UPLOAD'], ...AUTH }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attachments/{id}',
    tags,
    summary: 'Attachment details with a fresh signed URL',
    security: companySecurity,
    request: { params: idParam },
    responses: {
      200: { description: 'Attachment', content: { 'application/json': { schema: success(attachmentDto), example: exampleAttachment } } },
      ...errors({ ...AUTH, 404: ['ATTACHMENT_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attachments/{id}/file',
    tags,
    summary: 'Download the file through a signed link',
    description:
      'No login needed — use the `url` returned by the API as-is (e.g. in an `<img>` tag). Expired or edited links answer 403. ' +
      'Exports and documents come as `/attachments/{id}/file/<file name>?…` (the name is ignored by the server; browsers save the file under it) and `Content-Disposition` carries the name; `dl=1` (the `downloadUrl` of report exports) makes it an attachment (save instead of preview).',
    request: {
      params: idParam,
      query: z.object({
        tid: z.uuid().meta({ description: 'Company id (part of the signed link)' }),
        exp: z.number().int().meta({ description: 'Expiry, unix seconds' }),
        sig: z.string().meta({ description: 'HMAC signature' }),
        dl: z.enum(['1']).optional().meta({ description: '1 = Content-Disposition: attachment (not signed)' }),
      }),
    },
    responses: {
      200: { description: 'The file bytes with its Content-Type' },
      ...errors({ 400: ['VALIDATION_ERROR'], 403: ['INVALID_SIGNATURE', 'LINK_EXPIRED'], 404: ['ATTACHMENT_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/public/files/{id}',
    tags,
    summary: 'Open a shared document (WhatsApp link)',
    description:
      'The durable link the share payloads put in `url` / `whatsappText` (invoice, receipt, statement, change-order slip, handover certificate, estimate, quote). No login: the link carries its own HMAC (purpose `share:`, different from file links) and is valid for SHARE_LINK_TTL_DAYS (default 30). ' +
      'A valid link answers **302** to a fresh short-lived signed storage URL of the PDF. Only server-made PDFs open this way. 30 requests / min per IP.',
    request: {
      params: idParam,
      query: z.object({
        tid: z.uuid().meta({ description: 'Company id (part of the signed link)' }),
        exp: z.number().int().meta({ description: 'Expiry, unix seconds' }),
        sig: z.string().meta({ description: 'HMAC signature (share:)' }),
      }),
    },
    responses: {
      302: { description: 'Redirect to the PDF (short-lived signed URL)' },
      ...errors({ 400: ['VALIDATION_ERROR'], 403: ['INVALID_SIGNATURE', 'LINK_EXPIRED'], 404: ['ATTACHMENT_NOT_FOUND'], 429: ['RATE_LIMITED'] }),
    },
  });
}
