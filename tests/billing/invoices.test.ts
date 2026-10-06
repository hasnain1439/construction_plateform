import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { munshi } from '../inventory/fixtures.js';
import { api, daysAgo, markReady, mockPdf, owner, pdfCalls, pmWithFinancials, rs, stageInvoice, stagesOf, today } from './fixtures.js';

const seeded = useFreshDatabase();
beforeEach(() => mockPdf());

const dha = () => seeded().projects.dha.id;
const valencia = () => seeded().projects.valencia.id;

describe('B1 — stages', () => {
  it('mark ready needs a photo; warns when an earlier stage is unpaid past due', async () => {
    const o = await owner();
    const [, plinth, slab] = await stagesOf(dha());
    expect((await api().post(`/api/v1/billing-stages/${plinth!.id}/mark-ready`).set(o).send({ proofAttachmentIds: [] })).status).toBe(400);
    const ready = await markReady(o, plinth!.id);
    expect(ready).toMatchObject({ stage: { status: 'READY', proofAttachmentIds: [expect.any(String)] }, warning: null });

    const inv = await stageInvoice(o, dha(), plinth!.id, daysAgo(20)); // due 13 days ago, unpaid
    expect(inv).toMatchObject({ status: 'ISSUED', dueDate: daysAgo(13), totalPaisa: rs(2775000) });
    expect(inv.number).toMatch(/^INV-\d{4}-0001$/);
    expect((await stagesOf(dha()))[1]!.status).toBe('INVOICED');

    const next = await markReady(o, slab!.id);
    expect(next.warning).toMatchObject({ code: 'PREVIOUS_STAGE_UNPAID', details: { stages: [{ invoiceNumber: inv.number, balancePaisa: rs(2775000), overdueDays: 13 }] } });
    const events = await prismaAdmin.billingEvent.findMany({ where: { projectId: dha() } });
    expect(events.map((e) => [e.type, e.resolvedAt === null]).sort()).toEqual([
      ['PREVIOUS_STAGE_UNPAID', true],
      ['STAGE_READY_UNBILLED', false], // plinth: resolved when invoiced
      ['STAGE_READY_UNBILLED', true],
    ]);
    // Expected date is owner-only
    expect((await api().patch(`/api/v1/billing-stages/${slab!.id}`).set(o).send({ expectedDate: '2026-11-19' })).body.data.expectedDate).toBe('2026-11-19');
    const list = await api().get(`/api/v1/projects/${dha()}/billing-stages`).set(o);
    expect(list.body.data[1]).toMatchObject({ status: 'INVOICED', invoice: { number: inv.number } });
  });

  it('billing needs billing.view: MUNSHI and a PM without financials → 403; with financials the PM drafts but cannot issue', async () => {
    const [, plinth] = await stagesOf(dha());
    expect((await api().get(`/api/v1/projects/${dha()}/invoices`).set(await munshi(seeded().malik.id))).status).toBe(403);
    const p = await pmWithFinancials(seeded().malik.id);
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(p).send({ type: 'STAGE', billingStageId: plinth!.id, force: true, forceNote: 'PM draft' });
    expect(draft.status).toBe(201);
    expect((await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(p).send({})).status).toBe(403);
    expect((await api().get(`/api/v1/projects/${seeded().projects.bahria.id}/invoices`).set(p)).status).toBe(404); // not Bilal's project
  });

  it('running-bill progress: CRUD while unbilled; on a draft or billed it is locked', async () => {
    const o = await owner();
    expect((await api().post(`/api/v1/projects/${dha()}/billing-progress`).set(o).send({ date: today(), quantity: 10, description: 'x work' })).body.error.code).toBe('NOT_RUNNING_BILLS');
    const add = (date: string, quantity: number) => api().post(`/api/v1/projects/${valencia()}/billing-progress`).set(o).send({ date, quantity, description: 'Brickwork + plaster' });
    const a = (await add(daysAgo(40), 1000)).body.data;
    const b = (await add(daysAgo(10), 500)).body.data;
    expect(a).toMatchObject({ quantity: 1000, billed: false });
    expect((await api().patch(`/api/v1/billing-progress/${a.id}`).set(o).send({ quantity: 1200 })).body.data.quantity).toBe(1200);
    expect((await api().post(`/api/v1/projects/${valencia()}/billing-progress`).set(o).send({ date: '2099-01-01', quantity: 1, description: 'future' })).body.error.code).toBe('FUTURE_DATE');

    const draft = await api().post(`/api/v1/projects/${valencia()}/invoices`).set(o).send({ type: 'RUNNING_BILL', from: daysAgo(60), to: daysAgo(20) });
    expect(draft.status).toBe(201);
    expect(draft.body.data.lines.map((l: { sourceType: string }) => l.sourceType)).toEqual(['BILLING_PROGRESS', 'RETENTION']);
    expect((await api().patch(`/api/v1/billing-progress/${a.id}`).set(o).send({ quantity: 1 })).body.error.code).toBe('PROGRESS_ON_DRAFT');
    await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(o).send({}).expect(200);
    expect((await api().delete(`/api/v1/billing-progress/${a.id}`).set(o)).body.error.code).toBe('PROGRESS_BILLED');
    expect((await api().delete(`/api/v1/billing-progress/${b.id}`).set(o)).body.data).toEqual({ deleted: true });
  });
});

