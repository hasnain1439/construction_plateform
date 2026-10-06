/**
 * B3 — dashboards. Read models only: money comes from the billing receivables (`moneyOf`), the
 * cost engine (`projectCosts`), supplier FIFO balances, stock balances and the labour overview.
 *
 * Company overview (THEKEDAR / PM): money keys are left out entirely without billing.view.
 * Site dashboard (MUNSHI / PM / THEKEDAR with access): no rates or values — only the caller's
 * own cash.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { ClientPaymentMethod, Project, WorkerType } from '../../generated/prisma/client.js';
import { collectApprovals } from '../approvals/approvals.service.js';
import { addDays, today, ymd } from '../billing/billing.shared.js';
import { eventHref, eventSeverity, eventTitle } from '../billing/events.service.js';
import { projectCosts } from '../billing/projectCost.service.js';
import { moneyOf } from '../billing/receivables.service.js';
import { totalsOf } from '../cashbook/cash.js';
import { balances, qn, systemLocations } from '../inventory/stock.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { laborOverviewTx } from '../labor/overview.service.js';
import { laborSettings, weekOf } from '../labor/labor.shared.js';
import { subAccounts } from '../labor/subcontractLedger.js';
import { criticalUnread } from '../notifications/notifications.service.js';
import { supplierBalances } from '../procurement/supplierLedger.service.js';
import { findProjectFor } from '../projects/access.js';
import { cached } from './dashboard.cache.js';
import type { OverviewQuery } from './dashboard.schema.js';
import { percent, periodOf, readActor, scopedProjects, str, type Period, type ReadActor } from './dashboard.shared.js';

/** Projects shown on the dashboard (drafts and closed ones are left out). */
export const DASHBOARD_STATUSES = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER'] as const;
/** A project is "at risk" when an invoice is overdue or the own money in it is above this share of the contract. */
export const AT_RISK_OWN_MONEY_PERCENT = 10;

const WORKER_GROUP: Record<WorkerType, 'mistri' | 'mazdoor' | 'other'> = {
  MISTRI: 'mistri',
  MISTRI_TILES: 'mistri',
  MAZDOOR: 'mazdoor',
  STEEL_FIXER_HELPER: 'mazdoor',
  CHOWKIDAR: 'other',
  OTHER: 'other',
};

const METHODS: ClientPaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'JAZZCASH', 'EASYPAISA', 'RAAST'];

type ProjectWithClient = Project & { client: { id: string; name: string } | null };

async function projectMoney(tx: Tx, a: ReadActor, projects: ProjectWithClient[]) {
  const costs = await projectCosts(
    tx,
    a.tenantId,
    projects.map((p) => p.id),
  );
  const rows = [];
  for (const p of projects) {
    const m = await moneyOf(tx, a.tenantId, p);
    const cost = costs.get(p.id)!.cost.totalPaisa;
    const own = cost - m.received;
    const atRisk = m.overdue > 0n || (m.contract > 0n && own * 100n > m.contract * BigInt(AT_RISK_OWN_MONEY_PERCENT));
    rows.push({ project: p, m, cost, own, atRisk });
  }
  return rows;
}

async function siteStats(tx: Tx, a: ReadActor, ids: string[], date: string) {
  const present = await tx.attendance.findMany({
    where: { tenantId: a.tenantId, projectId: { in: ids }, date: dateOnly(date), status: { in: ['FULL', 'HALF'] } },
    select: { worker: { select: { type: true } } },
  });
  const hazri = { mistri: 0, mazdoor: 0, other: 0, total: present.length };
  for (const r of present) hazri[WORKER_GROUP[r.worker.type]] += 1;
  const sites = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, type: 'SITE', projectId: { in: ids } }, select: { id: true } });
  const siteIds = sites.map((s) => s.id);
  const dayStart = pktDayStart(date);
  const dayEnd = pktDayEnd(date);
  const deliveriesToday =
    (await tx.dispatch.count({ where: { tenantId: a.tenantId, toLocationId: { in: siteIds }, receivedAt: { gte: dayStart, lt: dayEnd } } })) +
    (await tx.purchase.count({ where: { tenantId: a.tenantId, locationId: { in: siteIds }, OR: [{ receivedAt: { gte: dayStart, lt: dayEnd } }, { status: 'PENDING_RATE', purchaseDate: dateOnly(date) }] } })) +
    (await tx.ownerDelivery.count({ where: { tenantId: a.tenantId, projectId: { in: ids }, deliveryDate: dateOnly(date) } }));
  const openShortages = await tx.shortage.count({ where: { tenantId: a.tenantId, status: 'OPEN', kind: { not: 'EXCESS' }, ...(a.role === 'THEKEDAR' ? {} : { projectId: { in: ids } }) } });
  return { hazriToday: hazri, deliveriesToday, openShortages };
}

