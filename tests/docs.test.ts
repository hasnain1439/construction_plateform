import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  acceptInvitationBody,
  adminLoginBody,
  forgotPasswordBody,
  loginBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
  resetPasswordBody,
  signupBody,
  updateMeBody,
} from '../src/modules/auth/auth.schema.js';
import { updateCompanyBody, updateSettingsBody, createHolidayBody } from '../src/modules/company/company.schema.js';
import { createInvitationBody, setUserProjectsBody, updateUserBody } from '../src/modules/team/team.schema.js';
import { changePlanBody, submitPaymentBody } from '../src/modules/subscription/subscription.schema.js';
import * as admin from '../src/modules/platform-admin/platformAdmin.schema.js';
import * as md from '../src/modules/master-data/master-data.schema.js';
import * as cl from '../src/modules/clients/clients.schema.js';
import * as pr from '../src/modules/projects/projects.schema.js';
import * as inv from '../src/modules/inventory/inventory.schema.js';
import * as proc from '../src/modules/procurement/procurement.schema.js';
import * as dsp from '../src/modules/dispatch/dispatch.schema.js';
import { api } from './helpers.js';

const BODY_SCHEMAS: Record<string, z.ZodType> = {
  'patch /api/v1/company': updateCompanyBody,
  'patch /api/v1/company/settings': updateSettingsBody,
  'post /api/v1/company/holidays': createHolidayBody,
  'patch /api/v1/users/{id}': updateUserBody,
  'put /api/v1/users/{id}/projects': setUserProjectsBody,
  'post /api/v1/invitations': createInvitationBody,
  'post /api/v1/subscription/payments': submitPaymentBody,
  'post /api/v1/subscription/change-plan': changePlanBody,
  'post /api/v1/admin/tenants': admin.createTenantBody,
  'patch /api/v1/admin/tenants/{id}/status': admin.tenantStatusBody,
  'patch /api/v1/admin/tenants/{id}/plan': admin.tenantPlanBody,
  'post /api/v1/admin/payments/{id}/approve': admin.approvePaymentBody,
  'post /api/v1/admin/payments/{id}/reject': admin.rejectPaymentBody,
  'post /api/v1/admin/plans': admin.createPlanBody,
  'patch /api/v1/admin/plans/{id}': admin.updatePlanBody,
  'post /api/v1/admin/holidays': admin.createHolidayBody,
  'patch /api/v1/admin/holidays/{id}': admin.updateHolidayBody,
  'post /api/v1/auth/signup': signupBody,
  'post /api/v1/auth/login': loginBody,
  'post /api/v1/auth/otp/request': otpRequestBody,
  'post /api/v1/auth/otp/verify': otpVerifyBody,
  'post /api/v1/auth/refresh': refreshBody,
  'post /api/v1/auth/password/forgot': forgotPasswordBody,
  'post /api/v1/auth/password/reset': resetPasswordBody,
  'patch /api/v1/auth/me': updateMeBody,
  'post /api/v1/invitations/{token}/accept': acceptInvitationBody,
  'post /api/v1/admin/auth/login': adminLoginBody,
  'post /api/v1/admin/auth/refresh': refreshBody,
  'post /api/v1/admin/materials': admin.createCatalogMaterialBody,
  'patch /api/v1/admin/materials/{id}': admin.updateCatalogMaterialBody,
  'post /api/v1/materials': md.createMaterialBody,
  'patch /api/v1/materials/{id}': md.updateMaterialBody,
  'post /api/v1/quality-categories': md.createCategoryBody,
  'patch /api/v1/quality-categories/{id}': md.updateCategoryBody,
  'post /api/v1/quality-categories/{id}/duplicate': md.duplicateCategoryBody,
  'put /api/v1/price-list': md.setPriceListBody,
  'post /api/v1/price-list/bulk-percent': md.bulkPercentBody,
  'put /api/v1/labor-rates': md.setLaborRatesBody,
  'post /api/v1/payment-templates': md.createTemplateBody,
  'patch /api/v1/payment-templates/{id}': md.updateTemplateBody,
  'post /api/v1/suppliers': md.createSupplierBody,
  'patch /api/v1/suppliers/{id}': md.updateSupplierBody,
  'put /api/v1/suppliers/{id}/rates': md.setSupplierRatesBody,
  'post /api/v1/workers': md.createWorkerBody,
  'patch /api/v1/workers/{id}': md.updateWorkerBody,
  'post /api/v1/subcontractors': md.createSubcontractorBody,
  'patch /api/v1/subcontractors/{id}': md.updateSubcontractorBody,
  'post /api/v1/clients': cl.createClientBody,
  'patch /api/v1/clients/{id}': cl.updateClientBody,
  'post /api/v1/projects': pr.createProjectBody,
  'patch /api/v1/projects/{id}/basic': pr.updateBasicBody,
  'put /api/v1/projects/{id}/team': pr.setTeamBody,
  'patch /api/v1/projects/{id}/contract': pr.updateContractBody,
  'patch /api/v1/projects/{id}/plot-structure': pr.updatePlotStructureBody,
  'patch /api/v1/projects/{id}/coverage': pr.updateCoverageBody,
  'patch /api/v1/projects/{id}/status': pr.changeStatusBody,
  'post /api/v1/floors/{id}/rooms': pr.createRoomBody,
  'post /api/v1/floors/{id}/copy': pr.copyFloorBody,
  'patch /api/v1/rooms/{id}': pr.updateRoomBody,
  'post /api/v1/rooms/{id}/openings': pr.openingInputSchema,
  'patch /api/v1/openings/{id}': pr.updateOpeningBody,
  'put /api/v1/stores/{locationId}/low-stock-levels': inv.lowStockLevelsBody,
  'post /api/v1/projects/{id}/material-usage': inv.usageBody,
  'post /api/v1/stock-counts': inv.stockCountBody,
  'post /api/v1/purchases': proc.createPurchaseBody,
  'patch /api/v1/purchases/{id}/rates': proc.setRatesBody,
  'post /api/v1/purchases/{id}/corrections': proc.correctionBody,
  'post /api/v1/purchases/{id}/returns': proc.purchaseReturnBody,
  'post /api/v1/purchases/{id}/receive': proc.receivePurchaseBody,
  'post /api/v1/purchase-orders': proc.createPurchaseOrderBody,
  'patch /api/v1/purchase-orders/{id}': proc.updatePurchaseOrderBody,
  'post /api/v1/supplier-payments': proc.createPaymentBody,
  'patch /api/v1/supplier-payments/{id}/cheque-status': proc.chequeStatusBody,
  'post /api/v1/dispatches': dsp.createDispatchBody,
  'post /api/v1/dispatches/{id}/receive': dsp.receiveDispatchBody,
  'post /api/v1/shortages/{id}/resolve': dsp.resolveShortageBody,
  'post /api/v1/projects/{id}/owner-deliveries': dsp.ownerDeliveryBody,
};

