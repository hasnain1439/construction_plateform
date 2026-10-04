import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import {
  changeStatusBody,
  copyFloorBody,
  createProjectBody,
  createRoomBody,
  listProjectsQuery,
  openingInputSchema,
  setTeamBody,
  updateBasicBody,
  updateContractBody,
  updateCoverageBody,
  updateOpeningBody,
  updatePlotStructureBody,
  updateRoomBody,
} from './projects.schema.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const READ_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED'];
const WRITE_403 = ['FORBIDDEN', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'];
const data = z.object({ success: z.literal(true), data: z.unknown() });
const resp = (status: 200 | 201, description: string, example?: unknown, meta?: unknown) => ({
  [status]: {
    description,
    content: { 'application/json': { schema: data, ...(example === undefined ? {} : { example: { success: true, data: example, ...(meta ? { meta } : {}) } }) } },
  },
});
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const idParam = (what: string) => z.object({ id: z.uuid().meta({ description: `${what} id` }) });

const PROJECT_ID = '0199a8c0-0000-7000-8000-000000000101';
const CLIENT_ID = '0199a8c0-0000-7000-8000-0000000001c1';
const BILAL = { id: '0199a8c0-0000-7000-8000-000000000002', name: 'Bilal Ahmed' };
const RAFAQAT = { id: '0199a8c0-0000-7000-8000-000000000003', name: 'Rafaqat Ali' };
const FLOOR_ID = '0199a8c0-0000-7000-8000-0000000002f1';
const FLOOR_FIRST = '0199a8c0-0000-7000-8000-0000000002f2';
const ROOM_ID = '0199a8c0-0000-7000-8000-0000000003a1';
const CAT_A_PLUS = '0199a8c0-0000-7000-8000-0000000000e1';
const TEMPLATE_ID = '0199a8c0-0000-7000-8000-0000000000b1';

const listRow = {
  id: PROJECT_ID,
  code: 'MSB-2026-012',
  name: 'DHA Phase 6 · 10 Marla',
  client: { id: CLIENT_ID, name: 'Ahmed Raza' },
  siteAddress: 'House 214, Sector C, DHA Phase 6',
  city: 'Lahore',
  status: 'ACTIVE',
  contractType: 'GREY_OWNER_FINISHING',
  startDate: '2026-03-15',
  endDate: '2027-02-15',
  pm: BILAL,
  munshi: RAFAQAT,
  coveredAreaSqft: 3950,
  contractValuePaisa: '1850000000',
};

const roomExample = {
  id: ROOM_ID,
  floorId: FLOOR_ID,
  type: 'DRAWING_ROOM',
  name: 'Drawing Room',
  lengthFt: 16,
  widthFt: 14,
  heightFt: 11,
  isWet: false,
  isWetOverridden: false,
  sortOrder: 1,
  openings: [
    { id: '0199a8c0-0000-7000-8000-0000000004b1', type: 'DOOR', widthFt: 3.5, heightFt: 7, quantity: 1 },
    { id: '0199a8c0-0000-7000-8000-0000000004b2', type: 'WINDOW', widthFt: 5, heightFt: 4, quantity: 1 },
  ],
  calculations: { floorAreaSqft: 224, grossWallAreaSqft: 660, openingsAreaSqft: 44.5, netWallAreaSqft: 615.5 },
};

const detailExample = {
  ...listRow,
  client: { id: CLIENT_ID, name: 'Ahmed Raza', phone: '+923331234567' },
  team: { pm: BILAL, munshis: [RAFAQAT] },
  contract: {
    contractType: 'GREY_OWNER_FINISHING',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: '1850000000',
    ratePerSqftPaisa: null,
    contractTotalPaisa: '1850000000',
    retentionPercent: 5,
    defectPeriodMonths: 6,
  },
  plot: { plotUnit: 'MARLA', plotSize: 10, marlaStandard: 225, frontFt: 35, depthFt: 65, cornerPlot: false },
  structure: { structureType: 'FRAMED', hasBasement: false, basementHeightFt: null },
  coverage: { coveredAreaSqft: 3950, semiCoveredSqft: 180, openAreaSqft: 420, boundaryWall: true, boundaryLengthFt: 200, boundaryHeightFt: 7, boundaryThickness: 'IN_9', boundaryPlasterSides: 2 },
  supplyRules: [
    { categoryKey: 'CEMENT', label: 'Cement', suppliedBy: 'CONTRACTOR', qualityCategory: { id: CAT_A_PLUS, name: 'A Standard', code: 'A_STD' }, locked: false },
    { categoryKey: 'TILES_FLOORING', label: 'Tiles, marble & flooring', suppliedBy: 'OWNER', qualityCategory: null, locked: false },
  ],
  billingStages: [{ id: '0199a8c0-0000-7000-8000-0000000005c1', sortOrder: 1, label: 'Agreement & mobilisation', percent: 15, isRetention: false, amountPaisa: '277500000', status: 'PAID' }],
  floors: [{ id: FLOOR_ID, level: 'GROUND', name: 'Ground floor', ceilingHeightFt: 11, sortOrder: 2, calculations: { rooms: 7, totalFloorAreaSqft: 1025, netWallAreaSqft: 3300.5, wetRooms: 3 } }],
  calculations: { plotAreaSqft: 2250, frontageAreaSqft: 2275, plotAreaMismatch: false, rooms: 17, totalFloorAreaSqft: 2269, netWallAreaSqft: 8123.5, wetRooms: 6 },
  wizardCompletedSteps: [1, 2, 3, 4, 5],
  createdFromQuoteId: null,
  activatedAt: '2026-03-15T09:00:00.000Z',
  createdAt: '2026-03-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

const PROJECT_ERRORS = { ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] };
const LOCK_NOTE = '\n\nOnly while DRAFT or ACTIVE (else 409 PROJECT_LOCKED). THEKEDAR, or a PM assigned to the project (others get 404).';

function path(tag: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) {
  registry.registerPath({ method, path: url, tags: [tag], security: companySecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
}

export function registerProjectsDocs(): void {
  // ─── Projects ────────────────────────────────────────────────────────────
  const P = 'Projects';
  path(P, 'get', '/api/v1/projects', {
    summary: 'List projects',
    description:
      'Every role, scoped: THEKEDAR sees all, PM and MUNSHI only their assigned projects. `contractValuePaisa` appears ' +
      'only with `billing.view` (omitted otherwise, not null).',
    request: { query: listProjectsQuery },
    responses: { ...resp(200, 'Projects', [listRow], { page: 1, limit: 25, total: 5, totalPages: 1 }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(P, 'post', '/api/v1/projects', {
    summary: 'Create a project (wizard tab 1)',
    description:
      'THEKEDAR, PM. Creates a **DRAFT** (not counted against the plan). Code is automatic (company initials + year + counter, e.g. ' +
      'MSB-2026-017) unless given. Either `clientId` or `newClient`. `pmId` / `munshiId` must be active users with that role; a PM ' +
      'creator is always assigned. Defaults: marla standard from company settings, retention 5 %, defect period 6 months.',
    request: {
      body: jsonBody(createProjectBody, {
        newClient: ex('New client, auto code, with team', {
          name: 'Gulberg · 10 Marla',
          newClient: { name: 'Naveed Akhtar', phone: '0300-7654321' },
          siteAddress: 'House 12, Block B, Gulberg III',
          city: 'Lahore',
          startDate: '2026-11-01',
          endDate: '2027-08-31',
          pmId: BILAL.id,
          munshiId: RAFAQAT.id,
        }),
        existing: ex('Existing client, own code', {
          name: 'Askari 11 · Villa',
          code: 'MSB-2026-030',
          clientId: CLIENT_ID,
          siteAddress: 'Villa 7, Askari 11',
          city: 'Lahore',
          startDate: '2026-12-01',
          endDate: '2027-11-30',
        }),
        bad: ex('❌ Both clientId and newClient → 400', {
          name: 'Wrong',
          clientId: CLIENT_ID,
          newClient: { name: 'X Y', phone: '03001112233' },
          siteAddress: 'Somewhere',
          city: 'Lahore',
          startDate: '2026-11-01',
          endDate: '2027-08-31',
        }),
      }),
    },
    responses: {
      ...resp(201, 'Created (full project)', { ...detailExample, status: 'DRAFT', wizardCompletedSteps: [1] }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_CLIENT', 'INVALID_PM', 'INVALID_MUNSHI'], ...AUTH, 403: WRITE_403, 409: ['PROJECT_CODE_TAKEN', 'CLIENT_PHONE_TAKEN'] }),
    },
  });
  path(P, 'get', '/api/v1/projects/{id}', {
    summary: 'Project details',
    description:
      'Scoped (others → 404). Client, team, contract, plot, structure, coverage, supply rules, billing stages, floor summaries, ' +
      'calculations and wizard progress. MUNSHI gets only id, code, name, status, client name, site, dates and team. ' +
      'Financial fields only with `billing.view`.',
    request: { params: idParam('Project') },
    responses: { ...resp(200, 'Project', detailExample), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(P, 'delete', '/api/v1/projects/{id}', {
    summary: 'Delete a draft project',
    description: 'THEKEDAR. Only DRAFT projects (with everything under them).',
    request: { params: idParam('Project') },
    responses: { ...resp(200, 'Deleted', { id: PROJECT_ID, deleted: true }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_NOT_DRAFT'] }) },
  });
  path(P, 'get', '/api/v1/projects/{id}/review', {
    summary: 'Review before activation',
    description:
      'THEKEDAR, PM. `errors` block activation (missing tab fields, stages ≠ 100 %, no GROUND floor, no rooms, contract value / rate ' +
      'missing). `warnings` don’t: plot vs front × depth > 10 %, room area vs covered area > 15 %, no PM, no Munshi, end date < 3 months after start.',
    request: { params: idParam('Project') },
    responses: {
      ...resp(200, 'Review', {
        ready: false,
        errors: [{ tab: 5, code: 'NO_ROOMS', message: 'Add the rooms' }],
        warnings: [{ tab: 1, code: 'NO_MUNSHI', message: 'No munshi assigned' }],
        summary: {
          client: { name: 'Ahmed Raza', phone: '+923331234567' },
          contract: { contractType: 'FULL', billingModel: 'STAGE_SCHEDULE', contractTotalPaisa: '1100000000', retentionPercent: 5, defectPeriodMonths: 6, billingStages: 8 },
          plot: { plotUnit: 'MARLA', plotSize: 5, plotAreaSqft: 1125, frontFt: 25, depthFt: 45, cornerPlot: false },
          structure: { structureType: 'FRAMED', hasBasement: false, floors: 2 },
          coverage: { coveredAreaSqft: 2100, semiCoveredSqft: 0, openAreaSqft: 0, boundaryWall: false },
          roomsPerFloor: [{ level: 'GROUND', name: 'Ground floor', rooms: 0, totalFloorAreaSqft: 0, netWallAreaSqft: 0, wetRooms: 0 }],
          supply: { contractor: 11, owner: 0 },
        },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(P, 'post', '/api/v1/projects/{id}/activate', {
    summary: 'Activate a draft',
    description:
      'THEKEDAR, PM. Only DRAFT; the review must have no errors (400 PROJECT_NOT_READY with `details.errors`); the plan’s active-project ' +
      'limit applies (402). Sets ACTIVE + `activatedAt`. `nextStep: "ESTIMATE"` (estimate engine: Phase 2).',
    request: { params: idParam('Project') },
    responses: {
      ...resp(200, 'Activated', { ...detailExample, nextStep: 'ESTIMATE' }),
      ...errors({ 400: ['PROJECT_NOT_READY'], ...AUTH, 402: ['PLAN_LIMIT_REACHED'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_NOT_DRAFT'] }),
    },
  });
  path(P, 'patch', '/api/v1/projects/{id}/status', {
    summary: 'Change project status',
    description:
      'THEKEDAR. ACTIVE → CLOSEOUT → HANDED_OVER → CLOSED, and CLOSEOUT → ACTIVE (reopen, plan limit checked). ' +
      'ACTIVE and CLOSEOUT count against the plan. READ_ONLY is set only by the subscription job.',
    request: {
      params: idParam('Project'),
      body: jsonBody(changeStatusBody, {
        closeout: ex('Start close-out', { status: 'CLOSEOUT', note: 'Snag list started' }),
        handover: ex('Handed over', { status: 'HANDED_OVER', note: 'Keys handed to Ahmed Raza' }),
      }),
    },
    responses: { ...resp(200, 'Updated', detailExample), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 402: ['PLAN_LIMIT_REACHED'], 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['INVALID_STATUS_TRANSITION'] }) },
  });

  // ─── Wizard ──────────────────────────────────────────────────────────────
  const Z = 'Project Wizard';
  path(Z, 'patch', '/api/v1/projects/{id}/basic', {
    summary: 'Tab 1 — basic details',
    description: 'Name, code (unique → 409 PROJECT_CODE_TAKEN), client (`clientId` or `newClient`), site, dates.' + LOCK_NOTE,
    request: {
      params: idParam('Project'),
      body: jsonBody(updateBasicBody, {
        rename: ex('Rename and move the end date', { name: 'DHA Phase 6 · 10 Marla (Ahmed Raza)', endDate: '2027-03-31' }),
      }),
    },
    responses: { ...resp(200, 'Saved (full project)', detailExample), ...errors({ ...PROJECT_ERRORS, 400: ['VALIDATION_ERROR', 'INVALID_DATES', 'INVALID_CLIENT'], 409: ['PROJECT_LOCKED', 'PROJECT_CODE_TAKEN', 'CLIENT_PHONE_TAKEN'] }) },
  });
  path(Z, 'put', '/api/v1/projects/{id}/team', {
    summary: 'Project team (PM + Munshis)',
    description: 'THEKEDAR. Omitted = unchanged; `pmId: null` / `munshiIds: []` removes. Users must be active with the matching role. Allowed while DRAFT, ACTIVE or CLOSEOUT.',
    request: {
      params: idParam('Project'),
      body: jsonBody(setTeamBody, { both: ex('PM and Munshi', { pmId: BILAL.id, munshiIds: [RAFAQAT.id] }), noPm: ex('Remove the PM', { pmId: null }) }),
    },
    responses: { ...resp(200, 'Saved', detailExample), ...errors({ ...PROJECT_ERRORS, 400: ['VALIDATION_ERROR', 'INVALID_PM', 'INVALID_MUNSHI'] }) },
  });
  path(Z, 'patch', '/api/v1/projects/{id}/contract', {
    summary: 'Tab 2 — contract, supply rules, billing stages',
    description:
      '`contractValuePaisa` is required for FULL / GREY_OWNER_FINISHING, `ratePerSqftPaisa` for LABOR_ONLY. Supply rules start from the ' +
      'contract-type preset (see /supply-presets; contractor rows get the default quality category) and `supplyRules` override single ' +
      'categories: CONTRACTOR rows need `qualityCategoryId`, OWNER rows must not have one; locked rows → 409 SUPPLY_RULE_LOCKED. ' +
      'Stages from `billingStages`, a `templateId`, or (first time) the company default template; total exactly 100 % ' +
      '(400 PERCENT_TOTAL_INVALID `{total}`), one retention stage max. Amounts = contract value × % (labour-only: rate × covered area), ' +
      'rounded to the rupee, last stage absorbs the rounding.' +
      LOCK_NOTE,
    request: {
      params: idParam('Project'),
      body: jsonBody(updateContractBody, {
        grey: ex('Grey structure by contractor (preset + default stages)', { contractType: 'GREY_OWNER_FINISHING', billingModel: 'STAGE_SCHEDULE', contractValuePaisa: '1850000000' }),
        full: ex('Full contract, A+ steel, template', {
          contractType: 'FULL',
          billingModel: 'STAGE_SCHEDULE',
          contractValuePaisa: '3400000000',
          retentionPercent: 5,
          defectPeriodMonths: 12,
          supplyRules: [
            { categoryKey: 'STEEL', suppliedBy: 'CONTRACTOR', qualityCategoryId: CAT_A_PLUS },
            { categoryKey: 'SANITARY', suppliedBy: 'OWNER' },
          ],
          templateId: TEMPLATE_ID,
        }),
        labour: ex('Labour only, own stages', {
          contractType: 'LABOR_ONLY',
          billingModel: 'RUNNING_BILLS',
          ratePerSqftPaisa: '45000',
          billingStages: [
            { label: 'Monthly running bills', percent: 95 },
            { label: 'Retention', percent: 5, isRetention: true },
          ],
        }),
        short: ex('❌ Stages add up to 95 → 400 PERCENT_TOTAL_INVALID', {
          contractType: 'FULL',
          billingModel: 'STAGE_SCHEDULE',
          contractValuePaisa: '1000000000',
          billingStages: [
            { label: 'A', percent: 50 },
            { label: 'B', percent: 45 },
          ],
        }),
      }),
    },
    responses: {
      ...resp(200, 'Saved', detailExample),
      ...errors({
        ...PROJECT_ERRORS,
        400: [
          'VALIDATION_ERROR',
          'CONTRACT_VALUE_REQUIRED',
          'RATE_REQUIRED',
          'PERCENT_TOTAL_INVALID',
          'RETENTION_STAGE_INVALID',
          'INVALID_TEMPLATE',
          'QUALITY_CATEGORY_REQUIRED',
          'QUALITY_CATEGORY_NOT_ALLOWED',
          'INVALID_QUALITY_CATEGORY',
        ],
        409: ['PROJECT_LOCKED', 'SUPPLY_RULE_LOCKED', 'BILLING_STAGES_LOCKED'],
      }),
    },
  });
  path(Z, 'patch', '/api/v1/projects/{id}/plot-structure', {
    summary: 'Tab 3 — plot & structure (floors)',
    description:
      'Plot in MARLA / KANAL (20 marla) / SQFT with the marla standard (225 or 272.25), front × depth, structure, basement. `floors` ' +
      'are upserted by level (GROUND required; BASEMENT only with `hasBasement`). Removing a floor that has rooms → 409 FLOOR_HAS_ROOMS ' +
      'unless `force: true` (its rooms are deleted).' +
      LOCK_NOTE,
    request: {
      params: idParam('Project'),
      body: jsonBody(updatePlotStructureBody, {
        tenMarla: ex('10 marla, G + 1 + mumty', {
          plotUnit: 'MARLA',
          plotSize: 10,
          frontFt: 35,
          depthFt: 65,
          structureType: 'FRAMED',
          hasBasement: false,
          floors: [
            { level: 'GROUND', ceilingHeightFt: 11 },
            { level: 'FIRST', ceilingHeightFt: 10 },
            { level: 'MUMTY', ceilingHeightFt: 9 },
          ],
        }),
        kanal: ex('1 kanal with basement (revenue marla)', {
          plotUnit: 'KANAL',
          plotSize: 1,
          marlaStandard: 272.25,
          frontFt: 50,
          depthFt: 90,
          cornerPlot: true,
          structureType: 'FRAMED',
          hasBasement: true,
          basementHeightFt: 10,
          floors: [
            { level: 'BASEMENT', ceilingHeightFt: 10 },
            { level: 'GROUND', ceilingHeightFt: 11 },
            { level: 'FIRST', ceilingHeightFt: 10 },
          ],
        }),
      }),
    },
    responses: { ...resp(200, 'Saved', detailExample), ...errors({ ...PROJECT_ERRORS, 400: ['VALIDATION_ERROR'], 409: ['PROJECT_LOCKED', 'FLOOR_HAS_ROOMS'] }) },
  });
  path(Z, 'patch', '/api/v1/projects/{id}/coverage', {
    summary: 'Tab 4 — coverage & boundary wall',
    description: 'Covered / semi-covered / open area (sq ft). Boundary length, height, thickness and plaster sides are required with a boundary wall.' + LOCK_NOTE,
    request: {
      params: idParam('Project'),
      body: jsonBody(updateCoverageBody, {
        dha: ex('With boundary wall', {
          coveredAreaSqft: 3950,
          semiCoveredSqft: 180,
          openAreaSqft: 420,
          boundaryWall: true,
          boundaryLengthFt: 200,
          boundaryHeightFt: 7,
          boundaryThickness: 'IN_9',
          boundaryPlasterSides: 2,
        }),
        simple: ex('No boundary wall', { coveredAreaSqft: 2100, boundaryWall: false }),
      }),
    },
    responses: { ...resp(200, 'Saved', detailExample), ...errors({ ...PROJECT_ERRORS, 400: ['VALIDATION_ERROR'] }) },
  });
  path(Z, 'get', '/api/v1/supply-presets', {
    summary: 'Supply presets',
    description: 'Every role. Who supplies each material category for each contract type.',
    responses: {
      ...resp(200, 'Presets', [
        {
          contractType: 'GREY_OWNER_FINISHING',
          label: 'Grey structure by contractor, finishing by owner',
          rules: [
            { categoryKey: 'CEMENT', suppliedBy: 'CONTRACTOR', label: 'Cement' },
            { categoryKey: 'PAINT', suppliedBy: 'OWNER', label: 'Paint & polish' },
          ],
        },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });

  // ─── Floors & rooms ──────────────────────────────────────────────────────
  const F = 'Floors & Rooms';
  const ROOM_ERRORS = { ...AUTH, 403: WRITE_403, 409: ['PROJECT_LOCKED'] };
  path(F, 'get', '/api/v1/projects/{id}/floors', {
    summary: 'Floors with rooms and calculations (tab 5)',
    description: 'Scoped (MUNSHI may read assigned projects). Room: floor area L × W, gross wall 2 × (L + W) × H, openings Σ w × h × qty, net wall. Floor and project totals.',
    request: { params: idParam('Project') },
    responses: {
      ...resp(200, 'Floors', {
        floors: [{ id: FLOOR_ID, level: 'GROUND', name: 'Ground floor', ceilingHeightFt: 11, sortOrder: 2, rooms: [roomExample], calculations: { rooms: 1, totalFloorAreaSqft: 224, netWallAreaSqft: 615.5, wetRooms: 0 } }],
        totals: { rooms: 1, totalFloorAreaSqft: 224, netWallAreaSqft: 615.5, wetRooms: 0 },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(F, 'post', '/api/v1/floors/{id}/rooms', {
    summary: 'Add a room',
    description:
      'THEKEDAR, assigned PM. Height defaults to the floor’s ceiling; name defaults to the type ("Bedroom 2" for the second). ' +
      'Bath, powder room and kitchen are wet automatically; `isWet` overrides. Openings larger than the walls → 400 OPENINGS_EXCEED_WALL.',
    request: {
      params: idParam('Floor'),
      body: jsonBody(createRoomBody, {
        drawing: ex('Drawing room with a door and two windows', {
          type: 'DRAWING_ROOM',
          lengthFt: 16,
          widthFt: 14,
          openings: [
            { type: 'DOOR', widthFt: 4, heightFt: 7 },
            { type: 'WINDOW', widthFt: 5, heightFt: 4, quantity: 2 },
          ],
        }),
        store: ex('Store marked wet by hand', { type: 'STORE', name: 'Washing area', lengthFt: 6, widthFt: 5, heightFt: 9, isWet: true }),
      }),
    },
    responses: { ...resp(201, 'Created', roomExample), ...errors({ ...ROOM_ERRORS, 400: ['VALIDATION_ERROR', 'OPENINGS_EXCEED_WALL'], 404: ['FLOOR_NOT_FOUND'] }) },
  });
  path(F, 'post', '/api/v1/floors/{id}/copy', {
    summary: 'Copy a floor’s rooms to another floor',
    description: 'Copies rooms + openings; heights take the target floor’s ceiling. The target must be empty unless `replace: true`.',
    request: { params: idParam('Source floor'), body: jsonBody(copyFloorBody, { copy: ex('Ground → First', { targetFloorId: FLOOR_FIRST }), replace: ex('Overwrite the target', { targetFloorId: FLOOR_FIRST, replace: true }) }) },
    responses: {
      ...resp(200, 'Target floor with rooms'),
      ...errors({ ...ROOM_ERRORS, 400: ['VALIDATION_ERROR', 'INVALID_TARGET_FLOOR'], 404: ['FLOOR_NOT_FOUND'], 409: ['PROJECT_LOCKED', 'FLOOR_NOT_EMPTY'] }),
    },
  });
  path(F, 'patch', '/api/v1/rooms/{id}', {
    summary: 'Edit a room',
    description: '`isWet: true/false` overrides, `null` returns to automatic; a type change re-derives the wet flag unless overridden.',
    request: { params: idParam('Room'), body: jsonBody(updateRoomBody, { resize: ex('Resize', { lengthFt: 17, widthFt: 14.5 }), auto: ex('Wet flag back to automatic', { isWet: null }) }) },
    responses: { ...resp(200, 'Updated', roomExample), ...errors({ ...ROOM_ERRORS, 400: ['VALIDATION_ERROR', 'OPENINGS_EXCEED_WALL'], 404: ['ROOM_NOT_FOUND'] }) },
  });
  path(F, 'delete', '/api/v1/rooms/{id}', {
    summary: 'Delete a room',
    description: 'Its openings are deleted too.',
    request: { params: idParam('Room') },
    responses: { ...resp(200, 'Deleted', { id: ROOM_ID, deleted: true }), ...errors({ ...ROOM_ERRORS, 404: ['ROOM_NOT_FOUND'] }) },
  });
  path(F, 'post', '/api/v1/rooms/{id}/openings', {
    summary: 'Add a door / window / ventilator',
    description: 'Returns the room with updated calculations.',
    request: { params: idParam('Room'), body: jsonBody(openingInputSchema, { door: ex('Door 3.5 × 7', { type: 'DOOR', widthFt: 3.5, heightFt: 7 }), windows: ex('Two windows 5 × 4', { type: 'WINDOW', widthFt: 5, heightFt: 4, quantity: 2 }) }) },
    responses: { ...resp(201, 'Room', roomExample), ...errors({ ...ROOM_ERRORS, 400: ['VALIDATION_ERROR', 'OPENINGS_EXCEED_WALL'], 404: ['ROOM_NOT_FOUND'] }) },
  });
  path(F, 'patch', '/api/v1/openings/{id}', {
    summary: 'Edit an opening',
    request: { params: idParam('Opening'), body: jsonBody(updateOpeningBody, { qty: ex('Three of them', { quantity: 3 }) }) },
    responses: { ...resp(200, 'Room', roomExample), ...errors({ ...ROOM_ERRORS, 400: ['VALIDATION_ERROR', 'OPENINGS_EXCEED_WALL'], 404: ['OPENING_NOT_FOUND'] }) },
  });
  path(F, 'delete', '/api/v1/openings/{id}', {
    summary: 'Delete an opening',
    request: { params: idParam('Opening') },
    responses: { ...resp(200, 'Room', roomExample), ...errors({ ...ROOM_ERRORS, 404: ['OPENING_NOT_FOUND'] }) },
  });
}
