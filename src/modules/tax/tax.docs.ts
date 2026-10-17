/** Step 18 · tax — OpenAPI docs (settings, project override, the two tax reports). */
import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, WRITE_403, ex, idParam, ok, path } from '../inventory/docs.shared.js';
import { projectTaxBody, taxReportQuery, taxSettingsBody } from './tax.schema.js';
import { ADVISER_NOTE, AUTHORITY_INFO, TAX_AUTHORITIES } from './tax.rules.js';

const T = 'Tax';

const settings = {
  enabled: true,
  authority: 'PRA',
  ratePercent: 16,
  label: null,
  effectiveLabel: 'PRA Sales Tax',
  ntn: '1234567-8',
  strn: '3277876123456',
  whtDefaultRatePercent: 8,
  authorities: TAX_AUTHORITIES.map((code) => ({ code, ...AUTHORITY_INFO[code] })),
  adviserNote: ADVISER_NOTE,
};
const projectTax = {
  projectId: IDS.dha,
  mode: 'ON',
  authority: 'SRB',
  ratePercent: 15,
  effective: { taxOn: true, applies: true, authority: 'SRB', ratePercent: 15, label: 'SRB Sales Tax', source: 'PROJECT' },
  company: { enabled: false, authority: 'PRA', ratePercent: 16, whtDefaultRatePercent: 8 },
};

const RULES =
  'Tax is OFF by default. Effective tax of a project: mode INHERIT = the company setting, ON / OFF = this project only; authority / rate = the project override when set, else the company value. ' +
  'An invoice gets a tax line when tax is on and the rate > 0: round half-up (taxable base × rate ÷ 100), base = every line except owner-recoverable purchases (CASH_ENTRY). ' +
  'Drafts are recalculated when settings change; issued invoices keep their snapshot. ' +
  ADVISER_NOTE;

const REPORTS = {
  'wht-summary': {
    summary: 'WHT summary (tax year)',
    detail: 'Per client × month: receipts, gross received (cash + WHT), cash, WHT deducted, WHT % of gross, certificates received / missing and WHT without a certificate. Bounced cheques left out.',
    example: { columns: [{ key: 'client', label: 'Client', type: 'text' }, { key: 'month', label: 'Month', type: 'text' }, { key: 'wht', label: 'WHT deducted', type: 'money' }], rows: [{ client: 'Ahmed Raza', month: '2026-09', wht: '8000000' }], totals: { client: null, month: null, wht: '8000000' } },
  },
  'tax-invoice-register': {
    summary: 'Tax-wise invoice register',
    detail: 'Issued invoices of the period (cancelled ones listed, not counted): invoice no., date, client, client NTN, project, value, taxable value, tax rate, tax, total, authority, status. Sorted by authority, then date; notes give the subtotal per authority + rate.',
    example: { columns: [{ key: 'number', label: 'Invoice no.', type: 'text' }, { key: 'tax', label: 'Tax', type: 'money' }], rows: [{ number: 'INV-2026-0050', tax: '59200000' }], totals: { number: null, tax: '59200000' } },
  },
} as const;

export function registerTaxDocs(): void {
  path(T, 'get', '/api/v1/tax/settings', {
    summary: 'Tax settings',
    description: `tax.view. ${RULES} \`authorities\` lists PRA / SRB / KPRA / ICT with their default rate and label (defaults only pre-fill the form).`,
    responses: { ...ok('Tax settings', settings), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'patch', '/api/v1/tax/settings', {
    summary: 'Change tax settings',
    description: `tax.settings.manage (owner, Administrator). Switching on needs an authority and a rate > 0. \`ntn\` is the company profile NTN. DRAFT invoices are recalculated; audited (tax.settings.update). ${ADVISER_NOTE}`,
    request: {
      body: jsonBody(taxSettingsBody, {
        on: ex('Switch on: PRA 16 %', { enabled: true, authority: 'PRA', ratePercent: 16, ntn: '1234567-8', strn: '3277876123456' }),
        off: ex('Switch off', { enabled: false }),
        wht: ex('Default WHT % on the payment form', { whtDefaultRatePercent: 7.5 }),
      }),
    },
    responses: { ...ok('Tax settings', settings), ...errors({ 400: ['VALIDATION_ERROR', 'TAX_SETTINGS_INCOMPLETE'], ...AUTH, 403: WRITE_403 }) },
  });
  path(T, 'get', '/api/v1/projects/{id}/tax', {
    summary: 'Tax of a project',
    description: 'billing.invoice.view (project scope). The project override (mode / authority / rate) and the effective tax its invoices get.',
    request: { params: idParam('Project') },
    responses: { ...ok('Project tax', projectTax), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/projects/{id}/tax', {
    summary: 'Project tax override',
    description: 'tax.settings.manage. INHERIT / ON / OFF, and authority / rate for a project in another province (null = the company value). ON needs an authority and rate (here or in the company settings). The project’s DRAFT invoices are recalculated; audited (project.tax.update).',
    request: {
      params: idParam('Project'),
      body: jsonBody(projectTaxBody, {
        karachi: ex('Karachi project: SRB 15 %', { mode: 'ON', authority: 'SRB', ratePercent: 15 }),
        inherit: ex('Back to the company setting', { mode: 'INHERIT', authority: null, ratePercent: null }),
        off: ex('No tax on this project', { mode: 'OFF' }),
      }),
    },
    responses: { ...ok('Project tax', projectTax), ...errors({ 400: ['VALIDATION_ERROR', 'TAX_SETTINGS_INCOMPLETE'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  for (const [name, info] of Object.entries(REPORTS)) {
    path('Reports', 'get', `/api/v1/reports/${name}`, {
      summary: `${info.summary} (Step 18)`,
      description:
        `tax.view + fields.amounts (403 FORBIDDEN without amounts). ${info.detail} Default period: the current tax year (1 July – 30 June). ` +
        '`format=json` (default) returns the table; `csv` / `xlsx` / `pdf` are stored as a REPORT attachment and answer `{ url, expiresAt }`. Money is paisa in JSON and rupees in files.',
      request: { query: taxReportQuery },
      responses: {
        ...ok('Report table (json) or a signed link (csv / xlsx / pdf)', { name, title: info.summary, subtitle: 'All projects · Tax year 2026-27 (1 Jul 2026 – 30 Jun 2027)', generatedAt: '2026-10-16T05:00:00.000Z', filters: { projectId: null, from: '2026-07-01', to: '2027-06-30' }, ...info.example, notes: [ADVISER_NOTE], noteCodes: [{ code: 'TAX_ADVISER', params: {} }] }),
        ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }),
      },
    });
  }
}
