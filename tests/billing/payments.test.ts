import { beforeEach, describe, expect, it } from 'vitest';
import { runBillingOverdueCheck } from '../../src/jobs/billingOverdue.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { SEED, useFreshDatabase } from '../helpers.js';
import { api, daysAgo, mockPdf, owner, pay, pdfCalls, pmWithFinancials, rs, stageInvoice, stagesOf } from './fixtures.js';

const seeded = useFreshDatabase();
beforeEach(() => mockPdf());
const dha = () => seeded().projects.dha.id;

/** Stage 2 (Rs 27,75,000, issued 30 days ago) and stage 3 (Rs 37,00,000, issued 3 days ago → not due yet). */
async function twoInvoices() {
  const o = await owner();
  const [, plinth, slab] = await stagesOf(dha());
  const older = await stageInvoice(o, dha(), plinth!.id, daysAgo(30));
  const newer = await stageInvoice(o, dha(), slab!.id, daysAgo(3));
  return { o, older, newer };
}
const invoice = async (o: Record<string, string>, id: string) => (await api().get(`/api/v1/invoices/${id}`).set(o)).body.data;

describe('B3 — payments', () => {
  it('auto-allocates oldest due first; partial payments; WHT settles the invoice', async () => {
    const { o, older, newer } = await twoInvoices();
    const first = await pay(o, dha(), { amountPaisa: rs(3000000), reference: 'FT-1' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ number: expect.stringMatching(/^RV-\d{4}-0001$/), status: 'CLEARED', creditPaisa: '0' });
    expect(first.body.data.allocations.map((a: { invoice: { id: string }; amountPaisa: string }) => [a.invoice.id, a.amountPaisa])).toEqual([
      [older.id, rs(2775000)],
      [newer.id, rs(225000)],
    ]);
    expect(await invoice(o, older.id)).toMatchObject({ status: 'PAID', balancePaisa: '0' });
    expect(await invoice(o, newer.id)).toMatchObject({ status: 'PARTLY_PAID', paidPaisa: rs(225000), balancePaisa: rs(3475000) });
    expect((await stagesOf(dha())).map((s) => s.status).slice(1, 3)).toEqual(['PAID', 'PARTLY_PAID']);

    const noTax = await pay(o, dha(), { amountPaisa: rs(100), whtDeductedPaisa: rs(10) });
    expect(noTax.body.error.code).toBe('WHT_NOT_ENABLED');
    await api().patch('/api/v1/company/settings').set(o).send({ taxEnabled: true }).expect(200);
    const wht = await pay(o, dha(), { amountPaisa: rs(3300000), whtDeductedPaisa: rs(175000), allocations: [{ invoiceId: newer.id, amountPaisa: rs(3475000) }] });
    expect(wht.status).toBe(201);
    expect(await invoice(o, newer.id)).toMatchObject({ status: 'PAID', paidPaisa: rs(3700000), balancePaisa: '0' });
    expect((await pay(o, dha(), { amountPaisa: rs(100), allocations: [{ invoiceId: newer.id, amountPaisa: rs(100) }] })).body.error.code).toBe('INVALID_ALLOCATION');
  });

  it('a pending cheque shows as pending; cleared → paid; bounced → balance returns, event + SMS', async () => {
    const { o, older } = await twoInvoices();
    const cheque = await pay(o, dha(), { amountPaisa: rs(1100000), method: 'CHEQUE', bankName: 'MCB', chequeNo: '118845' });
    expect(cheque.body.data.status).toBe('PENDING');
    expect(await invoice(o, older.id)).toMatchObject({ status: 'ISSUED', paidPaisa: '0', pendingPaisa: rs(1100000), balancePaisa: rs(2775000) });
    expect((await pay(o, dha(), { amountPaisa: rs(1), method: 'CHEQUE' })).status).toBe(400); // cheque no. required

    const second = await pay(o, dha(), { amountPaisa: rs(500000), method: 'CHEQUE', bankName: 'HBL', chequeNo: '004512' });
    await api().patch(`/api/v1/payments/${second.body.data.id}/cheque-status`).set(o).send({ status: 'CLEARED' }).expect(200);
    expect(await invoice(o, older.id)).toMatchObject({ status: 'PARTLY_PAID', paidPaisa: rs(500000), pendingPaisa: rs(1100000) });

    expect((await api().patch(`/api/v1/payments/${cheque.body.data.id}/cheque-status`).set(o).send({ status: 'BOUNCED' })).status).toBe(400); // reason
    const p = await pmWithFinancials(seeded().malik.id);
    expect((await api().patch(`/api/v1/payments/${cheque.body.data.id}/cheque-status`).set(p).send({ status: 'BOUNCED', reason: 'insufficient funds' })).status).toBe(403);
    const bounced = await api().patch(`/api/v1/payments/${cheque.body.data.id}/cheque-status`).set(o).send({ status: 'BOUNCED', reason: 'insufficient funds' });
    expect(bounced.body.data).toMatchObject({ status: 'BOUNCED', bounceReason: 'insufficient funds' });
    expect(await invoice(o, older.id)).toMatchObject({ pendingPaisa: '0', balancePaisa: rs(2275000) });
    expect(lastSmsTo(SEED.malik.owner.phone)?.body).toBe('MCB cheque 118845 (Rs 11,00,000) DHA Phase 6 · 10 Marla bounce ho gaya.');
    expect(await prismaAdmin.billingEvent.count({ where: { type: 'CHEQUE_BOUNCED', resolvedAt: null } })).toBe(1);
    expect((await api().patch(`/api/v1/payments/${cheque.body.data.id}/cheque-status`).set(o).send({ status: 'CLEARED' })).body.error.code).toBe('CHEQUE_ALREADY_SETTLED');
    // Paying the rest settles the invoice the cheque was for → the bounce alert closes
    await pay(o, dha(), { amountPaisa: rs(2275000), allocations: [{ invoiceId: older.id, amountPaisa: rs(2275000) }] });
    expect(await prismaAdmin.billingEvent.count({ where: { type: 'CHEQUE_BOUNCED', resolvedAt: null } })).toBe(0);
  });

  it('overpayment stays as project credit and settles the next invoice on issue; PM may record only when allowed', async () => {
    const o = await owner();
    const [, plinth, slab] = await stagesOf(dha());
    await stageInvoice(o, dha(), plinth!.id);
    const over = await pay(o, dha(), { amountPaisa: rs(3000000) });
    expect(over.body.data.creditPaisa).toBe(rs(225000));
    const rec = await api().get(`/api/v1/projects/${dha()}/receivables`).set(o);
    expect(rec.body.data.creditPaisa).toBe(rs(225000));
    const next = await stageInvoice(o, dha(), slab!.id);
    expect(next).toMatchObject({ status: 'PARTLY_PAID' });
    expect(await invoice(o, next.id)).toMatchObject({ paidPaisa: rs(225000), balancePaisa: rs(3475000) });

    const p = await pmWithFinancials(seeded().malik.id);
    expect((await pay(p, dha(), { amountPaisa: rs(1000) })).status).toBe(403);
    await api().patch('/api/v1/company/settings').set(o).send({ pmCanRecordPayments: true }).expect(200);
    expect((await pay(p, dha(), { amountPaisa: rs(1000) })).status).toBe(201);
  });
});

