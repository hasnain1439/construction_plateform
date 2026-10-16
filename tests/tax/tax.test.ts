/**
 * Step 18 — tax: settings (off by default), output tax on invoices (taxable base, rounding,
 * snapshot at issue, project override), client WHT on payments, the two tax reports + exports,
 * permissions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { seedMalikTax } from '../../prisma/seedTax.js';
import { bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';
import { munshi } from '../inventory/fixtures.js';
import { api, attachment, mockPdf, owner, pay, pdfCalls, rs, stageInvoice, stagesOf, today, type Auth } from '../billing/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(() => mockPdf());
const dha = () => seeded().projects.dha.id;
const valencia = () => seeded().projects.valencia.id;

const PRA = { enabled: true, authority: 'PRA', ratePercent: 16, ntn: '1234567-8', strn: '3277876123456' };
const settings = (o: Auth, body: Record<string, unknown>) => api().patch('/api/v1/tax/settings').set(o).send(body);
const draftStage = async (o: Auth, projectId: string, stageId: string) => {
  const res = await api().post(`/api/v1/projects/${projectId}/invoices`).set(o).send({ type: 'STAGE', billingStageId: stageId, force: true, forceNote: 'tax test' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};
const invoice = async (o: Auth, id: string) => (await api().get(`/api/v1/invoices/${id}`).set(o)).body.data;
const clientOf = async (projectId: string) => (await prismaAdmin.project.findUniqueOrThrow({ where: { id: projectId }, include: { client: true } })).client!;

/** Bilal (PM) moved to the Accountant template. */
async function accountant(): Promise<Auth> {
  const o = await owner();
  const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
  const res = await api().patch(`/api/v1/users/${seeded().users.bilal.id}/role`).set(o).send({ roleId: roles.find((r) => r.key === 'ACCOUNTANT')!.id });
  expect(res.status).toBe(200);
  return bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
}

