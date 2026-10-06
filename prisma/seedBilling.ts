/**
 * Demo billing for Malik & Sons (Phase 1 · Step 8). One transaction; skipped when the company
 * already has invoices. Everything goes through the billing services (no PDFs, no SMS).
 *
 *   DHA Phase 6     invoiced 92,50,000 · received 81,50,000 · outstanding 11,00,000 (overdue,
 *                   MCB cheque 118845 bounced) · 1st-floor slab expected ~19 Nov
 *   Johar Town      invoiced 88,30,000 · received 79,00,000 · outstanding 9,30,000 (4,50,000 overdue 21 days)
 *   Bahria Town     invoiced 1,10,40,000 · received 1,02,00,000 · outstanding 8,40,000 (not due)
 *   Valencia        labour-only: running bills 42,00,000 gross, received 39,90,000, retention 2,10,000 held
 */
import { Prisma } from '../src/core/db/prisma.js';
import type { Tx } from '../src/core/db/withTenant.js';
import { todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import type { CreateInvoiceInput, PaymentInput } from '../src/modules/billing/billing.schema.js';
import type { BillingActor } from '../src/modules/billing/billing.shared.js';
import { createInvoiceTx, issueTx } from '../src/modules/billing/invoices.service.js';
import { chequeStatusTx, recordPaymentTx } from '../src/modules/billing/payments.service.js';
import { addProgressTx, markReadyTx } from '../src/modules/billing/stages.service.js';
import { runBillingOverdueCheck } from '../src/jobs/billingOverdue.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const rs = (rupees: number) => BigInt(Math.round(rupees * 100));
const at = (date: string, hourPkt = 11) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
const daysAgo = (n: number) => new Date(Date.parse(`${todayIn('Asia/Karachi')}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export interface BillingSeedInput {
  tenantId: string;
  ownerId: string;
  projects: { dha: { id: string }; johar: { id: string }; bahria: { id: string }; valencia: { id: string } };
}

export async function seedMalikBilling(db: PrismaClient, s: BillingSeedInput): Promise<{ skipped: boolean }> {
  if ((await db.invoice.count({ where: { tenantId: s.tenantId } })) > 0) return { skipped: true };
  await db.$transaction((tx) => build(tx, s), { timeout: 300_000, maxWait: 30_000 });
  await runBillingOverdueCheck();
  return { skipped: false };
}

async function build(tx: Tx, s: BillingSeedInput) {
  const khalid: BillingActor = { tenantId: s.tenantId, userId: s.ownerId, role: 'THEKEDAR', seesFinancials: true, seesRates: true };
  const { dha, johar, bahria, valencia } = s.projects;
  // Stage status now follows invoices: start the stage-schedule projects from UPCOMING.
  await tx.projectBillingStage.updateMany({ where: { tenantId: s.tenantId, projectId: { in: [dha.id, johar.id, bahria.id] } }, data: { status: 'UPCOMING' } });
  const stages = async (projectId: string) => tx.projectBillingStage.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });

  /** A small site photo as the proof of a finished stage. */
  const photo = async () => {
    const id = uuidv7();
    let key = `${s.tenantId}/2026/09/${id}.png`;
    try {
      key = await storage().put(key, PNG, 'image/png');
    } catch {
      // keep the key; only the preview is missing
    }
    await tx.attachment.create({ data: { id, tenantId: s.tenantId, kind: 'SITE_PHOTO', storageKey: key, fileName: 'stage.png', mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: s.ownerId } });
    return id;
  };
  const invoice = async (projectId: string, input: CreateInvoiceInput, issueDate: string) => {
    const draft = await createInvoiceTx(tx, khalid, projectId, input, { at: at(issueDate, 9) });
    return issueTx(tx, khalid, draft.id, { issueDate }, { at: at(issueDate, 10) });
  };
  const stageBill = async (projectId: string, stageId: string, issueDate: string) => {
    await markReadyTx(tx, khalid, stageId, { proofAttachmentIds: [await photo()] }, { at: at(issueDate, 8) });
    return invoice(projectId, { type: 'STAGE', billingStageId: stageId }, issueDate);
  };
  const pay = (projectId: string, input: Omit<PaymentInput, 'amountPaisa'> & { amountPaisa: bigint }) => recordPaymentTx(tx, khalid, projectId, input, { at: at(input.receivedOn, 15) });
  const clear = (paymentId: string, date: string) => chequeStatusTx(tx, khalid, paymentId, { status: 'CLEARED', date }, { at: at(date, 12), sms: false });

  // ─── Valencia (2025, labour-only running bills at Rs 1,500 / sq ft on 2,800 sq ft) ─────
  await tx.project.update({ where: { id: valencia.id }, data: { ratePerSqftPaisa: rs(1500) } });
  for (const st of await stages(valencia.id)) {
    await tx.projectBillingStage.update({ where: { id: st.id }, data: { amountPaisa: BigInt(new Prisma.Decimal(rs(4200000).toString()).mul(st.percent).div(100).toFixed(0)) } });
  }
  const bills: Array<[string, string, string]> = [
    ['2025-03-31', 'Ground floor — brickwork & plaster', '2025-04-02'],
    ['2025-05-31', 'Ground floor — flooring prep, first floor brickwork', '2025-06-02'],
    ['2025-07-31', 'First floor — plaster & roof', '2025-08-02'],
    ['2025-10-31', 'Finishing labour & handover', '2025-11-03'],
  ];
  for (const [date, description, billDate] of bills) {
    await addProgressTx(tx, khalid, valencia.id, { date, quantity: new Prisma.Decimal(700), description }, { at: at(date, 17) });
    const inv = await invoice(valencia.id, { type: 'RUNNING_BILL', from: date, to: date }, billDate);
    await pay(valencia.id, { receivedOn: billDate.replace(/-0[23]$/, '-10'), amountPaisa: BigInt(inv.totalPaisa), method: 'BANK_TRANSFER', bankName: 'UBL', reference: `UBL-${billDate.slice(5, 7)}${billDate.slice(2, 4)}` });
  }

  // ─── 2026, in date order so the numbers run with the calendar ───────────────────────────
  const [d1, d2, d3, d4] = await stages(dha.id);
  const [j1, j2, j3, j4, j5] = await stages(johar.id);
  const [b1, b2] = await stages(bahria.id);

  const jInv1 = await stageBill(johar.id, j1!.id, '2026-01-10');
  await pay(johar.id, { receivedOn: '2026-01-15', amountPaisa: BigInt(jInv1.totalPaisa), method: 'BANK_TRANSFER', bankName: 'Allied Bank', reference: 'ABL-1501' });
  const dInv1 = await stageBill(dha.id, d1!.id, '2026-03-12');
  const hbl = await pay(dha.id, { receivedOn: '2026-03-15', amountPaisa: BigInt(dInv1.totalPaisa), method: 'CHEQUE', bankName: 'HBL', chequeNo: '004512' });
  await clear(hbl.id, '2026-03-18');
  const jInv2 = await stageBill(johar.id, j2!.id, '2026-03-15');
  await pay(johar.id, { receivedOn: '2026-03-25', amountPaisa: BigInt(jInv2.totalPaisa), method: 'CASH' });
  const jInv3 = await stageBill(johar.id, j3!.id, '2026-05-20');
  await pay(johar.id, { receivedOn: '2026-05-28', amountPaisa: BigInt(jInv3.totalPaisa), method: 'RAAST', reference: 'RAAST-2805' });
  const bInv1 = await stageBill(bahria.id, b1!.id, '2026-06-01');
  await pay(bahria.id, { receivedOn: '2026-06-05', amountPaisa: BigInt(bInv1.totalPaisa), method: 'BANK_TRANSFER', bankName: 'Bank Alfalah', reference: 'BAF-0605' });
  const dInv2 = await stageBill(dha.id, d2!.id, '2026-06-10');
  await pay(dha.id, { receivedOn: '2026-06-14', amountPaisa: BigInt(dInv2.totalPaisa), method: 'BANK_TRANSFER', bankName: 'Meezan', reference: 'FT26165' });
  const jInv4 = await stageBill(johar.id, j4!.id, '2026-07-25');
  await pay(johar.id, { receivedOn: '2026-08-01', amountPaisa: BigInt(jInv4.totalPaisa), method: 'BANK_TRANSFER', bankName: 'Allied Bank', reference: 'ABL-0108' });
  const bInv2 = await stageBill(bahria.id, b2!.id, '2026-08-20');
  await pay(bahria.id, { receivedOn: '2026-08-26', amountPaisa: BigInt(bInv2.totalPaisa), method: 'BANK_TRANSFER', bankName: 'Bank Alfalah', reference: 'BAF-2608' });

  // DHA ground-floor slab: Rs 37,00,000, due 3 Sep — 15 lakh cheque cleared, 11 lakh cash, 11 lakh cheque bounced
  await stageBill(dha.id, d3!.id, '2026-08-27');
  const mcb1 = await pay(dha.id, { receivedOn: '2026-08-31', amountPaisa: rs(1500000), method: 'CHEQUE', bankName: 'MCB', chequeNo: '118830' });
  await clear(mcb1.id, '2026-09-02');
  await pay(dha.id, { receivedOn: '2026-09-12', amountPaisa: rs(1100000), method: 'CASH', note: 'Received at site office' });
  const mcb2 = await pay(dha.id, { receivedOn: '2026-09-20', amountPaisa: rs(1100000), method: 'CHEQUE', bankName: 'MCB', chequeNo: '118845' });
  await chequeStatusTx(tx, khalid, mcb2.id, { status: 'BOUNCED', reason: 'insufficient funds', date: '2026-09-24' }, { at: at('2026-09-24', 12), sms: false });
  await tx.projectBillingStage.update({ where: { id: d4!.id }, data: { expectedDate: new Date('2026-11-19') } });

  // Johar: plaster stage 11 lakh (6.5 lakh received → 4.5 lakh overdue 21 days) + extra boundary wall 5.8 lakh (1 lakh received)
  await stageBill(johar.id, j5!.id, daysAgo(28));
  await pay(johar.id, { receivedOn: daysAgo(24), amountPaisa: rs(650000), method: 'CASH' });
  const extra = await invoice(
    johar.id,
    { type: 'OTHER', lines: [{ description: 'Extra work — boundary wall raised + main gate frame', amountPaisa: rs(580000) }], notes: 'Agreed with Mr. Usman on site' },
    daysAgo(5),
  );
  await pay(johar.id, { receivedOn: daysAgo(2), amountPaisa: rs(100000), method: 'JAZZCASH', reference: 'JC-77120', allocations: [{ invoiceId: extra.id, amountPaisa: rs(100000) }] });

  // Bahria: extra excavation & dewatering, issued 3 days ago (not due)
  await invoice(bahria.id, { type: 'OTHER', lines: [{ description: 'Extra excavation & dewatering (basement)', quantity: new Prisma.Decimal(1200), unit: 'cft', ratePaisa: rs(700) }] }, daysAgo(3));
}
