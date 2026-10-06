/**
 * B4 — finance read models. Nothing here re-derives business maths: receivables and own money
 * come from billing (`moneyOf`, `companyReceivables`), cost from the cost engine, supplier dues
 * from the FIFO supplier balances, cash from the cash book.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import { addDays, today, ymd } from '../billing/billing.shared.js';
import { LIVE } from '../billing/ledger.js';
import { bucketsDto, bucketsOf, costRows, PNL_BUCKETS, projectCosts, type CostRow } from '../billing/projectCost.service.js';
import { companyReceivables, moneyOf } from '../billing/receivables.service.js';
import { listAccounts } from '../cashbook/cashbook.service.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { laborSettings, weekOf } from '../labor/labor.shared.js';
import { supplierBalances } from '../procurement/supplierLedger.service.js';
import { findProjectFor } from '../projects/access.js';
import { cached } from '../dashboard/dashboard.cache.js';
import { percent, readActor, scopedProjects, str, type ReadActor } from '../dashboard/dashboard.shared.js';
import type { CashFlowQuery, PnlQuery } from './finance.schema.js';

const NON_DRAFT = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED'] as const;
export const SUPPLIER_TERMS_DAYS = 30;
export const RUN_RATE_WEEKS = 8;

function ownerOnly(a: ReadActor, what: string) {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', `Only the owner sees ${what}`);
}

// ─── Receivables (Step 8 + ageing) ──────────────────────────────────────────

export const receivables = companyReceivables;

// ─── Cash-flow outlook ──────────────────────────────────────────────────────

const monthKey = (date: string) => date.slice(0, 7);
function nextMonths(from: string, n: number): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
/** `n` months ending with `last` (YYYY-MM), oldest first. */
function monthsEndingWith(last: string, n: number): string[] {
  const [y, m] = last.split('-').map(Number) as [number, number];
  const startIndex = y * 12 + (m - 1) - (n - 1);
  return nextMonths(`${Math.floor(startIndex / 12)}-${String((startIndex % 12) + 1).padStart(2, '0')}-01`, n);
}
const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const RUN_RATE_GROUP: Partial<Record<CostRow['source'], 'wages' | 'subcontract' | 'expenses'>> = {
  WAGES: 'wages',
  ADVANCE_WORKER: 'wages',
  KHARCHA_LABOR: 'wages',
  SUBCONTRACT: 'subcontract',
  ADVANCE_SUBCONTRACTOR: 'subcontract',
  KHARCHA_OVERHEAD: 'expenses',
  KHARCHA_EQUIPMENT: 'expenses',
  KHARCHA_MATERIAL: 'expenses',
};