/** Wages of the period by worker type (weekly settlement lines of weeks starting in the period, returned weeks excluded). */
async function laborStats(tx: Tx, a: ReadActor, ids: string[], period: Period) {
  const lines = await tx.wageSettlementLine.findMany({
    where: {
      tenantId: a.tenantId,
      settlement: { projectId: { in: ids }, status: { not: 'RETURNED' }, weekStart: { gte: dateOnly(addDays(period.from, -6)), lte: dateOnly(period.to) } },
    },
    select: { grossPaisa: true, daysWorked: true, worker: { select: { type: true } } },
  });
  const byType = new Map<WorkerType, { days: number; wages: bigint }>();
  for (const l of lines) {
    const t = byType.get(l.worker.type) ?? { days: 0, wages: 0n };
    t.days += Number(l.daysWorked);
    t.wages += l.grossPaisa;
    byType.set(l.worker.type, t);
  }
  const assignments = await tx.subcontractAssignment.findMany({ where: { tenantId: a.tenantId, projectId: { in: ids } }, select: { id: true, retentionPercent: true } });
  const accounts = await subAccounts(tx, a.tenantId, assignments);
  return {
    wagesPaisa: str([...byType.values()].reduce((s, t) => s + t.wages, 0n)),
    byWorkerType: [...byType.entries()].map(([type, t]) => ({ type, days: t.days, wagesPaisa: str(t.wages) })).sort((x, y) => (BigInt(y.wagesPaisa) > BigInt(x.wagesPaisa) ? 1 : -1)),
    subcontractorsOverpaid: [...accounts.values()].filter((x) => x.overpaid).length,
  };
}

async function paymentStats(tx: Tx, a: ReadActor, ids: string[], period: Period) {
  const groups = await tx.clientPayment.groupBy({
    by: ['method', 'status'],
    where: { tenantId: a.tenantId, projectId: { in: ids }, receivedOn: { gte: dateOnly(period.from), lte: dateOnly(period.to) } },
    _sum: { amountPaisa: true },
    _count: true,
  });
  const of = (method: ClientPaymentMethod, status?: string) =>
    groups.filter((g) => g.method === method && (status ? g.status === status : g.status !== 'BOUNCED')).reduce((s, g) => s + (g._sum.amountPaisa ?? 0n), 0n);
  const byMethod = METHODS.map((method) => ({ method, amountPaisa: str(of(method)), count: groups.filter((g) => g.method === method && g.status !== 'BOUNCED').reduce((n, g) => n + g._count, 0) }));
  return {
    receivedPaisa: str(METHODS.reduce((s, m) => s + of(m, 'CLEARED'), 0n)),
    byMethod,
    cheques: { clearedPaisa: str(of('CHEQUE', 'CLEARED')), pendingPaisa: str(of('CHEQUE', 'PENDING')), bouncedPaisa: str(of('CHEQUE', 'BOUNCED')) },
  };
}

async function alertsFor(tx: Tx, a: ReadActor, ids: string[]) {
  const events = a.seesFinancials
    ? await tx.billingEvent.findMany({
        where: { tenantId: a.tenantId, resolvedAt: null, projectId: { in: ids } },
        include: { project: { select: { id: true, code: true, name: true } } },
        orderBy: { occurredAt: 'desc' },
        take: 10,
      })
    : [];
  const fromEvents = events.map((e) => ({
    source: 'BILLING_EVENT' as const,
    id: e.id,
    type: e.type as string,
    severity: eventSeverity(e.type) as string,
    title: eventTitle(e),
    project: e.project,
    at: e.occurredAt.toISOString(),
    actionUrl: eventHref(e),
  }));
  const fromNotes = (await criticalUnread(tx, a.tenantId, a.userId)).map((n) => ({
    source: 'NOTIFICATION' as const,
    id: n.id,
    type: n.type as string,
    severity: n.severity as string,
    title: n.title,
    project: n.project,
    at: n.createdAt,
    actionUrl: n.actionUrl,
  }));
  // A bounced cheque is both an event and a notification — show it once.
  const seen = new Set(fromEvents.map((e) => `${e.type}:${e.project.id}`));
  return [...fromEvents, ...fromNotes.filter((n) => !seen.has(`${n.type}:${n.project?.id}`))].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 10);
}

