import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { PNL_BUCKETS, projectCost } from '../../src/modules/billing/projectCost.service.js';
import { useFreshDatabase } from '../helpers.js';
import { api, mockPdf, munshi, owner, pm, pmWithFinancials, rs, seedMalikDemo } from '../dashboard/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  mockPdf();
  await seedMalikDemo(seeded());
});

type PnlRow = { project: { id: string; code: string }; cost: Record<string, string>; costToDatePaisa: string; billedToDatePaisa: string; grossProfitToDatePaisa: string; projectedMarginPercent: null };

describe('GET /finance/pnl', () => {
  it('cost buckets add up to the cost engine’s cost to date; gross profit = billed − cost', async () => {
    const res = await api().get('/api/v1/finance/pnl').set(await owner());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.buckets).toEqual([...PNL_BUCKETS]);
    for (const row of d.projects as PnlRow[]) {
      const buckets = Object.values(row.cost).reduce((s, v) => s + BigInt(v), 0n);
      expect(buckets.toString()).toBe(row.costToDatePaisa);
      const engine = await prismaAdmin.$transaction((tx) => projectCost(tx, seeded().malik.id, row.project.id));
      expect(row.costToDatePaisa).toBe(engine.totalPaisa.toString());
      expect(BigInt(row.grossProfitToDatePaisa)).toBe(BigInt(row.billedToDatePaisa) - BigInt(row.costToDatePaisa));
      expect(row.projectedMarginPercent).toBeNull();
    }
    const dha = (d.projects as PnlRow[]).find((r) => r.project.code === 'MSB-2026-012')!;
    expect(dha.billedToDatePaisa).toBe(rs(9250000));
    expect(BigInt(dha.cost['SUBCONTRACT']!)).toBeGreaterThan(0n);
    expect(d.totals.costToDatePaisa).toBe((d.projects as PnlRow[]).reduce((s, r) => s + BigInt(r.costToDatePaisa), 0n).toString());
    expect(d.trend).toHaveLength(12);
    expect(d.trend.reduce((s: bigint, m: { costPaisa: string }) => s + BigInt(m.costPaisa), 0n) <= BigInt(d.totals.costToDatePaisa)).toBe(true);
  });

  it('PM needs profit access and sees only assigned projects; MUNSHI 403', async () => {
    expect((await api().get('/api/v1/finance/pnl').set(await pm())).status).toBe(403);
    const p = await pmWithFinancials(seeded().malik.id);
    const codes = ((await api().get('/api/v1/finance/pnl').set(p)).body.data.projects as PnlRow[]).map((r) => r.project.code).sort();
    expect(codes).toEqual(['MSB-2025-031', 'MSB-2026-008', 'MSB-2026-012']);
    expect((await api().get('/api/v1/finance/pnl').set(p).query({ projectId: seeded().projects.bahria.id })).status).toBe(404);
    expect((await api().get('/api/v1/finance/pnl').set(await munshi(seeded().malik.id))).status).toBe(403);
  });
});

describe('GET /finance/cash-flow', () => {
  it('is an estimate with its assumptions; receipts include what owners owe now', async () => {
    const d = (await api().get('/api/v1/finance/cash-flow').set(await owner()).query({ months: 4 })).body.data;
    expect(d.estimate).toBe(true);
    expect(d.months).toHaveLength(4);
    expect(d.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(d.assumptions.join(' ')).toMatch(/30 days/);
    // Overdue and due balances (28,70,000) land in this month or later; nothing is lost.
    const invoices = d.months.reduce((s: bigint, m: { expectedReceipts: { invoicesPaisa: string } }) => s + BigInt(m.expectedReceipts.invoicesPaisa), 0n) + BigInt(d.beyondHorizonReceiptsPaisa);
    expect(invoices >= BigInt(rs(1100000 + 930000 + 840000))).toBe(true);
    expect(BigInt(d.months[0].expectedReceipts.invoicesPaisa) >= BigInt(rs(1100000 + 450000))).toBe(true); // overdue counted now
    const last = d.months.at(-1);
    expect(last.ownMoneyInvestedAfterPaisa).toBe(d.closingOwnMoneyInvestedPaisa);
  });

  it('owner only', async () => {
    expect((await api().get('/api/v1/finance/cash-flow').set(await pmWithFinancials(seeded().malik.id))).status).toBe(403);
  });
});

describe('GET /finance/receivables + /finance/cash-floats', () => {
  it('receivables carry ageing buckets that add up to the outstanding', async () => {
    const d = (await api().get('/api/v1/finance/receivables').set(await owner())).body.data;
    for (const row of d.items) {
      const aged = row.ageing.reduce((s: bigint, b: { amountPaisa: string }) => s + BigInt(b.amountPaisa), 0n);
      expect(aged.toString()).toBe(row.outstandingPaisa);
    }
    expect(d.totals.ageing.map((b: { bucket: string }) => b.bucket)).toEqual(['0-15', '16-30', '31-60', '60+']);
    expect((await api().get('/api/v1/finance/receivables').set(await pmWithFinancials(seeded().malik.id))).status).toBe(403);
  });

  it('cash floats: Step 7 accounts plus week spend, last count and pending top-ups', async () => {
    const d = (await api().get('/api/v1/finance/cash-floats').set(await owner())).body.data;
    expect(d.totals).toMatchObject({ balancePaisa: rs(9300 + 21500), pendingTopups: 1, pendingTopupsPaisa: rs(40000), holders: 2 });
    const rafaqat = d.items.find((i: { holder: { name: string } }) => i.holder.name === 'Rafaqat Ali');
    expect(rafaqat).toMatchObject({ balancePaisa: rs(9300), lastCount: { differencePaisa: rs(-100) }, pendingTopup: { amountPaisa: rs(40000) } });
    expect(rafaqat.projects.map((p: { code: string }) => p.code)).toContain('MSB-2026-012');
  });
});
