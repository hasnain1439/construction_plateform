import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, success } from '../../core/openapi/registry.js';
import {
  companyDto,
  createHolidayBody,
  holidayDto,
  settingsDto,
  updateCompanyBody,
  updateSettingsBody,
} from './company.schema.js';

const tags = ['Company'];
const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const OWNER_ONLY = { ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'] };
const ex = (summary: string, value: unknown, description?: string) => ({ summary, value, ...(description ? { description } : {}) });
const nextYear = new Date().getUTCFullYear() + 1;

const companyExample = {
  success: true,
  data: {
    id: '0199a8c0-0000-7000-8000-0000000000aa',
    name: 'Malik & Sons Builders',
    slug: 'malik-and-sons-builders',
    ntn: '1234567-8',
    logoAttachmentId: null,
    logoUrl: null,
    address: 'Office 12, MM Alam Road, Gulberg III, Lahore',
    phone: '+924235761234',
    email: 'info@maliksons.pk',
    region: 'PUNJAB_KP',
    marlaStandard: 225,
    status: 'ACTIVE',
    createdAt: '2026-10-01T09:00:00.000Z',
  },
};

const settingsExample = {
  success: true,
  data: {
    kharchaApprovalLimitPaisa: '2500000',
    overuseAlertPercent: 10,
    missingLogAlertTime: '18:00',
    quoteValidityDays: 15,
    taxEnabled: false,
    pmCanSeeFinancials: false,
    blindCountEnabled: true,
    settlementWeekStart: 'MONDAY',
    workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
    hoursPerDay: 8,
    overtimeMultiplier: null,
    subcontractPaymentsByPm: false,
    paymentTermsDays: 7,
    taxRatePercent: 0,
    taxLabel: null,
    pmCanRecordPayments: false,
    defaultLanguage: 'ROMAN_URDU',
  },
};

export function registerCompanyDocs(): void {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/company',
    tags,
    summary: 'Company profile',
    description: 'THEKEDAR and PM. `logoUrl` is a short-lived signed link.',
    security: companySecurity,
    responses: {
      200: { description: 'Company', content: { 'application/json': { schema: success(companyDto), example: companyExample } } },
      ...errors({ ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/company',
    tags,
    summary: 'Update company profile',
    description: 'THEKEDAR only. Send only the fields to change; `null` clears an optional field. Upload the logo first (`POST /attachments`, kind LOGO).',
    security: companySecurity,
    request: {
      body: jsonBody(updateCompanyBody, {
        profile: ex('Address, NTN and phone', { ntn: '1234567-8', address: 'Office 12, MM Alam Road, Gulberg III, Lahore', phone: '042-35761234' }),
        rename: ex('Rename company', { name: 'Malik & Sons Builders (Pvt) Ltd' }),
        logo: ex('Set logo', { logoAttachmentId: '0199a8c0-0000-7000-8000-00000000a001' }, 'Paste the id from POST /attachments (kind LOGO).'),
        marla: ex('Use revenue marla (272.25 sq ft)', { marlaStandard: 272.25 }),
        badNtn: ex('❌ Invalid NTN → 400', { ntn: '12345' }),
      }),
    },
    responses: {
      200: { description: 'Updated company', content: { 'application/json': { schema: success(companyDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...OWNER_ONLY, 404: ['ATTACHMENT_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/company/settings',
    tags,
    summary: 'Business rules',
    description: 'THEKEDAR only. Money is paisa as a string.',
    security: companySecurity,
    responses: {
      200: { description: 'Settings', content: { 'application/json': { schema: success(settingsDto), example: settingsExample } } },
      ...errors({ ...AUTH, 403: ['FORBIDDEN', 'COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/company/settings',
    tags,
    summary: 'Update business rules',
    description:
      'THEKEDAR only.\n\n- `kharchaApprovalLimitPaisa` ≥ 0 (paisa string)\n- `overuseAlertPercent` 1–20\n- `missingLogAlertTime` HH:MM\n- `quoteValidityDays` 1–90\n\n' +
      '`pmCanSeeFinancials` is the default for new PM invitations. `blindCountEnabled` hides sent / challan quantities while a site counts a delivery.\n\n' +
      'Labour: `settlementWeekStart`, `workingDays`, `hoursPerDay` (1–16), `overtimeMultiplier` (1–3, null = the DAILY labour rate multiplier) and `subcontractPaymentsByPm`.\n\n' +
      'Billing: `paymentTermsDays` (0–90), `taxRatePercent` (0–30) and `taxLabel` (used only when `taxEnabled`), `pmCanRecordPayments`.',
    security: companySecurity,
    request: {
      body: jsonBody(updateSettingsBody, {
        limits: ex('Kharcha limit Rs 50,000 and 15% overuse alert', { kharchaApprovalLimitPaisa: '5000000', overuseAlertPercent: 15 }),
        alerts: ex('Site log alert at 7 pm, quotes valid 30 days', { missingLogAlertTime: '19:00', quoteValidityDays: 30 }),
        flags: ex('Enable tax, Urdu by default', { taxEnabled: true, defaultLanguage: 'URDU' }),
        bad: ex('❌ overuseAlertPercent 50 → 400', { overuseAlertPercent: 50 }),
      }),
    },
    responses: {
      200: { description: 'Updated settings', content: { 'application/json': { schema: success(settingsDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR'], ...OWNER_ONLY }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/company/holidays',
    tags,
    summary: 'Holiday calendar (platform + company)',
    description:
      'All roles. National holidays (`source: platform`, read-only) merged with the company’s own (`source: company`). ' +
      'Defaults to the current year; pass `year` or `from` + `to`.',
    security: companySecurity,
    request: {
      query: z.object({
        year: z.number().int().optional().meta({ example: nextYear - 1 }),
        from: z.string().optional().meta({ example: `${nextYear - 1}-08-01` }),
        to: z.string().optional().meta({ example: `${nextYear - 1}-08-31` }),
      }),
    },
    responses: {
      200: {
        description: 'Holidays sorted by start date',
        content: {
          'application/json': {
            schema: success(z.array(holidayDto)),
            example: {
              success: true,
              data: [
                { id: '0199…', name: 'Independence Day', startDate: '2026-08-14', endDate: '2026-08-14', type: 'NON_WORKING', source: 'platform', editable: false },
                { id: '0199…', name: 'Site closed — monsoon', startDate: '2026-08-20', endDate: '2026-08-22', type: 'NON_WORKING', source: 'company', editable: true },
              ],
            },
          },
        },
      },
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: ['COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/company/holidays',
    tags,
    summary: 'Add a company holiday',
    description: 'THEKEDAR only. `startDate` can’t be in the past; `endDate` (optional) must be on or after it.',
    security: companySecurity,
    request: {
      body: jsonBody(createHolidayBody, {
        range: ex('Monsoon shutdown (3 days)', { name: 'Site closed — monsoon', startDate: `${nextYear}-08-20`, endDate: `${nextYear}-08-22`, type: 'NON_WORKING' }),
        partial: ex('Half day', { name: 'Company annual dinner', startDate: `${nextYear}-12-30`, type: 'PARTIAL' }),
        bad: ex('❌ endDate before startDate → 400', { name: 'Wrong', startDate: `${nextYear}-08-22`, endDate: `${nextYear}-08-20` }),
      }),
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: success(holidayDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR', 'HOLIDAY_IN_PAST'], ...OWNER_ONLY, 409: ['HOLIDAY_EXISTS'] }),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/company/holidays/{id}',
    tags,
    summary: 'Delete a company holiday',
    description: 'THEKEDAR only. Platform holidays cannot be deleted (404).',
    security: companySecurity,
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: success(z.object({ deleted: z.literal(true) })) } } },
      ...errors({ ...OWNER_ONLY, 404: ['HOLIDAY_NOT_FOUND'] }),
    },
  });
}
