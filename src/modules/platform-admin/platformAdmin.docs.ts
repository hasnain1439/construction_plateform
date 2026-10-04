import { z } from 'zod';
import { errors, jsonBody, platformSecurity, registry, type NamedExample } from '../../core/openapi/registry.js';
import {
  approvePaymentBody,
  auditQuery,
  catalogMaterialsQuery,
  createCatalogMaterialBody,
  createHolidayBody,
  createPlanBody,
  createTenantBody,
  holidaysQuery,
  paymentsQuery,
  rejectPaymentBody,
  tenantPlanBody,
  tenantsQuery,
  tenantStatusBody,
  updateHolidayBody,
  updateCatalogMaterialBody,
  updatePlanBody,
} from './platformAdmin.schema.js';

const tags = ['Platform admin'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED'], 403: ['FORBIDDEN'] };
const ok = (description: string, example?: unknown) => ({
  200: {
    description,
    content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.unknown() }), ...(example ? { example: { success: true, data: example } } : {}) } },
  },
});
const createdResp = (description: string, example?: unknown) => ({
  201: {
    description,
    content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.unknown() }), ...(example ? { example: { success: true, data: example } } : {}) } },
  },
});
const ex = (summary: string, value: unknown, description?: string): NamedExample => ({ summary, value, ...(description ? { description } : {}) });
const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });
const today = new Date().toISOString().slice(0, 10);
const nextYear = new Date().getUTCFullYear() + 1;
const PLAN_ID = '0199a8c0-0000-7000-8000-0000000000b2';

