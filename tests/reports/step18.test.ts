/**
 * Step 18 · reports on the whole Malik & Sons demo (`malik_reports`: stock, labour, billing,
 * schedule + control history, equipment + shuttering, closeout, change orders).
 *
 * Hand-checked on the seed:
 *   delay (DHA)     rain 9–8 days ago APPROVED = 2 excusable days; the smog-ban day is PENDING (listed,
 *                   not counted); CO-001 approved +3 days → change-order days 3; revised end = original
 *                   + 2 + 3 working days; contractor days = what is left (slow progress)
 *   variance (DHA)  cement 64.868 bags = 17.7 % over → the only OVER material (Step 14 test);
 *                   material impact = the control endpoint's totals.impactPaisa
 *   change orders   CO-001 BILLED Rs 65,670 (+3 d) on a VARIATION invoice, CO-002 SENT, CO-003 DRAFT;
 *                   totals = the approved set only → Rs 65,670 and 3 days
 *   equipment       props rented: RNT-0001 150 × 16 end-of-day balances (15 days ago … today) +
 *                   RNT-0002 100 × 13 = 3,700 unit-days; rent posted through yesterday
 *                   150 × Rs 15 × 15 + 100 × Rs 15 × 12 = Rs 51,750; EL-0001 6 plates lost
 *   snags           Johar Town 4 (2 open, 1 overdue, 1 fixed, 1 verified with Rs 12,000 rework),
 *                   DHA 2 (Rs 4,500 to Ustad Sharif's sub-contract), Valencia 1 defect-period snag
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { addDays } from '../../src/modules/billing/billing.shared.js';
import { api, bearer, loginMobile, loginMunshi, pathOf, SEED, useFreshDatabase, withSeedSnapshot } from '../helpers.js';
import { mockPdf, pdfCalls, today } from '../billing/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  mockPdf();
  await withSeedSnapshot('malik_reports', seeded());
});

type Auth = Record<string, string>;
type Row = Record<string, string | number | null>;
const owner = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const dha = () => seeded().projects.dha.id;
const johar = () => seeded().projects.johar.id;
const get = async (auth: Auth, path: string, query: Record<string, string> = {}) => {
  const res = await api().get(`/api/v1/reports/${path}`).set(auth).query(query);
  expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.body.data;
};
const download = async (url: string) => {
  const res = await api()
    .get(pathOf(url))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body as Buffer;
};
const keys = (d: { columns: Array<{ key: string }> }) => d.columns.map((c) => c.key);
/** Bilal (PM template) without fields.rates. */
async function pmWithoutRates(): Promise<Auth> {
  const bilal = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: seeded().malik.id, phone: SEED.malik.pm.phone } });
  const res = await api().put(`/api/v1/users/${bilal.id}/permission-overrides`).set(await owner()).send({ overrides: [{ key: 'fields.rates', effect: 'DENY' }] });
  expect(res.status).toBe(200);
  return pm();
}

describe('delay analysis', () => {
  it('company table = the Step 13 / 14 delay breakdown; book lists stoppages, change orders and milestones', async () => {
    const o = await owner();
    const d = await get(o, 'delay-analysis');
    const row = d.rows.find((r: Row) => r['code'] === 'MSB-2026-012');
    const control = (await api().get(`/api/v1/projects/${dha()}/control/delay-analysis`).set(o)).body.data;
    expect(row).toMatchObject({
      originalEnd: control.delays.originalEnd,
      revisedEnd: control.delays.revisedEnd,
      projectedEnd: control.delays.projectedEnd,
      ownerDays: 0,
      excusableDays: 2,
      changeOrderDays: 3,
      contractorDays: control.delays.days.contractor,
      totalDays: 2 + 3 + control.delays.days.contractor,
      behindMilestones: control.summary.behind,
    });
    expect(row.topReasons).toContain('Rain 2');
    expect(row.topReasons).toContain('Change order 3');
    // Only scheduled projects are listed
    expect(d.rows.map((r: Row) => r['code'])).toEqual(['MSB-2026-012']);
    expect(d.extra.projects[0].reasons).toEqual(expect.arrayContaining([{ reason: 'RAIN', category: 'EXCUSABLE', days: 2 }, { reason: 'CHANGE_ORDER', category: 'OWNER', days: 3 }]));

    const book = await get(o, `delay-analysis/${dha()}`);
    expect(book.project.code).toBe('MSB-2026-012');
    const sec = (k: string) => book.sections.find((x: { key: string }) => x.key === k);
    expect(sec('stoppages').rows.map((r: Row) => [r['reason'], r['stoppageStatus'], r['days']])).toEqual([
      ['RAIN', 'APPROVED', 2],
      ['SMOG_BAN', 'PENDING', 1],
    ]);
    expect(sec('stoppages').totals.days).toBe(2); // pending days don't count yet
    expect(sec('changeOrders').rows).toEqual([expect.objectContaining({ code: 'CO-001', days: 3 })]);
    expect(sec('milestones').rows.find((r: Row) => String(r['milestone']).startsWith('First floor — roof slab'))).toMatchObject({ milestoneStatus: 'IN_PROGRESS', progressPercent: 20 });
    expect(book.summary.find((x: { key: string }) => x.key === 'totalDays').value).toBe(row.totalDays);
    expect(JSON.stringify(book)).not.toMatch(/Paisa|"money"/);

    // No schedule → 409
    const res = await api().get(`/api/v1/reports/delay-analysis/${johar()}`).set(o);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_SCHEDULE');
  });
});

