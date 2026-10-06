import { beforeEach, describe, expect, it } from 'vitest';
import { seedMalikBilling } from '../../prisma/seedBilling.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, mockPdf, owner, rs } from './fixtures.js';

const seeded = useFreshDatabase();
beforeEach(() => mockPdf());

const seedBilling = () => {
  const s = seeded();
  return seedMalikBilling(prismaAdmin, { tenantId: s.malik.id, ownerId: s.users.khalid.id, projects: s.projects });
};

describe('billing seed', () => {
  it('Malik & Sons receivables match the demo story', async () => {
    expect(await seedBilling()).toEqual({ skipped: false });
    expect(await seedBilling()).toEqual({ skipped: true });
    const o = await owner();
    const rec = async (id: string) => (await api().get(`/api/v1/projects/${id}/receivables`).set(o)).body.data;
    const p = seeded().projects;

    const dha = await rec(p.dha.id);
    expect(dha).toMatchObject({ revisedContractPaisa: rs(18500000), invoicedPaisa: rs(9250000), receivedPaisa: rs(8150000), outstandingPaisa: rs(1100000), overduePaisa: rs(1100000), pendingChequesPaisa: '0' });
    expect(dha.stages.map((s: { status: string }) => s.status)).toEqual(['PAID', 'PAID', 'PARTLY_PAID', 'UPCOMING', 'UPCOMING', 'UPCOMING', 'UPCOMING', 'UPCOMING']);
    expect(dha.stages[3].expectedDate).toBe('2026-11-19');
    expect(dha.nextBillableStage).toMatchObject({ label: 'Grey structure — first floor & roof' });

    expect(await rec(p.johar.id)).toMatchObject({ invoicedPaisa: rs(8830000), receivedPaisa: rs(7900000), outstandingPaisa: rs(930000), overduePaisa: rs(450000), oldestOverdueDays: 21 });
    expect(await rec(p.bahria.id)).toMatchObject({ invoicedPaisa: rs(11040000), receivedPaisa: rs(10200000), outstandingPaisa: rs(840000), overduePaisa: '0' });
    expect(await rec(p.valencia.id)).toMatchObject({ invoicedPaisa: rs(3990000), receivedPaisa: rs(3990000), outstandingPaisa: '0', retentionHeldPaisa: rs(210000) });

    const payments = (await api().get(`/api/v1/projects/${p.dha.id}/payments`).set(o)).body;
    expect(payments.data.find((x: { chequeNo: string | null }) => x.chequeNo === '118845')).toMatchObject({ status: 'BOUNCED', bounceReason: 'insufficient funds' });
    const events = (await api().get('/api/v1/billing-events').set(o).query({ openOnly: 'true' })).body.data.map((e: { type: string; project: { code: string } }) => `${e.type} ${e.project.code}`);
    expect(events).toEqual(expect.arrayContaining(['CHEQUE_BOUNCED MSB-2026-012', 'INVOICE_OVERDUE MSB-2026-012', 'INVOICE_OVERDUE MSB-2026-008']));
    const company = (await api().get('/api/v1/receivables').set(o)).body.data;
    expect(company.totals).toMatchObject({ outstandingPaisa: rs(1100000 + 930000 + 840000), overdueProjects: 2 });
  });
});
