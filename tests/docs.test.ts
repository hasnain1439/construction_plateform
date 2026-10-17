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
  updatePreferencesBody,
} from '../src/modules/auth/auth.schema.js';
import { updateCompanyBody, updateSettingsBody, createHolidayBody } from '../src/modules/company/company.schema.js';
import { createInvitationBody, setUserPasswordBody, setUserProjectsBody, updateUserBody } from '../src/modules/team/team.schema.js';
import { changePlanBody, submitPaymentBody } from '../src/modules/subscription/subscription.schema.js';
import * as admin from '../src/modules/platform-admin/platformAdmin.schema.js';
import * as md from '../src/modules/master-data/master-data.schema.js';
import * as cl from '../src/modules/clients/clients.schema.js';
import * as pr from '../src/modules/projects/projects.schema.js';
import * as inv from '../src/modules/inventory/inventory.schema.js';
import * as proc from '../src/modules/procurement/procurement.schema.js';
import * as dsp from '../src/modules/dispatch/dispatch.schema.js';
import * as lab from '../src/modules/labor/labor.schema.js';
import * as cb from '../src/modules/cashbook/cashbook.schema.js';
import * as bl from '../src/modules/billing/billing.schema.js';
import * as ap from '../src/modules/approvals/approvals.schema.js';
import * as dl from '../src/modules/dailylogs/dailylogs.schema.js';
import * as sy from '../src/modules/sync/sync.schema.js';
import * as pe from '../src/modules/permissions/permissions.schema.js';
import * as ob from '../src/modules/onboarding/onboarding.schema.js';
import { estimateSettingsBody } from '../src/modules/estimate/settings.js';
import { contractFromEstimateBody } from '../src/modules/estimate/contractValue.js';
import { autoWallsBody, setWallsBody } from '../src/modules/projects/walls.js';
import * as eqp from '../src/modules/equipment/equipment.schema.js';
import * as co from '../src/modules/closeout/closeout.schema.js';
import { approveEstimateBody, generateEstimateBody, lineOverrideBody } from '../src/modules/estimate/estimate.schema.js';
import { setOverridesBody } from '../src/modules/rulebook/rulebook.schema.js';
import * as sales from '../src/modules/sales/sales.schema.js';
import { createRulebookBody, updateParameterBody, updateRulebookBody } from '../src/modules/platform-admin/rulebook.schema.js';
import * as sch from '../src/modules/schedule/schedule.schema.js';
import * as cho from '../src/modules/change-orders/changeOrders.schema.js';
import * as ctl from '../src/modules/control/control.schema.js';
import * as tax from '../src/modules/tax/tax.schema.js';
import { api } from './helpers.js';