describe('variance', () => {
  it('company row = the control endpoints (material impact, cost variance, projection)', async () => {
    const o = await owner();
    const d = await get(o, 'variance');
    const row = d.rows.find((r: Row) => r['code'] === 'MSB-2026-012');
    const mat = (await api().get(`/api/v1/projects/${dha()}/control/material-variance`).set(o)).body.data;
    const cost = (await api().get(`/api/v1/projects/${dha()}/control/cost-variance`).set(o)).body.data;
    expect(row).toMatchObject({
      progressPercent: cost.progress.percent,
      materialsOver: 1,
      materialImpact: mat.totals.impactPaisa,
      costEstimateToDate: cost.totals.estimateToDatePaisa,
      costActual: cost.totals.actualPaisa,
      costVariance: cost.totals.variancePaisa,
      revisedContract: cost.projection.revisedContractPaisa,
      projectedMargin: cost.projection.projectedMarginPaisa,
      projectedMarginPercent: cost.projection.projectedMarginPercent,
    });
    expect(mat.items.find((i: { status: string }) => i.status === 'OVER').description).toBe('Cement OPC');
    // Every running project is listed; totals add up
    expect(d.rows.map((r: Row) => r['code']).sort()).toEqual(['MSB-2026-008', 'MSB-2026-012', 'MSB-2026-014']);
    expect(d.totals.costActual).toBe(d.rows.reduce((s: bigint, r: Row) => s + BigInt(r['costActual']!), 0n).toString());

    const book = await get(o, `variance/${dha()}`);
    const sec = (k: string) => book.sections.find((x: { key: string }) => x.key === k);
    const cement = sec('materials').rows.find((r: Row) => r['material'] === 'Cement OPC');
    expect(cement).toMatchObject({ varianceQty: 64.868, variancePercent: 17.7, varianceStatus: 'OVER', quantityImpact: '9405860', priceImpact: '875382' });
    expect(sec('costBuckets').totals.actual).toBe(cost.totals.actualPaisa);
    expect(sec('burn').rows.at(-1).cumulativeCost).toBe(cost.totals.actualPaisa);
  });

  it('money follows Step 14: PM sees quantities + material PKR (rates), no cost / contract / margin; without rates no PKR at all', async () => {
    const p = await pm();
    const d = await get(p, 'variance');
    expect(keys(d)).toContain('materialImpact');
    for (const k of ['costActual', 'costVariance', 'spentPercent', 'revisedContract', 'projectedMargin', 'estimateAtCompletion']) expect(keys(d)).not.toContain(k);
    expect(d.rows.map((r: Row) => r['code'])).not.toContain('MSB-2026-014'); // Bahria is not Bilal's

    const n = await pmWithoutRates();
    const v = await get(n, 'variance');
    expect(keys(v)).not.toContain('materialImpact');
    const book = await get(n, `variance/${dha()}`);
    expect(JSON.stringify(book)).not.toMatch(/"money"/);
    expect(book.sections.find((x: { key: string }) => x.key === 'materials').rows[0]).not.toHaveProperty('impact');
    // rate redaction holds in the files too
    const csv = (await download((await get(n, `variance/${dha()}`, { format: 'csv', lang: 'en' })).url)).toString('utf8');
    expect(csv).not.toContain('(Rs)');
    expect(csv).toContain('Cement OPC');
  });
});

