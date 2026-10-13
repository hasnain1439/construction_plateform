import { Router, type RequestHandler } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
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
  createWorkerTypeBody,
  duplicateCategoryBody,
  idParams,
  listCategoriesQuery,
  listMaterialsQuery,
  listSubcontractorsQuery,
  listSuppliersQuery,
  listWorkersQuery,
  listWorkerTypesQuery,
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
  updateWorkerTypeBody,
} from './master-data.schema.js';

/**
 * Company master data. Every route: authenticate → tenantContext → readOnlyGuard
 * (blocks writes on READ_ONLY companies) → requirePerm → validate → handler.
 * Materials are visible to every role; rates never leave /price-list (masterdata.pricelist.view).
 */
const company: RequestHandler[] = [authenticate, tenantContext, readOnlyGuard];

/** Mounted at /api/v1/material-groups */
export const materialGroupsRouter = Router();
materialGroupsRouter.use(...company);
materialGroupsRouter.get('/', h(c.listGroups));

/** Mounted at /api/v1/materials */
export const materialsRouter = Router();
materialsRouter.use(...company);
materialsRouter.get('/', requirePerm('masterdata.material.view'), validate({ query: listMaterialsQuery }), h(c.listMaterials));
materialsRouter.post('/', requirePerm('masterdata.material.create'), validate({ body: createMaterialBody }), h(c.createMaterial));
materialsRouter.patch('/:id', requirePerm('masterdata.material.edit'), validate({ params: idParams, body: updateMaterialBody }), h(c.updateMaterial));
materialsRouter.post('/:id/hide', requirePerm('masterdata.material.manage'), validate({ params: idParams }), h(c.hideMaterial));
materialsRouter.post('/:id/show', requirePerm('masterdata.material.manage'), validate({ params: idParams }), h(c.showMaterial));
materialsRouter.delete('/:id', requirePerm('masterdata.material.manage'), validate({ params: idParams }), h(c.deleteMaterial));

/** Mounted at /api/v1/quality-categories */
export const qualityCategoriesRouter = Router();
qualityCategoriesRouter.use(...company);
qualityCategoriesRouter.get('/', requirePerm('masterdata.pricelist.view'), validate({ query: listCategoriesQuery }), h(c.listCategories));
qualityCategoriesRouter.post('/', requirePerm('masterdata.pricelist.manage'), validate({ body: createCategoryBody }), h(c.createCategory));
qualityCategoriesRouter.patch('/:id', requirePerm('masterdata.pricelist.manage'), validate({ params: idParams, body: updateCategoryBody }), h(c.updateCategory));
qualityCategoriesRouter.post('/:id/duplicate', requirePerm('masterdata.pricelist.manage'), validate({ params: idParams, body: duplicateCategoryBody }), h(c.duplicateCategory));
qualityCategoriesRouter.post('/:id/archive', requirePerm('masterdata.pricelist.manage'), validate({ params: idParams }), h(c.archiveCategory));

/** Mounted at /api/v1/price-list */
export const priceListRouter = Router();
priceListRouter.use(...company);
priceListRouter.get('/', requirePerm('masterdata.pricelist.view'), validate({ query: priceListQuery }), h(c.getPriceList));
priceListRouter.put('/', requirePerm('masterdata.pricelist.manage'), validate({ body: setPriceListBody }), h(c.setPriceList));
priceListRouter.post('/bulk-percent', requirePerm('masterdata.pricelist.manage'), validate({ body: bulkPercentBody }), h(c.bulkPercent));
priceListRouter.get('/history', requirePerm('masterdata.pricelist.view'), validate({ query: priceHistoryQuery }), h(c.priceHistory));

/** Mounted at /api/v1/labor-rates */
export const laborRatesRouter = Router();
laborRatesRouter.use(...company);
laborRatesRouter.get('/', requirePerm('masterdata.laborrate.view'), h(c.listLaborRates));
laborRatesRouter.put('/', requirePerm('masterdata.laborrate.manage'), validate({ body: setLaborRatesBody }), h(c.setLaborRates));

/** Mounted at /api/v1/worker-types — the company's DAILY labour rates; edited like labour rates (THEKEDAR). */
export const workerTypesRouter = Router();
workerTypesRouter.use(...company);
workerTypesRouter.get('/', requirePerm('masterdata.laborrate.view'), validate({ query: listWorkerTypesQuery }), h(c.listWorkerTypes));
workerTypesRouter.post('/', requirePerm('masterdata.laborrate.manage'), validate({ body: createWorkerTypeBody }), h(c.createWorkerType));
workerTypesRouter.patch('/:id', requirePerm('masterdata.laborrate.manage'), validate({ params: idParams, body: updateWorkerTypeBody }), h(c.updateWorkerType));