async function buildCashFlow(tx: Tx, a: ReadActor, months: number) {
  const day = today();
  const list = nextMonths(day, months);
  const thisMonth = list[0]!;
  const bucketMonth = (date: string) => (date < day ? thisMonth : monthKey(date));
  const zero = () => Object.fromEntries(list.map((m) => [m, 0n])) as Record<string, bigint>;

  const projects = await scopedProjects(tx, a, [...NON_DRAFT]);
  const ids = projects.map((p) => p.id);
  const running = projects.filter((p) => p.status === 'ACTIVE' || p.status === 'CLOSEOUT').map((p) => p.id);

  // Receipts: what owners owe (by due date; overdue counts now) + stages with an expected date.
  const invoiceIn = zero();
  const stageIn = zero();
  let beyond = 0n;
  const invoices = await tx.invoice.findMany({ where: { tenantId: a.tenantId, projectId: { in: ids }, status: { in: ['ISSUED', 'PARTLY_PAID'] }, balancePaisa: { gt: 0n } }, select: { dueDate: true, issueDate: true, balancePaisa: true } });
  for (const i of invoices) {
    const m = bucketMonth(ymd(i.dueDate) ?? ymd(i.issueDate) ?? day);
    if (m in invoiceIn) invoiceIn[m]! += i.balancePaisa;
    else beyond += i.balancePaisa;
  }
  const stages = await tx.projectBillingStage.findMany({ where: { tenantId: a.tenantId, projectId: { in: ids }, status: { in: ['UPCOMING', 'READY'] }, expectedDate: { not: null } }, select: { expectedDate: true, amountPaisa: true } });
  for (const s of stages) {
    const m = bucketMonth(ymd(s.expectedDate)!);
    if (m in stageIn) stageIn[m]! += s.amountPaisa;
    else beyond += s.amountPaisa;
  }

  // Outflows: supplier udhaar due 30 days after each unpaid purchase (FIFO) + the labour / site run-rate.
  const supplierOut = zero();
  const suppliers = await tx.supplier.findMany({ where: { tenantId: a.tenantId }, select: { id: true } });
  for (const b of (await supplierBalances(tx, a.tenantId, suppliers.map((s) => s.id))).values()) {
    for (const d of b.openDebits) {
      const due = addDays(ymd(d.at)!, SUPPLIER_TERMS_DAYS);
      const m = bucketMonth(due);
      if (m in supplierOut) supplierOut[m]! += d.leftPaisa;
    }
  }
  const since = addDays(day, -7 * RUN_RATE_WEEKS);
  const recent = await costRows(tx, a.tenantId, { projectIds: running, from: pktDayStart(since), to: pktDayEnd(day) });
  const weekly = { wages: 0n, subcontract: 0n, expenses: 0n };
  for (const r of recent) {
    const g = RUN_RATE_GROUP[r.source];
    if (g) weekly[g] += r.amountPaisa;
  }
  for (const k of Object.keys(weekly) as Array<keyof typeof weekly>) weekly[k] /= BigInt(RUN_RATE_WEEKS);

  const costs = await projectCosts(tx, a.tenantId, ids);
  let opening = 0n;
  for (const p of projects) opening += costs.get(p.id)!.cost.totalPaisa - (await moneyOf(tx, a.tenantId, p)).received;

  let position = opening;
  const rows = list.map((month) => {
    const days = month === thisMonth ? daysInMonth(month) - Number(day.slice(8, 10)) + 1 : daysInMonth(month);
    const runRate = (w: bigint) => (w * BigInt(days)) / 7n;
    const out = { suppliersPaisa: supplierOut[month]!, wagesPaisa: runRate(weekly.wages), subcontractPaisa: runRate(weekly.subcontract), expensesPaisa: runRate(weekly.expenses) };
    const outTotal = out.suppliersPaisa + out.wagesPaisa + out.subcontractPaisa + out.expensesPaisa;
    const inTotal = invoiceIn[month]! + stageIn[month]!;
    const net = inTotal - outTotal;
    position -= net;
    return {
      month,
      days,
      expectedReceipts: { invoicesPaisa: str(invoiceIn[month]!), stagesPaisa: str(stageIn[month]!), totalPaisa: str(inTotal) },
      plannedOutflows: {
        suppliersPaisa: str(out.suppliersPaisa),
        wagesPaisa: str(out.wagesPaisa),
        subcontractPaisa: str(out.subcontractPaisa),
        expensesPaisa: str(out.expensesPaisa),
        totalPaisa: str(outTotal),
      },
      netPaisa: str(net),
      ownMoneyInvestedAfterPaisa: str(position),
    };
  });
  return {
    estimate: true,
    asOf: day,
    months: rows,
    openingOwnMoneyInvestedPaisa: str(opening),
    closingOwnMoneyInvestedPaisa: str(position),
    beyondHorizonReceiptsPaisa: str(beyond),
    weeklyRunRate: { wagesPaisa: str(weekly.wages), subcontractPaisa: str(weekly.subcontract), expensesPaisa: str(weekly.expenses) },
    assumptions: [
      'This is an estimate, not a forecast you can bank on: it only uses what is already in the system.',
      'Expected receipts = unpaid invoice balances in the month they are due (overdue ones are counted in this month) + payment stages that have an expected date (stages without a date are left out).',
      `Supplier udhaar is assumed due ${SUPPLIER_TERMS_DAYS} days after each purchase, paid oldest first (FIFO); anything already past that is counted in this month.`,
      `Wages, sub-contract payments and site kharcha are the average per week of the last ${RUN_RATE_WEEKS} weeks on running projects, times the days in each month (this month: the days left).`,
      'New material purchases, new contracts, change orders and owner credit are not included.',
      'Own money invested starts at today’s figure (spent to date − received) and goes down by each month’s net (receipts − outflows).',
    ],
  };
}

export async function cashFlow(query: CashFlowQuery) {
  const a = readActor();
  ownerOnly(a, 'the cash-flow outlook');
  return cached(a.tenantId, `cashflow|${query.months}`, () => withTenant(a.tenantId, (tx) => buildCashFlow(tx, a, query.months)));
}