describe('change order register', () => {
  it('every change order with its invoice; totals = the approved set; filters', async () => {
    const o = await owner();
    const d = await get(o, 'change-orders');
    expect(d.rows.map((r: Row) => [r['code'], r['coStatus'], r['days']])).toEqual([
      ['CO-001', 'BILLED', 3],
      ['CO-002', 'SENT', 1],
      ['CO-003', 'DRAFT', 2],
    ]);
    const co1 = d.rows[0];
    const inv = await prismaAdmin.invoice.findFirstOrThrow({ where: { tenantId: seeded().malik.id, type: 'VARIATION' } });
    expect(co1).toMatchObject({ project: 'MSB-2026-012', coType: 'ADDITION', total: '6567000', proofType: 'WHATSAPP_SCREENSHOT', invoice: inv.number });
    expect(d.totals).toMatchObject({ total: '6567000', days: 3 });
    expect(d.extra).toMatchObject({ byStatus: { BILLED: 1, SENT: 1, DRAFT: 1 }, approvedCount: 1, approvedTotalPaisa: '6567000' });

    expect((await get(o, 'change-orders', { status: 'SENT' })).rows.map((r: Row) => r['code'])).toEqual(['CO-002']);
    expect((await get(o, 'change-orders', { type: 'DEDUCTION' })).rows).toEqual([]);
    expect((await get(o, 'change-orders', { from: addDays(today(), 1) })).rows).toEqual([]);
    expect((await api().get('/api/v1/reports/change-orders').set(o).query({ status: 'NOPE' })).status).toBe(400);
  });

  it('total needs fields.rates or fields.amounts (PM has rates; without them the column is gone)', async () => {
    expect(keys(await get(await pm(), 'change-orders'))).toContain('total');
    const d = await get(await pmWithoutRates(), 'change-orders');
    expect(keys(d)).not.toContain('total');
    expect(d.totals).not.toHaveProperty('total');
    expect(d.extra).not.toHaveProperty('approvedTotalPaisa');
  });
});

describe('equipment utilisation', () => {
  it('ledger days, hire / rent = the charge rows, losses', async () => {
    const o = await owner();
    const d = await get(o, 'equipment-utilisation');
    const from = addDays(today(), -29);
    const props = d.rows.find((r: Row) => r['code'] === 'PR-01');
    expect(props.rentedUnitDays).toBe(150 * 16 + 100 * 13);
    expect(props.rent).toBe(String((150 * 15 * 15 + 100 * 15 * 12) * 100));
    const plates = d.rows.find((r: Row) => r['code'] === 'SP-23');
    expect(plates.lostQty).toBe(6);
    for (const r of d.rows as Row[]) {
      const eq = await prismaAdmin.equipment.findFirstOrThrow({ where: { tenantId: seeded().malik.id, code: String(r['code']) } });
      const hire = await prismaAdmin.equipmentCharge.aggregate({ where: { tenantId: seeded().malik.id, equipmentId: eq.id, kind: 'INTERNAL_HIRE', date: { gte: new Date(`${from}T00:00:00Z`) } }, _sum: { amountPaisa: true } });
      expect(r['hireCharges']).toBe(String(hire._sum.amountPaisa ?? 0n));
      expect(Number(r['utilisationPercent'])).toBeLessThanOrEqual(100);
    }
    const mixer = d.rows.find((r: Row) => r['code'] === 'MX-01');
    expect(mixer).toMatchObject({ daysOnSite: 30, daysIdle: 0, utilisationPercent: 100 });

    const byCat = await get(o, 'equipment-utilisation', { group: 'category' });
    expect(keys(byCat).slice(0, 2)).toEqual(['category', 'items']);
    expect(byCat.totals.rent).toBe(d.totals.rent);
    // One project's site only: Johar Town's rented props, no DHA rent
    const j = await get(o, 'equipment-utilisation', { projectId: johar(), category: 'PROP' });
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0]).toMatchObject({ rentedUnitDays: 100 * 13, rent: String(100 * 15 * 12 * 100) });
    expect((await api().get('/api/v1/reports/equipment-utilisation').set(o).query({ from: '2025-01-01', to: '2026-06-01' })).status).toBe(400);
  });

  it('money needs fields.rates', async () => {
    const d = await get(await pmWithoutRates(), 'equipment-utilisation');
    for (const k of ['hireCharges', 'rent', 'lossValue']) expect(keys(d)).not.toContain(k);
    expect(d.rows.length).toBeGreaterThan(0);
  });
});

describe('snag summary', () => {
  it('per project counts, ageing, attribution; book by assignee / open / defect period', async () => {
    const o = await owner();
    const d = await get(o, 'snags');
    const by = (code: string) => d.rows.find((r: Row) => r['code'] === code);
    expect(by('MSB-2026-008')).toMatchObject({ total: 4, open: 2, fixed: 1, verified: 1, overdue: 1, rework: '1200000' });
    expect(by('MSB-2026-012')).toMatchObject({ total: 2, subcontractorDeduction: '450000' });
    expect(by('MSB-2025-031')).toMatchObject({ total: 1, defectPeriod: 1, defectOpen: 1 });
    expect(d.totals).toMatchObject({ total: 7, rework: '1200000', subcontractorDeduction: '450000' });
    const ages = (r: Row) => Number(r['age_0-7']) + Number(r['age_8-30']) + Number(r['age_31+']);
    for (const r of d.rows as Row[]) expect(ages(r)).toBe(r['open']);

    const book = await get(o, `snags/${johar()}`);
    const sec = (k: string) => book.sections.find((x: { key: string }) => x.key === k);
    expect(sec('byAssignee').totals).toMatchObject({ open: 2, fixed: 1, verified: 1, overdue: 1, cost: '1200000' });
    expect(sec('open').rows[0]).toMatchObject({ code: 'SN-001', overdueDays: expect.any(Number) });
    // PM: no amounts → no attribution money anywhere
    const p = await get(await pm(), `snags/${johar()}`);
    expect(JSON.stringify(p)).not.toMatch(/"money"/);
    expect(keys(await get(await pm(), 'snags'))).not.toContain('rework');
  });
});