const BODY_SCHEMAS: Record<string, z.ZodType> = {
  // Step 18 · Tax
  'patch /api/v1/tax/settings': tax.taxSettingsBody,
  'patch /api/v1/projects/{id}/tax': tax.projectTaxBody,
  'patch /api/v1/payments/{id}/wht-certificate': bl.whtCertificateBody,
  // Step 15 · Change orders
  'post /api/v1/projects/{id}/change-orders': cho.createChangeOrderBody,
  'patch /api/v1/change-orders/{id}': cho.updateChangeOrderBody,
  'post /api/v1/change-orders/{id}/approve': cho.approveBody,
  'post /api/v1/change-orders/{id}/reject': cho.rejectBody,
  'post /api/v1/change-orders/{id}/bill': cho.billBody,
  'post /api/v1/projects/{id}/site-instructions': cho.createSiteInstructionBody,
  'post /api/v1/site-instructions/{id}/convert': cho.convertBody,
  'post /api/v1/site-instructions/{id}/dismiss': cho.dismissBody,
  'post /api/v1/snags/{id}/change-order': cho.convertBody,
  // Step 17 · Closeout
  'post /api/v1/projects/{id}/drawings': co.createDrawingBody,
  'patch /api/v1/drawings/{id}': co.updateDrawingBody,
  'post /api/v1/drawings/{id}/revisions': co.addRevisionBody,
  'patch /api/v1/drawing-revisions/{id}': co.updateRevisionBody,
  'post /api/v1/projects/{id}/snags': co.createSnagBody,
  'patch /api/v1/snags/{id}': co.updateSnagBody,
  'post /api/v1/snags/{id}/fix': co.fixSnagBody,
  'post /api/v1/snags/{id}/verify': co.verifySnagBody,
  'post /api/v1/snags/{id}/reopen': co.reopenSnagBody,
  'put /api/v1/snags/{id}/cost': co.snagCostBody,
  'put /api/v1/projects/{id}/handover/items/{key}': co.handoverItemBody,
  'post /api/v1/projects/{id}/handover/sign-off': co.signOffBody,
  'post /api/v1/projects/{id}/handover/complete': co.completeHandoverBody,
  'patch /api/v1/projects/{id}/retention': co.retentionSettingsBody,
  // Step 13
  'post /api/v1/projects/{id}/schedule/generate': sch.generateScheduleBody,
  'post /api/v1/control/alerts/run': ctl.runAlertsBody, // Step 14
  'put /api/v1/control/settings': ctl.controlSettingsBody,
  'post /api/v1/projects/{id}/schedule/replan': sch.replanBody,
  'patch /api/v1/milestones/{id}': sch.milestoneEditBody,
  'post /api/v1/milestones/{id}/progress': sch.progressBody,
  'post /api/v1/projects/{id}/stoppages': sch.stoppageBody,
  'post /api/v1/stoppages/{id}/approve': sch.approveStoppageBody,
  'post /api/v1/stoppages/{id}/reject': sch.rejectStoppageBody,
  // Step 11
  'post /api/v1/projects/{id}/estimates': generateEstimateBody,
  'patch /api/v1/estimates/{id}/lines/{lineId}': lineOverrideBody,
  'post /api/v1/estimates/{id}/approve': approveEstimateBody,
  'put /api/v1/rulebook/overrides': setOverridesBody,
  'post /api/v1/admin/rulebooks': createRulebookBody,
  'patch /api/v1/admin/rulebooks/{id}': updateRulebookBody,
  'patch /api/v1/admin/rulebooks/{id}/parameters/{key}': updateParameterBody,
  // Step 12
  'post /api/v1/quotes/preview': sales.previewBody,
  'post /api/v1/quotes': sales.createQuoteBody,
  'patch /api/v1/quotes/{id}': sales.updateQuoteBody,
  'post /api/v1/quotes/{id}/revisions': sales.addRevisionBody,
  'post /api/v1/quotes/{id}/send': sales.sendQuoteBody,
  'post /api/v1/quotes/{id}/negotiation': sales.negotiationBody,
  'post /api/v1/quotes/{id}/lost': sales.lostBody,
  'post /api/v1/quotes/{id}/won': sales.wonBody,
  'post /api/v1/onboarding/checklist/dismiss': ob.dismissBody,
  'post /api/v1/opening-balances': ob.openingBody,
  'put /api/v1/projects/{id}/estimate/settings': estimateSettingsBody,
  'post /api/v1/projects/{id}/contract/from-estimate': contractFromEstimateBody,
  'patch /api/v1/company': updateCompanyBody,
  'patch /api/v1/company/settings': updateSettingsBody,
  'post /api/v1/company/holidays': createHolidayBody,
  'patch /api/v1/users/{id}': updateUserBody,
  'put /api/v1/users/{id}/projects': setUserProjectsBody,
  'put /api/v1/users/{id}/password': setUserPasswordBody,
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
  'patch /api/v1/auth/me/preferences': updatePreferencesBody,
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
  'post /api/v1/worker-types': md.createWorkerTypeBody,
  'patch /api/v1/worker-types/{id}': md.updateWorkerTypeBody,
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
  'put /api/v1/rooms/{id}/walls': setWallsBody,
  'post /api/v1/floors/{id}/walls/auto': autoWallsBody,
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
  'post /api/v1/projects/{id}/labor/workers': lab.assignWorkerBody,
  'patch /api/v1/project-workers/{id}': lab.updateProjectWorkerBody,
  'post /api/v1/projects/{id}/labor/subcontracts': lab.assignSubcontractBody,
  'patch /api/v1/subcontract-assignments/{id}': lab.updateSubcontractBody,
  'post /api/v1/projects/{id}/attendance': lab.attendanceBody,
  'post /api/v1/projects/{id}/work-measurements': lab.measurementBody,
  'post /api/v1/work-measurements/{id}/reject': lab.rejectBody,
  'post /api/v1/projects/{id}/advances': lab.advanceBody,
  'post /api/v1/projects/{id}/settlements/generate': lab.generateBody,
  'patch /api/v1/settlements/{id}/lines/{lineId}': lab.lineBody,
  'post /api/v1/settlements/{id}/return': lab.returnBody,
  'post /api/v1/settlements/{id}/pay': lab.payBody,
  'post /api/v1/subcontract-assignments/{id}/progress': lab.progressBody,
  'post /api/v1/subcontract-assignments/{id}/payments': lab.subcontractPaymentBody,
  'post /api/v1/subcontract-assignments/{id}/deductions': lab.deductionBody,
  'post /api/v1/cash-floats': cb.floatBody,
  'post /api/v1/cash-expenses': cb.expenseBody,
  'post /api/v1/cash-expenses/{id}/approve': cb.decisionBody,
  'post /api/v1/cash-expenses/{id}/reject': cb.rejectBody,
  'post /api/v1/topup-requests': cb.topupBody,
  'post /api/v1/topup-requests/{id}/approve': cb.approveTopupBody,
  'post /api/v1/topup-requests/{id}/reject': cb.rejectBody,
  'post /api/v1/cash-counts': cb.countBody,
  'post /api/v1/cash-handovers': cb.handoverBody,
  'post /api/v1/billing-stages/{id}/mark-ready': bl.markReadyBody,
  'patch /api/v1/billing-stages/{id}': bl.updateStageBody,
  'post /api/v1/projects/{id}/billing-progress': bl.progressBody,
  'patch /api/v1/billing-progress/{id}': bl.updateProgressBody,
  'post /api/v1/projects/{id}/invoices': bl.createInvoiceBody,
  'patch /api/v1/invoices/{id}': bl.updateInvoiceBody,
  'post /api/v1/invoices/{id}/issue': bl.issueBody,
  'post /api/v1/invoices/{id}/cancel': bl.cancelBody,
  'post /api/v1/projects/{id}/payments': bl.paymentBody,
  'patch /api/v1/payments/{id}/cheque-status': bl.chequeStatusBody,
  'post /api/v1/approvals/bulk': ap.bulkBody,
  'post /api/v1/projects/{id}/daily-logs': dl.dailyLogBody,
  'patch /api/v1/daily-logs/{id}': dl.updateDailyLogBody,
  'post /api/v1/sync/push': sy.pushBody,
  'post /api/v1/roles': pe.createRoleBody,
  'patch /api/v1/roles/{id}': pe.updateRoleBody,
  'post /api/v1/roles/{id}/duplicate': pe.duplicateRoleBody,
  'put /api/v1/roles/{id}/permissions': pe.setRolePermissionsBody,
  'put /api/v1/users/{id}/permission-overrides': pe.setOverridesBody,
  'patch /api/v1/users/{id}/role': pe.setUserRoleBody,
  'put /api/v1/users/{id}/roles': pe.setUserRolesBody,
  // Step 16 — equipment
  'post /api/v1/equipment': eqp.createEquipmentBody,
  'patch /api/v1/equipment/{id}': eqp.updateEquipmentBody,
  'post /api/v1/equipment/{id}/stock-in': eqp.stockInBody,
  'post /api/v1/equipment/{id}/adjust': eqp.adjustBody,
  'post /api/v1/equipment/transfers': eqp.createTransferBody,
  'post /api/v1/equipment/transfers/{id}/receive': eqp.receiveTransferBody,
  'post /api/v1/equipment/rentals': eqp.createRentalBody,
  'post /api/v1/equipment/rentals/{id}/extend': eqp.extendRentalBody,
  'post /api/v1/equipment/rentals/{id}/return': eqp.returnRentalBody,
  'post /api/v1/equipment/rentals/{id}/close': eqp.closeRentalBody,
  'post /api/v1/equipment/losses': eqp.reportLossBody,
  'post /api/v1/equipment/losses/{id}/charge': eqp.chargeLossBody,
  'post /api/v1/equipment/accruals/run': eqp.accrualBody,
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
      'Permissions',
      'Subscription',
      'Attachments',
      'Materials',
      'Price List',
      'Labor Rates',
      'Worker Types',
      'Payment Templates',
      'Suppliers',
      'Workers',
      'Sub-contractors',
      'Clients',
      'Onboarding',
      'Imports',
      'Projects',
      'Project Wizard',
      'Floors & Rooms',
      'Estimate',
      'Sales',
      'Rulebook',
      'Schedule',
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
      'Equipment',
      'Labor Assignments',
      'Attendance',
      'Work Measurements',
      'Advances',
      'Settlements',
      'Subcontract Accounts',
      'Cash Book',
      'Billing Stages',
      'Invoices',
      'Running Bills',
      'Client Payments',
      'Receivables',
      'Statements',
      'Approvals',
      'Notifications',
      'Dashboard',
      'Finance',
      'Control',
      'Daily Logs',
      'Closeout',
      'Change Orders',
      'Sync',
      'Reports',
      'Platform admin auth',
      'Platform admin',
    ]);
    expect(Object.keys(res.body.paths)).toHaveLength(381); // +1: QA-B-02 GET /public/files/{id}, +8: Step 18 reports (5 /reports/… + 3 /reports/…/{projectId} books), +5: Step 18 tax (/tax/settings, /projects/{id}/tax, /payments/{id}/wht-certificate, /reports/wht-summary, /reports/tax-invoice-register), +10: Step 14 control (4 /projects/{id}/control/…, /projects/{id}/control/alerts, /control/summary, /control/alerts, /control/alerts/rules, /control/alerts/run, /control/settings), +4: Step 16 part 2 (shuttering demand, project shuttering demand, idle list, idle check), +16: Step 15 change orders (2 /projects/{id}/change-orders…, 9 /change-orders/{id}…, /projects/{id}/site-instructions, 3 /site-instructions/{id}…, /snags/{id}/change-order), +11: Step 12 quotes (assumptions, preview, insights, list/create, detail, revisions, send, negotiation, lost, won, pdf), +14: Step 13 schedule (8 /projects/{id}/schedule…, /projects/{id}/stoppages, 3 /milestones, 3 /stoppages), +16: Step 11 (9 estimate revision / shopping list paths, 3 company rulebook, 4 admin rulebook), +21: Step 16 equipment, +16: Step 17 closeout (drawings, snags, handover, retention), +1: POST /projects/{id}/contract/from-estimate, +2: PUT /rooms/{id}/walls + POST /floors/{id}/walls/auto, +2: project estimate (GET /estimate, PUT /estimate/settings), +1: PUT /users/{id}/roles (several roles), +1: /health/ready, +20: onboarding / imports / opening balances / demo, +1: /auth/me/preferences, -4: admin/act-as-sessions removed (direct access)
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