// ─── Profit & loss ──────────────────────────────────────────────────────────

export const PROJECTED_MARGIN_NOTE = 'Available after the estimate engine (Phase 2)';

async function buildPnl(tx: Tx, a: ReadActor, query: PnlQuery) {
  if (query.projectId) await findProjectFor(tx, a, query.projectId);
  const projects = await scopedProjects(tx, a, [...NON_DRAFT], query.projectId);
  const ids = projects.map((p) => p.id);
  const to = query.to ?? today();
  const range = { ...(query.from ? { from: pktDayStart(query.from) } : {}), to: pktDayEnd(to) };
  const costs = await projectCosts(tx, a.tenantId, ids, range);

  // Billed = invoice amounts before sales tax; recoverable invoices pass the owner's own purchases through, so they are not income.
  const issued = { tenantId: a.tenantId, projectId: { in: ids }, status: { in: LIVE }, type: { not: 'RECOVERABLE' as const }, issueDate: { ...(query.from ? { gte: dateOnly(query.from) } : {}), lte: dateOnly(to) } };
  const billedBy = new Map((await tx.invoice.groupBy({ by: ['projectId'], where: issued, _sum: { subtotalPaisa: true } })).map((g) => [g.projectId, g._sum.subtotalPaisa ?? 0n]));
  const receivedBy = new Map(
    (
      await tx.clientPayment.groupBy({
        by: ['projectId'],
        where: { tenantId: a.tenantId, projectId: { in: ids }, status: 'CLEARED', receivedOn: { ...(query.from ? { gte: dateOnly(query.from) } : {}), lte: dateOnly(to) } },
        _sum: { amountPaisa: true, whtDeductedPaisa: true },
      })
    ).map((g) => [g.projectId, (g._sum.amountPaisa ?? 0n) + (g._sum.whtDeductedPaisa ?? 0n)]),
  );

  const contracts = new Map<string, bigint>();
  for (const p of projects) contracts.set(p.id, (await moneyOf(tx, a.tenantId, p)).contract);
  const rows = projects.map((p) => {
    const contract = contracts.get(p.id)!;
    const c = costs.get(p.id)!;
    const billed = billedBy.get(p.id) ?? 0n;
    const gp = billed - c.cost.totalPaisa;
    return {
      project: { id: p.id, code: p.code, name: p.name, status: p.status },
      client: p.client,
      revisedContractPaisa: str(contract),
      billedToDatePaisa: str(billed),
      receivedToDatePaisa: str(receivedBy.get(p.id) ?? 0n),
      costToDatePaisa: str(c.cost.totalPaisa),
      cost: bucketsDto(bucketsOf(c.rows)),
      grossProfitToDatePaisa: str(gp),
      marginToDatePercent: billed > 0n ? percent(gp, billed) : null,
      percentBilled: percent(billed, contract),
      percentCostOfContract: percent(c.cost.totalPaisa, contract),
      projectedMarginPercent: null,
      projectedMarginNote: PROJECTED_MARGIN_NOTE,
    };
  });
  const sum = (k: 'revisedContractPaisa' | 'billedToDatePaisa' | 'receivedToDatePaisa' | 'costToDatePaisa' | 'grossProfitToDatePaisa') => rows.reduce((s, r) => s + BigInt(r[k]), 0n);
  const allRows = [...costs.values()].flatMap((c) => c.rows);
  const totals = {
    revisedContractPaisa: str(sum('revisedContractPaisa')),
    billedToDatePaisa: str(sum('billedToDatePaisa')),
    receivedToDatePaisa: str(sum('receivedToDatePaisa')),
    costToDatePaisa: str(sum('costToDatePaisa')),
    cost: bucketsDto(bucketsOf(allRows)),
    grossProfitToDatePaisa: str(sum('grossProfitToDatePaisa')),
    marginToDatePercent: sum('billedToDatePaisa') > 0n ? percent(sum('grossProfitToDatePaisa'), sum('billedToDatePaisa')) : null,
  };

  // Trend: the 12 months ending with `to` — billed (by issue month) vs cost (by month).
  const trendMonths = monthsEndingWith(monthKey(to), 12);
  const trendFrom = `${trendMonths[0]}-01`;
  const trendCost = await costRows(tx, a.tenantId, { projectIds: ids, from: pktDayStart(trendFrom), to: pktDayEnd(to) });
  const trendBilled = await tx.invoice.findMany({ where: { ...issued, issueDate: { gte: dateOnly(trendFrom), lte: dateOnly(to) } }, select: { issueDate: true, subtotalPaisa: true } });
  const trend = trendMonths.map((month) => {
    const billed = trendBilled.filter((i) => ymd(i.issueDate)?.startsWith(month)).reduce((s, i) => s + i.subtotalPaisa, 0n);
    const cost = trendCost.filter((r) => r.month === month).reduce((s, r) => s + r.amountPaisa, 0n);
    return { month, billedPaisa: str(billed), costPaisa: str(cost), grossProfitPaisa: str(billed - cost) };
  });

  return {
    period: { from: query.from ?? null, to },
    buckets: PNL_BUCKETS,
    projects: rows,
    totals,
    trend,
    projectedMarginNote: PROJECTED_MARGIN_NOTE,
  };
}

