/** OpenAPI docs · Step 12: quotes / sales pipeline. */
import { z } from 'zod';
import { companySecurity, errors, jsonBody, registry, type NamedExample } from '../../core/openapi/registry.js';
import {
  addRevisionBody,
  createQuoteBody,
  insightsQuery,
  listQuotesQuery,
  lostBody,
  negotiationBody,
  pdfQuery,
  previewBody,
  quoteIdParams,
  sendQuoteBody,
  updateQuoteBody,
  wonBody,
} from './sales.schema.js';

const AUTH = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };
const data = z.object({ success: z.literal(true), data: z.unknown() });
const ex = (summary: string, value: unknown): NamedExample => ({ summary, value });
const resp = (status: 200 | 201, description: string, example?: unknown) => ({
  [status]: { description, content: { 'application/json': { schema: data, ...(example === undefined ? {} : { example: { success: true, data: example } }) } } },
});

const Q_ID = '0199a8c0-0000-7000-8000-00000000a001';
const CLIENT = { id: '0199a8c0-0000-7000-8000-000000000c01', name: 'Waqas Butt', phone: '+923335551122' };
const INPUTS = {
  plot: { unit: 'MARLA', size: 8, frontFt: 30, depthFt: 60 },
  coveredAreaSqft: 3300,
  floors: 2,
  mumty: true,
  basement: false,
  basementHeightFt: 10,
  structureType: 'FRAMED',
  contractType: 'GREY_OWNER_FINISHING',
};
const SUMMARY = {
  id: Q_ID,
  number: 'Q-2026-0004',
  status: 'NEGOTIATION',
  title: 'Bahria Orchard · 8 Marla',
  client: CLIENT,
  siteAddress: 'Plot 118, Block E, Bahria Orchard',
  city: 'Lahore',
  revision: 2,
  contractType: 'GREY_OWNER_FINISHING',
  coveredAreaSqft: 3300,
  validUntil: '2026-10-25',
  sentAt: '2026-10-10T11:00:00.000Z',
  lastActivityAt: '2026-10-14T12:00:00.000Z',
  daysSinceActivity: 2,
  followUp: false,
  wonAt: null,
  lostAt: null,
  expiredAt: null,
  lostReason: null,
  lostNote: null,
  wonProject: null,
  createdBy: { id: '0199a8c0-0000-7000-8000-000000000201', name: 'Bilal Ahmed' },
  createdAt: '2026-10-04T05:00:00.000Z',
  updatedAt: '2026-10-14T12:00:00.000Z',
  pricePaisa: '1310000000',
  perSqftPaisa: '396970',
};
const REVISION = {
  id: '0199a8c0-0000-7000-8000-00000000a102',
  revision: 2,
  note: 'Client asked for a better price — margin 15 %',
  createdAt: '2026-10-11T06:00:00.000Z',
  createdBy: { id: '0199a8c0-0000-7000-8000-000000000101', name: 'Khalid Malik' },
  inputs: { ...INPUTS, qualityCategoryId: '0199a8c0-0000-7000-8000-0000000007c1', supplyRules: [], paymentTemplateId: '0199a8c0-0000-7000-8000-0000000007d1', finalPricePaisa: null, marginPercent: 15, finishingAllowancePercent: 0 },
  rulebook: { region: 'PUNJAB_KP', version: 1 },
  basis: {
    plotAreaSqft: 1800,
    coveredAreaSqft: 3300,
    storeyAreaSqft: 1571.43,
    floors: [{ level: 'GROUND', name: 'Ground floor', areaSqft: 1571.43, rooms: 11, wetRooms: 4, ceilingHeightFt: 11 }],
    foundation: 'ISOLATED',
    assumptions: { quickMumtyPercent: 10, quickRoomFillPercent: 80 },
  },
  quantities: { cementBags: 2140.5, steelKg: 13920.4, bricks: 101200, blocks: 0, sandCft: 6120, crushCft: 3410, plasterSqft: 21400, floorTilesSqft: 2620, wallTilesSqft: 1480, paintGallons: 196 },
  sections: [{ section: 'CONCRETE', amountPaisa: '210000000' }],
  specifications: [{ categoryKey: 'CEMENT', label: 'Cement', suppliedBy: 'CONTRACTOR', qualityCategory: { id: '0199a8c0-0000-7000-8000-0000000007c1', name: 'Standard' }, materials: ['Cement OPC'] }],
  paymentStages: [{ label: 'Agreement & mobilisation', percent: 15, isRetention: false, amountPaisa: '196500000' }],
  paymentTemplate: { id: '0199a8c0-0000-7000-8000-0000000007d1', name: 'Residential standard' },
  warnings: [],
  costPaisa: '1139130000',
  directCostPaisa: '1035000000',
  overheadPaisa: '51750000',
  contingencyPaisa: '52380000',
  finishingAllowancePaisa: '0',
  costPerSqftPaisa: '345191',
  pricePaisa: '1310000000',
  computedPricePaisa: '1310000000',
  perSqftPaisa: '396970',
  priceOverridden: false,
  marginPercent: 15,
  finishingAllowancePercent: 0,
  marginPaisa: '170870000',
  marginOnPricePercent: 13.04,
};
const DETAIL = {
  ...SUMMARY,
  notes: null,
  latest: REVISION,
  revisions: [{ revision: 2, createdAt: REVISION.createdAt, createdBy: REVISION.createdBy, note: REVISION.note, pricePaisa: '1310000000', perSqftPaisa: '396970', costPaisa: '1139130000' }],
  activity: [{ action: 'quote.negotiation', at: '2026-10-14T12:00:00.000Z', by: REVISION.createdBy, system: false, details: { note: 'Wants the price under Rs 1.3 crore' } }],
};

