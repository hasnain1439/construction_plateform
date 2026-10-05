import { z } from 'zod';

export const attachmentKindSchema = z
  .enum(['LOGO', 'PROFILE_PHOTO', 'SITE_PHOTO', 'RECEIPT', 'DOCUMENT', 'VOICE_NOTE', 'PAYMENT_SLIP', 'CHALLAN'], {
    error: 'kind must be one of LOGO, PROFILE_PHOTO, SITE_PHOTO, RECEIPT, DOCUMENT, VOICE_NOTE, PAYMENT_SLIP, CHALLAN',
  })
  .meta({ example: 'LOGO' });

/** Multipart text fields (the file itself is the `file` part). */
export const uploadAttachmentBody = z.object({ kind: attachmentKindSchema });

export const attachmentIdParams = z.object({ id: z.uuid({ error: 'Invalid attachment id' }) });

export const fileQuery = z.object({
  tid: z.uuid(),
  exp: z.coerce.number().int().positive(),
  sig: z.string().min(20).max(100),
});

export const attachmentDto = z
  .object({
    id: z.uuid(),
    kind: attachmentKindSchema,
    fileName: z.string(),
    mimeType: z.string().meta({ example: 'image/png' }),
    sizeBytes: z.number().int().meta({ example: 48213 }),
    url: z.string().meta({ description: 'Signed, short-lived download URL' }),
    urlExpiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Attachment' });

export type AttachmentKindInput = z.infer<typeof attachmentKindSchema>;
export type AttachmentDto = z.infer<typeof attachmentDto>;
export type FileQuery = z.infer<typeof fileQuery>;
