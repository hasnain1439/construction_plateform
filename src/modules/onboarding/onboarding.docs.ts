import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import { ENTITY_DEFS, IMPORT_ENTITIES } from './imports.entities.js';
import { commitQuery, dismissBody, openingBody, openingListQuery } from './onboarding.schema.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const DENIED = ['PERMISSION_DENIED', 'COMPANY_SUSPENDED'];
const WRITE_DENIED = [...DENIED, 'ACCOUNT_READ_ONLY'];
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const resp = (status: 200 | 201, description: string, example: unknown) => ({
  [status]: { description, content: { 'application/json': { schema: data, example: { success: true, data: example } } } },
});

const checklistExample = {
  steps: [
    { key: 'LOGO', done: true },
    { key: 'RATES', done: false },
    { key: 'TEAM', done: true },
    { key: 'WORKERS', done: false },
    { key: 'SUPPLIERS', done: false },
    { key: 'PROJECT', done: false },
  ],
  completed: 2,
  total: 6,
  percent: 33,
  allDone: false,
  dismissed: false,
  dismissedAt: null,
  ratesReviewedAt: null,
  counts: { workers: 0, suppliers: 0, projects: 0, teamUsers: 1, pendingOrSentInvites: 1 },
  demo: null,
};

const multipart = {
  body: {
    required: true,
    content: { 'multipart/form-data': { schema: z.object({ file: z.string().meta({ format: 'binary', description: 'The filled template: .xlsx (sheet "Data" or the first sheet) or UTF-8 .csv, ≤ 2 MB, ≤ 1000 rows' }) }) } },
  },
};
const FILE_ERRORS = ['FILE_REQUIRED', 'FILE_TOO_LARGE', 'INVALID_FILE', 'INVALID_FILE_TYPE', 'EMPTY_FILE', 'TOO_MANY_ROWS', 'MISSING_COLUMNS', 'INVALID_UPLOAD'];

const previewExample = {
  entity: 'workers',
  fileName: 'workers.xlsx',
  columns: [
    { key: 'name', label: 'Name', labelRoman: 'Naam', labelUrdu: 'نام', required: true },
    { key: 'type', label: 'Worker type', required: true },
    { key: 'phone', label: 'Phone', required: false },
    { key: 'dailyRate', label: 'Daily rate (Rs)', required: false },
    { key: 'notes', label: 'Notes', required: false },
  ],
  unknownColumns: [],
  skippedExampleRows: 1,
  totalRows: 2,
  validRows: 1,
  invalidRows: 1,
  rows: [
    { rowNumber: 3, values: { name: 'Riaz', type: 'MAZDOOR', phone: '03001112233', dailyRate: '', notes: '' }, errors: [], valid: true },
    { rowNumber: 4, values: { name: 'A', type: 'PLUMBER', phone: '12345', dailyRate: 'abc', notes: '' }, errors: [{ column: 'dailyRate', message: 'Enter the amount in rupees, e.g. 1600' }, { column: 'name', message: 'Name is too short' }], valid: false },
  ],
};