type Spec = {
  paths: Record<string, Record<string, { requestBody?: { content: Record<string, { examples?: Record<string, { value: unknown }> }> } }>>;
};

describe('API docs', () => {
  it('serves the OpenAPI spec with the overview, tags and every auth route', async () => {
    const res = await api().get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.description).toContain('Getting started');
    expect(res.body.info.description).toContain('Common error codes');
    expect(res.body.info.description).toContain('What to do');
    expect(res.body.tags.map((t: { name: string }) => t.name)).toEqual([
      'Health',
      'Auth',
      'Company',
      'Team',
      'Subscription',
      'Attachments',
      'Materials',
      'Price List',
      'Labor Rates',
      'Payment Templates',
      'Suppliers',
      'Workers',
      'Sub-contractors',
      'Clients',
      'Projects',
      'Project Wizard',
      'Floors & Rooms',
      'Stock',
      'Purchases',
      'Purchase Orders',
      'Supplier Ledger',
      'Dispatch',
      'Receiving',
      'Shortages',
      'Owner Deliveries',
      'Material Usage',
      'Stock Counts',
      'Platform admin auth',
      'Platform admin',
    ]);
    expect(Object.keys(res.body.paths)).toHaveLength(130);
    expect(Object.keys(res.body.components.securitySchemes)).toEqual(['cookieAuth', 'bearerAuth']);
  });

  it('every request body has ready-to-run examples that pass validation', async () => {
    const spec = (await api().get('/api/docs.json')).body as Spec;
    const withBody = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => op.requestBody?.content['application/json'])
        .map(([method, op]) => ({ key: `${method} ${path}`, examples: op.requestBody!.content['application/json']?.examples })),
    );
    expect(withBody.map((b) => b.key).sort()).toEqual(Object.keys(BODY_SCHEMAS).sort());

    for (const { key, examples } of withBody) {
      expect(examples, `${key} has no examples`).toBeDefined();
      for (const [name, example] of Object.entries(examples!)) {
        // "❌ … → 400" examples demonstrate validation errors on purpose.
        if ((example as { summary?: string }).summary?.includes('→ 400')) continue;
        const parsed = BODY_SCHEMAS[key]!.safeParse(example.value);
        expect(parsed.success, `${key} example "${name}": ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      }
    }
  });

  it('the invitation token path parameter has the seeded example', async () => {
    const spec = (await api().get('/api/docs.json')).body;
    const params = spec.paths['/api/v1/invitations/{token}/accept'].post.parameters;
    expect(params[0]).toMatchObject({ name: 'token', in: 'path', required: true });
    expect(JSON.stringify(params[0])).toContain('dev-invite-kamran-shah-2026-0001');
  });

  it('serves the themed Swagger UI', async () => {
    const res = await api().get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Construction Platform API</title>');
    expect(res.text).toContain('--accent: #f59e0b');
    expect(res.text).toContain('data:image/svg+xml');
    expect(res.text).toContain('name="viewport"');
    expect((await api().get('/api/docs')).headers['location']).toBe('/api/docs/');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("style-src 'self' https: 'unsafe-inline'");

    const init = await api().get('/api/docs/swagger-ui-init.js');
    expect(init.text).toContain('"persistAuthorization": true');
    expect(init.text).toContain('"withCredentials": true');
  });
});
