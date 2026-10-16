import { z } from 'zod';
import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, KHALID, RAFAQAT, READ_403, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import * as S from './closeout.schema.js';

const T = 'Closeout';
const DRAWING = '0199a8c0-0000-7000-8000-000000001701';
const REV0 = '0199a8c0-0000-7000-8000-000000001702';
const REV1 = '0199a8c0-0000-7000-8000-000000001703';
const FILE0 = '0199a8c0-0000-7000-8000-000000001704';
const FILE1 = '0199a8c0-0000-7000-8000-000000001705';
const SNAG = '0199a8c0-0000-7000-8000-000000001711';
const ROOM = '0199a8c0-0000-7000-8000-000000001712';
const WORKER = '0199a8c0-0000-7000-8000-000000001713';
const SUB = '0199a8c0-0000-7000-8000-000000001714';
const ASSIGNMENT = '0199a8c0-0000-7000-8000-000000001715';
const SIGNATURE = '0199a8c0-0000-7000-8000-000000001716';
const SCOPE = 'Project scope: the owner sees every project, others need the permission on the project (outside → 404).';
const AMOUNTS = 'Money (`amountPaisa`, retention amounts) only with fields.amounts — a Munshi never gets it.';

const file = (id: string, name: string) => ({
  id,
  fileName: name,
  mimeType: 'application/pdf',
  sizeBytes: 482113,
  url: `https://api.example.com/api/v1/attachments/${id}/file?tid=…&exp=…&sig=…`,
  thumbUrl: null,
  expiresAt: '2026-10-16T10:10:00.000Z',
});
const rev = (id: string, no: number, latest: boolean, fileId: string) => ({
  id,
  drawingId: DRAWING,
  revisionNo: no,
  isLatest: latest,
  approvedAt: no === 0 ? '2026-03-02' : '2026-06-18',
  notes: no === 0 ? 'Society approved set' : 'Kitchen window moved 2 ft east',
  file: file(fileId, `A-101 R${no}.pdf`),
  uploadedBy: KHALID,
  createdAt: no === 0 ? '2026-03-02T07:00:00.000Z' : '2026-06-18T09:30:00.000Z',
});
const drawing = {
  id: DRAWING,
  projectId: IDS.dha,
  folder: 'ARCHITECTURAL',
  title: 'Ground floor plan',
  number: 'A-101',
  milestoneId: null,
  notes: null,
  revisionCount: 2,
  latest: rev(REV1, 1, true, FILE1),
  createdAt: '2026-03-02T07:00:00.000Z',
  updatedAt: '2026-06-18T09:30:00.000Z',
};
const drawingDetail = { ...drawing, revisions: [rev(REV1, 1, true, FILE1), rev(REV0, 0, false, FILE0)] };
const photo = { id: IDS.photo, mimeType: 'image/jpeg', url: 'https://…/file?sig=…', thumbUrl: 'https://…/file?w=320&sig=…' };
const snag = {
  id: SNAG,
  projectId: IDS.dha,
  number: 7,
  code: 'SN-007',
  roomId: ROOM,
  room: { id: ROOM, name: 'Master bedroom', floor: 'First floor' },
  location: 'East wall near the window',
  description: 'Hairline crack in plaster above the window lintel',
  status: 'FIXED',
  targetDate: '2026-10-20',
  overdue: false,
  inDefectPeriod: false,
  assignee: { type: 'SUBCONTRACTOR', id: SUB, name: 'Sharif Plaster Works' },
  beforePhotos: [photo],
  afterPhotos: [photo],
  fixNote: 'Crack opened, filled and re-plastered',
  fixedAt: '2026-10-14T11:00:00.000Z',
  fixedBy: RAFAQAT,
  verifiedAt: null,
  verifiedBy: null,
  reopenCount: 0,
  lastReopenReason: null,
  cost: { attribution: 'SUBCONTRACTOR_DEDUCTION', amountPaisa: '450000', note: 'Poor curing by the plaster team', subcontractAssignmentId: ASSIGNMENT, postedTo: 'SUBCONTRACTOR_ACCOUNT', postedAt: '2026-10-14T12:00:00.000Z' },
  clientId: null,
  createdBy: RAFAQAT,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-14T12:00:00.000Z',
};
const items = S.HANDOVER_ITEM_KEYS.map((key, i) => ({ key, done: i < 4, note: key === 'KEYS' ? '3 sets (main gate, front door, store)' : null, attachments: [], doneAt: i < 4 ? '2026-10-12T10:00:00.000Z' : null, doneBy: i < 4 ? KHALID : null }));
const handover = {
  projectId: IDS.dha,
  projectStatus: 'CLOSEOUT',
  items,
  signOff: null,
  handedOverAt: null,
  defectPeriodMonths: 6,
  retentionDueDate: null,
  openSnags: 3,
  canComplete: false,
  blockers: ['ITEMS_PENDING', 'SIGN_OFF_MISSING'],
  certificate: null,
};
const retention = {
  projectId: IDS.dha,
  projectStatus: 'HANDED_OVER',
  retentionPercent: 5,
  defectPeriodMonths: 6,
  handedOverAt: '2026-04-15',
  retentionDueDate: '2026-10-15',
  daysToDue: -1,
  reminder: { daysBefore: 14, reminderSentAt: '2026-10-01T21:45:00.000Z', dueNotifiedAt: null },
  client: { hasRetentionStage: true, stageLabel: 'Retention (after defect period)', amountPaisa: '21000000', invoice: null, canInvoice: true },
  subcontractors: [
    { assignmentId: ASSIGNMENT, subcontractorId: SUB, name: 'Sharif Plaster Works', trade: 'PLASTER', scope: 'Internal plaster', retentionPercent: 5, retentionHeldPaisa: '1525000', retentionReleasedPaisa: '0', releaseDate: '2026-10-15', releasable: true },
  ],
  totals: { clientHeldPaisa: '21000000', subcontractorHeldPaisa: '1525000' },
  defectSnags: { total: 2, open: 1 },
};
const itemParams = z.object({ id: z.uuid().meta({ description: 'Project id' }), key: S.handoverItemKeySchema });