async function buildOverview(tx: Tx, a: ReadActor, query: OverviewQuery) {
  const period = periodOf(query);
  if (query.projectId) await findProjectFor(tx, a, query.projectId);
  const projects = await scopedProjects(tx, a, [...DASHBOARD_STATUSES], query.projectId);
  const ids = projects.map((p) => p.id);
  const active = projects.filter((p) => p.status === 'ACTIVE' || p.status === 'CLOSEOUT');
  const date = today();
  const labour = await laborOverviewTx(tx, a, active.map((p) => p.id));
  const site = await siteStats(tx, a, ids, date);
  const pendingApprovals = (await collectApprovals(tx, a)).filter((i) => !query.projectId || i.project?.id === query.projectId).length;
  const { transit } = await systemLocations(tx, a.tenantId);
  const sites = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, type: 'SITE', projectId: { in: ids } }, select: { id: true } });
  const dispatchesOnTheWay = await tx.dispatch.count({ where: { tenantId: a.tenantId, status: 'ON_THE_WAY', ...(a.role === 'THEKEDAR' && !query.projectId ? {} : { toLocationId: { in: sites.map((s) => s.id) } }) } });

  const base = {
    period: { from: period.from, to: period.to },
    asOf: date,
    seesFinancials: a.seesFinancials,
    kpis: {
      activeProjects: { count: active.length, atRisk: 0, delayed: 0 },
      pendingApprovals,
      openShortages: site.openShortages,
      dispatchesOnTheWay,
    },
    site: {
      hazriToday: site.hazriToday,
      assignedWorkers: labour.hazriToday.assigned,
      peshgiThisWeekPaisa: labour.peshgiThisWeekPaisa,
      siteKharchaThisWeekPaisa: labour.kharchaThisWeekPaisa,
      week: labour.week,
      deliveriesToday: site.deliveriesToday,
      openShortages: site.openShortages,
    },
    labor: { period: { from: period.from, to: period.to }, ...(await laborStats(tx, a, ids, period)) },
    alerts: await alertsFor(tx, a, ids),
  };

  if (!a.seesFinancials) {
    return {
      ...base,
      projects: projects.map((p) => ({ project: { id: p.id, code: p.code, name: p.name, status: p.status }, client: p.client })),
    };
  }

  const money = await projectMoney(tx, a, projects);
  const sum = (f: (r: (typeof money)[number]) => bigint) => money.reduce((s, r) => s + f(r), 0n);
  const invoiced = sum((r) => r.m.invoiced);
  const received = sum((r) => r.m.received);
  base.kpis.activeProjects.atRisk = money.filter((r) => r.atRisk && (r.project.status === 'ACTIVE' || r.project.status === 'CLOSEOUT')).length;

  const suppliers = await tx.supplier.findMany({ where: { tenantId: a.tenantId }, select: { id: true } });
  const owed = [...(await supplierBalances(tx, a.tenantId, suppliers.map((s) => s.id))).values()].filter((b) => b.balancePaisa > 0n);
  const ledger = await tx.supplierLedgerEntry.groupBy({ by: ['type'], where: { tenantId: a.tenantId }, _sum: { amountPaisa: true } });
  const billed = ledger.filter((g) => (g._sum.amountPaisa ?? 0n) > 0n).reduce((s, g) => s + (g._sum.amountPaisa ?? 0n), 0n);
  const paid = -ledger.filter((g) => g.type === 'PAYMENT' || g.type === 'PAYMENT_REVERSAL').reduce((s, g) => s + (g._sum.amountPaisa ?? 0n), 0n);
  const stores = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, type: 'STORE' }, select: { id: true } });
  const storeValue = (await balances(tx, a.tenantId, { locationIds: stores.map((s) => s.id) })).filter((b) => !b.ownerSupplied).reduce((s, b) => s + b.value, 0n);
  const inTransit = (await balances(tx, a.tenantId, { locationIds: [transit.id] })).reduce((s, b) => s + b.value, 0n);

  return {
    ...base,
    kpis: {
      ...base.kpis,
      receivablesOutstandingPaisa: str(sum((r) => r.m.outstanding)),
      collectedPercent: percent(received, invoiced),
      invoicedPaisa: str(invoiced),
      receivedPaisa: str(received),
      overduePaisa: str(sum((r) => r.m.overdue)),
      supplierUdhaarPaisa: str(owed.reduce((s, b) => s + b.balancePaisa, 0n)),
      supplierOldestDays: owed.reduce((m, b) => Math.max(m, b.oldestUnpaidDays ?? 0), 0),
      supplierPaidPercent: percent(paid, billed),
      storeStockValuePaisa: str(storeValue),
      inTransitValuePaisa: str(inTransit),
      cashWithSiteStaffPaisa: labour.cashWithSiteStaffPaisa,
      ownMoneyInvestedPaisa: str(sum((r) => r.own)),
    },
    projects: money.map((r) => ({
      project: { id: r.project.id, code: r.project.code, name: r.project.name, status: r.project.status },
      client: r.project.client,
      contractPaisa: str(r.m.contract),
      invoicedPaisa: str(r.m.invoiced),
      receivedPaisa: str(r.m.received),
      outstandingPaisa: str(r.m.outstanding),
      overduePaisa: str(r.m.overdue),
      spentToDatePaisa: str(r.cost),
      ownMoneyInvestedPaisa: str(r.own),
      percentBilled: percent(r.m.invoiced, r.m.contract),
      percentSpentOfContract: percent(r.cost, r.m.contract),
      atRisk: r.atRisk,
      nextBillableStage: r.m.next ? { id: r.m.next.id, label: r.m.next.label, status: r.m.next.status, amountPaisa: str(r.m.next.amountPaisa) } : null,
    })),
    payments: { period: { from: period.from, to: period.to }, ...(await paymentStats(tx, a, ids, period)) },
  };
}

