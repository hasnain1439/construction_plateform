import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathOf, useFreshDatabase } from '../helpers.js';
import { api, mockPdf, munshi, owner, pdfCalls, pm, pmWithFinancials, rs, seedMalikDemo } from '../dashboard/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  mockPdf();
  await seedMalikDemo(seeded());
});

type Row = Record<string, string | number | null>;
const report = async (auth: Record<string, string>, name: string, query: Record<string, string> = {}) => api().get(`/api/v1/reports/${name}`).set(auth).query(query);
const download = async (url: string) => {
  const res = await api().get(pathOf(url)).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  expect(res.status).toBe(200);
  return res.body as Buffer;
};

describe('reports — JSON matches the source modules', () => {
  it('project summary = receivables + cost engine', async () => {
    const o = await owner();
    const d = (await report(o, 'project-summary')).body.data;
    const dha = d.rows.find((r: Row) => r['code'] === 'MSB-2026-012');
    const rec = (await api().get(`/api/v1/projects/${seeded().projects.dha.id}/receivables`).set(o)).body.data;
    expect(dha).toMatchObject({ contract: rec.revisedContractPaisa, billed: rec.invoicedPaisa, received: rec.receivedPaisa, outstanding: rec.outstandingPaisa, costTotal: rec.spentToDatePaisa, ownMoney: rec.ownMoneyInvestedPaisa });
    const buckets = ['MATERIALS', 'LABOR_WAGES', 'SUBCONTRACT', 'SITE_OVERHEAD', 'EQUIPMENT', 'LOSSES'].reduce((s, k) => s + BigInt(dha[`cost_${k}`]), 0n);
    expect(buckets.toString()).toBe(dha.costTotal);
    expect(d.totals.billed).toBe(d.rows.reduce((s: bigint, r: Row) => s + BigInt(r['billed']!), 0n).toString());
  });

  it('supplier ageing: balances = supplier udhaar, buckets add up', async () => {
    const o = await owner();
    const d = (await report(o, 'supplier-ageing')).body.data;
    const ittefaq = d.rows.find((r: Row) => String(r['supplier']).startsWith('Ittefaq'));
    expect(ittefaq.balance).toBe(rs(1210000));
    for (const r of d.rows as Row[]) {
      const aged = ['0-15', '16-30', '31-60', '60+'].reduce((s, k) => s + BigInt(r[`age_${k}`]!), 0n);
      expect(aged.toString()).toBe(r['balance']);
    }
    expect(d.totals.balance).toBe(rs(740000 + 1210000 + 325000 + 115000 + 86000));
  });

  it('receivables ageing, labour & peshgi, cash book, material audit and stock valuation', async () => {
    const o = await owner();
    const rec = (await report(o, 'receivables-ageing')).body.data;
    expect(rec.totals.outstanding).toBe(rs(1100000 + 930000 + 840000));

    const labor = (await report(o, 'labor-peshgi', { projectId: seeded().projects.dha.id })).body.data;
    const latif = labor.rows.find((r: Row) => String(r['payee']).includes('Latif'));
    expect(latif).toMatchObject({ kind: 'Sub-contractor', balanceDue: rs(-23590) });
    const akram = labor.rows.find((r: Row) => String(r['payee']).includes('Akram'));
    expect(akram).toMatchObject({ kind: 'Worker', peshgiOutstanding: rs(5000) });

    const cash = (await report(o, 'cash-book')).body.data;
    const net = cash.rows.filter((r: Row) => r['holder'] === 'Rafaqat Ali').reduce((s: bigint, r: Row) => s + BigInt(r['net']!), 0n);
    expect(net.toString()).toBe(rs(9300)); // all-time net = cash in hand

    const audit = (await report(o, 'material-audit', { projectId: seeded().projects.dha.id })).body.data;
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.columns.map((c: { key: string }) => c.key)).toContain('value');

    const stock = (await report(o, 'stock-valuation')).body.data;
    expect(stock.rows.some((r: Row) => r['kind'] === 'Store' && r['material'] === 'Cement OPC')).toBe(true);
    expect(stock.totals.value).toBe(stock.rows.reduce((s: bigint, r: Row) => s + BigInt(r['value']!), 0n).toString());
  });
});

describe('reports — files', () => {
  it('CSV: header + rows + total, returned as a signed link', async () => {
    const res = await report(await owner(), 'receivables-ageing', { format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ format: 'csv', mimeType: 'text/csv', fileName: expect.stringMatching(/^receivables-ageing-\d{4}-\d{2}-\d{2}\.csv$/) });
    expect(res.body.data.url).toBeTruthy();
    expect(res.body.data.expiresAt).toBeTruthy();
    const text = (await download(res.body.data.url)).toString('utf8').replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('Code,Project,Client,Invoiced (Rs),Received (Rs),Outstanding (Rs),0-15 days (Rs),16-30 days (Rs),31-60 days (Rs),60+ days (Rs),Overdue (Rs),Oldest overdue (days),Cheques pending (Rs)');
    expect(lines.some((l) => l.startsWith('MSB-2026-012,'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^Total,,,/);
    expect(lines.at(-1)).toContain(',2870000,'); // outstanding total in rupees (Rs 28,70,000)
  });

  it('Excel: opens with exceljs and has the rows', async () => {
    const res = await report(await owner(), 'supplier-ageing', { format: 'xlsx' });
    const wb = new ExcelJS.Workbook();
    const file = await download(res.body.data.url);
    await wb.xlsx.load(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toBe('Supplier Ageing');
    expect(ws.getRow(4).getCell(1).value).toBe('Supplier');
    const names = [];
    for (let i = 5; i <= ws.rowCount; i++) names.push(String(ws.getRow(i).getCell(1).value));
    expect(names).toContain('Total');
    expect(names.some((n) => n.startsWith('Ittefaq'))).toBe(true);
  });

  it('PDF: renders through the PDF service with the letterhead', async () => {
    const res = await report(await owner(), 'stock-valuation', { format: 'pdf' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ format: 'pdf', mimeType: 'application/pdf' });
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]!.html).toContain('STOCK VALUATION');
    expect(pdfCalls[0]!.html).toContain('Malik &amp; Sons Builders');
  });
});

describe('reports — permissions', () => {
  it('owner-only reports, money and rates rules', async () => {
    const p = await pm();
    expect((await report(p, 'supplier-ageing')).status).toBe(403);
    expect((await report(p, 'project-summary')).status).toBe(403); // no financials
    expect((await report(p, 'labor-peshgi', { projectId: seeded().projects.bahria.id })).status).toBe(404);
    const codes = new Set((await report(p, 'labor-peshgi')).body.data.rows.map((r: Row) => r['project']));
    expect(codes.has('MSB-2026-014')).toBe(false);
    expect((await report(await pmWithFinancials(seeded().malik.id), 'project-summary')).status).toBe(200);
    expect((await report(await munshi(seeded().malik.id), 'cash-book')).status).toBe(403);
  });
});
