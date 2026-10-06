import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import {
  bulkPercentBody,
  createCategoryBody,
  createMaterialBody,
  createSubcontractorBody,
  createSupplierBody,
  createTemplateBody,
  createWorkerBody,
  duplicateCategoryBody,
  listCategoriesQuery,
  listMaterialsQuery,
  listSubcontractorsQuery,
  listSuppliersQuery,
  listWorkersQuery,
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
} from './master-data.schema.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const READ_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED'];
const WRITE_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'];
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ok = (description: string, example?: unknown, meta?: unknown) => ({
  200: {
    description,
    content: { 'application/json': { schema: data, ...(example ? { example: { success: true, data: example, ...(meta ? { meta } : {}) } } : {}) } },
  },
});
const createdResp = (description: string, example?: unknown) => ({
  201: { description, content: { 'application/json': { schema: data, ...(example ? { example: { success: true, data: example } } : {}) } } },
});
const ex = (summary: string, value: unknown, description?: string): NamedExample => ({ summary, value, ...(description ? { description } : {}) });
const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });
const page = (total: number) => ({ page: 1, limit: 25, total, totalPages: 1 });

// Example ids (look them up with the list endpoints on a seeded database)
const GROUP_CEMENT = '0199a8c0-0000-7000-8000-0000000000c1';
const GROUP_OTHER = '0199a8c0-0000-7000-8000-0000000000c6';
const MAT_CEMENT = '0199a8c0-0000-7000-8000-0000000000d1';
const MAT_BRICKS = '0199a8c0-0000-7000-8000-0000000000d2';
const MAT_SRC = '0199a8c0-0000-7000-8000-0000000000d3';
const CAT_A_PLUS = '0199a8c0-0000-7000-8000-0000000000e1';
const CAT_A_STD = '0199a8c0-0000-7000-8000-0000000000e2';
const KHALID = { id: '0199a8c0-0000-7000-8000-000000000001', name: 'Khalid Malik' };

const cementGroup = { id: GROUP_CEMENT, code: 'CEMENT', name: 'Cement', section: 'CIVIL' };
const sampleMaterial = {
  id: MAT_CEMENT,
  name: 'Cement OPC',
  group: cementGroup,
  unit: 'bag',
  unitDetail: '1 bag = 50 kg',
  altUnits: [{ unit: 'kg', factor: 50 }],
  supplyCategory: 'GREY_STRUCTURE',
  source: 'PLATFORM',
  isHidden: false,
};
const sampleCategory = { id: CAT_A_STD, name: 'A Standard', code: 'A_STD', description: 'Good-quality standard brands', isDefault: true, isArchived: false, sortOrder: 2, ratedMaterials: 8 };
const sampleSupplier = {
  id: '0199a8c0-0000-7000-8000-0000000000f1',
  name: 'Al-Madina Cement Agency',
  category: 'Cement',
  phone: '+924235761234',
  city: 'Lahore',
  address: 'Badami Bagh, Lahore',
  ntn: '4123456-7',
  notes: null,
  isActive: true,
  createdAt: '2026-10-01T09:00:00.000Z',
};
const sampleWorker = {
  id: '0199a8c0-0000-7000-8000-0000000000a1',
  name: 'Ustad Akram',
  type: 'MISTRI',
  phone: '+923001110001',
  dailyRatePaisa: '300000',
  isActive: true,
  notes: null,
  createdAt: '2026-10-01T09:00:00.000Z',
};
const residential = {
  id: '0199a8c0-0000-7000-8000-0000000000b1',
  name: 'Residential standard',
  billingModel: 'STAGE_SCHEDULE',
  isDefault: true,
  stages: [
    { label: 'Agreement & mobilisation', percent: 15 },
    { label: 'Foundation & plinth', percent: 15 },
    { label: 'Grey structure — ground floor', percent: 20 },
    { label: 'Grey structure — first floor & roof', percent: 15 },
    { label: 'Plaster & MEP rough-in', percent: 10 },
    { label: 'Flooring & tiles', percent: 10 },
    { label: 'Finishing & handover', percent: 10 },
    { label: 'Retention (after defect period)', percent: 5, isRetention: true },
  ],
  updatedAt: '2026-10-01T09:00:00.000Z',
};

