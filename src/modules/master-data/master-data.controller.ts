import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as labor from './labor.service.js';
import * as materials from './materials.service.js';
import * as prices from './priceList.service.js';
import * as suppliers from './suppliers.service.js';
import * as workers from './workers.service.js';
import type {
  BulkPercentInput,
  CreateCategoryInput,
  CreateMaterialInput,
  CreateSubcontractorInput,
  CreateSupplierInput,
  CreateTemplateInput,
  CreateWorkerInput,
  DuplicateCategoryInput,
  ListCategoriesQuery,
  ListMaterialsQuery,
  ListSubcontractorsQuery,
  ListSuppliersQuery,
  ListWorkersQuery,
  PriceHistoryQuery,
  PriceListQuery,
  SetLaborRatesInput,
  SetPriceListInput,
  SetSupplierRatesInput,
  UpdateCategoryInput,
  UpdateMaterialInput,
  UpdateSubcontractorInput,
  UpdateSupplierInput,
  UpdateTemplateInput,
  UpdateWorkerInput,
} from './master-data.schema.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;

// ─── Materials ──────────────────────────────────────────────────────────────

export const listGroups = async (_req: Request, res: Response) => ok(res, await materials.listGroups());
export const listMaterials = async (req: Request, res: Response) => ok(res, await materials.listMaterials(query<ListMaterialsQuery>(req)));
export const createMaterial = async (req: Request, res: Response) => created(res, await materials.createMaterial(req.body as CreateMaterialInput));
export const updateMaterial = async (req: Request, res: Response) => ok(res, await materials.updateMaterial(id(req), req.body as UpdateMaterialInput));
export const hideMaterial = async (req: Request, res: Response) => ok(res, await materials.setHidden(id(req), true));
export const showMaterial = async (req: Request, res: Response) => ok(res, await materials.setHidden(id(req), false));
export const deleteMaterial = async (req: Request, res: Response) => ok(res, await materials.deleteMaterial(id(req)));

// ─── Quality categories ─────────────────────────────────────────────────────

export const listCategories = async (req: Request, res: Response) => ok(res, await prices.listCategories(query<ListCategoriesQuery>(req)));
export const createCategory = async (req: Request, res: Response) => created(res, await prices.createCategory(req.body as CreateCategoryInput));
export const updateCategory = async (req: Request, res: Response) => ok(res, await prices.updateCategory(id(req), req.body as UpdateCategoryInput));
export const duplicateCategory = async (req: Request, res: Response) =>
  created(res, await prices.duplicateCategory(id(req), req.body as DuplicateCategoryInput));
export const archiveCategory = async (req: Request, res: Response) => ok(res, await prices.archiveCategory(id(req)));

// ─── Price list ─────────────────────────────────────────────────────────────

export const getPriceList = async (req: Request, res: Response) => ok(res, await prices.getPriceList(query<PriceListQuery>(req)));
export const setPriceList = async (req: Request, res: Response) => ok(res, await prices.setPriceList(req.body as SetPriceListInput));
export const bulkPercent = async (req: Request, res: Response) => ok(res, await prices.bulkPercent(req.body as BulkPercentInput));
export const priceHistory = async (req: Request, res: Response) => ok(res, await prices.priceHistory(query<PriceHistoryQuery>(req)));

// ─── Labour rates + payment templates ───────────────────────────────────────

export const listLaborRates = async (_req: Request, res: Response) => ok(res, await labor.listLaborRates());
export const setLaborRates = async (req: Request, res: Response) => ok(res, await labor.setLaborRates(req.body as SetLaborRatesInput));
export const listTemplates = async (_req: Request, res: Response) => ok(res, await labor.listTemplates());
export const createTemplate = async (req: Request, res: Response) => created(res, await labor.createTemplate(req.body as CreateTemplateInput));
export const updateTemplate = async (req: Request, res: Response) => ok(res, await labor.updateTemplate(id(req), req.body as UpdateTemplateInput));
export const deleteTemplate = async (req: Request, res: Response) => ok(res, await labor.deleteTemplate(id(req)));

// ─── Suppliers ──────────────────────────────────────────────────────────────

export async function listSuppliers(req: Request, res: Response) {
  const { data, meta } = await suppliers.listSuppliers(query<ListSuppliersQuery>(req));
  return ok(res, data, meta);
}
export const getSupplier = async (req: Request, res: Response) => ok(res, await suppliers.getSupplier(id(req)));
export const createSupplier = async (req: Request, res: Response) => created(res, await suppliers.createSupplier(req.body as CreateSupplierInput));
export const updateSupplier = async (req: Request, res: Response) => ok(res, await suppliers.updateSupplier(id(req), req.body as UpdateSupplierInput));
export const deactivateSupplier = async (req: Request, res: Response) => ok(res, await suppliers.setActive(id(req), false));
export const activateSupplier = async (req: Request, res: Response) => ok(res, await suppliers.setActive(id(req), true));
export const getSupplierRates = async (req: Request, res: Response) => ok(res, await suppliers.getRates(id(req)));
export const setSupplierRates = async (req: Request, res: Response) =>
  ok(res, await suppliers.setRates(id(req), req.body as SetSupplierRatesInput));

// ─── Workers + sub-contractors ──────────────────────────────────────────────

export async function listWorkers(req: Request, res: Response) {
  const { data, meta } = await workers.listWorkers(query<ListWorkersQuery>(req));
  return ok(res, data, meta);
}
export const createWorker = async (req: Request, res: Response) => created(res, await workers.createWorker(req.body as CreateWorkerInput));
export const updateWorker = async (req: Request, res: Response) => ok(res, await workers.updateWorker(id(req), req.body as UpdateWorkerInput));
export const deactivateWorker = async (req: Request, res: Response) => ok(res, await workers.setWorkerActive(id(req), false));
export const activateWorker = async (req: Request, res: Response) => ok(res, await workers.setWorkerActive(id(req), true));

export async function listSubcontractors(req: Request, res: Response) {
  const { data, meta } = await workers.listSubcontractors(query<ListSubcontractorsQuery>(req));
  return ok(res, data, meta);
}
export const createSubcontractor = async (req: Request, res: Response) =>
  created(res, await workers.createSubcontractor(req.body as CreateSubcontractorInput));
export const updateSubcontractor = async (req: Request, res: Response) =>
  ok(res, await workers.updateSubcontractor(id(req), req.body as UpdateSubcontractorInput));
export const deactivateSubcontractor = async (req: Request, res: Response) => ok(res, await workers.setSubcontractorActive(id(req), false));
export const activateSubcontractor = async (req: Request, res: Response) => ok(res, await workers.setSubcontractorActive(id(req), true));