describe('Step 18 — tax settings and output tax', () => {
  it('is off by default: no tax line; switching on needs an authority and a rate', async () => {
    const o = await owner();
    const s = await api().get('/api/v1/tax/settings').set(o);
    expect(s.body.data).toMatchObject({ enabled: false, authority: null, ratePercent: 0, strn: '3277876158392', whtDefaultRatePercent: 8, adviserNote: expect.stringContaining('tax adviser') });
    expect(s.body.data.authorities.map((x: { code: string; defaultRatePercent: number }) => [x.code, x.defaultRatePercent])).toEqual([
      ['PRA', 16],
      ['SRB', 15],
      ['KPRA', 15],
      ['ICT', 16],
    ]);
    const [, plinth] = await stagesOf(dha());
    const inv = await stageInvoice(o, dha(), plinth!.id);
    expect(await invoice(o, inv.id)).toMatchObject({ subtotalPaisa: rs(2775000), taxableBasePaisa: '0', taxPaisa: '0', taxAuthority: null, totalPaisa: rs(2775000) });

    const incomplete = await settings(o, { enabled: true });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error).toMatchObject({ code: 'TAX_SETTINGS_INCOMPLETE', details: { missing: ['authority', 'ratePercent'] } });
    expect((await settings(o, { ratePercent: 31 })).status).toBe(400);
    expect((await settings(o, {})).status).toBe(400);
    expect((await clientOf(dha())).ntn).toBe('4210187-6'); // seed: NTN filled in, tax still off
  });

  it('the demo flag (SEED_TAX_DEMO=1) switches PRA 16 % on; invoices issued after it carry tax', async () => {
    const o = await owner();
    expect(await seedMalikTax(prismaAdmin as unknown as PrismaClient, { tenantId: seeded().malik.id, dhaProjectId: dha(), enable: true })).toEqual({ enabled: true });
    const [, plinth] = await stagesOf(dha());
    const inv = await stageInvoice(o, dha(), plinth!.id);
    expect(await invoice(o, inv.id)).toMatchObject({ taxPaisa: rs(444000), taxAuthority: 'PRA', buyerNtn: '4210187-6', sellerStrn: '3277876158392' });
  });

  it('tax on: tax on the taxable base, NTN / STRN snapshot, frozen at issue; drafts follow the settings', async () => {
    const o = await owner();
    const client = await clientOf(dha());
    await api().patch(`/api/v1/clients/${client.id}`).set(o).send({ ntn: '7654321-0' }).expect(200);
    const on = await settings(o, PRA);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data).toMatchObject({ enabled: true, authority: 'PRA', ratePercent: 16, effectiveLabel: 'PRA Sales Tax', ntn: '1234567-8', strn: '3277876123456' });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'tax.settings.update' } });
    expect(audit.details).toMatchObject({ before: { enabled: false, authority: null }, after: { enabled: true, authority: 'PRA', ratePercent: 16 } });

    const [, plinth, slab] = await stagesOf(dha());
    const draft = await draftStage(o, dha(), plinth!.id);
    // Rs 27,75,000 × 16 % = Rs 4,44,000
    expect(draft).toMatchObject({ subtotalPaisa: rs(2775000), taxableBasePaisa: rs(2775000), taxPaisa: rs(444000), totalPaisa: rs(3219000), taxLabel: 'PRA Sales Tax', taxRatePercent: 16, taxAuthority: 'PRA', sellerNtn: '1234567-8', sellerStrn: '3277876123456', buyerNtn: '7654321-0' });
    const issued = (await api().post(`/api/v1/invoices/${draft.id}/issue`).set(o).send({})).body.data;
    expect(issued).toMatchObject({ status: 'ISSUED', taxPaisa: rs(444000), totalPaisa: rs(3219000), balancePaisa: rs(3219000) });
    const html = pdfCalls.at(-1)!.html;
    expect(html).toContain('PRA Sales Tax');
    expect(html).toContain('3277876123456');
    expect(html).toContain('7654321-0');

    // A draft made now, then the rate changes: the draft follows, the issued invoice does not.
    const second = await draftStage(o, dha(), slab!.id);
    expect(second.taxPaisa).toBe(rs(592000)); // 37,00,000 × 16 %
    await settings(o, { ratePercent: 18, authority: 'PRA', label: 'Punjab ST', strn: '9999999999999' }).expect(200);
    expect(await invoice(o, second.id)).toMatchObject({ taxPaisa: rs(666000), taxRatePercent: 18, taxLabel: 'Punjab ST', sellerStrn: '9999999999999' });
    expect(await invoice(o, issued.id)).toMatchObject({ taxPaisa: rs(444000), taxRatePercent: 16, taxLabel: 'PRA Sales Tax', sellerStrn: '3277876123456', totalPaisa: rs(3219000) });
    await settings(o, { enabled: false }).expect(200);
    expect(await invoice(o, issued.id)).toMatchObject({ taxPaisa: rs(444000) });
    expect(await invoice(o, second.id)).toMatchObject({ taxPaisa: '0', taxAuthority: null, totalPaisa: rs(3700000) });

    // Cancel keeps the snapshot (the register lists it as cancelled)
    const cancelled = (await api().post(`/api/v1/invoices/${issued.id}/cancel`).set(o).send({ reason: 'wrong client' })).body.data;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', taxPaisa: rs(444000), taxAuthority: 'PRA' });
  });

  it('rounds half-up once per invoice on the paisa; owner purchases are not taxed', async () => {
    const o = await owner();
    await settings(o, { enabled: true, authority: 'ICT', ratePercent: 12.5 }).expect(200);
    // Rs 1,000.04 × 12.5 % = 12,500.5 paisa → 12,501
    const inv = await api()
      .post(`/api/v1/projects/${dha()}/invoices`)
      .set(o)
      .send({ type: 'OTHER', lines: [{ description: 'Extra boundary wall', amountPaisa: '100004' }] });
    expect(inv.body.data).toMatchObject({ subtotalPaisa: '100004', taxableBasePaisa: '100004', taxPaisa: '12501', totalPaisa: '112505', taxLabel: 'ICT Sales Tax', taxAuthority: 'ICT' });
    // Two lines: tax on the sum (Rs 0.03 + Rs 0.03 at 12.5 % = 0.75 paisa → 1), not per line (0 + 0)
    const two = await api()
      .post(`/api/v1/projects/${dha()}/invoices`)
      .set(o)
      .send({ type: 'OTHER', lines: [{ description: 'Line one', amountPaisa: '3' }, { description: 'Line two', amountPaisa: '3' }] });
    expect(two.body.data).toMatchObject({ subtotalPaisa: '6', taxPaisa: '1' });
  });

  it('project override: ON in another province, OFF, back to INHERIT', async () => {
    const o = await owner();
    expect((await api().patch(`/api/v1/projects/${dha()}/tax`).set(o).send({ mode: 'ON' })).body.error).toMatchObject({ code: 'TAX_SETTINGS_INCOMPLETE' });
    const [, plinth] = await stagesOf(dha());
    const draft = await draftStage(o, dha(), plinth!.id);
    expect(draft.taxPaisa).toBe('0');

    const karachi = await api().patch(`/api/v1/projects/${dha()}/tax`).set(o).send({ mode: 'ON', authority: 'SRB', ratePercent: 15 });
    expect(karachi.status, JSON.stringify(karachi.body)).toBe(200);
    expect(karachi.body.data).toMatchObject({ mode: 'ON', authority: 'SRB', ratePercent: 15, effective: { taxOn: true, applies: true, authority: 'SRB', ratePercent: 15, label: 'SRB Sales Tax', source: 'PROJECT' }, company: { enabled: false } });
    // The open draft is recalculated; another project stays untaxed
    expect(await invoice(o, draft.id)).toMatchObject({ taxPaisa: rs(416250), taxAuthority: 'SRB', taxLabel: 'SRB Sales Tax' });
    expect((await api().get(`/api/v1/projects/${valencia()}/tax`).set(o)).body.data.effective).toMatchObject({ taxOn: false, applies: false, source: 'OFF' });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'project.tax.update', entityId: dha() } })).toBe(1);

    // Company on (PRA 16 %), project OFF → no tax on this project
    await settings(o, PRA).expect(200);
    await api().patch(`/api/v1/projects/${dha()}/tax`).set(o).send({ mode: 'OFF' }).expect(200);
    expect(await invoice(o, draft.id)).toMatchObject({ taxPaisa: '0' });
    // INHERIT with the SRB override still set → SRB 15 % while the company is on
    await api().patch(`/api/v1/projects/${dha()}/tax`).set(o).send({ mode: 'INHERIT' }).expect(200);
    expect(await invoice(o, draft.id)).toMatchObject({ taxPaisa: rs(416250), taxAuthority: 'SRB' });
    await api().patch(`/api/v1/projects/${dha()}/tax`).set(o).send({ authority: null, ratePercent: null }).expect(200);
    expect(await invoice(o, draft.id)).toMatchObject({ taxPaisa: rs(444000), taxAuthority: 'PRA', taxLabel: 'PRA Sales Tax' });
  });
});

