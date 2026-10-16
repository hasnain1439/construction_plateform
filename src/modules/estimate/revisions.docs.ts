/** OpenAPI docs · Step 11: saved estimates (revisions), owner shopping list, company rulebook, admin rulebook versions. */
import { z } from 'zod';
import { companySecurity, errors, jsonBody, platformSecurity, registry, type NamedExample } from '../../core/openapi/registry.js';
import { createRulebookBody, rulebooksQuery, updateParameterBody, updateRulebookBody } from '../platform-admin/rulebook.schema.js';
import { setOverridesBody } from '../rulebook/rulebook.schema.js';
import { approveEstimateBody, generateEstimateBody, lineOverrideBody, shoppingListQuery } from './estimate.schema.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const ADMIN_AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED'], 403: ['FORBIDDEN'] };
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const resp = (status: 200 | 201, description: string, example?: unknown) => ({
  [status]: { description, content: { 'application/json': { schema: data, ...(example === undefined ? {} : { example: { success: true, data: example } }) } } },
});
const ID = (d: string) => z.uuid().meta({ description: d });
const projectParam = z.object({ id: ID('Project id') });
const estimateParam = z.object({ id: ID('Estimate id') });
const lang = z.object({ lang: z.enum(['en', 'roman', 'ur']).optional().meta({ description: 'Document language (default: the signed-in user)' }) });

