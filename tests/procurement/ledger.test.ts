import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { supplierBalances } from '../../src/modules/procurement/supplierLedger.service.js';
import { useFreshDatabase } from '../helpers.js';
import { api, munshi, owner, pm, supplierId } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();
const DAY = 86_400_000;

async function entry(supplier: string, type: 'OPENING' | 'PURCHASE' | 'PAYMENT', rupees: number, daysAgo: number) {
  await prismaAdmin.supplierLedgerEntry.create({
    data: { tenantId: seeded().malik.id, supplierId: supplier, type, amountPaisa: BigInt(rupees * 100), occurredAt: new Date(Date.now() - daysAgo * DAY) },
  });
}

describe('supplier ledger + payments', () => {
  it('ageing is FIFO: payments settle the oldest debit first', async () => {
    const t = seeded().malik.id;
    const s = await supplierId(t, 'Al-Madina Cement Agency');
    await entry(s, 'OPENING', 100_000, 60);
    await entry(s, 'PURCHASE', 50_000, 20);
    await entry(s, 'PAYMENT', -100_000, 10);
    const b = (await supplierBalances(prismaAdmin, t, [s])).get(s)!;
    expect(b.balancePaisa).toBe(5_000_000n);
    expect(b.oldestUnpaidDays).toBe(20); // the opening balance is paid off; the purchase is the oldest unpaid

    await entry(s, 'PAYMENT', -50_000, 1);
    const settled = (await supplierBalances(prismaAdmin, t, [s])).get(s)!;
    expect(settled).toMatchObject({ balancePaisa: 0n, oldestUnpaidDays: null });

    const list = await api().get('/api/v1/suppliers').set(await pm());
    const row = list.body.data.find((x: { id: string }) => x.id === s);
    expect(row).toMatchObject({ udhaarBalancePaisa: '0', oldestUnpaidDays: null });
  });

  it('cash payment credits the ledger; a cheque starts PENDING and a bounce reverses it', async () => {
    const t = seeded().malik.id;
    const s = await supplierId(t, 'Ittefaq Steel Traders');
    await entry(s, 'OPENING', 500_000, 30);
    const auth = await owner();

    const cash = await api().post('/api/v1/supplier-payments').set(auth).send({ supplierId: s, amountPaisa: '10000000', method: 'CASH', paidOn: '2026-10-01' });
    expect(cash.status).toBe(201);
    expect(cash.body.data).toMatchObject({ status: 'CLEARED', amountPaisa: '10000000' });

    const noNo = await api().post('/api/v1/supplier-payments').set(auth).send({ supplierId: s, amountPaisa: '100', method: 'CHEQUE', paidOn: '2026-10-01' });
    expect(noNo.status).toBe(400);
    const cheque = await api()
      .post('/api/v1/supplier-payments')
      .set(auth)
      .send({ supplierId: s, amountPaisa: '15000000', method: 'CHEQUE', chequeNo: '00412377', chequeDate: '2026-10-04', paidOn: '2026-10-04' });
    expect(cheque.body.data.status).toBe('PENDING');
    let detail = (await api().get(`/api/v1/suppliers/${s}`).set(auth)).body.data;
    expect(detail.udhaarBalancePaisa).toBe('25000000'); // 5,00,000 − 1,00,000 − 1,50,000

    const bounced = await api().patch(`/api/v1/supplier-payments/${cheque.body.data.id}/cheque-status`).set(auth).send({ status: 'BOUNCED', note: 'Insufficient funds' });
    expect(bounced.status).toBe(200);
    expect(bounced.body.data.status).toBe('BOUNCED');
    detail = (await api().get(`/api/v1/suppliers/${s}`).set(auth)).body.data;
    expect(detail.udhaarBalancePaisa).toBe('40000000');

    const again = await api().patch(`/api/v1/supplier-payments/${cheque.body.data.id}/cheque-status`).set(auth).send({ status: 'CLEARED' });
    expect(again.body.error.code).toBe('CHEQUE_ALREADY_SETTLED');
    expect((await api().patch(`/api/v1/supplier-payments/${cash.body.data.id}/cheque-status`).set(auth).send({ status: 'CLEARED' })).body.error.code).toBe('NOT_A_CHEQUE');

    const ledger = await api().get(`/api/v1/suppliers/${s}/ledger`).set(auth);
    expect(ledger.body.data.entries.map((e: { type: string }) => e.type)).toEqual(['PAYMENT_REVERSAL', 'PAYMENT', 'PAYMENT', 'OPENING']);
    expect(ledger.body.data.entries[0].runningBalancePaisa).toBe('40000000');

    const payments = await api().get(`/api/v1/supplier-payments?supplierId=${s}`).set(await pm());
    expect(payments.body.data).toHaveLength(2);
    expect(payments.body.meta.totalPaidPaisa).toBe('10000000'); // the bounced cheque doesn't count
  });

  it('only THEKEDAR records payments; MUNSHI sees no ledger and no balances', async () => {
    const t = seeded().malik.id;
    const s = await supplierId(t, 'Bilal Traders');
    expect((await api().post('/api/v1/supplier-payments').set(await pm()).send({ supplierId: s, amountPaisa: '100', method: 'CASH', paidOn: '2026-10-01' })).status).toBe(403);
    const m = await munshi(t);
    expect((await api().get(`/api/v1/suppliers/${s}/ledger`).set(m)).status).toBe(403);
    expect((await api().get('/api/v1/supplier-payments').set(m)).status).toBe(403);
  });
});