describe('Step 18 — client WHT on payments', () => {
  it('WHT from a rate, validation, reduces the receivable, certificate later', async () => {
    const o = await owner();
    const [, plinth] = await stagesOf(dha());
    const inv = await stageInvoice(o, dha(), plinth!.id);
    expect((await pay(o, dha(), { amountPaisa: rs(92000), whtRatePercent: 8 })).body.error.code).toBe('WHT_NOT_ENABLED');
    expect((await pay(o, dha(), { amountPaisa: rs(92000), whtCertificateNo: 'C-1' })).body.error.code).toBe('WHT_CERTIFICATE_WITHOUT_WHT');

    await settings(o, PRA).expect(200);
    // 8 % of the gross: Rs 92,000 cash → WHT Rs 8,000 (gross Rs 1,00,000)
    const p = await pay(o, dha(), { amountPaisa: rs(92000), whtRatePercent: 8 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.data).toMatchObject({ whtDeductedPaisa: rs(8000), grossPaisa: rs(100000), whtRatePercent: 8, whtCertificate: null, allocatedPaisa: rs(100000) });
    expect(await invoice(o, inv.id)).toMatchObject({ paidPaisa: rs(100000), balancePaisa: rs(2675000) });
    const rec = (await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data;
    expect(rec).toMatchObject({ receivedPaisa: rs(100000), outstandingPaisa: rs(2675000) });

    const mismatch = await pay(o, dha(), { amountPaisa: rs(92000), whtDeductedPaisa: rs(9000), whtRatePercent: 8 });
    expect(mismatch.body.error).toMatchObject({ code: 'WHT_RATE_MISMATCH', details: { expectedPaisa: rs(8000) } });
    expect((await pay(o, dha(), { amountPaisa: rs(1000), whtDeductedPaisa: rs(2000) })).body.error.code).toBe('WHT_TOO_HIGH');
    // Amount only → the rate is worked out (Rs 5,000 of Rs 1,05,000 = 4.76 %)
    const amountOnly = await pay(o, dha(), { amountPaisa: rs(100000), whtDeductedPaisa: rs(5000) });
    expect(amountOnly.body.data).toMatchObject({ whtRatePercent: 4.76, grossPaisa: rs(105000) });

    const file = await attachment(o, 'DOCUMENT');
    const cert = await api().patch(`/api/v1/payments/${p.body.data.id}/wht-certificate`).set(o).send({ certificateNo: 'WHT-2026-00412', certificateDate: today(), attachmentId: file });
    expect(cert.status, JSON.stringify(cert.body)).toBe(200);
    expect(cert.body.data.whtCertificate).toEqual({ number: 'WHT-2026-00412', date: today(), attachmentId: file });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'payment.wht_certificate', entityId: p.body.data.id } })).toBe(1);
    const plain = await pay(o, dha(), { amountPaisa: rs(100) });
    expect((await api().patch(`/api/v1/payments/${plain.body.data.id}/wht-certificate`).set(o).send({ certificateNo: 'X-1' })).body.error.code).toBe('NO_WHT');
    expect((await api().patch(`/api/v1/payments/${p.body.data.id}/wht-certificate`).set(o).send({ certificateNo: null })).body.data.whtCertificate).toBeNull();
  });
});

