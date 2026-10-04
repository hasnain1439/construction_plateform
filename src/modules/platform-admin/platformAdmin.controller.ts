import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as catalog from './catalog.service.js';
import * as materials from './materials.service.js';
import * as overview from './overview.service.js';
import * as payments from './payments.service.js';
import type {
  ApprovePaymentInput,
  AuditQuery,
  CreateHolidayInput,
  CreatePlanInput,
  CreateTenantInput,
  HolidaysQuery,
  PaymentsQuery,
  RejectPaymentInput,
  TenantPlanInput,
  TenantStatusInput,
  TenantsQuery,
  UpdateHolidayInput,
  UpdatePlanInput,
  CatalogMaterialsQuery,
  CreateCatalogMaterialInput,
  UpdateCatalogMaterialInput,
} from './platformAdmin.schema.js';
import * as tenants from './tenants.service.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;

export const getOverview = async (_req: Request, res: Response) => ok(res, await overview.getOverview());
export const getHealth = async (_req: Request, res: Response) => ok(res, await overview.getHealth());

export async function listTenants(req: Request, res: Response) {
  const { data, meta } = await tenants.listTenants(query<TenantsQuery>(req));
  return ok(res, data, meta);
}
export const getTenant = async (req: Request, res: Response) => ok(res, await tenants.getTenant(id(req)));
export const createTenant = async (req: Request, res: Response) => created(res, await tenants.createTenant(req.body as CreateTenantInput));
export const changeTenantStatus = async (req: Request, res: Response) =>
  ok(res, await tenants.changeTenantStatus(id(req), req.body as TenantStatusInput));
export const changeTenantPlan = async (req: Request, res: Response) => ok(res, await tenants.changeTenantPlan(id(req), req.body as TenantPlanInput));

export async function listPayments(req: Request, res: Response) {
  const { data, meta } = await payments.listPayments(query<PaymentsQuery>(req));
  return ok(res, data, meta);
}
export const getPayment = async (req: Request, res: Response) => ok(res, await payments.getPayment(id(req)));
export const approvePayment = async (req: Request, res: Response) => ok(res, await payments.approvePayment(id(req), req.body as ApprovePaymentInput));
export const rejectPayment = async (req: Request, res: Response) => ok(res, await payments.rejectPayment(id(req), req.body as RejectPaymentInput));

export const listPlans = async (_req: Request, res: Response) => ok(res, await catalog.listPlans());
export const createPlan = async (req: Request, res: Response) => created(res, await catalog.createPlan(req.body as CreatePlanInput));
export const updatePlan = async (req: Request, res: Response) => ok(res, await catalog.updatePlan(id(req), req.body as UpdatePlanInput));

export const listHolidays = async (req: Request, res: Response) => ok(res, await catalog.listHolidays(query<HolidaysQuery>(req)));
export const createHoliday = async (req: Request, res: Response) => created(res, await catalog.createHoliday(req.body as CreateHolidayInput));
export const updateHoliday = async (req: Request, res: Response) => ok(res, await catalog.updateHoliday(id(req), req.body as UpdateHolidayInput));
export const deleteHoliday = async (req: Request, res: Response) => ok(res, await catalog.deleteHoliday(id(req)));

export async function listAuditLogs(req: Request, res: Response) {
  const { data, meta } = await catalog.listAuditLogs(query<AuditQuery>(req));
  return ok(res, data, meta);
}

export const listMaterialGroups = async (_req: Request, res: Response) => ok(res, await materials.listGroups());
export const listCatalogMaterials = async (req: Request, res: Response) => ok(res, await materials.listMaterials(query<CatalogMaterialsQuery>(req)));
export const createCatalogMaterial = async (req: Request, res: Response) =>
  created(res, await materials.createMaterial(req.body as CreateCatalogMaterialInput));
export const updateCatalogMaterial = async (req: Request, res: Response) =>
  ok(res, await materials.updateMaterial(id(req), req.body as UpdateCatalogMaterialInput));
