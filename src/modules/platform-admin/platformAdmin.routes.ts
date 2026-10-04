import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePlatformAdmin } from '../../core/middleware/requirePlatformAdmin.js';
import { validate } from '../../core/middleware/validate.js';
import { assertAdminSessionActive } from '../auth/admin.service.js';
import * as c from './platformAdmin.controller.js';
import {
  approvePaymentBody,
  catalogMaterialsQuery,
  createCatalogMaterialBody,
  updateCatalogMaterialBody,
  auditQuery,
  createHolidayBody,
  createPlanBody,
  createTenantBody,
  holidaysQuery,
  idParams,
  paymentsQuery,
  rejectPaymentBody,
  tenantPlanBody,
  tenantsQuery,
  tenantStatusBody,
  updateHolidayBody,
  updatePlanBody,
} from './platformAdmin.schema.js';

/**
 * Mounted at /api/v1/admin (after /admin/auth). Every route:
 * authenticatePlatform → requirePlatformAdmin (platform audience + role) → live admin
 * session → validate → asyncHandler. Company tokens get 401.
 */
export const platformAdminRouter = Router();

platformAdminRouter.use(
  ...requirePlatformAdmin,
  h(async (_req, _res, next) => {
    await assertAdminSessionActive();
    next();
  }),
);

platformAdminRouter.get('/overview', h(c.getOverview));
platformAdminRouter.get('/health', h(c.getHealth));

platformAdminRouter.get('/tenants', validate({ query: tenantsQuery }), h(c.listTenants));
platformAdminRouter.post('/tenants', validate({ body: createTenantBody }), h(c.createTenant));
platformAdminRouter.get('/tenants/:id', validate({ params: idParams }), h(c.getTenant));
platformAdminRouter.patch('/tenants/:id/status', validate({ params: idParams, body: tenantStatusBody }), h(c.changeTenantStatus));
platformAdminRouter.patch('/tenants/:id/plan', validate({ params: idParams, body: tenantPlanBody }), h(c.changeTenantPlan));

platformAdminRouter.get('/payments', validate({ query: paymentsQuery }), h(c.listPayments));
platformAdminRouter.get('/payments/:id', validate({ params: idParams }), h(c.getPayment));
platformAdminRouter.post('/payments/:id/approve', validate({ params: idParams, body: approvePaymentBody }), h(c.approvePayment));
platformAdminRouter.post('/payments/:id/reject', validate({ params: idParams, body: rejectPaymentBody }), h(c.rejectPayment));

platformAdminRouter.get('/plans', h(c.listPlans));
platformAdminRouter.post('/plans', validate({ body: createPlanBody }), h(c.createPlan));
platformAdminRouter.patch('/plans/:id', validate({ params: idParams, body: updatePlanBody }), h(c.updatePlan));

platformAdminRouter.get('/holidays', validate({ query: holidaysQuery }), h(c.listHolidays));
platformAdminRouter.post('/holidays', validate({ body: createHolidayBody }), h(c.createHoliday));
platformAdminRouter.patch('/holidays/:id', validate({ params: idParams, body: updateHolidayBody }), h(c.updateHoliday));
platformAdminRouter.delete('/holidays/:id', validate({ params: idParams }), h(c.deleteHoliday));

platformAdminRouter.get('/audit-logs', validate({ query: auditQuery }), h(c.listAuditLogs));

platformAdminRouter.get('/material-groups', h(c.listMaterialGroups));
platformAdminRouter.get('/materials', validate({ query: catalogMaterialsQuery }), h(c.listCatalogMaterials));
platformAdminRouter.post('/materials', validate({ body: createCatalogMaterialBody }), h(c.createCatalogMaterial));
platformAdminRouter.patch('/materials/:id', validate({ params: idParams, body: updateCatalogMaterialBody }), h(c.updateCatalogMaterial));
