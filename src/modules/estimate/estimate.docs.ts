import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import { contractFromEstimateBody } from './contractValue.js';
import { ESTIMATE_DEFAULTS, estimateSettingsBody } from './settings.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const idParam = z.object({ id: z.uuid().meta({ description: 'Project id' }) });
const PROJECT_ID = '0199a8c0-0000-7000-8000-000000000101';

/** Trimmed response for the 5-marla worked example (README → "How the estimate is calculated"). */
const EXAMPLE = {
  projectId: PROJECT_ID,
  projectCode: 'MSB-2026-020',
  projectName: 'Johar Town · 5 Marla',
  contractType: 'GREY_OWNER_FINISHING',
  generatedAt: '2026-10-15T09:00:00.000Z',
  settings: ESTIMATE_DEFAULTS,
  defaults: ESTIMATE_DEFAULTS,
  customised: [],
  basis: {
    structureType: 'LOAD_BEARING',
    structureTypeAssumed: false,
    coveredAreaSqft: 1125,
    coveredAreaSource: 'PROJECT',
    plotAreaSqft: 1125,
    aspectRatio: 1.8,
    foundationWallLengthFt: 230,
    foundationWallLengthAuto: true,
    foundationWallLengthSource: 'ESTIMATED',
    methods: { walls: 'ESTIMATED', roof: 'ESTIMATED' },
    floors: [
      {
        level: 'GROUND',
        name: 'Ground floor',
        heightFt: 10,
        rooms: 7,
        roomAreaSqft: 1000,
        footprintSqft: 1125,
        roomPerimeterFt: 320,
        externalWallFt: 140,
        internalWallFt: 90,
        doorsSqft: 147,
        windowsSqft: 86,
        wallsMethod: 'ESTIMATED',
        roofMethod: 'ESTIMATED',
        walls: null,
        roof: null,
      },
    ],
  },
  stages: [
    {
      stage: 'RCC',
      lines: [
        {
          id: 'RCC.GROUND.slab.volume',
          stage: 'RCC',
          floor: { level: 'GROUND', name: 'Ground floor' },
          element: 'slab',
          kind: 'WORK',
          measure: 'VOLUME',
          material: null,
          netQuantity: 468.75,
          wastagePercent: 0,
          quantity: 468.75,
          unit: 'cft',
          formula: { key: 'slab', params: { area: 1125, thicknessIn: 5 } },
          formulaText: 'Footprint 1125 sq ft × 5″',
          method: 'ESTIMATED',
          suppliedBy: null,
          ratePaisa: null,
          rateUnit: null,
          rateQuantity: null,
          amountPaisa: null,
          rateStatus: null,
        },
        {
          id: 'RCC.GROUND.slab.steel',
          stage: 'RCC',
          floor: { level: 'GROUND', name: 'Ground floor' },
          element: 'slab',
          kind: 'MATERIAL',
          measure: null,
          material: 'steel',
          netQuantity: 1040.63,
          wastagePercent: 5,
          quantity: 1092.66,
          unit: 'kg',
          formula: { key: 'steel', params: { volume: 468.75, percent: 1 } },
          formulaText: '468.75 cft × 1% × 222 kg per cft',
          method: 'ESTIMATED',
          suppliedBy: 'CONTRACTOR',
          ratePaisa: '28500000',
          rateUnit: 'ton',
          rateQuantity: 1.0927,
          amountPaisa: '31140810',
          rateStatus: 'OK',
        },
      ],
      totals: [
        { material: 'cement', quantity: 90.72 },
        { material: 'sand', quantity: 226.78 },
        { material: 'crush', quantity: 453.57 },
        { material: 'steel', quantity: 1144.23 },
      ],
      materialsPaisa: '55516675',
      ownerSuppliedPaisa: '0',
      missingRates: 0,
    },
  ],
  materials: [
    {
      material: 'cement',
      unit: 'bag',
      netQuantity: 275.29,
      quantity: 289.04,
      suppliedBy: 'CONTRACTOR',
      materialId: '0199a8c0-0000-7000-8000-0000000007a1',
      materialName: 'Cement OPC',
      qualityCategory: { id: '0199a8c0-0000-7000-8000-0000000000e2', name: 'A Standard' },
      ratePaisa: '145000',
      rateUnit: 'bag',
      rateQuantity: 289.04,
      amountPaisa: '41910800',
      rateStatus: 'OK',
      rateFallback: false,
    },
    {
      material: 'termite',
      unit: 'litre',
      netQuantity: 5.63,
      quantity: 5.91,
      suppliedBy: 'CONTRACTOR',
      materialId: null,
      materialName: null,
      qualityCategory: { id: '0199a8c0-0000-7000-8000-0000000000e2', name: 'A Standard' },
      ratePaisa: null,
      rateUnit: null,
      rateQuantity: null,
      amountPaisa: null,
      rateStatus: 'RATE_MISSING',
      rateFallback: false,
    },
  ],
  labour: {
    method: 'PIECE_RATES',
    lines: [
      { item: 'BRICK_MASONRY', quantity: 36999.28, unit: 'nos', ratePaisa: '900', amountPaisa: '33299352', rateStatus: 'OK' },
      { item: 'PLASTER', quantity: 6179.33, unit: 'sqft', ratePaisa: '2200', amountPaisa: '13594526', rateStatus: 'OK' },
      { item: 'SHUTTERING', quantity: 1228.25, unit: 'sqft', ratePaisa: '4500', amountPaisa: '5527125', rateStatus: 'OK' },
      { item: 'STEEL_FIXING', quantity: 1.0898, unit: 'ton', ratePaisa: '900000', amountPaisa: '980820', rateStatus: 'OK' },
    ],
    totalPaisa: '53401823',
  },
  cost: {
    materialsPaisa: '162550533',
    ownerSuppliedPaisa: '0',
    labourPaisa: '53401823',
    totalPaisa: '215952356',
    perSqftPaisa: '191958',
    contractTotalPaisa: '300000000',
    marginPaisa: '84047644',
    marginPercent: 28.02,
  },
  warnings: [
    {
      code: 'RATES_MISSING',
      message: 'No price-list rate for: waterproofing, termite — these lines are left out of the cost',
      materials: ['waterproofing', 'termite'],
    },
  ],
};