const VIS =
  'Money follows the data-visibility permissions (keys are left out without them): the price (`pricePaisa`, `perSqftPaisa`, stage `amountPaisa`, `computedPricePaisa`, `inputs.finalPricePaisa`) needs fields.contract; the cost (`costPaisa`, section `amountPaisa`, overheads, contingency, finishing allowance, `costPerSqftPaisa`) fields.rates; the margin (`marginPaisa`, `marginOnPricePercent`, `marginPercent`, `finishingAllowancePercent`) fields.contract + fields.profit.';

export function registerSalesDocs(): void {
  const T = ['Sales'];
  const p = (method: 'get' | 'post' | 'patch' | 'delete', url: string, spec: Record<string, unknown>) =>
    registry.registerPath({ method, path: url, tags: T, security: companySecurity, ...spec } as Parameters<typeof registry.registerPath>[0]);
  const read403 = ['PERMISSION_DENIED', 'COMPANY_SUSPENDED'];
  const write403 = [...read403, 'ACCOUNT_READ_ONLY'];
  const inputErrors = ['VALIDATION_ERROR', 'INVALID_QUALITY_CATEGORY', 'INVALID_TEMPLATE', 'QUOTE_PRICE_MISSING'];

  p('get', '/api/v1/quotes/assumptions', {
    summary: 'Quick-mode assumptions',
    description: 'The area-based room assumptions a quote estimate uses instead of room-by-room input (rulebook-style: key, label in three languages, unit, value, description; all pending civil-engineer review). Permission sales.quote.view.',
    responses: { ...resp(200, 'Assumptions', [{ key: 'quickRoomSizeSqft', group: 'QUICK', label: { en: 'Typical room size', roman: 'Aam kamre ka size', ur: 'عام کمرے کا سائز' }, unit: 'sq ft', value: 160, description: '…', reviewStatus: 'PENDING_ENGINEER_REVIEW' }]), ...errors({ ...AUTH, 403: read403 }) },
  });
  p('post', '/api/v1/quotes/preview', {
    summary: 'Live quick estimate (nothing saved)',
    description: `Prices the inputs with the Step 11 engine in quick mode (synthetic rooms from the covered area, company rulebook, price list in the chosen quality category, sub-contract rates): cost by BoQ section, key quantities, price, rate per sq ft, margin and the payment schedule. The New Quote screen calls it on every change. Permission sales.quote.view. ${VIS}`,
    request: {
      body: jsonBody(previewBody, {
        grey: ex('8 marla, grey structure', { inputs: INPUTS }),
        full: ex('1 kanal full contract with a basement', { inputs: { plot: { unit: 'KANAL', size: 1, frontFt: 50, depthFt: 90 }, coveredAreaSqft: 7400, floors: 2, basement: true, structureType: 'FRAMED', contractType: 'FULL', marginPercent: 18, finishingAllowancePercent: 35 } }),
        bad: ex('❌ No covered area → 400', { inputs: { plot: { unit: 'MARLA', size: 5 }, floors: 2, structureType: 'FRAMED', contractType: 'FULL' } }),
      }),
    },
    responses: { ...resp(200, 'Preview', REVISION), ...errors({ ...AUTH, 400: inputErrors, 403: read403 }) },
  });
  p('get', '/api/v1/quotes/insights', {
    summary: 'Win / loss insights',
    description:
      'Quotes made in the last `months` months (this month included): totals by status, win rate (won ÷ won + lost + expired), quotes / wins / losses per month, loss reasons, and the follow-up list (SENT quotes with no activity for more than 5 days, any age). With fields.contract also the average rate per sq ft quoted (sent quotes) vs won, the won value and the open pipeline value. Permission sales.quote.view.',
    request: { query: insightsQuery },
    responses: {
      ...resp(200, 'Insights', {
        from: '2025-11-01',
        to: '2026-10-16',
        months: 12,
        totals: { quotes: 6, sent: 5, won: 1, lost: 1, expired: 1, open: 3 },
        winRate: 33.33,
        perMonth: [{ month: '2026-10', created: 3, won: 0, lost: 0 }],
        lossReasons: [{ reason: 'COMPETITOR_CHEAPER', count: 1 }],
        followUps: [SUMMARY],
        avgRateQuotedPaisa: '412000',
        avgRateWonPaisa: '468350',
        wonValuePaisa: '1850000000',
        pipelineValuePaisa: '3900000000',
      }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: read403 }),
    },
  });
  p('get', '/api/v1/quotes', {
    summary: 'Quote pipeline',
    description: `Quotes, latest activity first. Filters: status, client, search (number, title, client name or phone), followUp=true (SENT with no activity for more than 5 days). Permission sales.quote.view. ${VIS}`,
    request: { query: listQuotesQuery },
    responses: { ...resp(200, 'Quotes (meta: page, limit, total, totalPages)', [SUMMARY]), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: read403 }) },
  });
  p('post', '/api/v1/quotes', {
    summary: 'New quote (DRAFT, revision 1)',
    description:
      'Numbers the quote Q-YYYY-NNNN, prices revision 1 in quick mode and saves it as DRAFT. `validUntil` defaults to today + the company `quoteValidityDays` (15). `newClient` creates the client too (needs clients.client.create). No cost (rates missing) and no `finalPricePaisa` → 400 QUOTE_PRICE_MISSING. Permission sales.quote.create. Audited `quote.create`.',
    request: {
      body: jsonBody(createQuoteBody, {
        existing: ex('For an existing client', { clientId: CLIENT.id, title: 'Bahria Orchard · 8 Marla', siteAddress: 'Plot 118, Block E, Bahria Orchard', city: 'Lahore', inputs: INPUTS }),
        newClient: ex('With a new client', { newClient: { name: 'Nadia Hussain', phone: '0300-4447788' }, title: 'Wapda Town · 7 Marla', inputs: { ...INPUTS, plot: { unit: 'MARLA', size: 7 }, coveredAreaSqft: 2800, contractType: 'LABOR_ONLY' } }),
        negotiated: ex('Fixed price', { clientId: CLIENT.id, title: 'Bahria Orchard · 8 Marla', inputs: { ...INPUTS, finalPricePaisa: '1300000000' } }),
        bad: ex('❌ No client → 400', { title: 'Bahria Orchard · 8 Marla', inputs: INPUTS }),
      }),
    },
    responses: { ...resp(201, 'Created (detail)', DETAIL), ...errors({ ...AUTH, 400: [...inputErrors, 'INVALID_CLIENT'], 403: write403, 409: ['CLIENT_PHONE_TAKEN'] }) },
  });
  p('get', '/api/v1/quotes/{id}', {
    summary: 'Quote detail',
    description: `Summary + the latest revision in full, the revision list and the activity (audit rows of the quote, newest first). Permission sales.quote.view. ${VIS}`,
    request: { params: quoteIdParams },
    responses: { ...resp(200, 'Quote', DETAIL), ...errors({ ...AUTH, 403: read403, 404: ['QUOTE_NOT_FOUND'] }) },
  });
  p('patch', '/api/v1/quotes/{id}', {
    summary: 'Change the quote header',
    description: 'Title, client, site address, city, validity, notes. WON / LOST → 409 QUOTE_CLOSED. Permission sales.quote.edit. Audited `quote.update`.',
    request: { params: quoteIdParams, body: jsonBody(updateQuoteBody, { title: ex('Rename', { title: 'Bahria Orchard · 8 Marla (corner)' }), validity: ex('Extend validity', { validUntil: '2026-11-15' }), bad: ex('❌ Nothing to update → 400', {}) }) },
    responses: { ...resp(200, 'Updated (detail)', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'INVALID_CLIENT'], 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_CLOSED'] }) },
  });
  p('delete', '/api/v1/quotes/{id}', {
    summary: 'Delete a quote',
    description: 'Deletes a quote and its revisions (not a WON one → 409 QUOTE_WON). Permission sales.quote.manage. Audited `quote.delete`.',
    request: { params: quoteIdParams },
    responses: { ...resp(200, 'Deleted', { id: Q_ID, deleted: true }), ...errors({ ...AUTH, 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_WON'] }) },
  });
  p('get', '/api/v1/quotes/{id}/revisions', {
    summary: 'Every revision in full',
    description: `Newest first — the web compares two of them (inputs, sections, price). Permission sales.quote.view. ${VIS}`,
    request: { params: quoteIdParams },
    responses: { ...resp(200, 'Revisions', [REVISION]), ...errors({ ...AUTH, 403: read403, 404: ['QUOTE_NOT_FOUND'] }) },
  });
  p('post', '/api/v1/quotes/{id}/revisions', {
    summary: 'Add a revision (recompute)',
    description:
      'Prices the new inputs (today’s rulebook and rates) as revision n + 1; the quote shows its price from now on. An EXPIRED quote re-opens as DRAFT with a fresh validity. WON / LOST → 409 QUOTE_CLOSED. Permission sales.quote.edit. Audited `quote.revision`.',
    request: {
      params: quoteIdParams,
      body: jsonBody(addRevisionBody, {
        margin: ex('Lower margin', { inputs: { ...INPUTS, marginPercent: 15 }, note: 'Client asked for a better price' }),
        fixed: ex('Agreed price', { inputs: { ...INPUTS, finalPricePaisa: '1290000000' }, note: 'Final: Rs 1.29 crore' }),
      }),
    },
    responses: { ...resp(201, 'Revision added (detail)', DETAIL), ...errors({ ...AUTH, 400: inputErrors, 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_CLOSED'] }) },
  });
  p('post', '/api/v1/quotes/{id}/send', {
    summary: 'Send to the client (customer PDF + WhatsApp text)',
    description:
      'DRAFT / SENT / NEGOTIATION → SENT; validity = `validUntil` or today + quoteValidityDays. Makes the customer quotation PDF (letterhead, total, rate per sq ft, scope, material specifications, payment schedule, validity, terms — never costs or margins) and returns a signed link with a WhatsApp message and the client phone. EXPIRED → 409 QUOTE_STATUS_INVALID (add a revision first). Permission sales.quote.edit + fields.contract. Audited `quote.send`.',
    request: { params: quoteIdParams, body: jsonBody(sendQuoteBody, { roman: ex('Roman Urdu', { lang: 'roman' }), validity: ex('Valid 30 days', { validUntil: '2026-11-15', lang: 'en' }) }) },
    responses: {
      ...resp(200, 'Sent', { quote: { ...DETAIL, status: 'SENT' }, share: { attachmentId: '0199a8c0-0000-7000-8000-00000000f001', url: 'https://…', expiresAt: '2026-10-17T10:00:00.000Z', whatsappText: 'Assalam o Alaikum Waqas Butt sahib, …', clientPhone: CLIENT.phone } }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_CLOSED', 'QUOTE_STATUS_INVALID'], 503: ['PDF_UNAVAILABLE'] }),
    },
  });
  p('post', '/api/v1/quotes/{id}/negotiation', {
    summary: 'Record negotiation',
    description: 'SENT / NEGOTIATION → NEGOTIATION with what the client said (activity). Other statuses → 409 QUOTE_STATUS_INVALID / QUOTE_CLOSED. Permission sales.quote.edit. Audited `quote.negotiation`.',
    request: { params: quoteIdParams, body: jsonBody(negotiationBody, { note: ex('Client feedback', { note: 'Wants the price under Rs 1.3 crore' }), bad: ex('❌ Empty note → 400', { note: '' }) }) },
    responses: { ...resp(200, 'Updated (detail)', DETAIL), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_STATUS_INVALID', 'QUOTE_CLOSED'] }) },
  });
  p('post', '/api/v1/quotes/{id}/lost', {
    summary: 'Mark lost',
    description: 'Any open status → LOST with a reason (COMPETITOR_CHEAPER, CLIENT_POSTPONED, SELF_BUILD, OTHER — OTHER needs a note: 400 LOST_NOTE_REQUIRED). WON / LOST → 409 QUOTE_CLOSED. Permission sales.quote.edit. Audited `quote.lost`.',
    request: {
      params: quoteIdParams,
      body: jsonBody(lostBody, {
        cheaper: ex('Competitor cheaper', { reason: 'COMPETITOR_CHEAPER', note: 'Rs 300 per sq ft less' }),
        other: ex('Other reason', { reason: 'OTHER', note: 'Plot sold' }),
        bad: ex('❌ No reason → 400', { note: 'gone' }),
      }),
    },
    responses: { ...resp(200, 'Lost (detail)', { ...DETAIL, status: 'LOST', lostReason: 'COMPETITOR_CHEAPER' }), ...errors({ ...AUTH, 400: ['VALIDATION_ERROR', 'LOST_NOTE_REQUIRED'], 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_CLOSED'] }) },
  });
  p('post', '/api/v1/quotes/{id}/won', {
    summary: 'Mark won → pre-filled DRAFT project',
    description:
      'Makes a DRAFT project from the latest revision (wizard tabs 1–4 done: client, site, contract type + value = the quote price (labour-only: rate per sq ft), billing stages of the quote’s payment template, supply split with its quality category, plot, structure, floors, covered area, margin %) with `createdFromQuoteId`, and links it. Rooms are added in the wizard for the full estimate. Idempotent: a WON quote returns its project (`created: false`). LOST → 409 QUOTE_CLOSED. Permission sales.quote.approve + projects.project.create. Audited `quote.won` + `project.create`.',
    request: { params: quoteIdParams, body: jsonBody(wonBody, { plain: ex('Start today', {}), dates: ex('With dates', { startDate: '2026-11-01', endDate: '2027-10-31', name: 'Bahria Orchard · 8 Marla' }) }) },
    responses: {
      ...resp(200, 'Won', { quote: { ...DETAIL, status: 'WON' }, projectId: '0199a8c0-0000-7000-8000-000000000199', projectCode: 'MSB-2026-017', created: true }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: write403, 404: ['QUOTE_NOT_FOUND'], 409: ['QUOTE_CLOSED', 'PROJECT_CODE_TAKEN'] }),
    },
  });
  p('get', '/api/v1/quotes/{id}/pdf', {
    summary: 'Quote PDF (customer or internal)',
    description:
      '`variant=customer` (needs fields.contract): the quotation the client gets — never any cost, overhead, contingency or margin. `variant=internal` (needs fields.rates): cost by BoQ section, overheads, contingency, finishing allowance; the price with fields.contract and the margin with fields.contract + fields.profit. Returns a signed link + share text. Permission sales.quote.view.',
    request: { params: quoteIdParams, query: pdfQuery },
    responses: {
      ...resp(200, 'PDF link', { attachmentId: '0199a8c0-0000-7000-8000-00000000f001', url: 'https://…', expiresAt: '2026-10-17T10:00:00.000Z', whatsappText: '…', clientPhone: CLIENT.phone }),
      ...errors({ ...AUTH, 400: ['VALIDATION_ERROR'], 403: read403, 404: ['QUOTE_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }),
    },
  });
}