describe('B4–B6 — receivables, PDFs, statement, events', () => {
  it('receivables: outstanding, overdue days, own money invested; company totals', async () => {
    const { o } = await twoInvoices();
    await pay(o, dha(), { amountPaisa: rs(1000000) });
    await pay(o, dha(), { amountPaisa: rs(500000), method: 'CHEQUE', chequeNo: '1' });
    const r = (await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data;
    expect(r).toMatchObject({
      originalContractPaisa: rs(18500000),
      revisedContractPaisa: rs(18500000),
      invoicedPaisa: rs(6475000),
      receivedPaisa: rs(1000000),
      pendingChequesPaisa: rs(500000),
      outstandingPaisa: rs(5475000),
      overduePaisa: rs(1775000), // the older invoice (due 23 days ago) less Rs 10,00,000
      oldestOverdueDays: 23,
      spentToDatePaisa: '0',
      ownMoneyInvestedPaisa: rs(-1000000),
    });
    expect(r.stages[1]).toMatchObject({ status: 'PARTLY_PAID', invoiceNumber: expect.stringMatching(/^INV-/) });
    const company = (await api().get('/api/v1/receivables').set(o)).body.data;
    expect(company.totals).toMatchObject({ outstandingPaisa: rs(5475000), overdueProjects: 1 });
    expect((await api().get('/api/v1/receivables').set(o).query({ overdueOnly: 'true' })).body.data.items).toHaveLength(1);
  });

  it('owner statement maths + PDF; receipt PDF; 503 when PDFs cannot be made', async () => {
    const { o, older, newer } = await twoInvoices();
    const payment = (await pay(o, dha(), { amountPaisa: rs(1500000), receivedOn: daysAgo(5) })).body.data;
    await pay(o, dha(), { amountPaisa: rs(1100000), method: 'CHEQUE', bankName: 'MCB', chequeNo: '118845', receivedOn: daysAgo(2) });
    const st = (await api().get(`/api/v1/projects/${dha()}/owner-statement`).set(o).query({ from: daysAgo(15) })).body.data;
    expect(st).toMatchObject({ openingPaisa: older.totalPaisa, closingPaisa: rs(2775000 + 3700000 - 1500000), pendingChequesPaisa: rs(1100000) });
    expect(st.rows.map((r: { kind: string; reference: string; status: string | null }) => [r.kind, r.status])).toEqual([
      ['PAYMENT', null],
      ['INVOICE', null],
      ['PAYMENT', 'PENDING'],
    ]);
    expect(st.rows[1].reference).toBe(newer.number);

    pdfCalls.length = 0;
    const pdf = await api().get(`/api/v1/projects/${dha()}/owner-statement/pdf`).set(o).query({ from: daysAgo(15) });
    expect(pdf.body.data.whatsappText).toContain('baqaya Rs 49,75,000');
    expect(pdfCalls[0]!.html).toContain('STATEMENT');
    const receipt = await api().get(`/api/v1/payments/${payment.id}/receipt-pdf`).set(o);
    expect(receipt.body.data).toMatchObject({ url: expect.any(String), clientPhone: expect.stringMatching(/^\+92/) });

    mockPdf(true);
    const failed = await api().get(`/api/v1/projects/${dha()}/owner-statement/pdf`).set(o);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('PDF_UNAVAILABLE');
    // Issuing still works without a PDF
    const [, , , floor1] = await stagesOf(dha());
    const inv = await stageInvoice(o, dha(), floor1!.id);
    expect(inv.status).toBe('ISSUED');
    expect((await api().get(`/api/v1/invoices/${inv.id}/pdf`).set(o)).status).toBe(503);
  });

  it('overdue job is idempotent; open events list for the owner', async () => {
    const { o, older } = await twoInvoices();
    expect((await runBillingOverdueCheck()).marked).toEqual([older.id]); // the newer one is not due yet
    expect((await runBillingOverdueCheck()).marked).toEqual([]);
    const events = (await api().get('/api/v1/billing-events').set(o).query({ openOnly: 'true' })).body.data;
    expect(events.filter((e: { type: string }) => e.type === 'INVOICE_OVERDUE').length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ project: { code: 'MSB-2026-012' }, href: expect.stringContaining('/billing/') });
    await pay(o, dha(), { amountPaisa: rs(2775000) });
    expect(await prismaAdmin.billingEvent.count({ where: { type: 'INVOICE_OVERDUE', refId: older.id, resolvedAt: null } })).toBe(0);
  });
});