/** Mounted at /api/v1/payment-templates */
export const paymentTemplatesRouter = Router();
paymentTemplatesRouter.use(...company);
paymentTemplatesRouter.get('/', requirePerm('masterdata.template.view'), h(c.listTemplates));
paymentTemplatesRouter.post('/', requirePerm('masterdata.template.manage'), validate({ body: createTemplateBody }), h(c.createTemplate));
paymentTemplatesRouter.patch('/:id', requirePerm('masterdata.template.manage'), validate({ params: idParams, body: updateTemplateBody }), h(c.updateTemplate));
paymentTemplatesRouter.delete('/:id', requirePerm('masterdata.template.manage'), validate({ params: idParams }), h(c.deleteTemplate));

/** Mounted at /api/v1/suppliers */
export const suppliersRouter = Router();
suppliersRouter.use(...company);
// MUNSHI may list (urgent material bought with site cash); balances need fields.rates.
suppliersRouter.get('/', requirePerm(['masterdata.supplier.view', 'procurement.purchase.create'], { any: true }), validate({ query: listSuppliersQuery }), h(c.listSuppliers));
suppliersRouter.post('/', requirePerm('masterdata.supplier.create'), validate({ body: createSupplierBody }), h(c.createSupplier));
suppliersRouter.get('/:id', requirePerm('masterdata.supplier.view'), validate({ params: idParams }), h(c.getSupplier));
suppliersRouter.patch('/:id', requirePerm('masterdata.supplier.edit'), validate({ params: idParams, body: updateSupplierBody }), h(c.updateSupplier));
suppliersRouter.post('/:id/deactivate', requirePerm('masterdata.supplier.manage'), validate({ params: idParams }), h(c.deactivateSupplier));
suppliersRouter.post('/:id/activate', requirePerm('masterdata.supplier.manage'), validate({ params: idParams }), h(c.activateSupplier));
suppliersRouter.get('/:id/rates', requirePerm(['masterdata.supplier.view', 'fields.rates']), validate({ params: idParams }), h(c.getSupplierRates));
suppliersRouter.put('/:id/rates', requirePerm('masterdata.supplier.manage'), validate({ params: idParams, body: setSupplierRatesBody }), h(c.setSupplierRates));

/** Mounted at /api/v1/workers — site staff (MUNSHI) can list and add workers. */
export const workersRouter = Router();
workersRouter.use(...company);
workersRouter.get('/', requirePerm('masterdata.worker.view'), validate({ query: listWorkersQuery }), h(c.listWorkers));
workersRouter.post('/', requirePerm('masterdata.worker.create'), validate({ body: createWorkerBody }), h(c.createWorker));
workersRouter.patch('/:id', requirePerm('masterdata.worker.edit'), validate({ params: idParams, body: updateWorkerBody }), h(c.updateWorker));
workersRouter.post('/:id/deactivate', requirePerm('masterdata.worker.edit'), validate({ params: idParams }), h(c.deactivateWorker));
workersRouter.post('/:id/activate', requirePerm('masterdata.worker.edit'), validate({ params: idParams }), h(c.activateWorker));

/** Mounted at /api/v1/subcontractors */
export const subcontractorsRouter = Router();
subcontractorsRouter.use(...company);
subcontractorsRouter.get('/', requirePerm('masterdata.subcontractor.view'), validate({ query: listSubcontractorsQuery }), h(c.listSubcontractors));
subcontractorsRouter.post('/', requirePerm('masterdata.subcontractor.create'), validate({ body: createSubcontractorBody }), h(c.createSubcontractor));
subcontractorsRouter.patch('/:id', requirePerm('masterdata.subcontractor.edit'), validate({ params: idParams, body: updateSubcontractorBody }), h(c.updateSubcontractor));
subcontractorsRouter.post('/:id/deactivate', requirePerm('masterdata.subcontractor.edit'), validate({ params: idParams }), h(c.deactivateSubcontractor));
subcontractorsRouter.post('/:id/activate', requirePerm('masterdata.subcontractor.edit'), validate({ params: idParams }), h(c.activateSubcontractor));
