import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePermission, requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './master-data.controller.js';
import {
  bulkPercentBody,
  createCategoryBody,
  createMaterialBody,
  createSubcontractorBody,
  createSupplierBody,
  createTemplateBody,
  createWorkerBody,
  duplicateCategoryBody,
  idParams,
  listCategoriesQuery,
  listMaterialsQuery,
  listSubcontractorsQuery,
  listSuppliersQuery,
  listWorkersQuery,
  priceHistoryQuery,
  priceListQuery,
  setLaborRatesBody,
  setPriceListBody,
  setSupplierRatesBody,
  updateCategoryBody,
  updateMaterialBody,
  updateSubcontractorBody,
  updateSupplierBody,
  updateTemplateBody,
  updateWorkerBody,
} from './master-data.schema.js';

/**
 * Company master data. Every route: authenticate → tenantContext → readOnlyGuard
 * (blocks writes on READ_ONLY companies) → role / permission → validate → handler.
 * Materials are visible to every role; rates never leave /price-list (rates.view).
 */
const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');

/** Mounted at /api/v1/material-groups */
export const materialGroupsRouter = Router();
materialGroupsRouter.use(...company);
materialGroupsRouter.get('/', h(c.listGroups));

/** Mounted at /api/v1/materials */
export const materialsRouter = Router();
materialsRouter.use(...company);
materialsRouter.get('/', validate({ query: listMaterialsQuery }), h(c.listMaterials));
materialsRouter.post('/', office, validate({ body: createMaterialBody }), h(c.createMaterial));
materialsRouter.patch('/:id', office, validate({ params: idParams, body: updateMaterialBody }), h(c.updateMaterial));
materialsRouter.post('/:id/hide', owner, validate({ params: idParams }), h(c.hideMaterial));
materialsRouter.post('/:id/show', owner, validate({ params: idParams }), h(c.showMaterial));
materialsRouter.delete('/:id', owner, validate({ params: idParams }), h(c.deleteMaterial));

/** Mounted at /api/v1/quality-categories */
export const qualityCategoriesRouter = Router();
qualityCategoriesRouter.use(...company);
qualityCategoriesRouter.get('/', office, validate({ query: listCategoriesQuery }), h(c.listCategories));
qualityCategoriesRouter.post('/', owner, validate({ body: createCategoryBody }), h(c.createCategory));
qualityCategoriesRouter.patch('/:id', owner, validate({ params: idParams, body: updateCategoryBody }), h(c.updateCategory));
qualityCategoriesRouter.post('/:id/duplicate', owner, validate({ params: idParams, body: duplicateCategoryBody }), h(c.duplicateCategory));
qualityCategoriesRouter.post('/:id/archive', owner, validate({ params: idParams }), h(c.archiveCategory));

/** Mounted at /api/v1/price-list */
export const priceListRouter = Router();
priceListRouter.use(...company);
priceListRouter.get('/', requirePermission('rates.view'), validate({ query: priceListQuery }), h(c.getPriceList));
priceListRouter.put('/', owner, validate({ body: setPriceListBody }), h(c.setPriceList));
priceListRouter.post('/bulk-percent', owner, validate({ body: bulkPercentBody }), h(c.bulkPercent));
priceListRouter.get('/history', requirePermission('rates.view'), validate({ query: priceHistoryQuery }), h(c.priceHistory));

/** Mounted at /api/v1/labor-rates */
export const laborRatesRouter = Router();
laborRatesRouter.use(...company);
laborRatesRouter.get('/', h(c.listLaborRates));
laborRatesRouter.put('/', owner, validate({ body: setLaborRatesBody }), h(c.setLaborRates));

/** Mounted at /api/v1/payment-templates */
export const paymentTemplatesRouter = Router();
paymentTemplatesRouter.use(...company);
paymentTemplatesRouter.get('/', office, h(c.listTemplates));
paymentTemplatesRouter.post('/', owner, validate({ body: createTemplateBody }), h(c.createTemplate));
paymentTemplatesRouter.patch('/:id', owner, validate({ params: idParams, body: updateTemplateBody }), h(c.updateTemplate));
paymentTemplatesRouter.delete('/:id', owner, validate({ params: idParams }), h(c.deleteTemplate));

/** Mounted at /api/v1/suppliers */
export const suppliersRouter = Router();
suppliersRouter.use(...company);
// MUNSHI may list (urgent material bought with site cash); balances need rates.view.
suppliersRouter.get('/', validate({ query: listSuppliersQuery }), h(c.listSuppliers));
suppliersRouter.post('/', office, validate({ body: createSupplierBody }), h(c.createSupplier));
suppliersRouter.get('/:id', office, validate({ params: idParams }), h(c.getSupplier));
suppliersRouter.patch('/:id', office, validate({ params: idParams, body: updateSupplierBody }), h(c.updateSupplier));
suppliersRouter.post('/:id/deactivate', owner, validate({ params: idParams }), h(c.deactivateSupplier));
suppliersRouter.post('/:id/activate', owner, validate({ params: idParams }), h(c.activateSupplier));
suppliersRouter.get('/:id/rates', office, requirePermission('rates.view'), validate({ params: idParams }), h(c.getSupplierRates));
suppliersRouter.put('/:id/rates', owner, validate({ params: idParams, body: setSupplierRatesBody }), h(c.setSupplierRates));

/** Mounted at /api/v1/workers — site staff (MUNSHI) can list and add workers. */
export const workersRouter = Router();
workersRouter.use(...company);
workersRouter.get('/', validate({ query: listWorkersQuery }), h(c.listWorkers));
workersRouter.post('/', requireRole('THEKEDAR', 'PM', 'MUNSHI'), validate({ body: createWorkerBody }), h(c.createWorker));
workersRouter.patch('/:id', office, validate({ params: idParams, body: updateWorkerBody }), h(c.updateWorker));
workersRouter.post('/:id/deactivate', office, validate({ params: idParams }), h(c.deactivateWorker));
workersRouter.post('/:id/activate', office, validate({ params: idParams }), h(c.activateWorker));

/** Mounted at /api/v1/subcontractors */
export const subcontractorsRouter = Router();
subcontractorsRouter.use(...company);
subcontractorsRouter.get('/', validate({ query: listSubcontractorsQuery }), h(c.listSubcontractors));
subcontractorsRouter.post('/', office, validate({ body: createSubcontractorBody }), h(c.createSubcontractor));
subcontractorsRouter.patch('/:id', office, validate({ params: idParams, body: updateSubcontractorBody }), h(c.updateSubcontractor));
subcontractorsRouter.post('/:id/deactivate', office, validate({ params: idParams }), h(c.deactivateSubcontractor));
subcontractorsRouter.post('/:id/activate', office, validate({ params: idParams }), h(c.activateSubcontractor));