export async function pnl(query: PnlQuery) {
  const a = readActor();
  if (a.role === 'PM' && !a.seesProfit) throw new Forbidden('FORBIDDEN', 'You need profit access to see the P&L');
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Only the office sees the P&L');
  return cached(a.tenantId, `pnl|${a.userId}|${query.projectId ?? ''}|${query.from ?? ''}|${query.to ?? ''}`, () => withTenant(a.tenantId, (tx) => buildPnl(tx, a, query)));
}

// ─── Cash floats overview (Step 7 accounts + extras) ────────────────────────

export async function cashFloats() {
  const a = readActor();
  const base = await listAccounts({});
  return withTenant(a.tenantId, async (tx) => {
    const ids = base.items.map((i) => i.id);
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(today(), s.weekStart);
    const spent = await tx.cashEntry.groupBy({
      by: ['accountId'],
      where: { tenantId: a.tenantId, accountId: { in: ids }, type: 'EXPENSE', occurredAt: { gte: pktDayStart(week.weekStart), lt: pktDayEnd(week.weekEnd) } },
      _sum: { amountPaisa: true },
    });
    const floated = await tx.cashEntry.groupBy({
      by: ['accountId'],
      where: { tenantId: a.tenantId, accountId: { in: ids }, type: 'FLOAT_IN', status: { not: 'PENDING_ACK' } },
      _sum: { amountPaisa: true },
    });
    const counts = await tx.cashCount.findMany({ where: { tenantId: a.tenantId, accountId: { in: ids } }, orderBy: { countedAt: 'desc' }, distinct: ['accountId'], select: { accountId: true, countedAt: true, differencePaisa: true } });
    const holders = await tx.cashAccount.findMany({
      where: { tenantId: a.tenantId, id: { in: ids } },
      select: { id: true, holder: { select: { phone: true, projectAccess: { select: { project: { select: { id: true, code: true, name: true, status: true } } } } } } },
    });
    const topups = await tx.topupRequest.findMany({
      where: { tenantId: a.tenantId, accountId: { in: ids }, status: 'PENDING' },
      select: { id: true, accountId: true, amountPaisa: true, note: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const items = base.items.map((i) => {
      const count = counts.find((c) => c.accountId === i.id);
      const h = holders.find((x) => x.id === i.id)!;
      const topup = topups.find((t) => t.accountId === i.id);
      return {
        ...i,
        holder: { ...i.holder, phone: h.holder.phone },
        projects: h.holder.projectAccess.map((x) => x.project).filter((p) => p.status === 'ACTIVE' || p.status === 'CLOSEOUT'),
        totalFloatedPaisa: str(floated.find((f) => f.accountId === i.id)?._sum.amountPaisa ?? 0n),
        spentThisWeekPaisa: str(-(spent.find((x) => x.accountId === i.id)?._sum.amountPaisa ?? 0n)),
        lastCount: count ? { countedAt: count.countedAt.toISOString(), differencePaisa: str(count.differencePaisa) } : null,
        pendingTopup: topup ? { id: topup.id, amountPaisa: str(topup.amountPaisa), note: topup.note, requestedAt: topup.createdAt.toISOString() } : null,
      };
    });
    return {
      week,
      items,
      totals: {
        ...base.totals,
        holders: items.length,
        spentThisWeekPaisa: str(items.reduce((s, i) => s + BigInt(i.spentThisWeekPaisa), 0n)),
        pendingTopupsPaisa: str(topups.reduce((s, t) => s + t.amountPaisa, 0n)),
        pendingTopups: topups.length,
      },
    };
  });
}
