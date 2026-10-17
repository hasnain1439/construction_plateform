import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { createRateLimit } from '../../core/middleware/rateLimit.js';
import { validate } from '../../core/middleware/validate.js';
import { attachmentIdParams, shareQuery, type ShareQuery } from './attachments.schema.js';
import { openShareLink } from './attachments.service.js';

/**
 * QA-B-02 · public share links (WhatsApp). Mounted at /api/v1/public — no login: the `share:`
 * signature is the credential. A valid link answers 302 to a fresh short-lived signed storage URL,
 * so the long-lived link never exposes the storage itself. 30 requests / min per IP.
 */
export const publicRouter = Router();

const shareRateLimit = createRateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => ipKeyGenerator(req.ip ?? '0.0.0.0') });

publicRouter.get(
  '/files/:id',
  shareRateLimit,
  validate({ params: attachmentIdParams, query: shareQuery }),
  h(async (req: Request, res: Response) => {
    const url = await openShareLink(String(req.params['id']), req.query as unknown as ShareQuery);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  }),
);
