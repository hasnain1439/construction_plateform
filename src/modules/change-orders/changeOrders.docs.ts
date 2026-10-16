import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, KHALID, RAFAQAT, READ_403, WRITE_403, createdResp, ex, idParam, ok, path } from '../inventory/docs.shared.js';
import * as S from './changeOrders.schema.js';

const T = 'Change Orders';
const CO = '0199a8c0-0000-7000-8000-000000001501';
const LINE1 = '0199a8c0-0000-7000-8000-000000001502';
const LINE2 = '0199a8c0-0000-7000-8000-000000001503';
const SI = '0199a8c0-0000-7000-8000-000000001504';
const SNAG = '0199a8c0-0000-7000-8000-000000001505';
const PROOF = '0199a8c0-0000-7000-8000-000000001506';
const INVOICE = '0199a8c0-0000-7000-8000-000000001507';
const LABOUR = '0199a8c0-0000-7000-8000-000000001508';
const MILESTONE = '0199a8c0-0000-7000-8000-000000001509';
const SCOPE = 'Project scope: the owner sees every project, others need the permission on the project (outside → 404).';
const MONEY =
  'Money: cost side (line `ratePaisa` / `amountPaisa`, `markupPercent`, `costPaisa`, `markupPaisa`) only with fields.rates; owner price (`totalPaisa`, line `priceRatePaisa` / `priceAmountPaisa`) with fields.rates or fields.amounts; contract values with fields.contract. A Munshi never sees a change order.';