export async function overview(query: OverviewQuery) {
  const a = readActor();
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Site staff use the site dashboard');
  return cached(a.tenantId, `overview|${a.userId}|${query.from ?? ''}|${query.to ?? ''}|${query.projectId ?? ''}`, () => withTenant(a.tenantId, (tx) => buildOverview(tx, a, query)));
}

// ─── Site dashboard ─────────────────────────────────────────────────────────

export async function siteDashboard(projectId: string) {
  const a = readActor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await findProjectFor(tx, a, projectId);
    const date = today();
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(date, s.weekStart);

    const assigned = await tx.projectWorker.count({ where: { tenantId: a.tenantId, projectId, isActive: true } });
    const marks = await tx.attendance.findMany({ where: { tenantId: a.tenantId, projectId, date: dateOnly(date) }, select: { status: true, worker: { select: { type: true } } } });
    const count = (st: string) => marks.filter((m) => m.status === st).length;
    const present = { mistri: 0, mazdoor: 0, other: 0 };
    for (const m of marks) if (m.status !== 'ABSENT') present[WORKER_GROUP[m.worker.type]] += 1;

    const site = await tx.stockLocation.findFirst({ where: { tenantId: a.tenantId, type: 'SITE', projectId } });
    const dispatches = site
      ? await tx.dispatch.findMany({
          where: { tenantId: a.tenantId, toLocationId: site.id, status: 'ON_THE_WAY' },
          include: { items: { select: { sentQty: true, material: { select: { id: true, name: true, unit: true } } } }, fromLocation: { select: { name: true } } },
          orderBy: { dispatchedAt: 'asc' },
        })
      : [];
    const purchases = await tx.purchase.findMany({
      where: { tenantId: a.tenantId, projectId, status: 'PENDING_RECEIPT' },
      include: { items: { select: { challanQty: true, material: { select: { id: true, name: true, unit: true } } } }, supplier: { select: { name: true } } },
      orderBy: { purchaseDate: 'asc' },
    });
    const incoming = [
      ...dispatches.map((d) => ({
        kind: 'DISPATCH' as const,
        id: d.id,
        number: d.number,
        from: d.fromLocation.name,
        vehicleNo: d.vehicleNo,
        date: d.dispatchedAt.toISOString(),
        items: d.items.map((i) => ({ material: i.material, quantity: qn(i.sentQty) })),
        actionUrl: `/projects/${projectId}/site/incoming/dispatch/${d.id}`,
      })),
      ...purchases.map((p) => ({
        kind: 'PURCHASE' as const,
        id: p.id,
        number: p.number,
        from: p.supplier.name,
        vehicleNo: p.vehicleNo,
        date: `${formatDateOnly(p.purchaseDate)}T00:00:00.000Z`,
        items: p.items.map((i) => ({ material: i.material, quantity: qn(i.challanQty) })),
        actionUrl: `/projects/${projectId}/site/incoming/purchase/${p.id}`,
      })),
    ];

    const account = await tx.cashAccount.findFirst({ where: { tenantId: a.tenantId, holderUserId: a.userId, isActive: true } });
    const totals = account ? (await totalsOf(tx, a.tenantId, [account.id])).get(account.id)! : null;
    const floatsToAck = account ? await tx.cashEntry.findMany({ where: { tenantId: a.tenantId, accountId: account.id, status: 'PENDING_ACK' }, select: { id: true, amountPaisa: true, method: true, occurredAt: true } }) : [];
    const myKharcha = account
      ? await tx.cashEntry.findMany({
          where: { tenantId: a.tenantId, accountId: account.id, type: 'EXPENSE', projectId },
          select: { id: true, description: true, amountPaisa: true, status: true, occurredAt: true, category: true },
          orderBy: { occurredAt: 'desc' },
          take: 5,
        })
      : [];
    const openTopup = account ? await tx.topupRequest.findFirst({ where: { tenantId: a.tenantId, accountId: account.id, status: 'PENDING' }, select: { id: true, amountPaisa: true, createdAt: true } }) : null;

    const settlements = await tx.wageSettlement.findMany({
      where: { tenantId: a.tenantId, projectId, status: { in: ['DRAFT', 'RETURNED'] } },
      select: { id: true, weekStart: true, status: true, returnComment: true },
      orderBy: { weekStart: 'desc' },
    });
    const usages = await tx.materialUsage.findMany({
      where: { tenantId: a.tenantId, projectId },
      include: { items: { select: { qty: true, material: { select: { id: true, name: true, unit: true } } } } },
      orderBy: [{ usageDate: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    });

    const todo = [
      ...(assigned > 0 && marks.length < assigned ? [{ type: 'MARK_HAZRI', label: `Mark today's hazri (${assigned - marks.length} left)`, actionUrl: `/projects/${projectId}/labor/hazri` }] : []),
      ...incoming.map((i) => ({ type: 'RECEIVE', label: `Receive ${i.number} from ${i.from}`, actionUrl: i.actionUrl })),
      ...floatsToAck.map((f) => ({ type: 'ACKNOWLEDGE_FLOAT', label: `Confirm cash received (Rs ${(f.amountPaisa / 100n).toString()})`, actionUrl: `/projects/${projectId}/cash-book/floats` })),
      ...settlements.map((st) => ({
        type: st.status === 'RETURNED' ? 'FIX_SETTLEMENT' : 'SUBMIT_SETTLEMENT',
        label: `${st.status === 'RETURNED' ? 'Fix and resubmit' : 'Submit'} wages for week of ${formatDateOnly(st.weekStart)}`,
        actionUrl: `/projects/${projectId}/labor/settlements/${st.id}`,
      })),
    ];

    return {
      project: { id: project.id, code: project.code, name: project.name, status: project.status },
      date,
      week,
      hazriToday: {
        assigned,
        marked: marks.length,
        full: count('FULL'),
        half: count('HALF'),
        absent: count('ABSENT'),
        unmarked: Math.max(0, assigned - marks.length),
        present,
      },
      incoming,
      myCash: account
        ? {
            accountId: account.id,
            balancePaisa: str(totals!.balancePaisa),
            pendingAckPaisa: str(totals!.pendingAckPaisa),
            pendingApprovalPaisa: str(totals!.pendingApprovalPaisa),
            openTopup: openTopup ? { id: openTopup.id, amountPaisa: str(openTopup.amountPaisa), requestedAt: openTopup.createdAt.toISOString() } : null,
          }
        : null,
      todo,
      recent: {
        usage: usages.map((u) => ({ id: u.id, date: formatDateOnly(u.usageDate), items: u.items.map((i) => ({ material: i.material, quantity: qn(i.qty) })) })),
        myKharcha: myKharcha.map((k) => ({ id: k.id, date: ymd(k.occurredAt), description: k.description, category: k.category, amountPaisa: str(-k.amountPaisa), status: k.status })),
      },
    };
  });
}