const DESCRIPTION = `Computed live from the project's plot, structure type, foundation (bunyaad), floors / rooms / openings, the rulebook (platform version of the company region → company values → the project's own settings) and the company price list — nothing is stored but the settings.

**BoQ preview** \`boq\` = exactly what POST /projects/{id}/estimates would save: 14 sections with lines per build stage (\`stageKey\`), trace, wastage, supplier, rates / amounts (fields.rates), direct cost, overheads, contingency, total, cost per sq ft, \`parameters\` (value + source per rulebook key), \`warnings\` (RATES_MISSING, LABOUR_RATES_MISSING, STEEL_NORM_DEVIATION, RCC_NORM_DEVIATION). The fields below (grey-structure stages, materials, labour, cost) are unchanged.

**Stages** FOUNDATION (excavation, PCC, RCC footing / raft / piles, brick or stone foundation walls to plinth, DPC + waterproofing compound or bitumen, termite), WALLS (brickwork per floor + roof parapet), RCC (roof slab per floor, beams + columns for an RCC frame, lintels, shuttering), PLASTER (room faces, ceilings, external faces, parapet). Each line: \`kind\` WORK (volume / area / shuttering) or MATERIAL, \`netQuantity\`, \`wastagePercent\`, \`quantity\` (to order), \`unit\`, \`formula\` { key, params } and \`formulaText\`.

**Detailed vs estimated** Every line has \`method\`: DETAILED when it comes from data the user entered — the floor's roof (\`Floor.roof\`: RCC slab steel from the actual bars grouped by size as \`steel10\` / \`steel12\` / \`steel16\` / \`steel20\` kg, beams / columns from their sizes and bars, T-iron garders \`tIron\`, bricks / \`roofTile\`, screed, earth, \`precastPlank\` / \`steelDeck\` + topping + mesh) or every room's four walls (\`Room.walls\`: brickwork per wall thickness — lines \`WALLS.<floor>.walls.t9\`, \`.t4_5\` … — shared walls once, party walls already built and open sides excluded, double walls both leaves; plaster faces by wall type; lintels at the wall's thickness; the foundation run from the ground-floor walls) — else ESTIMATED (the % / perimeter rules). \`basis.methods\` { walls, roof } = DETAILED / ESTIMATED / MIXED; \`basis.floors[]\` has \`wallsMethod\`, \`roofMethod\`, \`walls\` (by thickness, bricks) and \`roof\` (steel by size, bar runs, beam run, columns). Warnings for the new data carry \`floor\`: ROOF_TOO_THIN, ROOF_SPAN_NEEDS_BEAM, ROOF_MAIN_SPACING_WIDE, ROOF_DIST_SPACING_WIDE (tab 3), WALLS_PARTIAL, WALLS_UNPAIRED (tab 5).

**Costing** Each material is priced from the company price list in the project's quality category for its supply category (cement, bricks, steel, sand & bajri, waterproofing; the company default category otherwise), converted to the rate's unit (kg → ton, nos → thousand, cft → trolley, alt units). No rate → \`rateStatus: RATE_MISSING\`, left out of every total, warning RATES_MISSING. Steel by size is priced from Steel Grade-60 #3 / #4 / #5 / #6 (a company "Grade-40 #n" material first when a roof is G40); a size without a rate takes the general steel rate (\`rateFallback: true\`, warning STEEL_RATE_GENERIC). Owner-supplied categories are valued but kept out of the contractor cost (\`ownerSuppliedPaisa\`). Labour: covered area × \`labourRatePerSqftPaisa\` when set, else the SUBCONTRACT piece rates BRICK_MASONRY / PLASTER / SHUTTERING / STEEL_FIXING. \`cost.marginPercent\` = (contract total − estimated cost) ÷ contract total.

**Contract value from this estimate** \`contractSuggestion\` (needs fields.contract + fields.rates; null before the contract type is chosen): \`kind\` CONTRACT_VALUE (FULL / GREY) = cost × (1 + finishing %) × (1 + margin %) rounded to the nearest Rs 1,000 — the finishing allowance applies to FULL only (\`finishingApplies\`) because this estimate is grey structure; RATE_PER_SQFT (LABOR_ONLY, the owner buys the material) = estimated labour × (1 + margin %) ÷ covered sq ft rounded to Rs 5. \`marginPercent\` / \`finishingAllowancePercent\` come from the project override (\`marginSource\` / \`finishingSource\` PROJECT) or the company settings (COMPANY; \`companyMarginPercent\`, \`companyFinishingAllowancePercent\`). \`basisPaisa\` = the cost (labour) used, \`suggestedPaisa\` (null without a cost / covered area), \`currentPaisa\` = the value already on the project. Apply it with POST /projects/{id}/contract/from-estimate.

**Visibility** Rates, amounts and \`cost\` need fields.rates; \`contractTotalPaisa\` fields.contract; the margin fields.profit + fields.contract. Warnings: NO_FLOORS, NO_ROOMS, FOUNDATION_MISSING, STRUCTURE_TYPE_ASSUMED, COVERED_AREA_ESTIMATED, FOUNDATION_LENGTH_UNKNOWN, ROOMS_BELOW_COVERED, RATES_MISSING, LABOUR_RATES_MISSING, CONTRACT_VALUE_MISSING, CONTRACT_INCLUDES_FINISHING. A project with no rooms or foundation answers 200 with warnings.

Permission projects.estimate.view (THEKEDAR, Administrator, Project Manager, Accountant); out of scope → 404.`;