describe('B2 — invoices', () => {
  it('stage invoice: READY → INVOICED; not ready needs force + note; DRAFT editable, ISSUED locked', async () => {
    const o = await owner();
    const [, plinth] = await stagesOf(dha());
    const notReady = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: plinth!.id });
    expect(notReady.body.error.code).toBe('STAGE_NOT_READY');
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: plinth!.id, force: true })).status).toBe(400);
    await markReady(o, plinth!.id);
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: plinth!.id, notes: 'Plinth complete' });
    expect(draft.body.data).toMatchObject({ status: 'DRAFT', number: null, subtotalPaisa: rs(2775000), taxPaisa: '0', totalPaisa: rs(2775000) });
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: plinth!.id })).body.error.code).toBe('STAGE_ALREADY_INVOICED');
    const id = draft.body.data.id;
    expect((await api().patch(`/api/v1/invoices/${id}`).set(o).send({ notes: 'Plinth + DPC' })).body.data.notes).toBe('Plinth + DPC');
    const issued = await api().post(`/api/v1/invoices/${id}/issue`).set(o).send({});
    expect(issued.body.data).toMatchObject({ status: 'ISSUED', issueDate: today(), dueDate: expect.any(String), pdfAttachmentId: expect.any(String) });
    expect(pdfCalls[0]!.html).toContain(issued.body.data.number);
    expect(pdfCalls[0]!.html).toContain('Rs 27,75,000');
    expect((await stagesOf(dha()))[1]!.status).toBe('INVOICED');
    expect((await api().patch(`/api/v1/invoices/${id}`).set(o).send({ notes: 'x' })).body.error.code).toBe('INVOICE_LOCKED');
    expect((await api().delete(`/api/v1/invoices/${id}`).set(o)).body.error.code).toBe('INVOICE_LOCKED');
    const pdf = await api().get(`/api/v1/invoices/${id}/pdf`).set(o);
    expect(pdf.body.data).toMatchObject({ url: expect.any(String), whatsappText: expect.stringContaining(`DHA Phase 6 · 10 Marla ka invoice ${issued.body.data.number} (Rs 27,75,000)`) });
  });

  it('tax line when tax is on; owner-recoverable kharcha is billed once; cancel releases the sources', async () => {
    const o = await owner();
    await api().patch('/api/v1/company/settings').set(o).send({ taxEnabled: true, taxRatePercent: 16, taxLabel: 'PRA' }).expect(200);
    const t = seeded().malik.id;
    const acc = await prismaAdmin.cashAccount.create({ data: { tenantId: t, holderUserId: seeded().users.rafaqatMalik.id, name: 'Rafaqat' } });
    const tiles = await prismaAdmin.cashEntry.create({
      data: { tenantId: t, accountId: acc.id, projectId: dha(), type: 'EXPENSE', amountPaisa: -280000n, category: 'OWNER_PURCHASE', costBucket: 'RECOVERABLE_FROM_OWNER', description: 'Tile samples', status: 'APPROVED', occurredAt: new Date() },
    });
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'RECOVERABLE', cashEntryIds: [tiles.id] });
    expect(draft.body.data).toMatchObject({ subtotalPaisa: rs(2800), taxPaisa: rs(448), totalPaisa: rs(3248), taxLabel: 'PRA', taxRatePercent: 16 });
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'RECOVERABLE', cashEntryIds: [tiles.id] })).body.error.code).toBe('SOURCE_ALREADY_BILLED');
    const issued = (await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(o).send({})).body.data;
    expect((await prismaAdmin.cashEntry.findUniqueOrThrow({ where: { id: tiles.id } })).billedInvoiceId).toBe(issued.id);

    const cancelled = await api().post(`/api/v1/invoices/${issued.id}/cancel`).set(o).send({ reason: 'Owner wants it on the next stage bill' });
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Owner wants it on the next stage bill' });
    expect((await prismaAdmin.cashEntry.findUniqueOrThrow({ where: { id: tiles.id } })).billedInvoiceId).toBeNull();
    // Now on a stage invoice as an extra line
    const [, plinth] = await stagesOf(dha());
    const stage = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: plinth!.id, force: true, forceNote: 'billing early', extraCashEntryIds: [tiles.id] });
    expect(stage.body.data.lines.map((l: { sourceType: string }) => l.sourceType)).toEqual(['BILLING_STAGE', 'CASH_ENTRY']);
    expect(stage.body.data.subtotalPaisa).toBe(rs(2777800));
  });

  it('cancel with payments → 409; manual (OTHER) invoices are owner-only; retention only after handover', async () => {
    const o = await owner();
    const [, plinth] = await stagesOf(dha());
    const inv = await stageInvoice(o, dha(), plinth!.id);
    await api().post(`/api/v1/projects/${dha()}/payments`).set(o).send({ receivedOn: today(), amountPaisa: rs(100000), method: 'CASH' }).expect(201);
    expect((await api().post(`/api/v1/invoices/${inv.id}/cancel`).set(o).send({ reason: 'mistake here' })).body.error.code).toBe('INVOICE_HAS_PAYMENTS');
    expect((await stagesOf(dha()))[1]!.status).toBe('PARTLY_PAID');

    const p = await pmWithFinancials(seeded().malik.id);
    const other = { type: 'OTHER', lines: [{ description: 'Extra boundary wall', quantity: 120, unit: 'rft', ratePaisa: rs(1500) }] };
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(p).send(other)).status).toBe(403);
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send(other)).body.data.totalPaisa).toBe(rs(180000));
    expect((await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'RETENTION' })).body.error.code).toBe('RETENTION_NOT_DUE');
    const ret = await api().post(`/api/v1/projects/${valencia()}/invoices`).set(o).send({ type: 'RETENTION' });
    expect(ret.status).toBe(201);
    expect(ret.body.data.lines[0].sourceType).toBe('BILLING_STAGE');
  });
});