const line1 = {
  id: LINE1,
  sortOrder: 1,
  kind: 'MATERIAL',
  materialId: IDS.tiles,
  laborRateId: null,
  description: 'Floor tiles 2×2 (bathroom 2)',
  unit: 'sqft',
  quantity: 120,
  rateSource: 'ESTIMATE',
  ratePaisa: '25000',
  amountPaisa: '3000000',
  priceRatePaisa: '27500',
  priceAmountPaisa: '3300000',
};
const line2 = {
  id: LINE2,
  sortOrder: 2,
  kind: 'LABOUR',
  materialId: null,
  laborRateId: LABOUR,
  description: 'Tile fixing',
  unit: 'sqft',
  quantity: 120,
  rateSource: 'LABOUR_RATE',
  ratePaisa: '6000',
  amountPaisa: '720000',
  priceRatePaisa: '6600',
  priceAmountPaisa: '792000',
};
const changeOrder = {
  id: CO,
  projectId: IDS.dha,
  number: 1,
  code: 'CO-001',
  title: 'Extra bathroom tiles (2nd bathroom, full height)',
  description: 'Owner wants wall tiles up to the ceiling in bathroom 2',
  type: 'ADDITION',
  status: 'APPROVED',
  source: 'MANUAL',
  siteInstructionId: null,
  snagId: null,
  daysImpact: 3,
  affectedMilestones: [{ id: MILESTONE, key: 'FINISHING.TILES', name: 'Tiles', stageKey: 'FINISHING' }],
  proofType: 'WHATSAPP_SCREENSHOT',
  proofNote: null,
  proofCount: 1,
  lineCount: 2,
  billingMode: 'NEXT_STAGE',
  invoice: null,
  sentAt: '2026-10-10T07:00:00.000Z',
  approvedOn: '2026-10-11',
  approvedAt: '2026-10-11T09:30:00.000Z',
  approvedBy: KHALID,
  rejectedAt: null,
  rejectionReason: null,
  startedAt: null,
  completedAt: null,
  billedAt: null,
  createdBy: KHALID,
  createdAt: '2026-10-10T06:30:00.000Z',
  updatedAt: '2026-10-11T09:30:00.000Z',
  markupPercent: 10,
  costPaisa: '3720000',
  markupPaisa: '372000',
  totalPaisa: '4092000',
};
const file = { id: PROOF, fileName: 'whatsapp.jpg', mimeType: 'image/jpeg', sizeBytes: 182113, url: 'https://…/file?sig=…', thumbUrl: 'https://…/file?w=480&sig=…', expiresAt: '2026-10-16T10:10:00.000Z' };
const detail = { ...changeOrder, lines: [line1, line2], proofFiles: [file], siteInstruction: null, snag: null, project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' } };
const photo = { id: IDS.photo, mimeType: 'image/jpeg', url: 'https://…/file?sig=…', thumbUrl: 'https://…/file?w=320&sig=…' };
const instruction = {
  id: SI,
  projectId: IDS.dha,
  number: 4,
  code: 'SI-004',
  note: 'Owner wants a skylight above the stairs instead of the plain slab',
  photos: [photo],
  status: 'NEW',
  changeOrder: null,
  dismissReason: null,
  clientId: '0199a8c0-0000-7000-8000-00000000ab15',
  createdBy: RAFAQAT,
  createdAt: '2026-10-15T10:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  updatedAt: '2026-10-15T10:00:00.000Z',
};
const summary = {
  approvedCount: 1,
  daysImpact: 3,
  originalEndDate: '2027-02-28',
  revisedEndDate: '2027-03-04',
  approvedChangesPaisa: '4092000',
  originalContractPaisa: '18500000',
  revisedContractPaisa: '22592000',
  byStatus: { DRAFT: 1, SENT: 1, APPROVED: 1, REJECTED: 0, IN_PROGRESS: 0, COMPLETED: 0, BILLED: 0 },
  newSiteInstructions: 1,
  changeOrderSnags: [{ id: SNAG, code: 'SN-007', description: 'Bigger window in the lounge (owner)', status: 'OPEN', amountPaisa: '2500000' }],
  pendingPaisa: '1850000',
};
const coErr = (extra: Record<number, string[]> = {}) => errors({ ...AUTH, 403: WRITE_403, 404: ['CHANGE_ORDER_NOT_FOUND'], ...extra });
const STATUS = ['INVALID_CHANGE_ORDER_STATUS', 'PROJECT_LOCKED'];

const lineEx = [
  { kind: 'MATERIAL', materialId: IDS.tiles, description: 'Floor tiles 2×2 (bathroom 2)', quantity: 120 },
  { kind: 'LABOUR', laborRateId: LABOUR, description: 'Tile fixing', quantity: 120 },
];

export function registerChangeOrderDocs(): void {
  path(T, 'get', '/api/v1/projects/{id}/change-orders', {
    summary: 'Change orders of a project',
    description: `changeorder.view. ${SCOPE} Newest first (filter \`status\`). \`summary\`: approved count, days, original / revised end date (contract end + approved CO days, company working days), approved changes and revised contract, counts by status, NEW site instructions, CHANGE_ORDER snags not converted yet. ${MONEY}`,
    request: { params: idParam('Project'), query: S.changeOrdersQuery },
    responses: { ...ok('Change orders', { items: [changeOrder], summary }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/change-orders', {
    summary: 'New change order (mini BoQ)',
    description:
      `changeorder.create. ${SCOPE} ACTIVE / CLOSEOUT projects. Lines: MATERIAL (rate from the APPROVED estimate, else the price list), LABOUR (company labour rate, or description + unit + rate), OTHER (description + unit + rate). An explicit \`ratePaisa\` / \`markupPercent\` needs fields.rates. ` +
      'Price = rate × (1 + markup %); a DEDUCTION total is negative. VERBAL proof needs a note. Creates a DRAFT (CO-001, CO-002 … per project).',
    request: {
      params: idParam('Project'),
      body: jsonBody(S.createChangeOrderBody, {
        tiles: ex('Extra tiles with fixing, 10 % markup', { title: 'Extra bathroom tiles (2nd bathroom, full height)', type: 'ADDITION', markupPercent: 10, daysImpact: 3, affectedMilestoneIds: [MILESTONE], lines: lineEx }),
        deduction: ex('Owner drops the boundary wall plaster', {
          title: 'Boundary wall plaster left out',
          type: 'DEDUCTION',
          lines: [{ kind: 'OTHER', description: 'Boundary wall plaster (both sides)', unit: 'sqft', quantity: 800, ratePaisa: '4500' }],
          proofType: 'VERBAL',
          proofNote: 'Owner told Bilal on site on 12 Oct, his brother was present',
        }),
      }),
    },
    responses: {
      ...createdResp('Change order (DRAFT)', { ...detail, status: 'DRAFT', approvedOn: null, approvedAt: null, approvedBy: null, billingMode: null }),
      ...errors({
        400: ['VALIDATION_ERROR', 'RATE_MISSING', 'INVALID_MATERIAL', 'INVALID_LABOR_RATE', 'LINE_INCOMPLETE', 'INVALID_MILESTONE', 'INVALID_ATTACHMENT', 'PROOF_NOTE_REQUIRED'],
        ...AUTH,
        403: [...WRITE_403, 'PERMISSION_DENIED'],
        404: ['PROJECT_NOT_FOUND'],
        409: ['PROJECT_LOCKED'],
      }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/change-orders/rates', {
    summary: 'Builder pick lists (materials, labour rates, milestones)',
    description: `changeorder.create. Every visible material with the rate a change order would use (APPROVED estimate → price list, \`rateSource\`), active labour rates and the schedule milestones. Rates only with fields.rates.`,
    request: { params: idParam('Project') },
    responses: {
      ...ok('Pick lists', {
        estimate: { id: '0199a8c0-0000-7000-8000-000000001110', revision: 1 },
        materials: [{ materialId: IDS.tiles, name: 'Floor tiles 2×2', unit: 'sqft', rateSource: 'ESTIMATE', ratePaisa: '25000' }],
        labour: [{ laborRateId: LABOUR, kind: 'SUBCONTRACT', label: 'Tile fixing', unit: 'sqft', ratePaisa: '6000' }],
        milestones: [{ id: MILESTONE, key: 'FINISHING.TILES', name: 'Tiles', stageKey: 'FINISHING', status: 'PLANNED' }],
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/change-orders/{id}', {
    summary: 'One change order',
    description: `changeorder.view. Lines, proof files (signed links), the site instruction / snag it came from, the live invoice carrying it. ${MONEY}`,
    request: { params: idParam('Change order') },
    responses: { ...ok('Change order', detail), ...errors({ ...AUTH, 403: READ_403, 404: ['CHANGE_ORDER_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/change-orders/{id}', {
    summary: 'Edit a draft',
    description: 'changeorder.edit. DRAFT only (reopen a SENT / REJECTED one first). `lines` replaces every line; a new markup re-prices the lines.',
    request: { params: idParam('Change order'), body: jsonBody(S.updateChangeOrderBody, { more: ex('More days, proof screenshot', { daysImpact: 4, proofType: 'WHATSAPP_SCREENSHOT', proofAttachmentIds: [PROOF] }) }) },
    responses: { ...ok('Change order', detail), ...coErr({ 400: ['VALIDATION_ERROR', 'RATE_MISSING', 'INVALID_MATERIAL', 'INVALID_MILESTONE', 'INVALID_ATTACHMENT', 'PROOF_NOTE_REQUIRED'], 409: ['CHANGE_ORDER_LOCKED', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'delete', '/api/v1/change-orders/{id}', {
    summary: 'Delete a draft',
    description: 'changeorder.edit. DRAFT only; a site instruction it came from goes back to NEW.',
    request: { params: idParam('Change order') },
    responses: { ...ok('Deleted', { id: CO, deleted: true }), ...coErr({ 409: ['CHANGE_ORDER_LOCKED', 'PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/send', {
    summary: 'Mark sent to the owner',
    description: 'changeorder.edit. DRAFT → SENT (share the slip PDF / WhatsApp text from `GET /change-orders/{id}/pdf`).',
    request: { params: idParam('Change order') },
    responses: { ...ok('Change order', { ...detail, status: 'SENT' }), ...coErr({ 400: ['EMPTY_CHANGE_ORDER'], 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/approve', {
    summary: 'Record the owner’s approval',
    description:
      'changeorder.approve. DRAFT / SENT → APPROVED with proof: WHATSAPP_SCREENSHOT / SIGNED_SLIP need a proof file, VERBAL a note. The revised contract (receivables, P&L) and the revised end date (Schedule.changeOrderDays, delay breakdown OWNER category) include it from now on. `billingMode` can be chosen now or when billing.',
    request: {
      params: idParam('Change order'),
      body: jsonBody(S.approveBody, {
        whatsapp: ex('Owner replied OK on WhatsApp', { approvedOn: '2026-10-11', proofType: 'WHATSAPP_SCREENSHOT', proofAttachmentIds: [PROOF], billingMode: 'NEXT_STAGE' }),
        verbal: ex('Verbal on site', { proofType: 'VERBAL', proofNote: 'Owner agreed on site with Bilal on 11 Oct (his son present)' }),
      }),
    },
    responses: { ...ok('Change order (APPROVED)', detail), ...coErr({ 400: ['VALIDATION_ERROR', 'PROOF_REQUIRED', 'PROOF_NOTE_REQUIRED', 'PROOF_FILE_REQUIRED', 'EMPTY_CHANGE_ORDER', 'FUTURE_DATE', 'INVALID_ATTACHMENT'], 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/reject', {
    summary: 'Owner said no',
    description: 'changeorder.approve. DRAFT / SENT → REJECTED with a reason (reopen to revise it).',
    request: { params: idParam('Change order'), body: jsonBody(S.rejectBody, { price: ex('Too expensive', { reason: 'Owner says the price is too high, will buy the tiles himself' }) }) },
    responses: { ...ok('Change order (REJECTED)', { ...detail, status: 'REJECTED' }), ...coErr({ 400: ['VALIDATION_ERROR'], 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/reopen', {
    summary: 'Back to draft',
    description: 'changeorder.edit. SENT / REJECTED → DRAFT.',
    request: { params: idParam('Change order') },
    responses: { ...ok('Change order (DRAFT)', { ...detail, status: 'DRAFT' }), ...coErr({ 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/start', {
    summary: 'Work started',
    description: 'changeorder.edit. APPROVED → IN_PROGRESS.',
    request: { params: idParam('Change order') },
    responses: { ...ok('Change order (IN_PROGRESS)', { ...detail, status: 'IN_PROGRESS' }), ...coErr({ 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/complete', {
    summary: 'Work completed',
    description: 'changeorder.edit. APPROVED / IN_PROGRESS → COMPLETED.',
    request: { params: idParam('Change order') },
    responses: { ...ok('Change order (COMPLETED)', { ...detail, status: 'COMPLETED' }), ...coErr({ 409: STATUS }) },
  });
  path(T, 'post', '/api/v1/change-orders/{id}/bill', {
    summary: 'Billing link (next stage invoice or VARIATION invoice)',
    description:
      'changeorder.manage + billing.invoice.create. APPROVED / IN_PROGRESS / COMPLETED. **VARIATION**: a DRAFT invoice of its own (type VARIATION, one line per CO line at the owner price; ADDITION only). **NEXT_STAGE**: one line "CO-001 · title" on the project’s DRAFT STAGE / RUNNING_BILL invoice if there is one, else on the next one created (`invoice: null` until then). Issuing the invoice marks the change order BILLED; cancelling it reverts that.',
    request: { params: idParam('Change order'), body: jsonBody(S.billBody, { stage: ex('With the next stage', { mode: 'NEXT_STAGE' }), own: ex('Own invoice', { mode: 'VARIATION', notes: 'Extra bathroom tiles — CO-001' }) }) },
    responses: {
      ...ok('Change order + invoice', { changeOrder: { ...detail, billingMode: 'VARIATION', invoice: { id: INVOICE, number: null, type: 'VARIATION', status: 'DRAFT' } }, invoice: { id: INVOICE, number: null, type: 'VARIATION', status: 'DRAFT' } }),
      ...coErr({ 400: ['VALIDATION_ERROR', 'DEDUCTION_NEEDS_STAGE', 'EMPTY_CHANGE_ORDER'], 409: ['INVALID_CHANGE_ORDER_STATUS', 'CHANGE_ORDER_ALREADY_BILLED', 'PROJECT_IS_DRAFT'] }),
    },
  });
  path(T, 'get', '/api/v1/change-orders/{id}/pdf', {
    summary: 'Change order slip PDF (owner) + WhatsApp text',
    description:
      'changeorder.view + fields.rates or fields.amounts. Letterhead, project, CO code / title / details, items at the owner price (no cost or markup), total (minus for a deduction), days impact, approval and signature lines. `?lang=en|roman|ur` (Urdu right-to-left). Signed link (10 min) + WhatsApp text + the owner’s phone.',
    request: { params: idParam('Change order'), query: S.pdfQuery },
    responses: {
      ...ok('Slip', { attachmentId: PROOF, url: 'https://…/file?sig=…', expiresAt: '2026-10-16T10:10:00.000Z', whatsappText: 'Assalam o Alaikum Ahmed Raza sahib, DHA Phase 6 · 10 Marla ka tabdeeli order CO-001: …', clientPhone: '+923001112233' }),
      ...errors({ ...AUTH, 403: [...READ_403, 'PERMISSION_DENIED'], 404: ['CHANGE_ORDER_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }),
    },
  });

  // ─── Site instructions ────────────────────────────────────────────────────
  path(T, 'get', '/api/v1/projects/{id}/site-instructions', {
    summary: 'Site instructions of a project',
    description: `changeorder.instruction.view (all) or changeorder.instruction.create (own only). ${SCOPE} Newest first. No money.`,
    request: { params: idParam('Project'), query: S.siteInstructionsQuery },
    responses: { ...ok('Site instructions', { items: [instruction], summary: { new: 1, converted: 2, dismissed: 0 } }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/site-instructions', {
    summary: 'Record a site instruction (Munshi)',
    description:
      'changeorder.instruction.create. ACTIVE / CLOSEOUT projects. What the owner asked for on site: note + SITE_PHOTO photos. A repeated `clientId` returns the saved row (200). The owner and the project PMs get a SITE_INSTRUCTION_CREATED notification. Also pushed offline as `SITE_INSTRUCTION_CREATE`.',
    request: {
      params: idParam('Project'),
      body: jsonBody(S.createSiteInstructionBody, {
        site: ex('From the phone', { note: 'Owner wants a skylight above the stairs instead of the plain slab', photoIds: [IDS.photo], clientId: '0199a8c0-0000-7000-8000-00000000ab15' }),
      }),
    },
    responses: {
      ...createdResp('Created (200 when the clientId was already saved)', instruction),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }),
    },
  });
  path(T, 'get', '/api/v1/site-instructions/{id}', {
    summary: 'One site instruction',
    description: 'changeorder.instruction.view, or changeorder.instruction.create for own ones.',
    request: { params: idParam('Site instruction') },
    responses: { ...ok('Site instruction', instruction), ...errors({ ...AUTH, 403: READ_403, 404: ['SITE_INSTRUCTION_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/site-instructions/{id}/convert', {
    summary: 'Turn into a change order draft',
    description: 'changeorder.create. NEW → CONVERTED; the CO draft (source SITE_INSTRUCTION) gets the note as title / details unless given; every create field is optional.',
    request: {
      params: idParam('Site instruction'),
      body: jsonBody(S.convertBody, { priced: ex('With a price', { title: 'Skylight above the stairs', lines: [{ kind: 'OTHER', description: 'Skylight 4×4 ft with toughened glass', unit: 'job', quantity: 1, ratePaisa: '18500000' }], daysImpact: 2 }), plain: ex('Price later', {}) }),
    },
    responses: {
      ...createdResp('Change order draft', { ...detail, status: 'DRAFT', source: 'SITE_INSTRUCTION', siteInstructionId: SI }),
      ...errors({ 400: ['VALIDATION_ERROR', 'RATE_MISSING', 'LINE_INCOMPLETE'], ...AUTH, 403: WRITE_403, 404: ['SITE_INSTRUCTION_NOT_FOUND'], 409: ['SITE_INSTRUCTION_NOT_NEW', 'PROJECT_LOCKED'] }),
    },
  });
  path(T, 'post', '/api/v1/site-instructions/{id}/dismiss', {
    summary: 'Dismiss',
    description: 'changeorder.create. NEW → DISMISSED with a reason.',
    request: { params: idParam('Site instruction'), body: jsonBody(S.dismissBody, { noCharge: ex('No charge', { reason: 'Small change, done free of cost' }) }) },
    responses: { ...ok('Site instruction', { ...instruction, status: 'DISMISSED', dismissReason: 'Small change, done free of cost' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['SITE_INSTRUCTION_NOT_FOUND'], 409: ['SITE_INSTRUCTION_NOT_NEW'] }) },
  });
  path(T, 'post', '/api/v1/snags/{id}/change-order', {
    summary: 'Snag → change order draft',
    description: 'changeorder.create. Only a snag whose cost attribution is CHANGE_ORDER (`PUT /snags/{id}/cost`), once. Default title "SN-007: description" and one OTHER line: quantity 1 × the snag amount (when set).',
    request: { params: idParam('Snag'), body: jsonBody(S.convertBody, { defaults: ex('Use the snag amount', {}), titled: ex('Own title', { title: 'Bigger lounge window (owner request)', daysImpact: 1 }) }) },
    responses: {
      ...createdResp('Change order draft', { ...detail, status: 'DRAFT', source: 'SNAG', snagId: SNAG }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['SNAG_NOT_FOUND'], 409: ['SNAG_NOT_CHANGE_ORDER', 'SNAG_ALREADY_CONVERTED', 'PROJECT_LOCKED'] }),
    },
  });
}