export function registerCloseoutDocs(): void {
  // ─── Drawings ─────────────────────────────────────────────────────────────
  path(T, 'get', '/api/v1/projects/{id}/drawings', {
    summary: 'Drawings of a project',
    description: `closeout.drawing.view. ${SCOPE} Each drawing with its latest revision (signed file link, 10 min) and counts per folder (ARCHITECTURAL, STRUCTURAL, MEP, SOCIETY_APPROVED, OTHER).`,
    request: { params: idParam('Project'), query: S.drawingsQuery },
    responses: { ...ok('Drawings', { items: [drawing], folders: [{ folder: 'ARCHITECTURAL', count: 1 }] }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/drawings', {
    summary: 'Add a drawing with its first revision',
    description: `closeout.drawing.manage. ${SCOPE} Upload the file first (\`POST /attachments\`, kind DOCUMENT — PDF or image). The first revision is R0 and latest. ACTIVE / CLOSEOUT / HANDED_OVER projects only.`,
    request: {
      params: idParam('Project'),
      body: jsonBody(S.createDrawingBody, {
        plan: ex('Ground floor plan', { folder: 'ARCHITECTURAL', title: 'Ground floor plan', number: 'A-101', revision: { attachmentId: FILE0, approvedAt: '2026-03-02', notes: 'Society approved set' } }),
      }),
    },
    responses: { ...createdResp('Created', { ...drawing, revisionCount: 1, latest: rev(REV0, 0, true, FILE0), revisions: [rev(REV0, 0, true, FILE0)] }), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'get', '/api/v1/drawings/{id}', {
    summary: 'A drawing with every revision',
    description: `closeout.drawing.view. Newest revision first; superseded revisions stay (\`isLatest: false\`).`,
    request: { params: idParam('Drawing') },
    responses: { ...ok('Drawing', drawingDetail), ...errors({ ...AUTH, 403: READ_403, 404: ['DRAWING_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/drawings/{id}', {
    summary: 'Change folder / title / number / milestone / notes',
    description: 'closeout.drawing.manage. `null` clears number, milestone or notes.',
    request: { params: idParam('Drawing'), body: jsonBody(S.updateDrawingBody, { rename: ex('Rename', { title: 'Ground floor plan (revised)', number: 'A-101' }) }) },
    responses: { ...ok('Drawing', drawingDetail), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['DRAWING_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'delete', '/api/v1/drawings/{id}', {
    summary: 'Delete a drawing',
    description: 'closeout.drawing.manage. The drawing and its revisions are removed; the uploaded files stay as attachments. Audited with the revision list.',
    request: { params: idParam('Drawing') },
    responses: { ...ok('Deleted', { id: DRAWING, deleted: true }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['DRAWING_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/drawings/{id}/revisions', {
    summary: 'Upload a new revision',
    description: 'closeout.drawing.manage. Revision number = last + 1; it becomes the latest and the previous latest is superseded (still readable).',
    request: { params: idParam('Drawing'), body: jsonBody(S.addRevisionBody, { r1: ex('Revision 1', { attachmentId: FILE1, approvedAt: '2026-06-18', notes: 'Kitchen window moved 2 ft east' }) }) },
    responses: { ...createdResp('Drawing with its revisions', drawingDetail), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['DRAWING_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'patch', '/api/v1/drawing-revisions/{id}', {
    summary: 'Set a revision’s approval date / notes',
    description: 'closeout.drawing.manage. `approvedAt: null` clears the approval.',
    request: { params: idParam('Revision'), body: jsonBody(S.updateRevisionBody, { approve: ex('Approved', { approvedAt: '2026-06-20' }) }) },
    responses: { ...ok('Drawing with its revisions', drawingDetail), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: WRITE_403, 404: ['REVISION_NOT_FOUND'], 409: ['PROJECT_LOCKED'] }) },
  });

  // ─── Snags ────────────────────────────────────────────────────────────────
  const snagErr = (extra: Record<number, string[]> = {}) => errors({ ...AUTH, 403: WRITE_403, 404: ['SNAG_NOT_FOUND'], ...extra });
  path(T, 'get', '/api/v1/projects/{id}/snags', {
    summary: 'Snag list of a project',
    description: `closeout.snag.view. ${SCOPE} Newest first, filters status / assignee / room / defect period / overdue (OPEN past the target date) / text. \`summary\` counts every snag of the project. ${AMOUNTS}`,
    request: { params: idParam('Project'), query: S.snagsQuery },
    responses: {
      ...ok('Snags', { items: [snag], summary: { open: 3, fixed: 1, verified: 2, overdue: 1, defectPeriodOpen: 0, reworkPaisa: '1200000', deductionPaisa: '450000', changeOrderPaisa: '0' } }, page(6)),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'post', '/api/v1/projects/{id}/snags', {
    summary: 'Log a snag',
    description:
      `closeout.snag.create (Munshi too). ${SCOPE} Room or location required; photos are SITE_PHOTO attachments; assign a worker OR a sub-contractor. ACTIVE / CLOSEOUT / HANDED_OVER projects — after handover the snag is a defect-period snag, refused after the retention due date (\`409 DEFECT_PERIOD_ENDED\`). ` +
      'A repeated `clientId` returns the saved snag (200). Also pushed offline as `SNAG_CREATE`.',
    request: {
      params: idParam('Project'),
      body: jsonBody(S.createSnagBody, {
        site: ex('From the site', { roomId: ROOM, location: 'East wall near the window', description: 'Hairline crack in plaster above the window lintel', beforePhotoIds: [IDS.photo], subcontractorId: SUB, targetDate: '2026-10-20', clientId: '0199a8c0-0000-7000-8000-00000000ab17' }),
        noRoom: ex('Without a room', { location: 'Boundary wall, back lane', description: 'Coping stone loose', workerId: WORKER }),
      }),
    },
    responses: {
      ...createdResp('Created (200 when the clientId was already saved)', { ...snag, status: 'OPEN', afterPhotos: [], fixNote: null, fixedAt: null, fixedBy: null }),
      ...errors({ 400: ['VALIDATION_ERROR', 'LOCATION_REQUIRED', 'INVALID_ATTACHMENT', 'INVALID_ROOM', 'INVALID_ASSIGNEE'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['PROJECT_LOCKED', 'DEFECT_PERIOD_ENDED'] }),
    },
  });
  path(T, 'get', '/api/v1/snags/{id}', {
    summary: 'One snag',
    description: `closeout.snag.view. ${AMOUNTS}`,
    request: { params: idParam('Snag') },
    responses: { ...ok('Snag', snag), ...errors({ ...AUTH, 403: READ_403, 404: ['SNAG_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/snags/{id}', {
    summary: 'Edit / assign a snag',
    description: 'closeout.snag.manage. Setting a worker clears the sub-contractor and the other way round; `null` clears. Not for VERIFIED snags (reopen first).',
    request: { params: idParam('Snag'), body: jsonBody(S.updateSnagBody, { assign: ex('Assign to a worker', { workerId: WORKER, targetDate: '2026-10-22' }) }) },
    responses: { ...ok('Snag', snag), ...snagErr({ 400: ['VALIDATION_ERROR', 'LOCATION_REQUIRED', 'INVALID_ATTACHMENT', 'INVALID_ROOM', 'INVALID_ASSIGNEE'], 409: ['PROJECT_LOCKED', 'SNAG_VERIFIED'] }) },
  });
  path(T, 'delete', '/api/v1/snags/{id}', {
    summary: 'Delete a snag',
    description: 'closeout.snag.manage. Only an OPEN snag without a cost attribution.',
    request: { params: idParam('Snag') },
    responses: { ...ok('Deleted', { id: SNAG, deleted: true }), ...snagErr({ 409: ['PROJECT_LOCKED', 'SNAG_NOT_DELETABLE'] }) },
  });
  path(T, 'post', '/api/v1/snags/{id}/fix', {
    summary: 'Mark fixed (after photos)',
    description: 'closeout.snag.create (site). OPEN → FIXED. Also pushed offline as `SNAG_FIX`.',
    request: { params: idParam('Snag'), body: jsonBody(S.fixSnagBody, { fixed: ex('Fixed', { afterPhotoIds: [IDS.photo], note: 'Crack opened, filled and re-plastered' }) }) },
    responses: { ...ok('Snag', snag), ...snagErr({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], 409: ['PROJECT_LOCKED', 'INVALID_SNAG_STATUS'] }) },
  });
  path(T, 'post', '/api/v1/snags/{id}/verify', {
    summary: 'Verify the fix',
    description: 'closeout.snag.manage. FIXED → VERIFIED.',
    request: { params: idParam('Snag'), body: jsonBody(S.verifySnagBody, { ok: ex('Checked on site', { note: 'Checked with the owner' }) }) },
    responses: { ...ok('Snag', { ...snag, status: 'VERIFIED', verifiedAt: '2026-10-15T09:00:00.000Z', verifiedBy: KHALID }), ...snagErr({ 409: ['PROJECT_LOCKED', 'INVALID_SNAG_STATUS'] }) },
  });
  path(T, 'post', '/api/v1/snags/{id}/reopen', {
    summary: 'Reopen',
    description: 'closeout.snag.manage. FIXED / VERIFIED → OPEN with a reason (`reopenCount` + 1).',
    request: { params: idParam('Snag'), body: jsonBody(S.reopenSnagBody, { again: ex('Crack came back', { reason: 'Crack visible again after a week' }) }) },
    responses: { ...ok('Snag', { ...snag, status: 'OPEN', reopenCount: 1, lastReopenReason: 'Crack visible again after a week' }), ...snagErr({ 400: ['VALIDATION_ERROR'], 409: ['PROJECT_LOCKED', 'INVALID_SNAG_STATUS'] }) },
  });
  path(T, 'put', '/api/v1/snags/{id}/cost', {
    summary: 'Who pays for the fix',
    description:
      'closeout.snag.manage + fields.amounts. **REWORK** → project cost (cost engine source REWORK, P&L bucket LOSSES). **SUBCONTRACTOR_DEDUCTION** → DEDUCTION on the sub-contract account (refType SNAG; the assignment given, else the snag sub-contractor’s latest one on the project); changing / clearing posts a reversing DEDUCTION (SNAG_REVERSAL) — the ledger stays append-only. ' +
      '**CHANGE_ORDER** → stored flag + amount for the change-order module (Step 15), no ledger. **NONE** clears.',
    request: {
      params: idParam('Snag'),
      body: jsonBody(S.snagCostBody, {
        deduction: ex('Deduct from the sub-contractor', { attribution: 'SUBCONTRACTOR_DEDUCTION', amountPaisa: '450000', note: 'Poor curing by the plaster team' }),
        rework: ex('Our rework', { attribution: 'REWORK', amountPaisa: '1200000' }),
        changeOrder: ex('Owner change', { attribution: 'CHANGE_ORDER', amountPaisa: '2500000', note: 'Owner asked for a bigger window' }),
      }),
    },
    responses: { ...ok('Snag', snag), ...snagErr({ 400: ['VALIDATION_ERROR', 'AMOUNT_REQUIRED', 'NO_SUBCONTRACT_ASSIGNMENT', 'INVALID_ASSIGNMENT'] }) },
  });

  // ─── Handover ─────────────────────────────────────────────────────────────
  const hErr = (extra: Record<number, string[]> = {}) => errors({ ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], ...extra });
  path(T, 'get', '/api/v1/projects/{id}/handover', {
    summary: 'Handover checklist and sign-off',
    description: `closeout.handover.manage. ${SCOPE} Items KEYS, ELECTRICITY_CONNECTION, GAS_CONNECTION, WATER_CONNECTION, WARRANTY_CARDS, FINAL_DRAWINGS, FINAL_PHOTOS; \`blockers\` say what stops completion; \`openSnags\` = not yet verified.`,
    request: { params: idParam('Project') },
    responses: { ...ok('Handover', handover), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'put', '/api/v1/projects/{id}/handover/items/{key}', {
    summary: 'Tick / untick a checklist item',
    description: 'closeout.handover.manage. ACTIVE / CLOSEOUT projects. Attachments: SITE_PHOTO or DOCUMENT.',
    request: { params: itemParams, body: jsonBody(S.handoverItemBody, { keys: ex('Keys handed over', { done: true, note: '3 sets (main gate, front door, store)' }) }) },
    responses: { ...ok('Handover', handover), ...hErr({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/handover/sign-off', {
    summary: 'Record the owner sign-off',
    description: 'closeout.handover.manage. Name, date (not in the future) and a photo of the signed slip.',
    request: { params: idParam('Project'), body: jsonBody(S.signOffBody, { owner: ex('Owner signed', { ownerName: 'Ahmed Raza', signedOn: '2026-10-15', signatureAttachmentId: SIGNATURE }) }) },
    responses: { ...ok('Handover', handover), ...hErr({ 400: ['VALIDATION_ERROR', 'FUTURE_DATE', 'INVALID_ATTACHMENT'], 409: ['PROJECT_LOCKED'] }) },
  });
  path(T, 'post', '/api/v1/projects/{id}/handover/complete', {
    summary: 'Hand over (CLOSEOUT → HANDED_OVER)',
    description:
      'closeout.handover.manage + projects.project.manage. Needs every checklist item and the owner sign-off; open snags need `acceptOpenSnags: true`. Sets the handover date, copies the defect period and sets the retention due date = handover + defect period months (draft RETENTION invoices get it as due date).',
    request: { params: idParam('Project'), body: jsonBody(S.completeHandoverBody, { today: ex('Hand over today', { acceptOpenSnags: true }) }) },
    responses: {
      ...ok('Handover', { ...handover, projectStatus: 'HANDED_OVER', handedOverAt: '2026-10-16', retentionDueDate: '2027-04-16', canComplete: false, blockers: ['PROJECT_NOT_CLOSEOUT'] }),
      ...hErr({ 400: ['VALIDATION_ERROR', 'FUTURE_DATE'], 409: ['PROJECT_NOT_CLOSEOUT', 'HANDOVER_INCOMPLETE', 'OPEN_SNAGS'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/handover/certificate', {
    summary: 'Handover certificate PDF',
    description: 'closeout.handover.manage. Letterhead, project, handover date, checklist, defect period, owner sign-off — no money. In the user’s language (`?lang=en|roman|ur`, Urdu right-to-left). Returns a signed link (10 min) and a WhatsApp text.',
    request: { params: idParam('Project'), query: S.certificateQuery },
    responses: {
      ...ok('Certificate', { attachmentId: FILE0, url: 'https://…/file?sig=…', expiresAt: '2026-10-16T10:10:00.000Z', whatsappText: 'Assalam o Alaikum Ahmed Raza sahib, …', clientPhone: '+923001112233' }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'], 409: ['SIGN_OFF_MISSING'], 503: ['PDF_UNAVAILABLE'] }),
    },
  });

  // ─── Retention ────────────────────────────────────────────────────────────
  path(T, 'get', '/api/v1/projects/{id}/retention', {
    summary: 'Retention after handover',
    description: `closeout.retention.view. ${SCOPE} Owner retention (stage / invoice) and sub-contractor retention held until the retention due date (handover + defect period). A daily job reminds the owner / PMs \`reminder.daysBefore\` days before and on the due date. ${AMOUNTS}`,
    request: { params: idParam('Project') },
    responses: { ...ok('Retention', retention), ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/projects/{id}/retention', {
    summary: 'Reminder lead time',
    description: 'closeout.handover.manage. Days before the due date for the reminder (1–90, default 14); a change re-arms the reminder.',
    request: { params: idParam('Project'), body: jsonBody(S.retentionSettingsBody, { month: ex('A month before', { reminderDaysBefore: 30 }) }) },
    responses: { ...ok('Retention', retention), ...hErr({ 400: ['VALIDATION_ERROR'] }) },
  });
}
