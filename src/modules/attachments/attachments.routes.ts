import { Router } from 'express';
import multer from 'multer';
import { BadRequest } from '../../core/errors/AppError.js';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './attachments.controller.js';
import { attachmentIdParams, fileQuery, uploadAttachmentBody } from './attachments.schema.js';
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from './fileTypes.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new BadRequest('INVALID_FILE_TYPE', `Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`, { allowed: ALLOWED_MIME_TYPES }));
  },
});

/** Mounted at /api/v1/attachments */
export const attachmentsRouter = Router();

// Any company role may upload (Munshis send site photos, receipts and voice notes).
attachmentsRouter.post(
  '/',
  authenticate,
  tenantContext,
  readOnlyGuard,
  upload.single('file'),
  validate({ body: uploadAttachmentBody }),
  h(c.upload),
);

// Signed link: no login, the signature is the credential.
attachmentsRouter.get('/:id/file', validate({ params: attachmentIdParams, query: fileQuery }), h(c.downloadFile));

attachmentsRouter.get('/:id', authenticate, tenantContext, validate({ params: attachmentIdParams }), h(c.getMetadata));