const E_ID = '0199a8c0-0000-7000-8000-000000000e11';
const P_ID = '0199a8c0-0000-7000-8000-000000000101';
const LINE = {
  id: '0199a8c0-0000-7000-8000-000000000e51',
  lineKey: 'CONCRETE.GF_STRUCTURE.cement',
  section: 'CONCRETE',
  stageKey: 'GF_STRUCTURE',
  kind: 'MATERIAL',
  description: 'Cement OPC',
  material: 'cement',
  materialId: '0199a8c0-0000-7000-8000-0000000007a1',
  unit: 'bag',
  quantity: 182.4,
  wastagePercent: 2,
  quantityWithWastage: 186.05,
  suppliedBy: 'CONTRACTOR',
  formula: '4 items · 182.4 bag + 2% wastage = 186.05 bag',
  trace: ['Ground floor · slab: 1125 sq ft × 5″ … = 82.5 bag'],
  override: null,
  effectiveQuantity: 186.05,
  ratePaisa: '145000',
  effectiveRatePaisa: '145000',
  rateUnit: 'bag',
  rateQuantity: 186.05,
  amountPaisa: '26977250',
  rateStatus: 'OK',
};
const SUMMARY = {
  id: E_ID,
  projectId: P_ID,
  revision: 2,
  status: 'DRAFT',
  ratesOutdated: false,
  note: null,
  rulebook: { id: '01920000-0000-7000-8000-00000000b001', region: 'PUNJAB_KP', version: 1 },
  region: 'PUNJAB_KP',
  generatedAt: '2026-11-01T09:00:00.000Z',
  generatedBy: { id: '0199a8c0-0000-7000-8000-000000000201', name: 'Bilal Ahmed' },
  approvedAt: null,
  approvedBy: null,
  supersededAt: null,
  coveredAreaSqft: 3950,
  lineCount: 74,
  ownerSuppliedLines: 9,
  directCostPaisa: '1180000000',
  overheadPaisa: '35400000',
  contingencyPaisa: '60770000',
  totalPaisa: '1276170000',
  perSqftPaisa: '323081',
  contractTotalPaisa: '1850000000',
  marginPaisa: '573830000',
  marginPercent: 31.02,
};
const DETAIL = {
  ...SUMMARY,
  project: { id: P_ID, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', contractType: 'GREY_OWNER_FINISHING' },
  sections: [{ section: 'CONCRETE', amountPaisa: '120000000', lines: [LINE] }],
  stages: [{ stageKey: 'FOUNDATION_PLINTH', amountPaisa: '210000000' }],
  parameters: { slabThicknessIn: { value: 5, source: 'RULEBOOK' }, contingencyPercent: { value: 7, source: 'COMPANY' } },
  warnings: [],
  basis: { structureType: 'FRAMED', coveredAreaSqft: 3950 },
};

const VIS =
  'Money fields (`ratePaisa`, `amountPaisa`, every `*Paisa` total, `perSqftPaisa`) need fields.rates — without it they are left out; `contractTotalPaisa` needs fields.contract; `marginPaisa` / `marginPercent` fields.contract + fields.profit.';

export function registerRevisionDocs(): void {
  const T = ['Estimate'];
  const p = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, spec: Record<string, unknown>, tags = T) =>
    registry.registerPath({ method, path: url, tags, security: companySecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
  const common403 = ['PERMISSION_DENIED', 'COMPANY_SUSPENDED'];
  const write403 = [...common403, 'ACCOUNT_READ_ONLY'];

  p('post', '/api/v1/projects/{id}/estimates', {
    summary: 'Generate an estimate revision (DRAFT)',
    description:
      'Saves the current estimate as DRAFT revision n (last + 1): every BoQ line (14 sections, build `stageKey`, trace, wastage, supplier) with the current rulebook (company region → company overrides → project overrides) and price-list rates. Only one DRAFT at a time (409 ESTIMATE_DRAFT_EXISTS `{ estimateId }` — regenerate it instead). Project must be DRAFT or ACTIVE (409 PROJECT_LOCKED). Permission projects.estimate.manage. Audited `estimate.generate`. ' +
      VIS,
    request: { params: projectParam, body: jsonBody(generateEstimateBody, { plain: ex('Generate', {}), note: ex('With a note', { note: 'After the owner added a store on the first floor' }) }) },
    responses: { ...resp(201, 'Created (detail)', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: write403, 404: ['PROJECT_NOT_FOUND'], 409: ['ESTIMATE_DRAFT_EXISTS', 'PROJECT_LOCKED'] }) },
  });
  p('get', '/api/v1/projects/{id}/estimates', {
    summary: 'Estimate revisions of a project',
    description: `Every revision, newest first (summary). Permission projects.estimate.view. ${VIS}`,
    request: { params: projectParam },
    responses: { ...resp(200, 'Revisions', [SUMMARY]), ...errors({ ...AUTH, 403: common403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  p('get', '/api/v1/estimates/{id}', {
    summary: 'Estimate revision (BoQ)',
    description:
      `Lines grouped by section with section totals, totals per build stage, direct cost, site overheads (% of direct), contingency (% of direct + overheads), total, cost per sq ft and the margin against the current contract value. Each line has its calculation \`trace\` and any override { quantity, ratePaisa, note, by, at }. Owner-supplied lines have no rate or amount. Permission projects.estimate.view (project in scope, else 404). ${VIS}`,
    request: { params: estimateParam },
    responses: { ...resp(200, 'Estimate', DETAIL), ...errors({ ...AUTH, 403: common403, 404: ['ESTIMATE_NOT_FOUND'] }) },
  });
  p('post', '/api/v1/estimates/{id}/regenerate', {
    summary: 'Regenerate a DRAFT revision',
    description:
      'Recomputes a DRAFT from the current project, rulebook and price list (same id and revision; `ratesOutdated` back to false). Line overrides are kept by `lineKey`. APPROVED / SUPERSEDED → 409 ESTIMATE_LOCKED. Permission projects.estimate.manage. Audited `estimate.regenerate`.',
    request: { params: estimateParam },
    responses: { ...resp(200, 'Regenerated (detail)', DETAIL), ...errors({ ...AUTH, 403: write403, 404: ['ESTIMATE_NOT_FOUND'], 409: ['ESTIMATE_LOCKED'] }) },
  });
  p('patch', '/api/v1/estimates/{id}/lines/{lineId}', {
    summary: 'Override a line (DRAFT only)',
    description:
      'Sets or clears (`null`) the quantity and / or rate of one line; a note is required when setting a value (400 NOTE_REQUIRED). The amount, overheads, contingency and totals are recomputed. A rate needs fields.rates (403 PERMISSION_DENIED); owner-supplied lines take no rate (400 OWNER_SUPPLIED_NO_RATE); overheads / contingency lines cannot be changed (400 LINE_NOT_EDITABLE). Not a DRAFT → 409 ESTIMATE_LOCKED. Permission projects.estimate.manage. Audited `estimate.line_override`.',
    request: {
      params: z.object({ id: ID('Estimate id'), lineId: ID('Line id') }),
      body: jsonBody(lineOverrideBody, {
        qty: ex('Measured quantity', { quantity: 300, note: 'Site measured: 300 bags' }),
        rate: ex('Negotiated rate', { ratePaisa: '140000', note: 'Dealer rate agreed for this site' }),
        clear: ex('Back to the computed values', { quantity: null, ratePaisa: null }),
        bad: ex('❌ No note → 400', { quantity: 300 }),
      }),
    },
    responses: { ...resp(200, 'Updated (detail)', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'NOTE_REQUIRED', 'LINE_NOT_EDITABLE', 'OWNER_SUPPLIED_NO_RATE'], 403: write403, 404: ['ESTIMATE_NOT_FOUND', 'ESTIMATE_LINE_NOT_FOUND'], 409: ['ESTIMATE_LOCKED'] }) },
  });
  p('post', '/api/v1/estimates/{id}/approve', {
    summary: 'Approve a revision',
    description:
      'DRAFT → APPROVED: rates and rulebook values are frozen; the previous APPROVED revision of the project becomes SUPERSEDED (only one APPROVED per project). A DRAFT whose rates changed in the price list (`ratesOutdated`) needs `confirmOutdatedRates: true` (else 409 RATES_OUTDATED). Permission estimate.revision.approve (owner, Administrator). Audited `estimate.approve`.',
    request: { params: estimateParam, body: jsonBody(approveEstimateBody, { approve: ex('Approve', {}), outdated: ex('Approve with outdated rates', { confirmOutdatedRates: true }) }) },
    responses: { ...resp(200, 'Approved (detail)', { ...DETAIL, status: 'APPROVED' }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: write403, 404: ['ESTIMATE_NOT_FOUND'], 409: ['ESTIMATE_NOT_DRAFT', 'RATES_OUTDATED'] }) },
  });
  p('get', '/api/v1/estimates/{a}/compare/{b}', {
    summary: 'Compare two revisions',
    description: `Line diffs by \`lineKey\` (ADDED / REMOVED / CHANGED / UNCHANGED, effective quantities, rates and amounts, delta = b − a), section totals and the total diff (+ %). Both revisions must be of the same project (400 DIFFERENT_PROJECTS). Permission projects.estimate.view. ${VIS}`,
    request: { params: z.object({ a: ID('Revision a (older)'), b: ID('Revision b (newer)') }) },
    responses: {
      ...resp(200, 'Comparison', {
        a: { ...SUMMARY, revision: 1, status: 'APPROVED' },
        b: SUMMARY,
        lines: [{ lineKey: 'CONCRETE.GF_STRUCTURE.cement', section: 'CONCRETE', stageKey: 'GF_STRUCTURE', description: 'Cement OPC', unit: 'bag', change: 'CHANGED', quantityA: 180, quantityB: 186.05, quantityDelta: 6.05, ratePaisaA: '140000', ratePaisaB: '145000', amountPaisaA: '25200000', amountPaisaB: '26977250', amountDeltaPaisa: '1777250' }],
        sections: [{ section: 'CONCRETE', amountPaisaA: '115000000', amountPaisaB: '120000000', deltaPaisa: '5000000' }],
        totals: { totalPaisaA: '1250000000', totalPaisaB: '1276170000', deltaPaisa: '26170000', deltaPercent: 2.09 },
      }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'DIFFERENT_PROJECTS'], 403: common403, 404: ['ESTIMATE_NOT_FOUND'] }),
    },
  });
  p('get', '/api/v1/estimates/{id}/pdf', {
    summary: 'Estimate PDF (internal BoQ)',
    description: 'Letterhead, sections with lines, wastage, stage, rates / amounts (only with fields.rates), overheads, contingency, total and cost per sq ft — marked internal. Stored as a REPORT attachment; returns a signed link + WhatsApp text. 503 PDF_UNAVAILABLE when the PDF engine is down. Permission projects.estimate.view.',
    request: { params: estimateParam, query: lang },
    responses: { ...resp(200, 'Share payload', { attachmentId: '0199a8c0-0000-7000-8000-000000000f01', url: 'https://…', expiresAt: '2026-11-01T10:00:00.000Z', whatsappText: 'Estimate DHA Phase 6 · 10 Marla · Rev 2: https://…' }), ...errors({ ...AUTH, 403: common403, 404: ['ESTIMATE_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }) },
  });
  p('get', '/api/v1/projects/{id}/owner-shopping-list', {
    summary: 'Owner shopping list',
    description:
      'What the owner buys himself: the owner-supplied lines summed per material with the quantity per build stage and `neededBy` (the first stage that needs it), in stage order. Never any rate. From `estimateId`, else the APPROVED revision, else the DRAFT, else the live preview (`source` ESTIMATE / APPROVED / DRAFT / PREVIEW). Permission projects.estimate.view.',
    request: { params: projectParam, query: shoppingListQuery },
    responses: {
      ...resp(200, 'Shopping list', {
        source: 'APPROVED',
        estimateId: E_ID,
        revision: 1,
        items: [{ material: 'floorTiles', materialId: null, description: 'Floor tiles', unit: 'sqft', quantity: 3210.5, neededBy: 'FINISHING', stages: [{ stageKey: 'FINISHING', quantity: 3210.5 }] }],
      }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: common403, 404: ['PROJECT_NOT_FOUND', 'ESTIMATE_NOT_FOUND'] }),
    },
  });
  p('get', '/api/v1/projects/{id}/owner-shopping-list/pdf', {
    summary: 'Owner shopping list PDF',
    description: 'The shopping list as a PDF for the owner (no rates) + WhatsApp text in the document language, the client phone to send it to. Permission projects.estimate.view.',
    request: { params: projectParam, query: shoppingListQuery },
    responses: { ...resp(200, 'Share payload', { attachmentId: '0199a8c0-0000-7000-8000-000000000f02', url: 'https://…', expiresAt: '2026-11-01T10:00:00.000Z', whatsappText: 'Assalam o Alaikum Ahmed Raza sahib, …', clientPhone: '+923331234567' }), ...errors({ ...AUTH, 403: common403, 404: ['PROJECT_NOT_FOUND', 'ESTIMATE_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }) },
  });

  // ─── Company rulebook ──────────────────────────────────────────────────────
  const R = ['Rulebook'];
  const RULEBOOK = {
    region: 'PUNJAB_KP',
    rulebook: { id: '01920000-0000-7000-8000-00000000b001', version: 1, status: 'PUBLISHED', publishedAt: '2026-11-01T00:00:00.000Z', notes: 'v1 — built-in Pakistani rules of thumb' },
    parameters: [
      { key: 'contingencyPercent', group: 'OVERHEADS', label: { en: 'Contingency', roman: 'Ghair mutawaqqa kharcha', ur: 'غیر متوقع خرچہ' }, unit: '%', description: '% of direct cost + overheads', platformValue: 5, companyValue: 7, companyNote: 'Our sites need more allowance', value: 7, source: 'COMPANY', safeMin: 0, safeMax: 15, reviewStatus: 'PENDING_ENGINEER_REVIEW', projectOverridable: true },
    ],
  };
  p('get', '/api/v1/rulebook', {
    summary: 'Company estimation rulebook',
    description: 'Every rulebook parameter of the company region (highest PUBLISHED version; `rulebook: null` = built-in v1) with the platform value, the company value / note, the value in effect and its `source`, the safe range and the engineer-review status. Permission rulebook.override.view (owner, Administrator, Project Manager).',
    responses: { ...resp(200, 'Rulebook', RULEBOOK), ...errors({ ...AUTH, 403: common403 }) },
  }, R);
  p('get', '/api/v1/rulebook/overrides', {
    summary: 'Company rulebook overrides',
    description: 'The company own values. Permission rulebook.override.view.',
    responses: { ...resp(200, 'Overrides', [{ key: 'contingencyPercent', value: 7, note: 'Our sites need more allowance', updatedAt: '2026-11-01T09:00:00.000Z', updatedBy: { id: '0199a8c0-0000-7000-8000-000000000201', name: 'Khalid Malik' } }]), ...errors({ ...AUTH, 403: common403 }) },
  }, R);
  p('put', '/api/v1/rulebook/overrides', {
    summary: 'Set company rulebook values',
    description: 'Upserts the sent values (others untouched). Each must be a known key (400 UNKNOWN_PARAMETER) inside the parameter safe range (400 OUT_OF_SAFE_RANGE `{ key, value, safeMin, safeMax }`). Applies to every estimate generated afterwards (approved revisions keep their values). Permission rulebook.override.manage. Audited `rulebook.override_set`. Returns GET /rulebook.',
    request: {
      body: jsonBody(setOverridesBody, {
        one: ex('7 % contingency', { overrides: [{ key: 'contingencyPercent', value: 7, note: 'Our sites need more allowance' }] }),
        two: ex('Cement wastage 3 %, 6″ slabs', { overrides: [{ key: 'cementWastagePercent', value: 3 }, { key: 'slabThicknessIn', value: 6 }] }),
        bad: ex('❌ Contingency 40 % → 400', { overrides: [{ key: 'contingencyPercent', value: 40 }] }),
      }),
    },
    responses: { ...resp(200, 'Rulebook', RULEBOOK), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'UNKNOWN_PARAMETER', 'OUT_OF_SAFE_RANGE'], 403: write403 }) },
  }, R);
  p('delete', '/api/v1/rulebook/overrides/{key}', {
    summary: 'Back to the platform value',
    description: 'Removes the company value of one parameter. Permission rulebook.override.manage. Audited `rulebook.override_delete`. Returns GET /rulebook.',
    request: { params: z.object({ key: z.string().meta({ description: 'Parameter key', example: 'contingencyPercent' }) }) },
    responses: { ...resp(200, 'Rulebook', RULEBOOK), ...errors({ ...AUTH, 403: write403, 404: ['OVERRIDE_NOT_FOUND'] }) },
  }, R);

  // ─── Platform admin: rulebook versions ─────────────────────────────────────
  const a = (method: 'get' | 'post' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) =>
    registry.registerPath({ method, path: url, tags: ['Platform admin'], security: platformSecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
  const ADMIN_DETAIL = {
    id: '01920000-0000-7000-8000-00000000b001',
    region: 'PUNJAB_KP',
    version: 1,
    status: 'PUBLISHED',
    publishedAt: '2026-11-01T00:00:00.000Z',
    notes: 'v1',
    createdAt: '2026-11-01T00:00:00.000Z',
    parameters: [{ id: '0199a8c0-0000-7000-8000-000000000c01', key: 'bricksPerCft', group: 'MASONRY', label: { en: 'Bricks per cft of brickwork', roman: 'Fi cft eenten', ur: 'فی مکعب فٹ اینٹیں' }, unit: 'bricks / cft', description: 'Standard bricks per cft', value: 13.5, safeMin: 12, safeMax: 15, reviewStatus: 'PENDING_ENGINEER_REVIEW', sortOrder: 5 }],
  };
  const rbId = z.object({ id: ID('Rulebook version id') });
  a('get', '/api/v1/admin/rulebooks', {
    summary: 'Estimation rulebook versions',
    description: 'Every version per region (newest first) with the parameter count and how many still wait for engineer review.',
    request: { query: rulebooksQuery },
    responses: { ...resp(200, 'Versions', [{ id: ADMIN_DETAIL.id, region: 'PUNJAB_KP', version: 1, status: 'PUBLISHED', publishedAt: ADMIN_DETAIL.publishedAt, notes: 'v1', parameterCount: 68, pendingReview: 68, createdAt: ADMIN_DETAIL.createdAt }]), ...errors(ADMIN_AUTH) },
  });
  a('post', '/api/v1/admin/rulebooks', {
    summary: 'New rulebook version (DRAFT)',
    description: 'Version = last + 1 of the region; values copied from `copyFromId` (same region, else 400 INVALID_SOURCE) or the latest version; keys the source lacks come from the built-in defaults. Audited `admin.rulebook_created`.',
    request: { body: jsonBody(createRulebookBody, { punjab: ex('Next Punjab version', { region: 'PUNJAB_KP', notes: 'Engineer review round 1' }) }) },
    responses: { ...resp(201, 'Created', { ...ADMIN_DETAIL, version: 2, status: 'DRAFT', publishedAt: null }), ...errors({ ...ADMIN_AUTH, 400: ['VALIDATION_ERROR', 'INVALID_SOURCE'] }) },
  });
  a('get', '/api/v1/admin/rulebooks/{id}', { summary: 'Rulebook version with its parameters', request: { params: rbId }, responses: { ...resp(200, 'Version', ADMIN_DETAIL), ...errors({ ...ADMIN_AUTH, 404: ['RULEBOOK_NOT_FOUND'] }) } });
  a('patch', '/api/v1/admin/rulebooks/{id}', {
    summary: 'Edit version notes',
    description: 'Audited `admin.rulebook_updated`.',
    request: { params: rbId, body: jsonBody(updateRulebookBody, { notes: ex('Notes', { notes: 'v2 draft — pending engineer sign-off' }) }) },
    responses: { ...resp(200, 'Version', ADMIN_DETAIL), ...errors({ ...ADMIN_AUTH, 400: ['VALIDATION_ERROR'], 404: ['RULEBOOK_NOT_FOUND'] }) },
  });
  a('delete', '/api/v1/admin/rulebooks/{id}', { summary: 'Delete a DRAFT version', description: 'Published versions cannot be deleted (409 RULEBOOK_PUBLISHED). Audited `admin.rulebook_deleted`.', request: { params: rbId }, responses: { ...resp(200, 'Deleted', { deleted: true }), ...errors({ ...ADMIN_AUTH, 404: ['RULEBOOK_NOT_FOUND'], 409: ['RULEBOOK_PUBLISHED'] }) } });
  a('patch', '/api/v1/admin/rulebooks/{id}/parameters/{key}', {
    summary: 'Edit a parameter',
    description: 'Value and safe range only on a DRAFT (409 RULEBOOK_PUBLISHED); review status, labels and description any time. safeMin ≤ value ≤ safeMax (400 INVALID_RANGE / OUT_OF_SAFE_RANGE). Audited `admin.rulebook_parameter_updated` (before + changes).',
    request: {
      params: z.object({ id: ID('Rulebook version id'), key: z.string().meta({ description: 'Parameter key', example: 'bricksPerCft' }) }),
      body: jsonBody(updateParameterBody, { value: ex('New value', { value: 13 }), reviewed: ex('Engineer reviewed', { reviewStatus: 'REVIEWED' }), bad: ex('❌ Nothing → 400', {}) }),
    },
    responses: { ...resp(200, 'Version', ADMIN_DETAIL), ...errors({ ...ADMIN_AUTH, 400: ['VALIDATION_ERROR', 'INVALID_RANGE', 'OUT_OF_SAFE_RANGE'], 404: ['RULEBOOK_NOT_FOUND', 'PARAMETER_NOT_FOUND'], 409: ['RULEBOOK_PUBLISHED'] }) },
  });
  a('post', '/api/v1/admin/rulebooks/{id}/publish', {
    summary: 'Publish a version',
    description: 'DRAFT → PUBLISHED: from now on every company of the region estimates with it (approved estimates keep the version they froze). Every value must be inside its safe range. Audited `admin.rulebook_published`.',
    request: { params: rbId },
    responses: { ...resp(200, 'Published', ADMIN_DETAIL), ...errors({ ...ADMIN_AUTH, 400: ['OUT_OF_SAFE_RANGE'], 404: ['RULEBOOK_NOT_FOUND'], 409: ['RULEBOOK_PUBLISHED'] }) },
  });
}