export function registerEstimateDocs(): void {
  const T = 'Estimate';
  registry.registerPath({
    method: 'get',
    path: '/api/v1/projects/{id}/estimate',
    tags: [T],
    security: companySecurity,
    summary: 'Grey-structure estimate (BoQ) with cost',
    description: DESCRIPTION,
    request: { params: idParam },
    responses: {
      200: { description: 'Estimate', content: { 'application/json': { schema: data, example: { success: true, data: EXAMPLE } } } },
      ...errors({ ...AUTH, 403: ['PERMISSION_DENIED', 'COMPANY_SUSPENDED'], 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/projects/{id}/contract/from-estimate',
    tags: [T],
    security: companySecurity,
    summary: 'Set the contract value from the estimate',
    description:
      'Sets the contract value (FULL / GREY: cost × (1 + finishing %) × (1 + margin %), nearest Rs 1,000) or, for LABOR_ONLY, the rate per sq ft (labour × (1 + margin %) ÷ covered sq ft, nearest Rs 5) from the live estimate — the same numbers as `contractSuggestion` of GET /estimate. ' +
      'Omitted percentages = the project override, else the company default (TenantSettings.defaultMarginPercent / defaultFinishingAllowancePercent). A percentage that differs from the company default is stored on the project (it sticks for the next suggestion); one equal to it clears the override. ' +
      'Contract type, billing model, supply rules and stages are unchanged; stage amounts are recomputed. A project that already has a value → 409 CONTRACT_VALUE_EXISTS `{ currentPaisa, suggestedPaisa }` unless `replace: true` (the user confirmed). ' +
      'No contract type yet → 400 CONTRACT_MISSING; no cost (no rooms / rates; labour-only: no labour or covered area) → 400 ESTIMATE_COST_MISSING. ' +
      'Needs projects.project.edit + fields.contract + fields.rates (403 PERMISSION_DENIED); project DRAFT or ACTIVE (409 PROJECT_LOCKED). ' +
      'Audited `project.contract_from_estimate` { costPaisa, marginPercent, marginSource, finishingAllowancePercent, valuePaisa, previousPaisa }. Returns the full project.',
    request: {
      params: idParam,
      body: jsonBody(contractFromEstimateBody, {
        defaults: ex('Company margin (first time)', {}),
        custom: ex('25 % margin, 30 % finishing allowance, overwrite the current value', { marginPercent: 25, finishingAllowancePercent: 30, replace: true }),
      }),
    },
    responses: {
      200: { description: 'Saved (full project)', content: { 'application/json': { schema: data } } },
      ...errors({
        ...AUTH,
        400: ['VALIDATION_ERROR', 'CONTRACT_MISSING', 'ESTIMATE_COST_MISSING'],
        403: ['PERMISSION_DENIED', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'],
        404: ['PROJECT_NOT_FOUND'],
        409: ['PROJECT_LOCKED', 'CONTRACT_VALUE_EXISTS'],
      }),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/v1/projects/{id}/estimate/settings',
    tags: [T],
    security: companySecurity,
    summary: 'Change the estimate assumptions',
    description:
      'Replaces the project\'s estimate settings: every field is optional — fields sent are kept, fields left out go back to the Pakistani default, `{}` resets everything. ' +
      'Only values that differ from the defaults are stored. Ranges are checked (400 VALIDATION_ERROR). Returns the recomputed estimate (same shape as GET). ' +
      'Permission projects.estimate.manage (THEKEDAR, Administrator, Project Manager); only while the project is DRAFT or ACTIVE (else 409 PROJECT_LOCKED). Audited `project.estimate_settings_update`.',
    request: {
      params: idParam,
      body: jsonBody(estimateSettingsBody, {
        sixInch: ex('6″ slab, 1:6 external plaster, 7 % wastage', { slabThicknessIn: 6, externalPlasterMix: '1:6', wastagePercent: 7 }),
        foundation: ex('Measured foundation wall length + labour per sq ft', { foundationWallLengthFt: 260, labourRatePerSqftPaisa: '45000' }),
        reset: ex('Reset to defaults', {}),
        bad: ex('❌ Slab 12″ → 400', { slabThicknessIn: 12 }),
      }),
    },
    responses: {
      200: { description: 'Recomputed estimate', content: { 'application/json': { schema: data, example: { success: true, data: { ...EXAMPLE, customised: ['slabThicknessIn'] } } } } },
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: ['PERMISSION_DENIED', 'COMPANY_SUSPENDED', 'ACCOUNT_READ_ONLY'], 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }),
    },
  });
}
