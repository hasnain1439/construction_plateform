import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { created, ok } from '../../core/http/response.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as service from './sales.service.js';
import {
  addRevisionBody,
  createQuoteBody,
  insightsQuery,
  listQuotesQuery,
  lostBody,
  negotiationBody,
  pdfQuery,
  previewBody,
  quoteIdParams,
  sendQuoteBody,
  updateQuoteBody,
  wonBody,
  type AddRevisionInput,
  type CreateQuoteInput,
  type ListQuotesQuery,
  type LostInput,
  type PdfQuery,
  type SendQuoteInput,
  type UpdateQuoteInput,
  type WonInput,
} from './sales.schema.js';

const id = (req: Request) => String(req.params['id']);
/** Parsed query (validate() replaces req.query). */
const q = <T>(req: Request) => req.query as unknown as T;

/** Mounted at /api/v1/quotes — Step 12 sales pipeline (company-wide, not project-scoped). */
export const quotesRouter = Router();
quotesRouter.get('/assumptions', ...company, requirePerm('sales.quote.view'), h(async (_req: Request, res: Response) => ok(res, service.assumptions())));
quotesRouter.get('/insights', ...company, requirePerm('sales.quote.view'), validate({ query: insightsQuery }), h(async (req: Request, res: Response) => ok(res, await service.insights(q<{ months: number }>(req).months))));
quotesRouter.post('/preview', ...company, requirePerm('sales.quote.view'), validate({ body: previewBody }), h(async (req: Request, res: Response) => ok(res, await service.preview((req.body as { inputs: CreateQuoteInput['inputs'] }).inputs))));
quotesRouter.get(
  '/',
  ...company,
  requirePerm('sales.quote.view'),
  validate({ query: listQuotesQuery }),
  h(async (req: Request, res: Response) => {
    const r = await service.listQuotes(q<ListQuotesQuery>(req));
    ok(res, r.data, r.meta);
  }),
);
quotesRouter.post('/', ...company, requirePerm('sales.quote.create'), validate({ body: createQuoteBody }), h(async (req: Request, res: Response) => created(res, await service.createQuote(req.body as CreateQuoteInput))));
quotesRouter.get('/:id', ...company, requirePerm('sales.quote.view'), validate({ params: quoteIdParams }), h(async (req: Request, res: Response) => ok(res, await service.getQuote(id(req)))));
quotesRouter.patch('/:id', ...company, requirePerm('sales.quote.edit'), validate({ params: quoteIdParams, body: updateQuoteBody }), h(async (req: Request, res: Response) => ok(res, await service.updateQuote(id(req), req.body as UpdateQuoteInput))));
quotesRouter.delete('/:id', ...company, requirePerm('sales.quote.manage'), validate({ params: quoteIdParams }), h(async (req: Request, res: Response) => ok(res, await service.deleteQuote(id(req)))));
quotesRouter.get('/:id/revisions', ...company, requirePerm('sales.quote.view'), validate({ params: quoteIdParams }), h(async (req: Request, res: Response) => ok(res, await service.listRevisions(id(req)))));
quotesRouter.post(
  '/:id/revisions',
  ...company,
  requirePerm('sales.quote.edit'),
  validate({ params: quoteIdParams, body: addRevisionBody }),
  h(async (req: Request, res: Response) => created(res, await service.addRevision(id(req), req.body as AddRevisionInput))),
);
quotesRouter.post(
  '/:id/send',
  ...company,
  requirePerm(['sales.quote.edit', 'fields.contract']),
  validate({ params: quoteIdParams, body: sendQuoteBody }),
  h(async (req: Request, res: Response) => ok(res, await service.sendQuote(id(req), req.body as SendQuoteInput))),
);
quotesRouter.post(
  '/:id/negotiation',
  ...company,
  requirePerm('sales.quote.edit'),
  validate({ params: quoteIdParams, body: negotiationBody }),
  h(async (req: Request, res: Response) => ok(res, await service.recordNegotiation(id(req), (req.body as { note: string }).note))),
);
quotesRouter.post('/:id/lost', ...company, requirePerm('sales.quote.edit'), validate({ params: quoteIdParams, body: lostBody }), h(async (req: Request, res: Response) => ok(res, await service.markLost(id(req), req.body as LostInput))));
quotesRouter.post(
  '/:id/won',
  ...company,
  requirePerm(['sales.quote.approve', 'projects.project.create']),
  validate({ params: quoteIdParams, body: wonBody }),
  h(async (req: Request, res: Response) => ok(res, await service.markWon(id(req), req.body as WonInput))),
);
quotesRouter.get('/:id/pdf', ...company, requirePerm('sales.quote.view'), validate({ params: quoteIdParams, query: pdfQuery }), h(async (req: Request, res: Response) => ok(res, await service.quotePdf(id(req), q<PdfQuery>(req)))));
