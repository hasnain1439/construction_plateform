import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, KHALID, READ_403, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import {
  cancelBody,
  chequeStatusBody,
  createInvoiceBody,
  eventsQuery,
  invoicesQuery,
  issueBody,
  markReadyBody,
  paymentBody,
  paymentsQuery,
  progressBody,
  progressQuery,
  receivablesQuery,
  statementQuery,
  updateInvoiceBody,
  updateProgressBody,
  updateStageBody,
} from './billing.schema.js';

const B = {
  stage: '0199a8c0-0000-7000-8000-000000000e01',
  invoice: '0199a8c0-0000-7000-8000-000000000e11',
  payment: '0199a8c0-0000-7000-8000-000000000e21',
  progress: '0199a8c0-0000-7000-8000-000000000e31',
  cashEntry: '0199a8c0-0000-7000-8000-000000000e41',
  pdf: '0199a8c0-0000-7000-8000-000000000e51',
} as const;
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' };
const AHMED = { id: '0199a8c0-0000-7000-8000-000000000101', name: 'Ahmed Raza', phone: '+923001112222', address: 'House 12, DHA Phase 6' };
const BILLING_403 = [...WRITE_403];
const PROJECT_404 = { 404: ['PROJECT_NOT_FOUND'] };
const ACCESS = 'THEKEDAR, or a PM with billing.view on their projects (MUNSHI / PM without financials → 403).';

const stage = {
  id: B.stage,
  sortOrder: 3,
  label: 'Grey structure — ground floor',
  percent: 20,
  isRetention: false,
  amountPaisa: '370000000',
  status: 'PARTLY_PAID',
  expectedDate: null,
  readyAt: '2026-08-27T03:00:00.000Z',
  readyById: KHALID.id,
  readyNote: null,
  proofAttachmentIds: [IDS.photo],
  invoice: { id: B.invoice, number: 'INV-2026-0010', status: 'PARTLY_PAID', dueDate: '2026-09-03', totalPaisa: '370000000', balancePaisa: '110000000' },
};
const invoice = {
  id: B.invoice,
  number: 'INV-2026-0010',
  type: 'STAGE',
  status: 'PARTLY_PAID',
  project: DHA,
  client: AHMED,
  billingStage: { id: B.stage, label: 'Grey structure — ground floor', percent: 20 },
  issueDate: '2026-08-27',
  dueDate: '2026-09-03',
  overdue: true,
  overdueDays: 33,
  subtotalPaisa: '370000000',
  taxPaisa: '0',
  taxLabel: null,
  taxRatePercent: null,
  totalPaisa: '370000000',
  paidPaisa: '260000000',
  pendingPaisa: '0',
  balancePaisa: '110000000',
  notes: null,
  forceNote: null,
  cancelReason: null,
  cancelledAt: null,
  pdfAttachmentId: B.pdf,
  lines: [{ id: B.invoice, description: 'Grey structure — ground floor (20% of contract)', quantity: null, unit: null, ratePaisa: null, amountPaisa: '370000000', sourceType: 'BILLING_STAGE', sourceId: B.stage }],
  allocations: [
    { id: B.payment, amountPaisa: '150000000', counts: true, payment: { id: B.payment, number: 'RV-2026-0011', receivedOn: '2026-08-31', method: 'CHEQUE', status: 'CLEARED', chequeNo: '118830' } },
    { id: B.payment, amountPaisa: '110000000', counts: false, payment: { id: B.payment, number: 'RV-2026-0013', receivedOn: '2026-09-20', method: 'CHEQUE', status: 'BOUNCED', chequeNo: '118845' } },
  ],
  createdAt: '2026-08-27T04:00:00.000Z',
  issuedAt: '2026-08-27T05:00:00.000Z',
};
const payment = {
  id: B.payment,
  number: 'RV-2026-0013',
  project: DHA,
  client: { id: AHMED.id, name: AHMED.name },
  receivedOn: '2026-09-20',
  amountPaisa: '110000000',
  whtDeductedPaisa: '0',
  method: 'CHEQUE',
  bankName: 'MCB',
  reference: null,
  chequeNo: '118845',
  chequeDate: null,
  status: 'PENDING',
  allocatedPaisa: '110000000',
  creditPaisa: '0',
  allocations: [{ id: B.payment, amountPaisa: '110000000', invoice: { id: B.invoice, number: 'INV-2026-0010', type: 'STAGE', status: 'PARTLY_PAID' } }],
  attachmentId: null,
  receiptAttachmentId: B.pdf,
  note: null,
  bounceReason: null,
  clearedAt: null,
  bouncedAt: null,
  receivedById: KHALID.id,
  createdAt: '2026-09-20T10:00:00.000Z',
};
const share = (text: string) => ({ attachmentId: B.pdf, url: 'https://res.cloudinary.com/demo/raw/upload/s--sig--/INV-2026-0010.pdf', expiresAt: '2026-10-06T10:15:00.000Z', whatsappText: text, clientPhone: AHMED.phone });