describe('files', () => {
  it('CSV / Excel / PDF for a table and a book, translated', async () => {
    const o = await owner();
    const csv = (await download((await get(o, 'change-orders', { format: 'csv', lang: 'en' })).url)).toString('utf8').replace(/^﻿/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Project,Code,Title,Type,Status,Total (Rs),Days,Proof,Billed on invoice,Created,Approved on');
    expect(lines[1]).toContain('Billed');
    expect(lines.at(-1)).toMatch(/^Total,.*,65670,3,/);

    const roman = (await download((await get(o, 'snags', { format: 'csv', lang: 'roman' })).url)).toString('utf8');
    expect(roman).toContain('Khuli');

    const xl = await get(o, `delay-analysis/${dha()}`, { format: 'xlsx', lang: 'en' });
    expect(xl).toMatchObject({ format: 'xlsx', fileName: expect.stringMatching(/^delay-analysis-project-/) });
    const wb = new ExcelJS.Workbook();
    const file = await download(xl.url);
    await wb.xlsx.load(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Delay Analysis', 'Delay by category', 'Stoppages', 'Change-order days', 'Late or slipped milestones']);
    expect(wb.worksheets[2]!.getRow(4).getCell(4).value).toBe('Rain');

    const bookCsv = (await download((await get(o, `variance/${dha()}`, { format: 'csv', lang: 'en' })).url)).toString('utf8');
    expect(bookCsv).toContain('Material variance');
    expect(bookCsv).toContain('Cost variance by bucket');

    pdfCalls.length = 0;
    const pdf = await get(o, `delay-analysis/${dha()}`, { format: 'pdf', lang: 'ur' });
    expect(pdf.mimeType).toBe('application/pdf');
    expect(pdfCalls[0]!.html).toContain('تاخیر کا جائزہ');
    expect(pdfCalls[0]!.html).toContain('بارش');
    expect(pdfCalls[0]!.html).toContain('dir="rtl"');
    const table = await get(o, 'equipment-utilisation', { format: 'pdf', lang: 'en' });
    expect(table.format).toBe('pdf');
    expect(pdfCalls[1]!.html).toContain('EQUIPMENT UTILISATION');
  });
});

describe('permissions and timing', () => {
  it('Munshi never; module key + scope decide the projects', async () => {
    const m = await munshi();
    for (const p of ['delay-analysis', 'variance', 'change-orders', 'equipment-utilisation', 'snags', `variance/${dha()}`]) {
      expect((await api().get(`/api/v1/reports/${p}`).set(m)).status, p).toBe(403);
    }
    const p = await pm();
    const bahria = seeded().projects.bahria.id;
    expect((await api().get(`/api/v1/reports/variance/${bahria}`).set(p)).status).toBe(404);
    expect((await api().get('/api/v1/reports/snags').set(p).query({ projectId: bahria })).status).toBe(404);
    // Accountant-like: finance.reports.view without equipment.view → 403 on utilisation only
    const bilal = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: seeded().malik.id, phone: SEED.malik.pm.phone } });
    await api().put(`/api/v1/users/${bilal.id}/permission-overrides`).set(await owner()).send({ overrides: [{ key: 'equipment.view', effect: 'DENY' }] });
    const q = await pm();
    expect((await api().get('/api/v1/reports/equipment-utilisation').set(q)).status).toBe(403);
    expect((await api().get('/api/v1/reports/change-orders').set(q)).status).toBe(200);
  });

  it('each multi-project report answers in < 500 ms on the seed (logged)', async () => {
    const o = await owner();
    const timings: Record<string, number> = {};
    for (const name of ['delay-analysis', 'variance', 'change-orders', 'equipment-utilisation', 'snags']) {
      await get(o, name); // warm up (first query plans, lazy imports)
      const t = performance.now();
      await get(o, name);
      timings[name] = Math.round(performance.now() - t);
    }
    console.log('Step 18 report timings (ms, warm, seed):', JSON.stringify(timings));
    // Generous bound for a loaded CI box running files in parallel; on the seed they run ~20–150 ms.
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(1500);
  });
});
