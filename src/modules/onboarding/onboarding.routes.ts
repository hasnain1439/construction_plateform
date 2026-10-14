import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { BadRequest } from '../../core/errors/AppError.js';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './onboarding.controller.js';
import { ENTITY_DEFS, IMPORT_ENTITIES } from './imports.entities.js';
import { MAX_IMPORT_BYTES } from './imports.file.js';
import { commitQuery, dismissBody, openingBody, openingListQuery } from './onboarding.schema.js';

/** Mounted at /api/v1/onboarding — the first-login setup checklist (owner: company.settings.manage). */
export const onboardingRouter = Router();
onboardingRouter.use(authenticate, tenantContext, readOnlyGuard);
onboardingRouter.get('/checklist', requirePerm('company.settings.manage'), h(c.getChecklist));
onboardingRouter.post('/checklist/dismiss', requirePerm('company.settings.manage'), validate({ body: dismissBody }), h(c.dismissChecklist));
onboardingRouter.post('/checklist/rates-reviewed', requirePerm('company.settings.manage'), h(c.ratesReviewed));

/** One .xlsx / .csv file in memory (≤ 2 MB); a bigger file → 400 FILE_TOO_LARGE. */
const multerSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 5 } }).single('file');
const importFile: RequestHandler = (req, res, next) => {
  multerSingle(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new BadRequest('FILE_TOO_LARGE', 'The file is larger than 2 MB — split it into smaller files'));
    next(err as Error | undefined);
  });
};

/**
 * Mounted at /api/v1/imports — Excel / CSV import. Each entity needs the permission of its own
 * create endpoint (an import is many creates): /imports/workers|subcontractors|suppliers|materials|clients/…
 */
export const importsRouter = Router();
importsRouter.use(authenticate, tenantContext, readOnlyGuard);
for (const entity of IMPORT_ENTITIES) {
  const perm = requirePerm(ENTITY_DEFS[entity].permission);
  importsRouter.get(`/${entity}/template`, perm, h(c.importTemplate(entity)));
  importsRouter.post(`/${entity}/preview`, perm, importFile, h(c.importPreview(entity)));
  importsRouter.post(`/${entity}/commit`, perm, importFile, validate({ query: commitQuery }), h(c.importCommit(entity)));
}

/** Mounted at /api/v1/opening-balances — company.opening.manage (owner; can be granted). */
export const openingBalancesRouter = Router();
openingBalancesRouter.use(authenticate, tenantContext, readOnlyGuard);
openingBalancesRouter.get('/', requirePerm('company.opening.manage'), validate({ query: openingListQuery }), h(c.listOpenings));
openingBalancesRouter.post('/', requirePerm('company.opening.manage'), validate({ body: openingBody }), h(c.createOpening));

/** Mounted at /api/v1/demo — "Try with demo data" (owner: company.settings.manage). */
export const demoRouter = Router();
demoRouter.use(authenticate, tenantContext, readOnlyGuard);
demoRouter.post('/', requirePerm('company.settings.manage'), h(c.createDemo));
demoRouter.delete('/', requirePerm('company.settings.manage'), h(c.deleteDemo));