function path(tag: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) {
  registry.registerPath({ method, path: url, tags: [tag], security: companySecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
}

export function registerMasterDataDocs(): void {
  // ─── Materials ───────────────────────────────────────────────────────────
  const M = 'Materials';
  path(M, 'get', '/api/v1/material-groups', {
    summary: 'Material groups',
    description: 'All roles. The 12 fixed groups (Cement … Paint) with their section (CIVIL / FINISHING).',
    responses: { ...ok('Groups', [{ ...cementGroup, sortOrder: 1 }]), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(M, 'get', '/api/v1/materials', {
    summary: 'List materials',
    description:
      'All roles (MUNSHI too). Never includes rates — those live in the Price List. Hidden materials only with ' +
      '`includeHidden=true`, and only for THEKEDAR / PM.',
    request: { query: listMaterialsQuery },
    responses: { ...ok('Materials', [sampleMaterial]), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(M, 'post', '/api/v1/materials', {
    summary: 'Add a company material',
    description: 'THEKEDAR, PM. Saved with `source: COMPANY`. `supplyCategory` defaults from the group section.',
    request: {
      body: jsonBody(createMaterialBody, {
        cement: ex('Fauji cement 40 kg', { groupId: GROUP_CEMENT, name: 'Cement Fauji 40kg', unit: 'bag', unitDetail: '1 bag = 40 kg', altUnits: [{ unit: 'kg', factor: 40 }] }),
        simple: ex('Scaffolding pipe (minimal)', { groupId: GROUP_OTHER, name: 'Scaffolding pipe', unit: 'nos' }),
      }),
    },
    responses: {
      ...createdResp('Created', { ...sampleMaterial, name: 'Cement Fauji 40kg', unitDetail: '1 bag = 40 kg', source: 'COMPANY' }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_GROUP'], ...AUTH, 403: WRITE_403, 409: ['MATERIAL_EXISTS'] }),
    },
  });
  path(M, 'patch', '/api/v1/materials/{id}', {
    summary: 'Edit a material',
    description:
      'THEKEDAR, PM. Marks the row customised, so later platform catalog edits no longer overwrite it. The unit ' +
      'of a catalog material, or of any material that already has rates, is locked (400 UNIT_LOCKED).',
    request: {
      params: idParam('Material'),
      body: jsonBody(updateMaterialBody, {
        rename: ex('Rename', { name: 'Cement OPC (Lucky)' }),
        detail: ex('Change the unit note', { unitDetail: '1 bag = 50 kg (Lucky only)' }),
      }),
    },
    responses: { ...ok('Updated', sampleMaterial), ...errors({ 400: ['VALIDATION_ERROR', 'UNIT_LOCKED', 'INVALID_GROUP'], ...AUTH, 403: WRITE_403, 404: ['MATERIAL_NOT_FOUND'], 409: ['MATERIAL_EXISTS'] }) },
  });
  for (const action of ['hide', 'show'] as const) {
    path(M, 'post', `/api/v1/materials/{id}/${action}`, {
      summary: action === 'hide' ? 'Hide a material' : 'Show a hidden material',
      description: 'THEKEDAR. Hidden materials drop out of pick lists and the price list.',
      request: { params: idParam('Material') },
      responses: { ...ok('Done', { ...sampleMaterial, isHidden: action === 'hide' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['MATERIAL_NOT_FOUND'] }) },
    });
  }
  path(M, 'delete', '/api/v1/materials/{id}', {
    summary: 'Delete a company material',
    description: 'THEKEDAR. Only COMPANY materials without any rate; catalog materials or materials with rates → 409 MATERIAL_IN_USE (hide them instead).',
    request: { params: idParam('Material') },
    responses: { ...ok('Deleted', { id: MAT_CEMENT, deleted: true }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['MATERIAL_NOT_FOUND'], 409: ['MATERIAL_IN_USE'] }) },
  });

  // ─── Price list (quality categories + rates) ─────────────────────────────
  const P = 'Price List';
  path(P, 'get', '/api/v1/quality-categories', {
    summary: 'Quality categories',
    description: 'THEKEDAR, PM. A+ Premium / A Standard (default) / B Economy to start with. `ratedMaterials` = materials with a rate.',
    request: { query: listCategoriesQuery },
    responses: { ...ok('Categories', [sampleCategory]), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(P, 'post', '/api/v1/quality-categories', {
    summary: 'Add a quality category',
    description: 'THEKEDAR. Optionally starts with the current rates of another category.',
    request: {
      body: jsonBody(createCategoryBody, {
        copy: ex('A Luxury, starting from A+ rates', { name: 'A Luxury', code: 'A_LUX', description: 'Imported fittings', copyRatesFromCategoryId: CAT_A_PLUS }),
        empty: ex('Empty category', { name: 'C Basic', code: 'C_BASIC' }),
        bad: ex('❌ Lower-case code → 400', { name: 'Lux', code: 'lux' }),
      }),
    },
    responses: {
      ...createdResp('Created', { ...sampleCategory, id: CAT_A_PLUS, name: 'A Luxury', code: 'A_LUX', isDefault: false, sortOrder: 4, copiedRates: 8 }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'], 409: ['CATEGORY_EXISTS'] }),
    },
  });
  path(P, 'patch', '/api/v1/quality-categories/{id}', {
    summary: 'Edit a quality category',
    description: 'THEKEDAR. `isDefault: true` makes this the only default (there is always exactly one).',
    request: {
      params: idParam('Quality category'),
      body: jsonBody(updateCategoryBody, {
        rename: ex('Rename', { name: 'A Standard (Lahore)', description: 'Lucky / Maple Leaf / Ittefaq' }),
        default: ex('Make default', { isDefault: true }),
      }),
    },
    responses: { ...ok('Updated', sampleCategory), ...errors({ 400: ['VALIDATION_ERROR', 'CATEGORY_ARCHIVED'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'], 409: ['CATEGORY_EXISTS'] }) },
  });
  path(P, 'post', '/api/v1/quality-categories/{id}/duplicate', {
    summary: 'Duplicate a quality category',
    description: 'THEKEDAR. New category with a copy of the current rates.',
    request: { params: idParam('Quality category'), body: jsonBody(duplicateCategoryBody, { copy: ex('Next year’s A rates', { name: 'A Standard 2027', code: 'A_STD27' }) }) },
    responses: { ...createdResp('Created'), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'], 409: ['CATEGORY_EXISTS'] }) },
  });
  path(P, 'post', '/api/v1/quality-categories/{id}/archive', {
    summary: 'Archive a quality category',
    description: 'THEKEDAR. Not the default, and not the last active category.',
    request: { params: idParam('Quality category') },
    responses: { ...ok('Archived'), ...errors({ 400: ['CATEGORY_IS_DEFAULT', 'LAST_ACTIVE_CATEGORY'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'] }) },
  });
  path(P, 'get', '/api/v1/price-list', {
    summary: 'Price list',
    description:
      'THEKEDAR, PM (`rates.view`); MUNSHI → 403. Current rate per material in one quality category (default category ' +
      'when `categoryId` is omitted). Current = the latest rate whose effectiveFrom ≤ now. Hidden materials are left out.',
    request: { query: priceListQuery },
    responses: {
      ...ok('Price list', {
        category: { ...sampleCategory, ratedMaterials: undefined },
        items: [
          {
            material: { id: MAT_CEMENT, name: 'Cement OPC', unit: 'bag', unitDetail: '1 bag = 50 kg', group: cementGroup },
            ratePaisa: '145000',
            specification: 'Lucky / Maple Leaf',
            lastUpdatedAt: '2026-10-02T09:00:00.000Z',
            lastUpdatedBy: KHALID,
          },
        ],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['CATEGORY_NOT_FOUND'] }),
    },
  });
  path(P, 'put', '/api/v1/price-list', {
    summary: 'Set rates',
    description:
      'THEKEDAR. 1–500 rates for one category. A history row is written only when the rate or specification changed ' +
      '(an omitted specification keeps the current one). Returns how many changed.',
    request: {
      body: jsonBody(setPriceListBody, {
        update: ex('New cement and brick rates', {
          categoryId: CAT_A_STD,
          rates: [
            { materialId: MAT_CEMENT, ratePaisa: '146000', specification: 'Lucky / Maple Leaf' },
            { materialId: MAT_BRICKS, ratePaisa: 1800 },
          ],
        }),
      }),
    },
    responses: { ...ok('Saved', { categoryId: CAT_A_STD, changed: 2, unchanged: 0 }), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_MATERIAL', 'CATEGORY_ARCHIVED'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'] }) },
  });
  path(P, 'post', '/api/v1/price-list/bulk-percent', {
    summary: 'Raise / lower rates by a percentage',
    description: 'THEKEDAR. −50 … +100 % on every current rate in the category (or a group / list of materials). New rates are rounded to the nearest rupee.',
    request: {
      body: jsonBody(bulkPercentBody, {
        all: ex('Everything +7 %', { categoryId: CAT_A_STD, percent: 7 }),
        group: ex('Cement group −5 %', { categoryId: CAT_A_STD, percent: -5, groupId: GROUP_CEMENT }),
        some: ex('Two materials +3.5 %', { categoryId: CAT_A_STD, percent: 3.5, materialIds: [MAT_CEMENT, MAT_SRC] }),
      }),
    },
    responses: { ...ok('Applied', { categoryId: CAT_A_STD, percent: 7, changed: 8, unchanged: 0 }), ...errors({ 400: ['VALIDATION_ERROR', 'CATEGORY_ARCHIVED'], ...AUTH, 403: WRITE_403, 404: ['CATEGORY_NOT_FOUND'] }) },
  });
  path(P, 'get', '/api/v1/price-list/history', {
    summary: 'Rate history of a material',
    description: 'THEKEDAR, PM. Newest first (max 200), optionally for one category, with who changed it.',
    request: { query: priceHistoryQuery },
    responses: {
      ...ok('History', {
        material: { id: MAT_CEMENT, name: 'Cement OPC', unit: 'bag' },
        history: [{ id: '0199a8c0-0000-7000-8000-000000000e91', category: { id: CAT_A_STD, name: 'A Standard', code: 'A_STD' }, ratePaisa: '145000', specification: 'Lucky / Maple Leaf', effectiveFrom: '2026-10-02T09:00:00.000Z', changedBy: KHALID }],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['MATERIAL_NOT_FOUND'] }),
    },
  });

  // ─── Labour rates ────────────────────────────────────────────────────────
  const L = 'Labor Rates';
  path(L, 'get', '/api/v1/labor-rates', {
    summary: 'Labour rates',
    description: 'All roles. DAILY wages (per day, with overtime multiplier) and SUBCONTRACT piece rates.',
    responses: {
      ...ok('Labour rates', [
        { id: '0199a8c0-0000-7000-8000-000000000a51', kind: 'DAILY', key: 'MISTRI', label: 'Mistri', unit: 'DAY', ratePaisa: '280000', overtimeMultiplier: 1.5, updatedAt: '2026-10-01T09:00:00.000Z' },
        { id: '0199a8c0-0000-7000-8000-000000000a52', kind: 'SUBCONTRACT', key: 'SHUTTERING', label: 'Shuttering', unit: 'SQFT', ratePaisa: '4500', overtimeMultiplier: null, updatedAt: '2026-10-01T09:00:00.000Z' },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(L, 'put', '/api/v1/labor-rates', {
    summary: 'Set labour rates',
    description:
      'THEKEDAR. Upsert by kind + key. DAILY keys: MISTRI, MISTRI_TILES, MAZDOOR, STEEL_FIXER_HELPER, CHOWKIDAR (unit DAY). ' +
      'SUBCONTRACT keys: SHUTTERING, STEEL_FIXING, BRICK_MASONRY, PLASTER, TILE_LAYING, ELECTRICAL_CONDUIT, PLUMBING_ROUGH_IN, WATERPROOFING, PAINT.',
    request: {
      body: jsonBody(setLaborRatesBody, {
        wages: ex('New daily wages', {
          rates: [
            { kind: 'DAILY', key: 'MISTRI', unit: 'DAY', ratePaisa: '300000', overtimeMultiplier: 1.5 },
            { kind: 'DAILY', key: 'MAZDOOR', unit: 'DAY', ratePaisa: '170000' },
          ],
        }),
        piece: ex('Plaster piece rate', { rates: [{ kind: 'SUBCONTRACT', key: 'PLASTER', label: 'Plaster (both sides)', unit: 'SQFT', ratePaisa: '2500' }] }),
      }),
    },
    responses: { ...ok('Saved'), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_LABOR_KEY', 'INVALID_LABOR_UNIT'], ...AUTH, 403: WRITE_403 }) },
  });

  // ─── Payment templates ───────────────────────────────────────────────────
  const T = 'Payment Templates';
  const templateErrors = { 400: ['VALIDATION_ERROR', 'PERCENT_TOTAL_INVALID', 'RETENTION_STAGE_INVALID'], ...AUTH, 403: WRITE_403, 409: ['TEMPLATE_EXISTS'] };
  path(T, 'get', '/api/v1/payment-templates', {
    summary: 'Payment schedule templates',
    description: 'THEKEDAR, PM. Default first.',
    responses: { ...ok('Templates', [residential]), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'post', '/api/v1/payment-templates', {
    summary: 'Add a payment template',
    description: 'THEKEDAR. 1–15 stages, each > 0 %, adding up to exactly 100 (else 400 PERCENT_TOTAL_INVALID with `details.total`). At most one retention stage.',
    request: {
      body: jsonBody(createTemplateBody, {
        villa: ex('Villa — 4 stages', {
          name: 'Villa — 4 stages',
          stages: [
            { label: 'Advance', percent: 20 },
            { label: 'Grey structure', percent: 50 },
            { label: 'Finishing', percent: 25 },
            { label: 'Retention', percent: 5, isRetention: true },
          ],
        }),
        running: ex('Running bills, new default', { name: 'Monthly running bills', billingModel: 'RUNNING_BILLS', isDefault: true, stages: [{ label: 'Monthly bills', percent: 100 }] }),
        short: ex('❌ Adds up to 95 → 400 PERCENT_TOTAL_INVALID', { name: 'Short', stages: [{ label: 'A', percent: 50 }, { label: 'B', percent: 45 }] }),
      }),
    },
    responses: { ...createdResp('Created', residential), ...errors(templateErrors) },
  });
  path(T, 'patch', '/api/v1/payment-templates/{id}', {
    summary: 'Edit a payment template',
    description: 'THEKEDAR. `isDefault: true` makes it the only default.',
    request: { params: idParam('Template'), body: jsonBody(updateTemplateBody, { default: ex('Make default', { isDefault: true }), rename: ex('Rename', { name: 'Residential (standard)' }) }) },
    responses: { ...ok('Updated', residential), ...errors({ ...templateErrors, 404: ['TEMPLATE_NOT_FOUND'] }) },
  });
  path(T, 'delete', '/api/v1/payment-templates/{id}', {
    summary: 'Delete a payment template',
    description: 'THEKEDAR. The default template cannot be deleted.',
    request: { params: idParam('Template') },
    responses: { ...ok('Deleted'), ...errors({ 400: ['TEMPLATE_IS_DEFAULT'], ...AUTH, 403: WRITE_403, 404: ['TEMPLATE_NOT_FOUND'] }) },
  });

  // ─── Suppliers ───────────────────────────────────────────────────────────
  const S = 'Suppliers';
  path(S, 'get', '/api/v1/suppliers', {
    summary: 'List suppliers',
    description: 'All roles (MUNSHI picks the seller of urgent material bought with site cash). Udhaar balances only with rates.view. Search matches name, city or phone.',
    request: { query: listSuppliersQuery },
    responses: { ...ok('Suppliers', [sampleSupplier], page(5)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(S, 'post', '/api/v1/suppliers', {
    summary: 'Add a supplier',
    description: 'THEKEDAR, PM. Phone may be a mobile or a landline.',
    request: {
      body: jsonBody(createSupplierBody, {
        full: ex('Tiles shop (landline)', { name: 'Lahore Tiles Centre', category: 'Tiles', phone: '042-35880011', city: 'Lahore', address: 'Ferozepur Road', ntn: '7654321-0' }),
        minimal: ex('Name + category only', { name: 'Hamza Hardware', category: 'Hardware' }),
      }),
    },
    responses: { ...createdResp('Created', sampleSupplier), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 409: ['SUPPLIER_EXISTS'] }) },
  });
  path(S, 'get', '/api/v1/suppliers/{id}', {
    summary: 'Supplier details',
    description: 'THEKEDAR, PM. With the current agreed rates.',
    request: { params: idParam('Supplier') },
    responses: {
      ...ok('Supplier', { ...sampleSupplier, rates: [{ material: { id: MAT_CEMENT, name: 'Cement OPC', unit: 'bag' }, ratePaisa: '143000', effectiveFrom: '2026-10-02T09:00:00.000Z', updatedBy: 'Khalid Malik' }] }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['SUPPLIER_NOT_FOUND'] }),
    },
  });
  path(S, 'patch', '/api/v1/suppliers/{id}', {
    summary: 'Edit a supplier',
    description: 'THEKEDAR, PM. `null` clears an optional field.',
    request: { params: idParam('Supplier'), body: jsonBody(updateSupplierBody, { move: ex('New city, clear notes', { city: 'Sheikhupura', notes: null }) }) },
    responses: { ...ok('Updated', sampleSupplier), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['SUPPLIER_NOT_FOUND'], 409: ['SUPPLIER_EXISTS'] }) },
  });
  for (const action of ['deactivate', 'activate'] as const) {
    path(S, 'post', `/api/v1/suppliers/{id}/${action}`, {
      summary: action === 'deactivate' ? 'Deactivate a supplier' : 'Reactivate a supplier',
      description: 'THEKEDAR.',
      request: { params: idParam('Supplier') },
      responses: { ...ok('Done', { ...sampleSupplier, isActive: action === 'activate' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['SUPPLIER_NOT_FOUND'] }) },
    });
  }
  path(S, 'get', '/api/v1/suppliers/{id}/rates', {
    summary: 'Supplier rates',
    description: 'THEKEDAR, PM. Current agreed rates plus the history (newest first, max 200).',
    request: { params: idParam('Supplier') },
    responses: { ...ok('Rates'), ...errors({ ...AUTH, 403: READ_403, 404: ['SUPPLIER_NOT_FOUND'] }) },
  });
  path(S, 'put', '/api/v1/suppliers/{id}/rates', {
    summary: 'Set supplier rates',
    description: 'THEKEDAR. A history row is written only for rates that changed.',
    request: {
      params: idParam('Supplier'),
      body: jsonBody(setSupplierRatesBody, { cement: ex('Cement rates', { rates: [{ materialId: MAT_CEMENT, ratePaisa: '143000' }, { materialId: MAT_SRC, ratePaisa: '152000' }] }) }),
    },
    responses: { ...ok('Saved'), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_MATERIAL'], ...AUTH, 403: WRITE_403, 404: ['SUPPLIER_NOT_FOUND'] }) },
  });

  // ─── Workers ─────────────────────────────────────────────────────────────
  const W = 'Workers';
  path(W, 'get', '/api/v1/workers', {
    summary: 'List workers',
    description: 'All roles. Search matches name or phone.',
    request: { query: listWorkersQuery },
    responses: { ...ok('Workers', [sampleWorker], page(14)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(W, 'post', '/api/v1/workers', {
    summary: 'Add a worker',
    description:
      "THEKEDAR, PM, MUNSHI. `dailyRatePaisa` defaults to the company's DAILY labour rate for the type (type OTHER " +
      'needs one: 400 DAILY_RATE_REQUIRED). Phone is unique within the company.',
    request: {
      body: jsonBody(createWorkerBody, {
        mazdoor: ex('Mazdoor with default wage', { name: 'Kashif', type: 'MAZDOOR', phone: '0300-1110099' }),
        mistri: ex('Tiles mistri with own rate', { name: 'Ustad Fazal', type: 'MISTRI_TILES', dailyRatePaisa: '350000', notes: 'Marble specialist' }),
      }),
    },
    responses: { ...createdResp('Created', sampleWorker), ...errors({ 400: ['VALIDATION_ERROR', 'DAILY_RATE_REQUIRED'], ...AUTH, 403: WRITE_403, 409: ['WORKER_PHONE_TAKEN'] }) },
  });
  path(W, 'patch', '/api/v1/workers/{id}', {
    summary: 'Edit a worker',
    description: 'THEKEDAR, PM.',
    request: { params: idParam('Worker'), body: jsonBody(updateWorkerBody, { raise: ex('New wage', { dailyRatePaisa: '320000' }), phone: ex('Remove phone', { phone: null }) }) },
    responses: { ...ok('Updated', sampleWorker), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['WORKER_NOT_FOUND'], 409: ['WORKER_PHONE_TAKEN'] }) },
  });
  for (const action of ['deactivate', 'activate'] as const) {
    path(W, 'post', `/api/v1/workers/{id}/${action}`, {
      summary: action === 'deactivate' ? 'Deactivate a worker' : 'Reactivate a worker',
      description: 'THEKEDAR, PM.',
      request: { params: idParam('Worker') },
      responses: { ...ok('Done', { ...sampleWorker, isActive: action === 'activate' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['WORKER_NOT_FOUND'] }) },
    });
  }

  // ─── Sub-contractors ─────────────────────────────────────────────────────
  const C = 'Sub-contractors';
  const sampleSub = { id: '0199a8c0-0000-7000-8000-0000000000a9', name: 'Ustad Sharif Shuttering', trade: 'SHUTTERING', phone: '+923004440001', notes: null, isActive: true, createdAt: '2026-10-01T09:00:00.000Z' };
  path(C, 'get', '/api/v1/subcontractors', {
    summary: 'List sub-contractors',
    description: 'All roles. `trade` is a SUBCONTRACT labour key.',
    request: { query: listSubcontractorsQuery },
    responses: { ...ok('Sub-contractors', [sampleSub], page(6)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(C, 'post', '/api/v1/subcontractors', {
    summary: 'Add a sub-contractor',
    description: 'THEKEDAR, PM.',
    request: { body: jsonBody(createSubcontractorBody, { paint: ex('Paint team', { name: 'Khan Paint House', trade: 'PAINT', phone: '042-35112233' }) }) },
    responses: { ...createdResp('Created', sampleSub), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 409: ['SUBCONTRACTOR_EXISTS'] }) },
  });
  path(C, 'patch', '/api/v1/subcontractors/{id}', {
    summary: 'Edit a sub-contractor',
    description: 'THEKEDAR, PM.',
    request: { params: idParam('Sub-contractor'), body: jsonBody(updateSubcontractorBody, { notes: ex('Add a note', { notes: 'Has own steel plates' }) }) },
    responses: { ...ok('Updated', sampleSub), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['SUBCONTRACTOR_NOT_FOUND'], 409: ['SUBCONTRACTOR_EXISTS'] }) },
  });
  for (const action of ['deactivate', 'activate'] as const) {
    path(C, 'post', `/api/v1/subcontractors/{id}/${action}`, {
      summary: action === 'deactivate' ? 'Deactivate a sub-contractor' : 'Reactivate a sub-contractor',
      description: 'THEKEDAR, PM.',
      request: { params: idParam('Sub-contractor') },
      responses: { ...ok('Done', { ...sampleSub, isActive: action === 'activate' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['SUBCONTRACTOR_NOT_FOUND'] }) },
    });
  }
}