export function registerBillingDocs(): void {
  // ─── Billing Stages ───────────────────────────────────────────────────────
  const S = 'Billing Stages';
  path(S, 'get', '/api/v1/projects/{id}/billing-stages', {
    summary: 'Payment schedule',
    description: `${ACCESS} Stages with status (UPCOMING → READY → INVOICED → PARTLY_PAID → PAID), proof photos, expected date and the stage's invoice.`,
    request: { params: idParam('Project') },
    responses: { ...ok('Stages', [stage]), ...errors({ ...AUTH, 403: READ_403, ...PROJECT_404 }) },
  });
  path(S, 'post', '/api/v1/billing-stages/{id}/mark-ready', {
    summary: 'Mark a stage ready to bill',
    description:
      `${ACCESS} Proof photos are required. Returns \`warning: PREVIOUS_STAGE_UNPAID\` (with the stages) when an earlier stage's invoice is past due and unpaid — the stage is still marked ready. ` +
      'Writes STAGE_READY_UNBILLED (and PREVIOUS_STAGE_UNPAID) events for the dashboard.',
    request: { params: idParam('ProjectBillingStage'), body: jsonBody(markReadyBody, { slab: ex('Slab cast, photos attached', { proofAttachmentIds: [IDS.photo], note: 'Slab cast 25 Aug, curing done' }) }) },
    responses: {
      ...ok('Ready', {
        stage: { ...stage, status: 'READY', invoice: null },
        warning: { code: 'PREVIOUS_STAGE_UNPAID', message: 'An earlier stage is still unpaid past the due date', details: { stages: [{ stageId: B.stage, label: 'Foundation & plinth', invoiceNumber: 'INV-2026-0006', dueDate: '2026-06-17', balancePaisa: '50000000', overdueDays: 12 }] } },
      }),
      ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], ...AUTH, 403: BILLING_403, 404: ['STAGE_NOT_FOUND'], 409: ['STAGE_ALREADY_INVOICED', 'PROJECT_IS_DRAFT'] }),
    },
  });
  path(S, 'patch', '/api/v1/billing-stages/{id}', {
    summary: 'Set the expected date',
    description: 'THEKEDAR.',
    request: { params: idParam('ProjectBillingStage'), body: jsonBody(updateStageBody, { nov: ex('First-floor slab around 19 Nov', { expectedDate: '2026-11-19' }) }) },
    responses: { ...ok('Stage', stage), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: BILLING_403, 404: ['STAGE_NOT_FOUND'] }) },
  });

  // ─── Running Bills ────────────────────────────────────────────────────────
  const R = 'Running Bills';
  const progress = { id: B.progress, projectId: IDS.dha, date: '2026-09-30', quantity: 700, unit: 'sqft', description: 'First floor — plaster', attachmentIds: [], valuePaisa: '105000000', billedInvoiceId: null, draftInvoiceId: null, billed: false, createdAt: '2026-09-30T12:00:00.000Z' };
  path(R, 'get', '/api/v1/projects/{id}/billing-progress', {
    summary: 'Running-bill progress',
    description: `${ACCESS} RUNNING_BILLS projects only (400 NOT_RUNNING_BILLS). Value = sq ft × the contract rate per sq ft.`,
    request: { params: idParam('Project'), query: progressQuery },
    responses: { ...ok('Progress', { items: [progress], ratePerSqftPaisa: '150000', unbilledQuantity: 700, unbilledValuePaisa: '105000000' }), ...errors({ 400: ['NOT_RUNNING_BILLS'], ...AUTH, 403: READ_403, ...PROJECT_404 }) },
  });
  path(R, 'post', '/api/v1/projects/{id}/billing-progress', {
    summary: 'Add progress',
    description: ACCESS,
    request: { params: idParam('Project'), body: jsonBody(progressBody, { plaster: ex('700 sq ft plaster', { date: '2026-09-30', quantity: 700, description: 'First floor — plaster', attachmentIds: [IDS.photo] }) }) },
    responses: { ...createdResp('Added', progress), ...errors({ 400: ['VALIDATION_ERROR', 'NOT_RUNNING_BILLS', 'FUTURE_DATE'], ...AUTH, 403: BILLING_403, ...PROJECT_404 }) },
  });
  path(R, 'patch', '/api/v1/billing-progress/{id}', {
    summary: 'Edit progress',
    description: 'Only while unbilled (409 PROGRESS_BILLED) and not on a draft invoice (409 PROGRESS_ON_DRAFT).',
    request: { params: idParam('BillingProgress'), body: jsonBody(updateProgressBody, { fix: ex('Correct the quantity', { quantity: 650 }) }) },
    responses: { ...ok('Updated', progress), ...errors({ 400: ['VALIDATION_ERROR', 'FUTURE_DATE'], ...AUTH, 403: BILLING_403, 404: ['PROGRESS_NOT_FOUND'], 409: ['PROGRESS_BILLED', 'PROGRESS_ON_DRAFT'] }) },
  });
  path(R, 'delete', '/api/v1/billing-progress/{id}', {
    summary: 'Delete progress',
    description: 'Only while unbilled and not on a draft invoice.',
    request: { params: idParam('BillingProgress') },
    responses: { ...ok('Deleted', { deleted: true }), ...errors({ ...AUTH, 403: BILLING_403, 404: ['PROGRESS_NOT_FOUND'], 409: ['PROGRESS_BILLED', 'PROGRESS_ON_DRAFT'] }) },
  });

  // ─── Invoices ─────────────────────────────────────────────────────────────
  const I = 'Invoices';
  path(I, 'get', '/api/v1/projects/{id}/invoices', {
    summary: 'Project invoices',
    description: `${ACCESS} Overdue = issued / part paid, past due, balance > 0. Totals of live invoices in \`meta\`.`,
    request: { params: idParam('Project'), query: invoicesQuery },
    responses: { ...ok('Invoices', [invoice], { ...page(1), invoicedPaisa: '925000000', paidPaisa: '815000000', balancePaisa: '110000000' }), ...errors({ ...AUTH, 403: READ_403, ...PROJECT_404 }) },
  });
  path(I, 'post', '/api/v1/projects/{id}/invoices', {
    summary: 'Create a draft invoice',
    description:
      'THEKEDAR, or a PM with billing.view. Types:\n\n' +
      '- **STAGE** `billingStageId` — stage must be READY (UPCOMING with `force` + `forceNote`); `extraCashEntryIds` adds owner-recoverable kharcha\n' +
      '- **RUNNING_BILL** `from`/`to` — unbilled progress × rate per sq ft, less the retention %\n' +
      '- **RECOVERABLE** `cashEntryIds` — owner-recoverable kharcha not yet billed\n' +
      '- **RETENTION** — after handover (CLOSEOUT / HANDED_OVER)\n' +
      '- **OTHER** `lines` — manual (THEKEDAR)\n\nTax is added when tax is on (subtotal × taxRatePercent).',
    request: {
      params: idParam('Project'),
      body: jsonBody(createInvoiceBody, {
        stage: ex('Ready stage + tile samples', { type: 'STAGE', billingStageId: B.stage, extraCashEntryIds: [B.cashEntry] }),
        running: ex('Running bill for September', { type: 'RUNNING_BILL', from: '2026-09-01', to: '2026-09-30' }),
        other: ex('Extra work', { type: 'OTHER', lines: [{ description: 'Boundary wall raised', quantity: 120, unit: 'rft', ratePaisa: '150000' }] }),
      }),
    },
    responses: {
      ...createdResp('Draft', { ...invoice, status: 'DRAFT', number: null, issueDate: null, dueDate: null, overdue: false, overdueDays: 0, paidPaisa: '0', balancePaisa: '370000000', allocations: [] }),
      ...errors({
        400: ['VALIDATION_ERROR', 'USE_RETENTION_INVOICE', 'NOT_RUNNING_BILLS', 'RATE_REQUIRED', 'NOTHING_TO_BILL', 'INVALID_RECOVERABLE', 'NO_RETENTION_STAGE', 'LINE_AMOUNT_REQUIRED'],
        ...AUTH,
        403: BILLING_403,
        404: ['PROJECT_NOT_FOUND', 'STAGE_NOT_FOUND'],
        409: ['STAGE_NOT_READY', 'STAGE_ALREADY_INVOICED', 'SOURCE_ALREADY_BILLED', 'RETENTION_NOT_DUE', 'PROJECT_IS_DRAFT'],
      }),
    },
  });
  path(I, 'get', '/api/v1/invoices/{id}', {
    summary: 'Invoice',
    description: `${ACCESS} Lines, allocations (bounced cheques have \`counts: false\`) and totals.`,
    request: { params: idParam('Invoice') },
    responses: { ...ok('Invoice', invoice), ...errors({ ...AUTH, 403: READ_403, 404: ['INVOICE_NOT_FOUND'] }) },
  });
  path(I, 'patch', '/api/v1/invoices/{id}', {
    summary: 'Edit a draft',
    description: 'DRAFT only (409 INVOICE_LOCKED). Notes, due date; manual lines on OTHER drafts (THEKEDAR). A PM edits only their own drafts.',
    request: { params: idParam('Invoice'), body: jsonBody(updateInvoiceBody, { notes: ex('Add a note', { notes: 'Payable to Malik & Sons — HBL 0042-7' }) }) },
    responses: { ...ok('Draft', invoice), ...errors({ 400: ['VALIDATION_ERROR', 'LINES_LOCKED', 'LINE_AMOUNT_REQUIRED'], ...AUTH, 403: BILLING_403, 404: ['INVOICE_NOT_FOUND'], 409: ['INVOICE_LOCKED'] }) },
  });
  path(I, 'delete', '/api/v1/invoices/{id}', {
    summary: 'Delete a draft',
    request: { params: idParam('Invoice') },
    responses: { ...ok('Deleted', { deleted: true }), ...errors({ ...AUTH, 403: BILLING_403, 404: ['INVOICE_NOT_FOUND'], 409: ['INVOICE_LOCKED'] }) },
  });
  path(I, 'post', '/api/v1/invoices/{id}/issue', {
    summary: 'Issue',
    description: 'THEKEDAR. Numbers it (INV-2026-0001), due = issue + payment terms, locks its stage / progress / kharcha, applies project credit and makes the PDF (a PDF failure does not stop the issue).',
    request: { params: idParam('Invoice'), body: jsonBody(issueBody, { today: ex('Issue today', {}) }) },
    responses: { ...ok('Issued', invoice), ...errors({ 400: ['EMPTY_INVOICE', 'FUTURE_DATE'], ...AUTH, 403: BILLING_403, 404: ['INVOICE_NOT_FOUND'], 409: ['INVOICE_NOT_DRAFT', 'SOURCE_ALREADY_BILLED'] }) },
  });
  path(I, 'post', '/api/v1/invoices/{id}/cancel', {
    summary: 'Cancel',
    description: 'THEKEDAR. Only without payments (409 INVOICE_HAS_PAYMENTS). Releases the stage / progress / kharcha back to unbilled; the invoice stays visible as CANCELLED.',
    request: { params: idParam('Invoice'), body: jsonBody(cancelBody, { wrong: ex('Wrong stage', { reason: 'Billed the wrong stage — reissuing' }) }) },
    responses: { ...ok('Cancelled', { ...invoice, status: 'CANCELLED', cancelReason: 'Billed the wrong stage — reissuing' }), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: BILLING_403, 404: ['INVOICE_NOT_FOUND'], 409: ['INVOICE_HAS_PAYMENTS', 'INVOICE_NOT_ISSUED', 'INVOICE_CANCELLED'] }) },
  });
  path(I, 'get', '/api/v1/invoices/{id}/pdf', {
    summary: 'Invoice PDF + share text',
    description: 'Signed URL of the stored PDF (made again if missing), and a ready WhatsApp message. 503 PDF_UNAVAILABLE when PDFs cannot be made.',
    request: { params: idParam('Invoice') },
    responses: {
      ...ok('PDF', share('Assalam o Alaikum Ahmed Raza sahib, DHA Phase 6 · 10 Marla ka invoice INV-2026-0010 (Rs 37,00,000), due 3 Sept. Link: https://…')),
      ...errors({ ...AUTH, 403: READ_403, 404: ['INVOICE_NOT_FOUND'], 409: ['INVOICE_NOT_ISSUED'], 503: ['PDF_UNAVAILABLE'] }),
    },
  });

  // ─── Client Payments ──────────────────────────────────────────────────────
  const P = 'Client Payments';
  path(P, 'get', '/api/v1/projects/{id}/payments', {
    summary: 'Payments received',
    description: `${ACCESS} Sums by status in \`meta\`.`,
    request: { params: idParam('Project'), query: paymentsQuery },
    responses: { ...ok('Payments', [payment], { ...page(1), clearedPaisa: '815000000', pendingPaisa: '0', bouncedPaisa: '110000000' }), ...errors({ ...AUTH, 403: READ_403, ...PROJECT_404 }) },
  });
  path(P, 'post', '/api/v1/projects/{id}/payments', {
    summary: 'Record a payment',
    description:
      'THEKEDAR (PM only when `pmCanRecordPayments`). Numbered RV-2026-0001. Without `allocations` the oldest due invoices are settled first; the remainder is kept as project credit and settles the next issued invoice. ' +
      'Cheques start PENDING (shown as pending, not paid). WHT (only when tax is on) counts towards the invoices.',
    request: {
      params: idParam('Project'),
      body: jsonBody(paymentBody, {
        cheque: ex('MCB cheque', { receivedOn: '2026-09-20', amountPaisa: '110000000', method: 'CHEQUE', bankName: 'MCB', chequeNo: '118845' }),
        transfer: ex('IBFT against one invoice', { receivedOn: '2026-06-14', amountPaisa: '277500000', method: 'BANK_TRANSFER', bankName: 'Meezan', reference: 'FT26165', allocations: [{ invoiceId: B.invoice, amountPaisa: '277500000' }] }),
      }),
    },
    responses: {
      ...createdResp('Recorded', payment),
      ...errors({
        400: ['VALIDATION_ERROR', 'FUTURE_DATE', 'WHT_NOT_ENABLED', 'INVALID_ATTACHMENT', 'INVALID_ALLOCATION', 'ALLOCATION_EXCEEDS_BALANCE', 'ALLOCATION_EXCEEDS_PAYMENT'],
        ...AUTH,
        403: BILLING_403,
        ...PROJECT_404,
      }),
    },
  });
  path(P, 'get', '/api/v1/payments/{id}', {
    summary: 'Payment',
    request: { params: idParam('ClientPayment') },
    responses: { ...ok('Payment', payment), ...errors({ ...AUTH, 403: READ_403, 404: ['PAYMENT_NOT_FOUND'] }) },
  });
  path(P, 'patch', '/api/v1/payments/{id}/cheque-status', {
    summary: 'Cheque cleared / bounced',
    description: 'THEKEDAR. CLEARED moves the allocations from pending to paid. BOUNCED (reason required) makes them stop counting — balances come back — writes a CHEQUE_BOUNCED event and SMSes the owners.',
    request: {
      params: idParam('ClientPayment'),
      body: jsonBody(chequeStatusBody, { cleared: ex('Cleared', { status: 'CLEARED' }), bounced: ex('Bounced', { status: 'BOUNCED', reason: 'insufficient funds' }) }),
    },
    responses: { ...ok('Payment', { ...payment, status: 'BOUNCED', bounceReason: 'insufficient funds' }), ...errors({ 400: ['VALIDATION_ERROR', 'NOT_A_CHEQUE'], ...AUTH, 403: BILLING_403, 404: ['PAYMENT_NOT_FOUND'], 409: ['CHEQUE_ALREADY_SETTLED'] }) },
  });
  path(P, 'get', '/api/v1/payments/{id}/receipt-pdf', {
    summary: 'Receipt PDF + share text',
    request: { params: idParam('ClientPayment') },
    responses: { ...ok('PDF', share('Assalam o Alaikum Ahmed Raza sahib, … ki receipt RV-2026-0013. Link: https://…')), ...errors({ ...AUTH, 403: READ_403, 404: ['PAYMENT_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }) },
  });

  // ─── Receivables ──────────────────────────────────────────────────────────
  const V = 'Receivables';
  path(V, 'get', '/api/v1/projects/{id}/receivables', {
    summary: 'Project money summary',
    description: `${ACCESS} Contract, invoiced, received (cleared incl. WHT), pending cheques, outstanding, overdue (+ oldest days), credit, retention held, unbilled recoverables, spent to date (breakdown) and own money invested = spent − received (negative = owner paid ahead).`,
    request: { params: idParam('Project') },
    responses: {
      ...ok('Summary', {
        project: { ...DHA, status: 'ACTIVE', billingModel: 'STAGE_SCHEDULE' },
        originalContractPaisa: '1850000000',
        approvedChangesPaisa: '0',
        revisedContractPaisa: '1850000000',
        invoicedPaisa: '925000000',
        receivedPaisa: '815000000',
        pendingChequesPaisa: '0',
        outstandingPaisa: '110000000',
        overduePaisa: '110000000',
        oldestOverdueDays: 33,
        creditPaisa: '0',
        retentionHeldPaisa: '92500000',
        unbilledRecoverablePaisa: '280000',
        readyStagesCount: 0,
        collectedPercent: 88.1,
        spentToDatePaisa: '640000000',
        spent: { materialPaisa: '420000000', wagesPaisa: '90000000', advancesPaisa: '20000000', subcontractPaisa: '100000000', kharchaPaisa: '10000000', lossesPaisa: '0', totalPaisa: '640000000' },
        ownMoneyInvestedPaisa: '-175000000',
        nextBillableStage: { ...stage, sortOrder: 4, label: 'Grey structure — first floor & roof', status: 'UPCOMING', invoice: null },
        stages: [{ id: B.stage, label: 'Grey structure — ground floor', percent: 20, amountPaisa: '370000000', status: 'PARTLY_PAID', isRetention: false, expectedDate: null, invoiceId: B.invoice, invoiceNumber: 'INV-2026-0010', dueDate: '2026-09-03' }],
      }),
      ...errors({ ...AUTH, 403: READ_403, ...PROJECT_404 }),
    },
  });
  path(V, 'get', '/api/v1/receivables', {
    summary: 'Company receivables',
    description: 'THEKEDAR. One row per non-draft project with money, plus totals. `overdueOnly=true` keeps projects with overdue invoices.',
    request: { query: receivablesQuery },
    responses: {
      ...ok('Receivables', {
        asOf: '2026-10-06',
        items: [
          {
            project: { ...DHA, status: 'ACTIVE' },
            client: { id: AHMED.id, name: AHMED.name, phone: AHMED.phone },
            revisedContractPaisa: '1850000000',
            invoicedPaisa: '925000000',
            receivedPaisa: '815000000',
            pendingChequesPaisa: '0',
            outstandingPaisa: '110000000',
            overduePaisa: '110000000',
            oldestOverdueDays: 33,
            creditPaisa: '0',
            retentionHeldPaisa: '92500000',
            nextBillableStage: { id: B.stage, label: 'Grey structure — first floor & roof', status: 'UPCOMING', amountPaisa: '277500000' },
          },
        ],
        totals: { revisedContractPaisa: '1850000000', invoicedPaisa: '925000000', receivedPaisa: '815000000', pendingChequesPaisa: '0', outstandingPaisa: '110000000', overduePaisa: '110000000', retentionHeldPaisa: '92500000', overdueProjects: 1 },
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });
  path(V, 'get', '/api/v1/billing-events', {
    summary: 'Billing alerts',
    description: 'THEKEDAR. INVOICE_OVERDUE (daily job, once per invoice), CHEQUE_BOUNCED, STAGE_READY_UNBILLED, PREVIOUS_STAGE_UNPAID — with a link for the action.',
    request: { query: eventsQuery },
    responses: {
      ...ok('Events', [
        { id: B.payment, type: 'CHEQUE_BOUNCED', project: DHA, refType: 'PAYMENT', refId: B.payment, details: { number: 'RV-2026-0013', chequeNo: '118845', bankName: 'MCB', amountPaisa: '110000000', reason: 'insufficient funds' }, occurredAt: '2026-09-24T07:00:00.000Z', resolvedAt: null, href: `/projects/${IDS.dha}/billing/payments` },
      ]),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });

  // ─── Statements ───────────────────────────────────────────────────────────
  const T = 'Statements';
  path(T, 'get', '/api/v1/projects/{id}/owner-statement', {
    summary: 'Owner statement',
    description: `${ACCESS} Opening balance, invoices (billed) and payments (received — pending / bounced cheques are listed with their status but do not reduce the balance), closing balance due, credit and unbilled recoverables. Default period: first entry → today.`,
    request: { params: idParam('Project'), query: statementQuery },
    responses: {
      ...ok('Statement', {
        project: DHA,
        client: { id: AHMED.id, name: AHMED.name, phone: AHMED.phone },
        from: '2026-08-01',
        to: '2026-10-06',
        openingPaisa: '0',
        rows: [{ date: '2026-08-27', kind: 'INVOICE', id: B.invoice, reference: 'INV-2026-0010', description: 'Invoice due 3 Sept 2026', debitPaisa: '370000000', creditPaisa: '0', balancePaisa: '370000000', status: null }],
        totals: { invoicedPaisa: '370000000', receivedPaisa: '260000000' },
        closingPaisa: '110000000',
        creditPaisa: '0',
        pendingChequesPaisa: '0',
        unbilledRecoverables: [{ id: B.cashEntry, date: '2026-10-04', description: 'Tile samples for the owner', amountPaisa: '280000' }],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, ...PROJECT_404 }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/owner-statement/pdf', {
    summary: 'Owner statement PDF + share text',
    request: { params: idParam('Project'), query: statementQuery },
    responses: { ...ok('PDF', share('Assalam o Alaikum Ahmed Raza sahib, DHA Phase 6 · 10 Marla ka hisaab (…): baqaya Rs 11,00,000. Link: https://…')), ...errors({ ...AUTH, 403: READ_403, ...PROJECT_404, 503: ['PDF_UNAVAILABLE'] }) },
  });
}