function path(method: 'get' | 'post' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) {
  registry.registerPath({ method, path: url, tags, security: platformSecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
}

export function registerPlatformAdminDocs(): void {
  // ─── Overview & health ───────────────────────────────────────────────────
  path('get', '/api/v1/admin/overview', {
    summary: 'Dashboard numbers',
    description:
      'Company counts by state, **MRR** (sum of plan prices for ACTIVE + GRACE subscriptions, paisa), payments waiting for review, ' +
      'trials ending in 7 days, companies per plan and approved revenue for the last 12 months.',
    responses: {
      ...ok('Overview', {
        activeCompanies: 2,
        trialCompanies: 0,
        graceCompanies: 1,
        readOnlyCompanies: 1,
        suspendedCompanies: 0,
        mrrPaisa: '1750000',
        paymentsAwaitingReview: 1,
        trialsEndingThisWeek: 0,
        planDistribution: [{ planCode: 'STARTER', count: 3 }, { planCode: 'PROFESSIONAL', count: 1 }],
        revenueByMonth: [{ month: '2026-09', amountPaisa: '950000' }],
      }),
      ...errors(AUTH),
    },
  });
  path('get', '/api/v1/admin/health', {
    summary: 'System health',
    description: 'API, database (latency), SMS / mail / storage providers, version, uptime and the last subscription-lifecycle job run.',
    responses: { ...ok('Health'), ...errors(AUTH) },
  });

  // ─── Companies ───────────────────────────────────────────────────────────
  path('get', '/api/v1/admin/tenants', {
    summary: 'Companies',
    description: 'Search by name, slug or owner phone; filter by company status, subscription status, plan code or renewal date.',
    request: { query: tenantsQuery },
    responses: { ...ok('Companies with owner, plan, status and usage'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'] }) },
  });
  path('post', '/api/v1/admin/tenants', {
    summary: 'Create a company from the console',
    description:
      'One transaction: company, settings, subscription (TRIAL, or PAID = ACTIVE 30 days + an approved payment with a receipt number) ' +
      'and a 7-day **THEKEDAR invitation** for the owner (sent by SMS). The owner sets a password by accepting it. ' +
      '`devInviteUrl` is returned outside production.',
    request: {
      body: jsonBody(createTenantBody, {
        trial: ex('14-day trial on Professional', {
          company: { name: 'Lahore Grand Builders', phone: '042-35000000', region: 'PUNJAB_KP', ntn: '7654321-0' },
          owner: { name: 'Imran Qureshi', phone: '0345-2223334' },
          subscription: { mode: 'TRIAL', planCode: 'PROFESSIONAL', trialDays: 14 },
          note: 'Signed up at the Expo Centre',
        }),
        paid: ex('Paid Starter (bank transfer received)', {
          company: { name: 'Karachi Coastal Builders', slug: 'karachi-coastal', phone: '021-34567890', region: 'KARACHI_SINDH', marlaStandard: 272.25 },
          owner: { name: 'Salman Shaikh', phone: '0300-7778889' },
          subscription: { mode: 'PAID', planCode: 'STARTER', payment: { method: 'IBFT', transactionId: 'IBFT2610050001', amountPaisa: '400000', paidOn: today } },
        }, 'Change transactionId / owner phone to create another one.'),
      }),
    },
    responses: {
      ...createdResp('Created', {
        tenant: { id: '0199…', name: 'Lahore Grand Builders', slug: 'lahore-grand-builders', status: 'ACTIVE' },
        subscription: { status: 'TRIAL', plan: { code: 'PROFESSIONAL', name: 'Professional' }, trialEndsAt: '2026-10-19T09:00:00.000Z', currentPeriodEnd: null, receiptNo: null },
        owner: { name: 'Imran Qureshi', phone: '+923452223334', invitation: { id: '0199…', status: 'PENDING', expiresAt: '2026-10-12T09:00:00.000Z', devInviteUrl: 'http://localhost:3000/invite/…' } },
      }),
      ...errors({
        ...AUTH,
        400: ['VALIDATION_ERROR', 'INVALID_PLAN', 'AMOUNT_MISMATCH', 'PAID_ON_IN_FUTURE', 'PAID_ON_TOO_OLD'],
        409: ['SLUG_TAKEN', 'DUPLICATE_TRANSACTION', 'PHONE_TAKEN'],
      }),
    },
  });
  path('get', '/api/v1/admin/tenants/{id}', {
    summary: 'Company detail',
    description: 'Profile, owner, settings summary, full subscription, usage, last 10 payments and last 20 audit events.',
    request: { params: idParam('Company') },
    responses: { ...ok('Company'), ...errors({ ...AUTH, 404: ['TENANT_NOT_FOUND'] }) },
  });
  path('patch', '/api/v1/admin/tenants/{id}/status', {
    summary: 'Extend trial, set read-only, reactivate, suspend or close',
    description:
      '- `EXTEND_TRIAL` (days 1–30): only a TRIAL or a lapsed trial; back to TRIAL and company ACTIVE.\n' +
      '- `SET_READ_ONLY`: company READ_ONLY.\n- `REACTIVATE`: company status implied by the subscription (ACTIVE, or READ_ONLY if lapsed).\n' +
      '- `SUSPEND` / `CLOSE` (note required): signs every user out; logins answer 403 COMPANY_SUSPENDED.',
    request: {
      params: idParam('Company'),
      body: jsonBody(tenantStatusBody, {
        extend: ex('Extend trial by 7 days', { action: 'EXTEND_TRIAL', days: 7 }),
        suspend: ex('Suspend', { action: 'SUSPEND', note: 'Cheque bounced, owner asked to pause' }),
        reactivate: ex('Reactivate', { action: 'REACTIVATE' }),
        readOnly: ex('Make read-only', { action: 'SET_READ_ONLY', note: 'Waiting for bank confirmation' }),
        noNote: ex('❌ Suspend without note → 400', { action: 'SUSPEND' }),
      }),
    },
    responses: {
      ...ok('New status', { id: '0199…', tenantStatus: 'ACTIVE', subscriptionStatus: 'TRIAL', trialEndsAt: '2026-10-19T09:00:00.000Z' }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 404: ['TENANT_NOT_FOUND'], 409: ['CANNOT_EXTEND_TRIAL', 'TENANT_CLOSED'] }),
    },
  });
  path('patch', '/api/v1/admin/tenants/{id}/plan', {
    summary: "Change a company's plan",
    description:
      '`IMMEDIATE` switches now; `NEXT_RENEWAL` waits for the end of the paid period (or the next approved payment). ' +
      'Same limit checks and error codes as the company-side change-plan; projects outside `keepActiveProjectIds` become READ_ONLY on an immediate downgrade.',
    request: {
      params: idParam('Company'),
      body: jsonBody(tenantPlanBody, {
        now: ex('Switch now', { planId: PLAN_ID, effective: 'IMMEDIATE', note: 'Owner asked by phone' }, 'Use a planId from GET /admin/plans.'),
        renewal: ex('At next renewal', { planId: PLAN_ID, effective: 'NEXT_RENEWAL' }),
      }),
    },
    responses: {
      ...ok('Plan change'),
      ...errors({
        ...AUTH,
        400: ['VALIDATION_ERROR', 'INVALID_PLAN', 'SAME_PLAN', 'DOWNGRADE_USERS_OVER_LIMIT', 'KEEP_PROJECTS_REQUIRED', 'TOO_MANY_PROJECTS', 'INVALID_PROJECT'],
        404: ['TENANT_NOT_FOUND'],
      }),
    },
  });

  // ─── Payments ────────────────────────────────────────────────────────────
  path('get', '/api/v1/admin/payments', {
    summary: 'Payment review queue',
    description:
      'Defaults to PENDING_REVIEW (oldest first). `duplicateWarning` = another company paid the same amount by the same method within a day, ' +
      'or this company already had a rejected payment with the same amount, method and date.',
    request: { query: paymentsQuery },
    responses: {
      ...ok('Payments', [
        {
          id: '0199…',
          tenant: { id: '0199…', name: 'Ahmed Constructions' },
          plan: { code: 'STARTER', name: 'Starter' },
          expectedAmountPaisa: '400000',
          amountPaisa: '400000',
          method: 'EASYPAISA',
          transactionId: 'EP2610010042',
          paidOn: '2026-10-02',
          submittedAt: '2026-10-03T08:00:00.000Z',
          status: 'PENDING_REVIEW',
          duplicateWarning: false,
        },
      ]),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'] }),
    },
  });
  path('get', '/api/v1/admin/payments/{id}', {
    summary: 'Payment detail',
    description: 'Includes a signed slip URL and `duplicateOf` [{ tenantName, paidOn, status }].',
    request: { params: idParam('Payment') },
    responses: { ...ok('Payment'), ...errors({ ...AUTH, 404: ['PAYMENT_NOT_FOUND'] }) },
  });
  path('post', '/api/v1/admin/payments/{id}/approve', {
    summary: 'Approve a payment',
    description:
      '30 days from **today** (TRIAL / GRACE / LAPSED) or from the **current period end** (ACTIVE). Switches to the paid plan and clears a matching pending change. ' +
      'Receipt `RCPT-YYYY-NNNN` (per-year counter, gap-free). Subscription ACTIVE, company ACTIVE immediately, SMS to the owner.',
    request: { params: idParam('Payment'), body: jsonBody(approvePaymentBody, { plain: ex('Approve', {}), note: ex('With a note', { note: 'Matched in the JazzCash statement' }) }) },
    responses: {
      ...ok('Approved', { id: '0199…', status: 'APPROVED', receiptNo: 'RCPT-2026-0382', periodStart: '2026-10-05T09:00:00.000Z', periodEnd: '2026-11-04T09:00:00.000Z' }),
      ...errors({ ...AUTH, 400: ['DOWNGRADE_USERS_OVER_LIMIT', 'KEEP_PROJECTS_REQUIRED'], 404: ['PAYMENT_NOT_FOUND'], 409: ['ALREADY_PROCESSED'] }),
    },
  });
  path('post', '/api/v1/admin/payments/{id}/reject', {
    summary: 'Reject a payment',
    description: 'Reason (5–300 characters) is sent to the owner by SMS and shown in their payment history.',
    request: {
      params: idParam('Payment'),
      body: jsonBody(rejectPaymentBody, {
        blurred: ex('Blurred slip', { reason: 'Slip is blurred — please upload a clear photo' }),
        tooShort: ex('❌ Too short → 400', { reason: 'no' }),
      }),
    },
    responses: { ...ok('Rejected'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 404: ['PAYMENT_NOT_FOUND'], 409: ['ALREADY_PROCESSED'] }) },
  });

  // ─── Plans ───────────────────────────────────────────────────────────────
  path('get', '/api/v1/admin/plans', { summary: 'Plans (including inactive) with company counts', responses: { ...ok('Plans'), ...errors(AUTH) } });
  path('post', '/api/v1/admin/plans', {
    summary: 'Create a plan',
    request: {
      body: jsonBody(createPlanBody, {
        plan: ex('Business Plus', { code: 'BUSINESS_PLUS', name: 'Business Plus', pricePaisa: '1500000', maxActiveProjects: 8, maxOfficeUsers: null, features: ['8 active projects', 'Unlimited office users'], sortOrder: 3 }),
      }),
    },
    responses: { ...createdResp('Created'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 409: ['PLAN_CODE_TAKEN'] }) },
  });
  path('patch', '/api/v1/admin/plans/{id}', {
    summary: 'Update a plan',
    description: '`code` cannot change. A new price applies to future payments only. The last active paid plan cannot be deactivated.',
    request: {
      params: idParam('Plan'),
      body: jsonBody(updatePlanBody, {
        price: ex('New price', { pricePaisa: '450000' }),
        hide: ex('Stop selling', { isActive: false }),
        code: ex('❌ Change code → 400', { code: 'CHEAP' }),
      }),
    },
    responses: { ...ok('Updated'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 404: ['PLAN_NOT_FOUND'], 409: ['LAST_ACTIVE_PLAN'] }) },
  });

  // ─── Holidays ────────────────────────────────────────────────────────────
  path('get', '/api/v1/admin/holidays', { summary: 'Platform holidays', request: { query: holidaysQuery }, responses: { ...ok('Holidays'), ...errors(AUTH) } });
  path('post', '/api/v1/admin/holidays', {
    summary: 'Add a platform holiday',
    description: 'Nationwide (region omitted) or for one region. Shown in every company calendar.',
    request: {
      body: jsonBody(createHolidayBody, {
        eid: ex('Eid ul Fitr (3 days)', { name: 'Eid ul Fitr', startDate: `${nextYear}-03-20`, endDate: `${nextYear}-03-22`, type: 'NON_WORKING' }),
        regional: ex('Sindh only, half day', { name: 'Sindh Culture Day', startDate: `${nextYear}-12-07`, type: 'PARTIAL', region: 'KARACHI_SINDH' }),
        bad: ex('❌ endDate before startDate → 400', { name: 'Wrong', startDate: `${nextYear}-03-22`, endDate: `${nextYear}-03-20` }),
      }),
    },
    responses: { ...createdResp('Created'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 409: ['HOLIDAY_EXISTS'] }) },
  });
  path('patch', '/api/v1/admin/holidays/{id}', {
    summary: 'Edit a platform holiday',
    request: { params: idParam('Holiday'), body: jsonBody(updateHolidayBody, { moon: ex('Moon sighted a day later', { startDate: `${nextYear}-03-21`, endDate: `${nextYear}-03-23` }) }) },
    responses: { ...ok('Updated'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 404: ['HOLIDAY_NOT_FOUND'], 409: ['HOLIDAY_EXISTS'] }) },
  });
  path('delete', '/api/v1/admin/holidays/{id}', {
    summary: 'Delete a platform holiday',
    request: { params: idParam('Holiday') },
    responses: { ...ok('Deleted'), ...errors({ ...AUTH, 404: ['HOLIDAY_NOT_FOUND'] }) },
  });

  // ─── Audit log ───────────────────────────────────────────────────────────
  path('get', '/api/v1/admin/audit-logs', {
    summary: 'Audit log',
    description: 'Newest first. `action` is a prefix (e.g. `auth.`, `subscription.payment`). Secret-looking fields are always redacted.',
    request: { query: auditQuery },
    responses: { ...ok('Audit events'), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'] }) },
  });

  // ─── Material catalog ────────────────────────────────────────────────────
  const GROUP_ID = '0199a8c0-0000-7000-8000-0000000000c4';
  const catalogItem = {
    id: '0199a8c0-0000-7000-8000-0000000000d9',
    group: { id: GROUP_ID, code: 'WATERPROOFING', name: 'Waterproofing' },
    name: 'Waterproof coating',
    unit: 'bucket',
    unitDetail: '1 bucket = 20 kg',
    altUnits: [{ unit: 'kg', factor: 20 }],
    supplyCategory: 'GREY_STRUCTURE',
    usedByRulebook: false,
    rulebookKey: null,
    isActive: true,
    sortOrder: 41,
  };
  path('get', '/api/v1/admin/material-groups', {
    summary: 'Material groups',
    description: 'The 12 fixed groups with how many catalog materials each has.',
    responses: { ...ok('Groups', [{ id: GROUP_ID, code: 'WATERPROOFING', name: 'Waterproofing', section: 'CIVIL', sortOrder: 5, materials: 3 }]), ...errors(AUTH) },
  });
  path('get', '/api/v1/admin/materials', {
    summary: 'Platform material catalog',
    description: 'Every catalog material; `companies` = how many companies have a copy.',
    request: { query: catalogMaterialsQuery },
    responses: { ...ok('Catalog', [{ ...catalogItem, companies: 4 }]), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'] }) },
  });
  path('post', '/api/v1/admin/materials', {
    summary: 'Add a catalog material',
    description:
      'With `pushToTenants` (default true) it is copied into every company at once; a company that already has a ' +
      'material with that name keeps its own. New companies always get every active catalog material.',
    request: {
      body: jsonBody(createCatalogMaterialBody, {
        push: ex('Waterproof coating, push to all', { groupId: GROUP_ID, name: 'Waterproof coating', unit: 'bucket', unitDetail: '1 bucket = 20 kg', altUnits: [{ unit: 'kg', factor: 20 }], supplyCategory: 'GREY_STRUCTURE' }),
        quiet: ex('Catalog only (new companies get it)', { groupId: GROUP_ID, name: 'Crystalline admixture', unit: 'kg', supplyCategory: 'GREY_STRUCTURE', pushToTenants: false }),
      }),
    },
    responses: { ...createdResp('Created', { ...catalogItem, pushedTo: 4 }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'INVALID_GROUP'], 409: ['PLATFORM_MATERIAL_EXISTS'] }) },
  });
  path('patch', '/api/v1/admin/materials/{id}', {
    summary: 'Edit a catalog material',
    description:
      'Name, unitDetail and altUnits flow into company copies that were never customised (skipping a company that ' +
      'already has another material with the new name). The unit can never change.',
    request: {
      params: idParam('Catalog material'),
      body: jsonBody(updateCatalogMaterialBody, {
        rename: ex('Rename everywhere', { name: 'Waterproof coating (acrylic)' }),
        retire: ex('Stop giving it to new companies', { isActive: false }),
        unit: ex('❌ Change unit → 400', { unit: 'litre' }),
      }),
    },
    responses: { ...ok('Updated', { ...catalogItem, propagatedTo: 3 }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 404: ['PLATFORM_MATERIAL_NOT_FOUND'], 409: ['PLATFORM_MATERIAL_EXISTS'] }) },
  });
}