const openingExample = {
  id: '0199a8c0-0000-7000-8000-0000000000b1',
  kind: 'SUPPLIER_UDHAAR',
  entity: { id: '0199a8c0-0000-7000-8000-0000000000a1', name: 'Al-Madina Cement Agency' },
  project: null,
  amountPaisa: '74000000',
  quantity: null,
  ratePaisa: null,
  date: '2026-10-01',
  note: null,
  refType: 'OPENING_BALANCE',
  refId: '0199a8c0-0000-7000-8000-0000000000b1',
  locked: true,
  createdBy: { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' },
  createdAt: '2026-10-13T09:00:00.000Z',
};

export function registerOnboardingDocs(): void {
  // ─── Checklist ────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/onboarding/checklist',
    tags: ['Onboarding'],
    summary: 'Setup checklist',
    description:
      'Owner (`company.settings.manage`). Computed from the company’s data, demo data excluded: LOGO (company logo), RATES (a rate / worker type changed, or confirmed with rates-reviewed), TEAM (a PM / munshi or an invitation), WORKERS, SUPPLIERS, PROJECT. `demo` = the demo project when there is one.',
    security: companySecurity,
    responses: { ...resp(200, 'Checklist', checklistExample), ...errors({ ...AUTH, 403: DENIED }) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/onboarding/checklist/dismiss',
    tags: ['Onboarding'],
    summary: 'Hide (or show again) the checklist',
    description: 'Owner. Stored per company (`TenantSettings.onboardingDismissedAt`), audited `onboarding.dismiss` / `onboarding.restore`. Returns the checklist.',
    security: companySecurity,
    request: { body: jsonBody(dismissBody, { hide: ex('Hide the card', { dismissed: true }), show: ex('Show it again', { dismissed: false }) }) },
    responses: { ...resp(200, 'Checklist', { ...checklistExample, dismissed: true, dismissedAt: '2026-10-13T09:00:00.000Z' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_DENIED }) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/onboarding/checklist/rates-reviewed',
    tags: ['Onboarding'],
    summary: 'Confirm the rates are fine',
    description: 'Owner. Marks the RATES step done without changing a rate (audited `onboarding.rates_reviewed`).',
    security: companySecurity,
    responses: { ...resp(200, 'Checklist', { ...checklistExample, ratesReviewedAt: '2026-10-13T09:00:00.000Z' }), ...errors({ ...AUTH, 403: WRITE_DENIED }) },
  });

  // ─── Imports ──────────────────────────────────────────────────────────────
  for (const entity of IMPORT_ENTITIES) {
    const def = ENTITY_DEFS[entity];
    const cols = def.columns.map((c) => `\`${c.key}\`${c.required ? ' (required)' : ''}`).join(', ');
    registry.registerPath({
      method: 'get',
      path: `/api/v1/imports/${entity}/template`,
      tags: ['Imports'],
      summary: `${def.label.en}: download the import template`,
      description: `\`${def.permission}\`. An .xlsx file: sheet **Data** with the headers (English + Roman Urdu, notes in English / Roman Urdu / Urdu on each header) and one example row (rows containing "(example" are skipped), sheet **Instructions** with every column in three languages and the allowed values of this company. Columns: ${cols}.`,
      security: companySecurity,
      responses: {
        200: { description: 'Excel template', content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: z.string().meta({ format: 'binary' }) } } },
        ...errors({ ...AUTH, 403: DENIED }),
      },
    });
    registry.registerPath({
      method: 'post',
      path: `/api/v1/imports/${entity}/preview`,
      tags: ['Imports'],
      summary: `${def.label.en}: preview an import`,
      description: `\`${def.permission}\`. Parses the file and checks every row with the create endpoint’s own rules (Zod schema + ${def.unique.column} must be new — in the company and in the file). **Writes nothing.** Headers are matched by key or by any of the three labels; unknown columns are listed in \`unknownColumns\`.`,
      security: companySecurity,
      request: multipart,
      responses: { ...resp(200, 'Rows with their errors', previewExample), ...errors({ 400: FILE_ERRORS, ...AUTH, 403: WRITE_DENIED }) },
    });
    registry.registerPath({
      method: 'post',
      path: `/api/v1/imports/${entity}/commit`,
      tags: ['Imports'],
      summary: `${def.label.en}: import`,
      description: `\`${def.permission}\`. Send the SAME file again (stateless: nothing is kept between preview and commit, and the rows are checked again). **All-or-nothing** by default: any row with an error → 400 IMPORT_HAS_ERRORS (\`details.rows\`) and nothing is written; \`?skipInvalid=true\` imports only the valid rows. One transaction, one audit row \`import.${entity}\`. Master data has no plan limits.`,
      security: companySecurity,
      request: { ...multipart, query: commitQuery },
      responses: {
        ...resp(201, 'Imported', { entity, fileName: `${entity}.xlsx`, created: 12, skipped: 0, ids: ['0199a8c0-0000-7000-8000-0000000000c1'] }),
        ...errors({ 400: [...FILE_ERRORS, 'IMPORT_HAS_ERRORS', 'NOTHING_TO_IMPORT', 'VALIDATION_ERROR'], ...AUTH, 403: WRITE_DENIED, 409: ['IMPORT_CONFLICT'] }),
      },
    });
  }

  // ─── Opening balances ─────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/opening-balances',
    tags: ['Onboarding'],
    summary: 'Opening balances',
    description: '`company.opening.manage` (owner; can be granted). Every saved (locked) opening balance with its item, who entered it and when.',
    security: companySecurity,
    request: { query: openingListQuery },
    responses: { ...resp(200, 'Opening balances', [openingExample]), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: DENIED }) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/opening-balances',
    tags: ['Onboarding'],
    summary: 'Enter an opening balance',
    description:
      '`company.opening.manage`. Once per item, then **locked** (409 OPENING_LOCKED); audited `opening_balance.create`. Posted to the normal ledgers so balances and reports include it: SUPPLIER_UDHAAR → supplier ledger OPENING; CASH_IN_HAND → cash entry OPENING in the munshi / PM’s cash account; STORE_STOCK → stock movement OPENING_IN at the Central Store (value = quantity × rate); WORKER_PESHGI → an office-cash peshgi on the worker’s project, cut from their next wages (the worker must be on that project’s team).',
    security: companySecurity,
    request: {
      body: jsonBody(openingBody, {
        udhaar: ex('Supplier udhaar', { kind: 'SUPPLIER_UDHAAR', supplierId: '0199a8c0-0000-7000-8000-0000000000a1', amountPaisa: '74000000', date: '2026-10-01' }),
        cash: ex('Cash with a munshi', { kind: 'CASH_IN_HAND', holderUserId: '0199a8c0-0000-7000-8000-000000000003', amountPaisa: '840000', date: '2026-10-01' }),
        stock: ex('Store stock', { kind: 'STORE_STOCK', materialId: '0199a8c0-0000-7000-8000-0000000000d1', quantity: 120, ratePaisa: '145000', date: '2026-10-01' }),
        peshgi: ex('Worker peshgi', { kind: 'WORKER_PESHGI', workerId: '0199a8c0-0000-7000-8000-0000000000e1', projectId: '0199a8c0-0000-7000-8000-000000000101', amountPaisa: '500000', date: '2026-10-01', note: 'Taken before Eid' }),
      }),
    },
    responses: {
      ...resp(201, 'Saved and locked', openingExample),
      ...errors({
        400: ['VALIDATION_ERROR', 'DATE_IN_FUTURE', 'FUTURE_DATE', 'INVALID_HOLDER', 'WORKER_NOT_ASSIGNED'],
        ...AUTH,
        403: WRITE_DENIED,
        404: ['SUPPLIER_NOT_FOUND', 'MATERIAL_NOT_FOUND', 'WORKER_NOT_FOUND', 'PROJECT_NOT_FOUND'],
        409: ['OPENING_LOCKED', 'PROJECT_LOCKED'],
      }),
    },
  });

  // ─── Demo ─────────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'post',
    path: '/api/v1/demo',
    tags: ['Onboarding'],
    summary: 'Try with demo data',
    description:
      'Owner (`company.settings.manage`). Creates ONE demo project tagged DEMO (`isDemo`, code `DEMO-001`, names start with "DEMO ·") with a client, a supplier, 4 workers on site, 6 days of hazri, a site purchase on udhaar (received), a small site cash book with kharcha and a draft invoice. The demo project never counts against the plan’s active-project limit; it uses no real document numbers (purchase `DEMO-PUR-1`, invoice left as a draft).',
    security: companySecurity,
    responses: {
      ...resp(201, 'Created', { project: { id: '0199a8c0-0000-7000-8000-000000000999', code: 'DEMO-001', name: 'DEMO · Sample house (10 Marla)', isDemo: true }, counts: { workers: 4, hazri: 24, purchases: 1, kharcha: 4, invoices: 1 } }),
      ...errors({ ...AUTH, 403: WRITE_DENIED, 409: ['DEMO_EXISTS'] }),
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/v1/demo',
    tags: ['Onboarding'],
    summary: 'Remove the demo data',
    description:
      'Owner. Removes the demo project and everything on it (hazri, purchases, supplier ledger, stock movements, cash entries, invoices, …) plus the demo client, supplier, workers and cash book, in one transaction — no leftovers in ledgers or stock. Refused with 409 DEMO_IN_USE (`details.uses`) when real data uses demo records (a dispatch to / from the demo site, real cash entries on the demo project, demo workers / supplier / client on real projects or stock). Audit rows are kept.',
    security: companySecurity,
    responses: { ...resp(200, 'Removed', { removed: true, projectId: '0199a8c0-0000-7000-8000-000000000999', code: 'DEMO-001' }), ...errors({ ...AUTH, 403: WRITE_DENIED, 404: ['DEMO_NOT_FOUND'], 409: ['DEMO_IN_USE'] }) },
  });
}