describe('Step 18 — tax reports', () => {
  async function scenario() {
    const o = await owner();
    const client = await clientOf(dha());
    await api().patch(`/api/v1/clients/${client.id}`).set(o).send({ ntn: '7654321-0' }).expect(200);
    await settings(o, PRA).expect(200);
    const [, plinth, slab, third] = await stagesOf(dha());
    const a = await stageInvoice(o, dha(), plinth!.id); // taxed 16 %
    const b = await stageInvoice(o, dha(), slab!.id); // taxed 16 %, then cancelled
    await api().post(`/api/v1/invoices/${b.id}/cancel`).set(o).send({ reason: 'issued twice' }).expect(200);
    await settings(o, { enabled: false }).expect(200);
    const c = await stageInvoice(o, dha(), third!.id); // untaxed
    await settings(o, { enabled: true }).expect(200);
    const p1 = await pay(o, dha(), { amountPaisa: rs(92000), whtRatePercent: 8, whtCertificateNo: 'WHT-1', allocations: [{ invoiceId: a.id, amountPaisa: rs(100000) }] });
    const p2 = await pay(o, dha(), { amountPaisa: rs(46000), whtRatePercent: 8, allocations: [{ invoiceId: a.id, amountPaisa: rs(50000) }] });
    await pay(o, dha(), { amountPaisa: rs(10000), allocations: [{ invoiceId: a.id, amountPaisa: rs(10000) }] });
    expect([p1.status, p2.status]).toEqual([201, 201]);
    return { o, client, a, b, c, third: third! };
  }

  it('WHT summary: per client × month, certificates received / missing', async () => {
    const { o, client } = await scenario();
    const r = await api().get('/api/v1/reports/wht-summary').set(o);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.subtitle).toMatch(/Tax year 2026-27/);
    expect(r.body.data.rows).toEqual([
      {
        client: client.name,
        ntn: '7654321-0',
        month: today().slice(0, 7),
        payments: 3,
        gross: rs(160000),
        cashReceived: rs(148000),
        wht: rs(12000),
        whtRate: 7.5,
        certificatesReceived: 1,
        certificatesMissing: 1,
        whtWithoutCertificate: rs(4000),
      },
    ]);
    expect(r.body.data.totals).toMatchObject({ payments: 3, wht: rs(12000), certificatesMissing: 1 });
    expect(r.body.data.notes.join(' ')).toContain('missing certificates');
    // A period with nothing in it
    expect((await api().get('/api/v1/reports/wht-summary?from=2025-07-01&to=2026-06-30').set(o)).body.data.rows).toEqual([]);
  });

  it('tax-wise invoice register: taxed, untaxed and cancelled invoices; totals skip cancelled', async () => {
    const { o, client, a, b, c } = await scenario();
    const r = (await api().get(`/api/v1/reports/tax-invoice-register?projectId=${dha()}`).set(o)).body.data;
    expect(r.rows.map((x: Record<string, unknown>) => [x['number'], x['authority'], x['taxRate'], x['tax'], x['invoiceStatus']])).toEqual([
      [a.number, 'PRA', 16, rs(444000), 'PARTLY_PAID'],
      [b.number, 'PRA', 16, rs(592000), 'CANCELLED'],
      [c.number, null, 0, '0', 'ISSUED'],
    ]);
    expect(r.rows[0]).toMatchObject({ client: client.name, clientNtn: '7654321-0', code: 'MSB-2026-012', value: rs(2775000), taxableValue: rs(2775000), total: rs(3219000) });
    expect(r.totals).toMatchObject({ taxableValue: rs(2775000), tax: rs(444000), value: rs(2775000 + Number(c.totalPaisa) / 100) });
    expect(r.notes[0]).toBe('PRA 16%: taxable Rs 27,75,000 · tax Rs 4,44,000 (1 invoice)');
    expect(r.notes.join(' ')).toContain('1 cancelled invoice is listed');

    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      const file = await api().get(`/api/v1/reports/tax-invoice-register?format=${format}&lang=ur`).set(o);
      expect(file.status, JSON.stringify(file.body)).toBe(200);
      expect(file.body.data).toMatchObject({ format, url: expect.any(String), fileName: expect.stringMatching(new RegExp(`^tax-invoice-register-.*\\.${format}$`)) });
    }
    const csv = await prismaAdmin.attachment.findFirstOrThrow({ where: { kind: 'REPORT', fileName: { endsWith: '.csv' } } });
    expect(csv.mimeType).toBe('text/csv');
    expect(pdfCalls.at(-1)!.html).toContain('ٹیکس وار انوائس رجسٹر');
  });

  it('who may run them: tax.view + fields.amounts (owner, Accountant); never a PM by default or the Munshi', async () => {
    await scenario();
    const m = await munshi(seeded().malik.id);
    expect((await api().get('/api/v1/reports/wht-summary').set(m)).body.error.code).toMatch(/FORBIDDEN|PERMISSION_DENIED/);
    const p = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    expect((await api().get('/api/v1/reports/tax-invoice-register').set(p)).status).toBe(403);
    expect((await api().get('/api/v1/tax/settings').set(p)).status).toBe(403);

    const acc = await accountant();
    expect((await api().get('/api/v1/reports/tax-invoice-register').set(acc)).status).toBe(200);
    expect((await api().get('/api/v1/tax/settings').set(acc)).status).toBe(200);
    expect((await api().patch('/api/v1/tax/settings').set(acc).send({ enabled: false })).status).toBe(403);
    expect((await api().patch(`/api/v1/projects/${dha()}/tax`).set(acc).send({ mode: 'OFF' })).status).toBe(403);

    // Accountant without fields.amounts → 403 on the reports
    const o = await owner();
    await api()
      .put(`/api/v1/users/${seeded().users.bilal.id}/permission-overrides`)
      .set(o)
      .send({ overrides: [{ key: 'fields.amounts', effect: 'DENY' }] })
      .expect(200);
    const noAmounts = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    expect((await api().get('/api/v1/reports/wht-summary').set(noAmounts)).status).toBe(403);
  });
});
